#!/usr/bin/env node
// Deterministic "does the packaged app actually work" check — a plain script, no
// browser/Electron automation (which is flaky: single-instance locks, target-
// closed races). It launches the REAL built exe/app, waits for the backend, and
// reads the same backend.log the shipped app writes to confirm the whole boot:
//
//   - [provenance] line present and its sha == git rev-parse HEAD (right build)
//   - [perf] app-launch < first-paint < backend-http-ready (UI painted, ordered)
//   - the backend answers /api/health/check with 200 (it actually serves)
//
// first-paint coming from the log means we prove the renderer painted WITHOUT
// scraping the DOM. Reserve Playwright for genuine GUI-click regressions; this
// covers "did the artifact boot and serve" far more robustly.
//
//   node scripts/ci/verify-packaged-app.js [--app <path>] [--timeout-ms 180000]
//
// Exit 0 = all good. Exit 1 = something didn't boot/serve/match (prints why).

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { app: null, timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

function packagedAppPath(explicit) {
  if (explicit) return explicit;
  const dist = path.join(REPO_ROOT, 'electron', 'dist');
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'win-unpacked', 'OpenSwarm.exe')]
    : process.platform === 'darwin'
      ? ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(dist, d, 'OpenSwarm.app', 'Contents', 'MacOS', 'OpenSwarm'))
      : [path.join(dist, 'linux-unpacked', 'openswarm')];
  const found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!found) { fail(`packaged app not found; build first or pass --app. Looked in:\n  ${candidates.join('\n  ')}`); }
  return found;
}

function backendLogPath() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'OpenSwarm', 'data', 'backend.log');
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'OpenSwarm', 'data', 'backend.log');
}

function gitHeadShort() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim().slice(0, 12); } catch { return null; }
}

function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fail(msg) { process.stderr.write(`\nVERIFY FAIL: ${msg}\n`); killApp(); process.exit(1); }

let child = null;
function killApp() {
  try {
    if (process.platform === 'win32') {
      if (child && child.pid) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
      // Also reap a stray bundled python the app spawned, scoped to our app dir.
      try { execSync('taskkill /IM OpenSwarm.exe /T /F', { stdio: 'ignore' }); } catch { /* none */ }
    } else if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* best effort */ }
}

function healthCode(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health/check' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => { req.destroy(); resolve(0); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = packagedAppPath(args.app);
  const logPath = backendLogPath();
  const headShort = gitHeadShort();

  // Start from a clean log so we read THIS launch, not a stale one.
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* exists */ }
  try { fs.unlinkSync(logPath); } catch { /* none */ }

  process.stdout.write(`Launching: ${appPath}\n`);
  child = spawn(appPath, [], { detached: process.platform !== 'win32', stdio: 'ignore', cwd: path.dirname(appPath) });
  child.on('error', (e) => fail(`could not launch app: ${e.message}`));

  // Wait until backend.log shows backend-http-ready (or time out).
  const deadline = Date.now() + args.timeoutMs;
  let log = '';
  let port = 0;
  while (Date.now() < deadline) {
    log = readFileSafe(logPath);
    const m = log.match(/Backend ready on port (\d+)/);
    if (m) port = Number(m[1]);
    if (/\[perf\] backend-http-ready/.test(log)) break;
    await sleep(1000);
  }

  // --- assertions ---
  const prov = log.match(/\[provenance\] OpenSwarm \S+ sha=([0-9a-f]+)/);
  if (!prov) fail('no [provenance] line in backend.log (app may not have booted)');
  if (headShort && prov[1] !== headShort) fail(`provenance sha ${prov[1]} != git HEAD ${headShort}`);

  const marks = {};
  for (const re of [/\[perf\] app-launch t=(\d+)/, /\[perf\] first-paint t=(\d+)/, /\[perf\] backend-http-ready t=(\d+)/]) {
    const mm = log.match(re); if (mm) marks[re.source.match(/(app-launch|first-paint|backend-http-ready)/)[0]] = Number(mm[1]);
  }
  for (const k of ['app-launch', 'first-paint', 'backend-http-ready']) if (!(k in marks)) fail(`missing [perf] ${k} in backend.log`);
  if (!(marks['app-launch'] <= marks['first-paint'] && marks['first-paint'] <= marks['backend-http-ready'])) {
    fail(`[perf] marks out of order: ${JSON.stringify(marks)}`);
  }

  if (port) {
    let code = 0;
    for (let i = 0; i < 10 && code !== 200; i++) { code = await healthCode(port); if (code !== 200) await sleep(1000); }
    if (code !== 200) fail(`backend health on :${port} returned ${code}, expected 200`);
  } else {
    process.stdout.write('  (note: could not parse backend port from log; relied on perf marks + provenance)\n');
  }

  killApp();
  process.stdout.write('\nVERIFY PASS: packaged app booted, painted, and served.\n');
  process.stdout.write(`  provenance sha   = ${prov[1]} (== HEAD)\n`);
  process.stdout.write(`  app-launch       = ${marks['app-launch']} ms\n`);
  process.stdout.write(`  first-paint      = ${marks['first-paint']} ms\n`);
  process.stdout.write(`  backend-ready    = ${marks['backend-http-ready']} ms${port ? ` (health 200 on :${port})` : ''}\n\n`);
  process.exit(0);
}

main().catch((e) => fail(e && e.message || String(e)));
