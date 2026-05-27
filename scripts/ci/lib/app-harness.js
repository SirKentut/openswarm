'use strict';
// Shared plumbing for the packaged-app verifiers in scripts/ci/. Every verifier
// needs the same things: find the built artifact for this OS, launch it, read the
// backend.log it writes, and kill it cleanly. Keeping that here means each verifier
// stays small and single-purpose (boot, resilience, signature, network).
//
// These helpers THROW on misuse and return data on success; the calling script
// owns the pass/fail print + exit code so the harness has no opinion on policy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

// This file is scripts/ci/lib/ -> repo root is three up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function packagedAppPath(explicit) {
  if (explicit) return explicit;
  const dist = path.join(REPO_ROOT, 'electron', 'dist');
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'win-unpacked', 'OpenSwarm.exe')]
    : process.platform === 'darwin'
      ? ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(dist, d, 'OpenSwarm.app', 'Contents', 'MacOS', 'OpenSwarm'))
      : [path.join(dist, 'linux-unpacked', 'openswarm')];
  const found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!found) throw new Error(`packaged app not found; build first or pass --app. Looked in:\n  ${candidates.join('\n  ')}`);
  return found;
}

// The on-disk binary the OS actually signs/scans: the .exe on win, the .app
// bundle dir on mac (codesign/spctl assess the bundle, not the inner MachO).
function signableTarget(appExecutable) {
  if (process.platform === 'darwin') {
    // .../OpenSwarm.app/Contents/MacOS/OpenSwarm -> .../OpenSwarm.app
    const i = appExecutable.indexOf('.app');
    return i === -1 ? appExecutable : appExecutable.slice(0, i + 4);
  }
  return appExecutable;
}

function backendLogPath() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSwarm', 'data', 'backend.log');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'OpenSwarm', 'data', 'backend.log');
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'OpenSwarm', 'data', 'backend.log');
}

// The bearer token the shell writes before the HTTP bind; tests reuse it to call
// the same authenticated API the app itself uses.
function authTokenPath() {
  const dir = path.dirname(backendLogPath());
  return path.join(dir, 'auth.token');
}

function gitHeadShort() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim().slice(0, 12); } catch { return null; }
}

function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spawnApp(appPath, extraArgs = []) {
  // detached on posix so we can SIGKILL the whole process group (the app spawns
  // python + 9router children); on win we reap by image name instead.
  return spawn(appPath, extraArgs, { detached: process.platform !== 'win32', stdio: 'ignore', cwd: path.dirname(appPath) });
}

function killApp(child) {
  try {
    if (process.platform === 'win32') {
      if (child && child.pid) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
      try { execSync('taskkill /IM OpenSwarm.exe /T /F', { stdio: 'ignore' }); } catch { /* none */ }
    } else if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* best effort */ }
}

function healthCode(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health/check' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
  });
}

function parseProvenanceSha(log) {
  const m = log.match(/\[provenance\] OpenSwarm \S+ sha=([0-9a-f]+)/);
  return m ? m[1] : null;
}

function parsePerfMarks(log) {
  const marks = {};
  for (const key of ['app-launch', 'first-paint', 'backend-http-ready']) {
    const m = log.match(new RegExp(`\\[perf\\] ${key} t=(\\d+)`));
    if (m) marks[key] = Number(m[1]);
  }
  return marks;
}

// Launch the app and poll its backend.log until it reports HTTP-ready (or time out).
// Returns { child, log, port }. Caller is responsible for killApp(child).
async function launchAndWait({ appPath, timeoutMs = 180000, freshLog = true } = {}) {
  const logPath = backendLogPath();
  if (freshLog) {
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* exists */ }
    try { fs.unlinkSync(logPath); } catch { /* none */ }
  }
  const child = spawnApp(appPath);
  let launchError = null;
  child.on('error', (e) => { launchError = e; });

  const deadline = Date.now() + timeoutMs;
  let log = '';
  let port = 0;
  while (Date.now() < deadline) {
    if (launchError) throw new Error(`could not launch app: ${launchError.message}`);
    log = readFileSafe(logPath);
    const m = log.match(/Backend ready on port (\d+)/);
    if (m) port = Number(m[1]);
    if (/\[perf\] backend-http-ready/.test(log)) break;
    await sleep(1000);
  }
  return { child, log, port, logPath };
}

module.exports = {
  REPO_ROOT,
  packagedAppPath,
  signableTarget,
  backendLogPath,
  authTokenPath,
  gitHeadShort,
  readFileSafe,
  sleep,
  spawnApp,
  killApp,
  healthCode,
  parseProvenanceSha,
  parsePerfMarks,
  launchAndWait,
};
