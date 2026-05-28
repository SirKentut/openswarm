import { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// VisibilityRecorder: stream every observable signal from one packaged-app run
// into a single per-test directory so a failing test tells you the full causal
// chain, not just "this assertion didn't match". Layers it stitches together:
//
//   playwright-trace.zip    - built-in trace: action timeline, before/after
//                             screenshots, DOM snapshots, network panel,
//                             console panel, source line per call. Open with
//                             `npx playwright show-trace <path>`.
//   events.jsonl            - unified timestamped stream of EVERY event we
//                             can intercept: console, pageerror, request,
//                             response, requestfailed, websocket open/frame/
//                             close, custom action wrappers, mousemove,
//                             wheel, keypress, perf marks, electron windows.
//   backend.log.tail        - the running app's backend.log captured live
//                             starting at our baseline byte offset so we
//                             see only the slice that belongs to this test.
//   mousepath.jsonl         - cursor positions sampled in the renderer
//                             (mousemove listener), so cursor speed, path
//                             curvature, hover dwell, and pan trajectory are
//                             all reconstructable post-hoc.
//   video.webm + screenshots/  - visual record alongside the timeline.

export interface VisibilityHandle {
  dir: string;
  recordAction<T>(name: string, fn: () => Promise<T>): Promise<T>;
  mark(label: string, payload?: Record<string, unknown>): void;
  stop(): Promise<void>;
}

function backendLogPath(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OpenSwarm', 'data', 'backend.log');
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);
}

// Renderer-side instrumentation. Runs in EVERY frame of the app before any
// page script, captures mousemove/wheel/keydown with high-res timestamps,
// and forwards to the test side via window.__visibility_log__ which the test
// reads on a poll. No frontend code changes; this is test-only init script.
const INIT_SCRIPT = `
(() => {
  if ((window).__visibility_installed__) return;
  (window).__visibility_installed__ = true;
  const buf = [];
  (window).__visibility_drain__ = () => { const out = buf.splice(0); return out; };
  const push = (kind, payload) => {
    try { buf.push({ ts: performance.now(), kind, payload }); }
    catch (e) { /* never throw out of an event listener */ }
  };
  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    // Sample at most every 8ms to keep the buffer tractable on long tests.
    const now = performance.now();
    if (now - lastMove < 8) return;
    lastMove = now;
    push('mousemove', { x: e.clientX, y: e.clientY, btn: e.buttons });
  }, { capture: true, passive: true });
  document.addEventListener('wheel', (e) => {
    push('wheel', { dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, ctrl: e.ctrlKey });
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (e) => {
    push('keydown', { key: e.key, code: e.code, mod: { c: e.ctrlKey, s: e.shiftKey, a: e.altKey, m: e.metaKey } });
  }, { capture: true, passive: true });
  document.addEventListener('click', (e) => {
    const t = e.target;
    const id = (t && t.getAttribute && (t.getAttribute('data-onboarding') || t.getAttribute('aria-label') || t.getAttribute('data-select-id'))) || (t && t.tagName);
    push('click', { x: e.clientX, y: e.clientY, target: id });
  }, { capture: true, passive: true });
  // Surface any long task (>50ms blocking the main thread) so we see where
  // input responsiveness craters.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) push('longtask', { dur: entry.duration, name: entry.name });
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {}
})();
`;

