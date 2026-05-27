#!/usr/bin/env node
// Verifies the Windows NSIS installer (OpenSwarm-Setup-x64.exe). Two modes,
// because the installer is oneClick + per-user to a FIXED dir
// (%LOCALAPPDATA%\Programs\OpenSwarm), so a blind install/uninstall on a machine
// that already has OpenSwarm would DESTROY the user's real install.
//
//   default (safe, observational): validate the Setup.exe artifact, and if an
//     install is present, assert its invariants (dir layout, uninstaller registry
//     entry whose target actually exists, shortcuts). Touches nothing.
//
//   --destructive: the real cycle - install /S, assert invariants, (optionally
//     launch + verify-all), uninstall /S, assert removal AND that user data
//     survived (deleteAppDataOnUninstall:false). REFUSES if an install already
//     exists unless --force, so it only runs where there is nothing to clobber
//     (a clean machine / CI runner). This is what the CI installer job runs.
//
//   node scripts/ci/verify-installer.js [--setup <path>] [--destructive] [--force]
//
// Exit 0 = invariants hold. Exit 1 = a real installer/install problem.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const h = require('./lib/app-harness');

function parseArgs(argv) {
  const out = { setup: null, destructive: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--setup') out.setup = argv[++i];
    else if (argv[i] === '--destructive') out.destructive = true;
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenSwarm');
const DATA_DIR = path.join(process.env.APPDATA || '', 'OpenSwarm');
const failures = [];
const ok = (m) => process.stdout.write(`  ok   ${m}\n`);
const bad = (m) => { failures.push(m); process.stdout.write(`  FAIL ${m}\n`); };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } }

function defaultSetup() {
  const p = path.join(h.REPO_ROOT, 'electron', 'dist', 'OpenSwarm-Setup-x64.exe');
  return exists(p) ? p : null;
}

// The shipped installer must be a real, complete PE - not a 0-byte stub or a
// truncated upload (a real CI failure mode).
function checkSetupArtifact(setup) {
  process.stdout.write(`Setup.exe: ${setup}\n`);
  if (!exists(setup)) { bad(`Setup.exe missing at ${setup}`); return; }
  const size = fs.statSync(setup).size;
  if (size < 50 * 1024 * 1024) bad(`Setup.exe is only ${size} bytes (truncated? expected >50MB)`);
  else ok(`Setup.exe size ${(size / 1048576).toFixed(0)} MB`);
  const fd = fs.openSync(setup, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd);
  if (b.toString('latin1') !== 'MZ') bad('Setup.exe is not a valid PE (no MZ header)'); else ok('valid PE (MZ) header');
}

function regUninstall() {
  try {
    const ps = `$ErrorActionPreference='SilentlyContinue'; Get-ChildItem 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if ($p.DisplayName -like '*OpenSwarm*') { $p.DisplayName + '|' + $p.QuietUninstallString } }`;
    return execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function uninstallerPathFromReg(reg) {
  const m = reg.match(/"([^"]*Uninstall OpenSwarm\.exe)"/i) || reg.match(/([A-Za-z]:\\[^|]*Uninstall OpenSwarm\.exe)/i);
  return m ? m[1] : null;
}

function findShortcuts() {
  const dirs = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(os.homedir(), 'Desktop'),
    path.join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop'),
  ];
  const found = [];
  for (const d of dirs) {
    try { for (const f of fs.readdirSync(d)) if (/openswarm.*\.lnk/i.test(f)) found.push(path.join(d, f)); } catch { /* */ }
  }
  return found;
}

