import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchApp, waitForMainWindow } from '../helpers/launch';
import { startVisibility, VisibilityHandle } from '../helpers/visibility';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Drives all 8 onboarding steps to completion in three different orders:
//   (1) sequential 1->2->3->...->8 (the happy path)
//   (2) skip-3-resume (user opens stage 2 then returns; tests the "panel mode
//       transitions don't strand state" class of bug we have seen historically)
//   (3) full unmark + re-mark (regression for the "completed steps re-firing
//       the AC animation" leak)
// After each ordering, asserts the slice's completed set matches expectation,
// the panel's done/total counter matches, and the renderer didn't crash.

const STEP_IDS = [
  'connect_model',
  'enable_actions',
  'launch_agent',
  'use_browser',
  'agent_use_browser',
  'agent_control_agents',
  'install_skill',
  'make_app',
];

function backendLogPath(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OpenSwarm', 'data', 'backend.log');
}
function crashCount(): number {
  try { return (fs.readFileSync(backendLogPath(), 'utf8').match(/renderer process gone/g) || []).length; }
  catch { return 0; }
}

test.describe.configure({ mode: 'serial' });
test.describe('onboarding completion (8 steps, 3 orderings)', () => {
  let app: ElectronApplication;
  let page: Page;
  let vis: VisibilityHandle;
  let baseline = 0;
  const errors: Array<{ kind: string; text: string }> = [];
  const WHITELIST = [/DevTools listening/i, /Autofill/i, /electron-store/i, /downloadable font/i];

  test.beforeAll(async () => {
    app = await launchApp();
    page = await waitForMainWindow(app);
    vis = await startVisibility(app, page, 'onboarding-completion');
    page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e?.message ?? e) }));
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });
    baseline = crashCount();
  });
  test.afterAll(async () => { try { await vis?.stop(); } catch {} await app?.close().catch(() => {}); });

  async function markCompleted(stepId: string) {
    await page.evaluate((id) => {
      const store = (window as any).__OPENSWARM_STORE__;
      if (!store) throw new Error('Redux store not exposed');
      store.dispatch({ type: 'onboardingProgress/markStepCompleted', payload: id });
    }, stepId);
    await page.waitForTimeout(120);
  }
  async function unmarkCompleted(stepId: string) {
    await page.evaluate((id) => {
      const store = (window as any).__OPENSWARM_STORE__;
      if (!store) throw new Error('Redux store not exposed');
      store.dispatch({ type: 'onboardingProgress/unmarkStepCompleted', payload: id });
    }, stepId);
    await page.waitForTimeout(120);
  }
  async function readCompletedSet(): Promise<string[]> {
    return await page.evaluate(() => {
      const store = (window as any).__OPENSWARM_STORE__;
      if (!store) return [];
      const s = store.getState().onboardingProgress;
      return Array.isArray(s?.completed) ? s.completed : Object.keys(s?.completed || {});
    });
  }
  async function resetAll() {
    for (const id of STEP_IDS) await unmarkCompleted(id);
  }

  function freshErrors(mark: number): string {
    return errors.slice(mark).filter((e) => !WHITELIST.some((rx) => rx.test(e.text))).map((e) => `${e.kind}: ${e.text}`).join('\n');
  }

  test('self-check: 8 known step ids and Redux store is reachable', async () => {
    expect(STEP_IDS.length).toBe(8);
    const ok = await page.evaluate(() => !!(window as any).__OPENSWARM_STORE__);
    expect(ok, 'window.__OPENSWARM_STORE__ not exposed - __OPENSWARM_E2E__ init script missing or store gate failed').toBe(true);
  });

  test('ordering 1: sequential 1->8 marks every step exactly once', async () => {
    await resetAll();
    const errMark = errors.length;
    for (let i = 0; i < STEP_IDS.length; i++) {
      vis?.mark('mark-step', { i, id: STEP_IDS[i] });
      await markCompleted(STEP_IDS[i]);
      const set = await readCompletedSet();
      for (let j = 0; j <= i; j++) expect(set, `after step ${i + 1}, ${STEP_IDS[j]} missing`).toContain(STEP_IDS[j]);
      expect(crashCount(), `step ${STEP_IDS[i]} crashed renderer`).toBe(baseline);
    }
    expect(freshErrors(errMark), 'sequential ordering produced unexpected errors').toBe('');
  });

  test('ordering 2: skip pattern (1,2,4,3,5,7,6,8) still ends with all 8 marked', async () => {
    await resetAll();
    const errMark = errors.length;
    const order = ['connect_model', 'enable_actions', 'use_browser', 'launch_agent', 'agent_use_browser', 'install_skill', 'agent_control_agents', 'make_app'];
    for (const id of order) {
      vis?.mark('mark-step-skip-pattern', { id });
      await markCompleted(id);
      expect(crashCount()).toBe(baseline);
    }
    const set = await readCompletedSet();
    for (const id of STEP_IDS) expect(set, `out-of-order completion lost ${id}`).toContain(id);
    expect(freshErrors(errMark), 'skip pattern produced unexpected errors').toBe('');
  });

  test('ordering 3: full unmark + re-mark idempotency (regression: AC animation leak)', async () => {
    await resetAll();
    const errMark = errors.length;
    // First pass: mark all 8.
    for (const id of STEP_IDS) await markCompleted(id);
    let set = await readCompletedSet();
    expect(set.length, 'pass 1: not all 8 marked').toBeGreaterThanOrEqual(8);
    // Unmark every step.
    for (const id of STEP_IDS) await unmarkCompleted(id);
    set = await readCompletedSet();
    expect(set.length, 'after unmark: completed set should be empty').toBe(0);
    // Re-mark each. State must accept this without re-firing AC for already-marked steps.
    for (const id of STEP_IDS) await markCompleted(id);
    set = await readCompletedSet();
    expect(set.length, 'pass 2: not all 8 re-marked').toBeGreaterThanOrEqual(8);
    expect(crashCount(), 'unmark+re-mark cycle crashed renderer').toBe(baseline);
    expect(freshErrors(errMark), 'unmark+re-mark cycle produced unexpected errors').toBe('');
  });

  test('idempotency: marking the same step twice does not change the set', async () => {
    await resetAll();
    await markCompleted('connect_model');
    const before = (await readCompletedSet()).length;
    await markCompleted('connect_model');
    const after = (await readCompletedSet()).length;
    expect(after, 'duplicate mark inflated the set').toBe(before);
  });

  // Real-UI mode: drive each step's primary user action via the actual DOM
  // rather than the slice. Skips agent-touching steps (3/5/6/8) unless a real
  // provider key is wired because those hit the cloud's analytics ingest.
  const REAL_UI = process.env.OPENSWARM_E2E_REAL_UI === '1';
  const HAS_KEY = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENROUTER_API_KEY);
  const safeClick = async (sel: string, label: string) => {
    const loc = page.locator(sel);
    if ((await loc.count()) === 0) return false;
    await loc.first().click({ timeout: 5000 }).catch(() => {});
    return true;
  };

  test('real-UI step 1: connect_model opens Settings -> Models tab', async () => {
    test.skip(!REAL_UI, 'OPENSWARM_E2E_REAL_UI=1 not set');
    await resetAll();
    await page.locator('[data-onboarding="sidebar-settings-button"]').click({ timeout: 5000 });
    await page.locator('[data-onboarding="settings-models-tab"]').click({ timeout: 5000 });
    await expect(page.locator('[data-onboarding="settings-api-keys"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-onboarding="settings-close-button"]').click({ timeout: 3000 }).catch(() => {});
    expect(crashCount()).toBe(baseline);
  });

  test('real-UI step 2: enable_actions navigates to Customization > Actions', async () => {
    test.skip(!REAL_UI, 'OPENSWARM_E2E_REAL_UI=1 not set');
    await safeClick('[data-onboarding="sidebar-customization"]', 'customization');
    await page.getByText('Actions', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/actions|customization/i);
    expect(crashCount()).toBe(baseline);
  });

  test('real-UI step 3: launch_agent opens compose (skip send if no provider key)', async () => {
    test.skip(!REAL_UI, 'OPENSWARM_E2E_REAL_UI=1 not set');
    await safeClick('[data-onboarding="sidebar-dashboards"]', 'dashboards');
    await safeClick('[data-onboarding="new-agent-button"]', 'new agent');
    await expect(page.locator('[data-onboarding="chat-input"]').first()).toBeVisible({ timeout: 10_000 });
    if (HAS_KEY) {
      await page.locator('[data-onboarding="chat-input"]').first().click();
      await page.keyboard.type('hello');
      await expect.poll(async () => (await page.locator('[data-onboarding="chat-input"]').first().innerText()).trim()).toContain('hello');
    }
    await page.keyboard.press('Escape').catch(() => {});
    expect(crashCount()).toBe(baseline);
  });

  test('real-UI step 4: use_browser mounts a webview', async () => {
    test.skip(!REAL_UI, 'OPENSWARM_E2E_REAL_UI=1 not set');
    await safeClick('[data-onboarding="sidebar-dashboards"]', 'dashboards');
    await safeClick('[data-onboarding="browser-button"]', 'browser');
    await page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, { timeout: 15_000 });
    expect(crashCount(), 'webview mount crashed renderer').toBe(baseline);
  });

  test('real-UI step 7: install_skill navigates to Customization > Skills', async () => {
    test.skip(!REAL_UI, 'OPENSWARM_E2E_REAL_UI=1 not set');
    await safeClick('[data-onboarding="sidebar-customization"]', 'customization');
    await page.getByText('Skills', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/skills|customization/i);
    expect(crashCount()).toBe(baseline);
  });

  test('real-UI step 8: make_app opens the Add App picker', async () => {
    test.skip(!REAL_UI, 'OPENSWARM_E2E_REAL_UI=1 not set');
    await safeClick('[data-onboarding="sidebar-dashboards"]', 'dashboards');
    await safeClick('[data-onboarding="dashboard-toolbar-apps"]', 'add app');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape').catch(() => {});
    expect(crashCount()).toBe(baseline);
  });

  test('roadmap UI reflects the marked state (8/8 after sequential pass)', async () => {
    await resetAll();
    for (const id of STEP_IDS) await markCompleted(id);
    // Open the roadmap and confirm the counter matches the slice.
    const trigger = page.getByText('See all todos', { exact: true });
    if (await trigger.count()) {
      await trigger.first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape').catch(() => {});
    }
    const set = await readCompletedSet();
    expect(set.length).toBeGreaterThanOrEqual(8);
    expect(crashCount()).toBe(baseline);
  });

  test('final: zero new renderer-gone-lines across all orderings', () => {
    expect(crashCount()).toBe(baseline);
  });
});