export async function startVisibility(
  app: ElectronApplication,
  page: Page,
  testId: string,
  rootDir = path.resolve(__dirname, '..', 'traces'),
): Promise<VisibilityHandle> {
  const dir = path.join(rootDir, safeName(testId));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });

  const eventsPath = path.join(dir, 'events.jsonl');
  const mousePath = path.join(dir, 'mousepath.jsonl');
  const backendTailPath = path.join(dir, 'backend.log.tail');
  const eventsStream = fs.createWriteStream(eventsPath, { flags: 'a' });
  const mouseStream = fs.createWriteStream(mousePath, { flags: 'a' });
  const backendTailStream = fs.createWriteStream(backendTailPath, { flags: 'a' });

  const log = (kind: string, payload: unknown) => {
    eventsStream.write(JSON.stringify({ ts: Date.now(), kind, payload }) + '\n');
  };

  // 1) Playwright tracing - the heavy lifter. Captures every action, network
  //    request, console message, and produces snapshot timeline. Saved as a
  //    .zip viewable in `npx playwright show-trace`.
  const ctx = app.context();
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true, title: testId });

  // 2) Renderer-side hooks for input timing + long tasks.
  await ctx.addInitScript({ content: INIT_SCRIPT });
  // Inject into the already-open main page too (init scripts only fire on new pages).
  await page.evaluate(INIT_SCRIPT).catch(() => { /* page may be navigating */ });

  // 3) Page-level event listeners. Console + errors + every network round-trip.
  page.on('console', (m) => log('console', { type: m.type(), text: m.text(), location: m.location() }));
  page.on('pageerror', (e) => log('pageerror', { message: String(e?.message ?? e), stack: e?.stack }));
  page.on('request', (r) => log('request', { url: r.url(), method: r.method(), resourceType: r.resourceType() }));
  page.on('response', (r) => log('response', { url: r.url(), status: r.status(), fromCache: r.fromServiceWorker() }));
  page.on('requestfailed', (r) => log('requestfailed', { url: r.url(), failure: r.failure()?.errorText }));
  page.on('crash', () => log('crash', { url: page.url() }));

  // 4) WebSocket frame capture - the agent protocol streams over this; without
  //    it you see UI changes but not what message arrived.
  page.on('websocket', (ws) => {
    log('ws-open', { url: ws.url() });
    ws.on('framereceived', (f) => log('ws-recv', { url: ws.url(), preview: String(f.payload).slice(0, 400) }));
    ws.on('framesent', (f) => log('ws-send', { url: ws.url(), preview: String(f.payload).slice(0, 400) }));
    ws.on('close', () => log('ws-close', { url: ws.url() }));
    ws.on('socketerror', (e) => log('ws-error', { url: ws.url(), error: String(e) }));
  });

  // 5) Backend log live tail. Capture only the suffix from our start offset so
  //    interleaving with the test timeline stays exact.
  const startOffset = (() => {
    try { return fs.statSync(backendLogPath()).size; } catch { return 0; }
  })();
  let backendOffset = startOffset;
  const backendTimer = setInterval(() => {
    try {
      const stat = fs.statSync(backendLogPath());
      if (stat.size <= backendOffset) return;
      const fd = fs.openSync(backendLogPath(), 'r');
      const buf = Buffer.alloc(stat.size - backendOffset);
      fs.readSync(fd, buf, 0, buf.length, backendOffset);
      fs.closeSync(fd);
      backendOffset = stat.size;
      backendTailStream.write(buf);
      // Also project each line into the unified events stream so a single grep
      // across events.jsonl recovers everything ordered.
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line) log('backend', line.slice(0, 800));
      }
    } catch { /* file may not exist yet; keep polling */ }
  }, 500);

  // 6) Drain the renderer-side buffer (mousemove etc.) on a tick.
  const drainTimer = setInterval(async () => {
    try {
      const drained: Array<{ ts: number; kind: string; payload: unknown }> = await page.evaluate(() => (window as any).__visibility_drain__?.() || []);
      for (const e of drained) {
        if (e.kind === 'mousemove' || e.kind === 'wheel') mouseStream.write(JSON.stringify(e) + '\n');
        log(e.kind, e.payload);
      }
    } catch { /* renderer may be busy; pick up next tick */ }
  }, 200);

  // 7) Video. Electron context recording isn't always supported; if it isn't,
  //    skip silently - the snapshots in the trace zip are the fallback.
  // (Playwright's electron.launch does not currently expose recordVideo; we
  // capture frequent screenshots in tests instead, plus the trace's snapshots.)

  log('start', { testId, platform: process.platform, pid: process.pid });

  const handle: VisibilityHandle = {
    dir,
    async recordAction<T>(name, fn) {
      const t0 = Date.now();
      log('action-start', { name });
      try {
        const result = await fn();
        log('action-end', { name, durationMs: Date.now() - t0, ok: true });
        return result;
      } catch (e: any) {
        log('action-end', { name, durationMs: Date.now() - t0, ok: false, error: String(e?.message ?? e) });
        throw e;
      }
    },
    mark(label, payload) { log('mark', { label, ...(payload || {}) }); },
    async stop() {
      log('stop', {});
      clearInterval(backendTimer);
      clearInterval(drainTimer);
      try { await ctx.tracing.stop({ path: path.join(dir, 'playwright-trace.zip') }); } catch {}
      await new Promise<void>((r) => eventsStream.end(() => r()));
      await new Promise<void>((r) => mouseStream.end(() => r()));
      await new Promise<void>((r) => backendTailStream.end(() => r()));
    },
  };
  return handle;
}