// Assert the on-disk + registry state a correct install produces. Used both to
// observe an existing install (safe) and to verify a fresh one (destructive).
function assertInstalled() {
  if (!exists(INSTALL_DIR)) { bad(`install dir missing: ${INSTALL_DIR}`); return; }
  ok(`install dir present: ${INSTALL_DIR}`);
  for (const f of ['OpenSwarm.exe', 'resources', 'locales']) {
    if (exists(path.join(INSTALL_DIR, f))) ok(`contains ${f}`); else bad(`install dir missing ${f}`);
  }
  const reg = regUninstall();
  if (!/OpenSwarm/i.test(reg)) bad('no OpenSwarm uninstall entry in HKCU registry');
  else {
    ok(`uninstall registry entry: ${reg.split('|')[0]}`);
    const up = uninstallerPathFromReg(reg);
    // A registered uninstaller whose target does not exist is an orphaned entry -
    // a real, user-visible "can't uninstall" bug. Assert the target actually exists.
    if (!up) bad('uninstall entry has no parseable uninstaller path');
    else if (!exists(up)) bad(`uninstaller registered but missing on disk: ${up}`);
    else ok(`uninstaller exists: ${up}`);
  }
  const sc = findShortcuts();
  if (sc.length) ok(`shortcut(s): ${sc.join(', ')}`);
  else process.stdout.write('  warn shortcuts not found (location varies; non-fatal)\n');
}

function killRunning() {
  try { execSync('taskkill /IM OpenSwarm.exe /T /F', { stdio: 'ignore' }); } catch { /* none */ }
}

function runDestructive(setup) {
  if (exists(INSTALL_DIR) && !process.argv.includes('--force')) {
    bad(`refusing --destructive: an install already exists at ${INSTALL_DIR}. Running would clobber it. Use a clean machine/CI, or --force if you really mean it.`);
    return;
  }
  process.stdout.write('\n[destructive] installing silently...\n');
  killRunning();
  const inst = spawnSync(setup, ['/S'], { stdio: 'inherit' });
  if (inst.status !== 0 && inst.status !== null) bad(`Setup.exe /S exited ${inst.status}`);
  // oneClick installer returns before files settle; wait for the exe to appear.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !exists(path.join(INSTALL_DIR, 'OpenSwarm.exe'))) { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000"'); }
  assertInstalled();

  // Launch the INSTALLED exe through the full gate (boot/serve/provenance/etc.).
  const installedExe = path.join(INSTALL_DIR, 'OpenSwarm.exe');
  if (exists(installedExe)) {
    process.stdout.write('\n[destructive] verifying the INSTALLED app...\n');
    const v = spawnSync(process.execPath, [path.join(__dirname, 'verify-all.js'), '--app', installedExe], { stdio: 'inherit' });
    if (v.status !== 0) bad('verify-all against the installed app failed');
  }

  process.stdout.write('\n[destructive] uninstalling silently...\n');
  killRunning();
  const reg = regUninstall();
  const up = uninstallerPathFromReg(reg);
  if (up && exists(up)) { const un = spawnSync(up, ['/currentuser', '/S'], { stdio: 'inherit' }); if (un.status) bad(`uninstaller exited ${un.status}`); }
  else bad('could not find the uninstaller to run');
  const delDeadline = Date.now() + 60000;
  while (Date.now() < delDeadline && exists(path.join(INSTALL_DIR, 'OpenSwarm.exe'))) { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000"'); }
  if (exists(path.join(INSTALL_DIR, 'OpenSwarm.exe'))) bad('uninstall left OpenSwarm.exe behind');
  else ok('uninstall removed the app');
  // deleteAppDataOnUninstall:false - user data MUST survive an uninstall.
  if (exists(DATA_DIR)) ok(`user data preserved across uninstall: ${DATA_DIR}`);
  else process.stdout.write('  warn no data dir to check (app may never have run here)\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') { process.stdout.write('SKIP: NSIS installer check is Windows-only.\n'); process.exit(0); }
  const setup = args.setup || defaultSetup();
  if (!setup) { process.stderr.write('INSTALLER FAIL: no Setup.exe found; build first or pass --setup.\n'); process.exit(1); }

  checkSetupArtifact(setup);

  if (args.destructive) {
    runDestructive(setup);
  } else if (exists(INSTALL_DIR)) {
    process.stdout.write('\nObserving existing install (safe; no changes):\n');
    assertInstalled();
  } else {
    process.stdout.write('\nNo install present to observe. Run with --destructive on a CLEAN machine/CI for the full install->verify->uninstall cycle.\n');
  }

  if (failures.length) { process.stderr.write(`\nINSTALLER FAIL: ${failures.length} problem(s).\n`); process.exit(1); }
  process.stdout.write('\nINSTALLER PASS.\n');
  process.exit(0);
}

main();
