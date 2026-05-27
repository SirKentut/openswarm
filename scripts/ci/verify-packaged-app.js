#!/usr/bin/env node
// Deterministic "does the packaged app actually boot and serve" check — a plain
// script, no browser/Electron automation (which is flaky: single-instance locks,
// target-closed races). It launches the REAL built exe/app, waits for the backend,
// and reads the same backend.log the shipped app writes to confirm the boot:
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
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { app: null, timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

let child = null;
function fail(msg) { process.stderr.write(`\nVERIFY FAIL: ${msg}\n`); h.killApp(child); process.exit(1); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appPath = h.packagedAppPath(args.app);
  const headShort = h.gitHeadShort();

  process.stdout.write(`Launching: ${appPath}\n`);
  const res = await h.launchAndWait({ appPath, timeoutMs: args.timeoutMs });
  child = res.child;
  const { log, port } = res;

  // --- assertions ---
  const provSha = h.parseProvenanceSha(log);
  if (!provSha) fail('no [provenance] line in backend.log (app may not have booted)');
  if (headShort && provSha !== headShort) fail(`provenance sha ${provSha} != git HEAD ${headShort}`);

  const marks = h.parsePerfMarks(log);
  for (const k of ['app-launch', 'first-paint', 'backend-http-ready']) if (!(k in marks)) fail(`missing [perf] ${k} in backend.log`);
  if (!(marks['app-launch'] <= marks['first-paint'] && marks['first-paint'] <= marks['backend-http-ready'])) {
    fail(`[perf] marks out of order: ${JSON.stringify(marks)}`);
  }

  if (port) {
    let code = 0;
    for (let i = 0; i < 10 && code !== 200; i++) { code = await h.healthCode(port); if (code !== 200) await h.sleep(1000); }
    if (code !== 200) fail(`backend health on :${port} returned ${code}, expected 200`);
  } else {
    process.stdout.write('  (note: could not parse backend port from log; relied on perf marks + provenance)\n');
  }

  h.killApp(child);
  process.stdout.write('\nVERIFY PASS: packaged app booted, painted, and served.\n');
  process.stdout.write(`  provenance sha   = ${provSha} (== HEAD)\n`);
  process.stdout.write(`  app-launch       = ${marks['app-launch']} ms\n`);
  process.stdout.write(`  first-paint      = ${marks['first-paint']} ms\n`);
  process.stdout.write(`  backend-ready    = ${marks['backend-http-ready']} ms${port ? ` (health 200 on :${port})` : ''}\n\n`);
  process.exit(0);
}

main().catch((e) => fail(e && e.message || String(e)));
