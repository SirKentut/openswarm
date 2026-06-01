# electron/CLAUDE.md

Electron 40.x (CastLabs DRM build) desktop shell + auto-updater via GitHub Releases. Entry: `main.js`. Version is in `package.json`. See root `CLAUDE.md` for repo-wide constraints.

## Coding precedences

Full precedences live in root [CLAUDE.md](../.claude/CLAUDE.md). Always: **understand the end goal before coding** (what does the user actually need?); **reuse before you write** (grep existing IPC handlers / helpers in `main.js`, most needs already have one); ~300 LOC/file ceiling; downward-tree imports; comments only when necessary (the non-obvious WHY), one line each; **no em-dashes or en-dashes anywhere** (`—`, `–`); say IDK to the user when you don't know, then go find out; test the packaged build path after meaningful changes (not just dev); weigh speed (startup time), efficiency (memory), robustness (auto-updater, OAuth windows), UX, and security (signed binaries, no plaintext secrets) on every change.

## Build / release

- Local build: `npm run build` produces `build-staging/` containing the frontend dist, backend bundle, standalone Python 3.13, and the 9router binary. Build artifacts are ephemeral; not git-tracked.
- macOS release: requires Apple ID, app-specific password, and team ID env vars. App is signed + notarized.
- Windows release: signed via Azure code signing in CI (`.github/workflows/release-windows.yml`); triggers on `v*` tags.

## Bundling

- Python 3.13 is bundled via python-build-standalone, so users do not need a system Python.
- 9router binary is pulled at build time by `scripts/fetch-router.sh` / `fetch-router.ps1`. The version pin (`0.3.60`) is load-bearing for cross-provider WebSearch; see root `CLAUDE.md`.

## Versioning

- Source of truth: `electron/package.json` `version`. Bump alongside any user-facing release; CI tags off it.
- Bump only when cutting a release; coordinate with the publish flow rather than landing version bumps speculatively.

## Dev vs production

The packaged DMG/EXE behaves differently from `bash run.sh` in ways that silently break code:

- **Paths:** `__dirname` and `app.getAppPath()` resolve inside an `asar` archive in production. Use `app.getPath('userData')` for writable storage; `process.resourcesPath` points to unpacked resources.
- **Python:** bundled standalone Python 3.13 lives under `process.resourcesPath/python/`, not the system Python. Spawn it explicitly; don't assume `python3` is on `PATH`.
- **9router:** the binary lives under `process.resourcesPath/9router/`, not downloaded at runtime. Spawn from the bundled path.
- **Backend startup:** in dev, `run.sh` launches uvicorn directly. In prod, `main.js` spawns the bundled Python + backend. Bearer token must be on disk before the HTTP bind so the shell can read it.
- **Auto-updater:** only fires in signed production builds. Staging/test builds must use a separate channel (via `electron-builder` `--config`) to avoid clobbering the stable feed.
- **Deep links (`openswarm://`):** registered via `app.setAsDefaultProtocolClient`. OAuth and Stripe return flows depend on this; test on a packaged build, not the dev shell.
- **Code signing:** macOS unsigned/un-notarized builds get Gatekeeper-blocked; Windows unsigned builds trigger SmartScreen. CI signs on `v*` tags only.
- **Platform splits:** `process.platform`, path separators, line endings, and macOS-only flows (notarization, dock icon, menu bar) require explicit handling for both targets.

For any change touching paths, subprocess spawning, IPC, deep links, or the auto-updater: build with `npm run build` and run the produced DMG or EXE before reporting done.

## Pitfalls

- `build-staging/` is regenerated on every build; never commit it.
- Auto-updater reads the latest release feed from GitHub; staging/test builds should use a separate channel to avoid pushing unsigned bits to users.

## Hardening precedences (learned the hard way)

- **Renderer origin (port) must be stable across launches.** `localStorage` is keyed by full origin including port, so `server.listen(0)` (OS-assigned random port) was wiping onboarding state every restart and re-triggering the tour. Pin to a preferred port (currently `4173`), fall back to OS-assigned only if held. Same rule applies to any future renderer-side persisted state.
- **`webSecurity` stays on.** The file:// segfault was fixed by serving over `http://127.0.0.1:<port>`, NOT by disabling web security. Any future "let's just disable CSP" fix is wrong; find the underlying file:// quirk and route around it (loopback HTTP is the canonical workaround).
- **Mitigations must fail silently in BOTH directions.** When adding a workaround for an Electron / Chromium / platform-level crash you can't fix in our code, every option has two failure modes: (a) the mitigation doesn't help, and (b) the mitigation activates incorrectly and breaks something that was working. The latter is far worse than the former because it produces NEW failure modes we have to debug. Pick options that fail-quiet in both directions; reject options that fail-loud when they succeed (e.g. "hide window on sleep" successfully prevents a crash but every sleep-wake cycle now has a confused user).
- **Per-platform scope every workaround.** If the crash signature is OS-specific (e.g. macOS 26 NSEvent, Windows TSF), gate the workaround behind `process.platform === '<os>'`. Don't apply Mac dodges on Windows (or vice versa) "just to be consistent" — that's pure surface-area expansion for zero crash-fix benefit, and risks introducing new platform-specific regressions on the OS that wasn't crashing.
- **Crash watchdogs need EVERY guard, not most of them.** A naive "process died → relaunch" loop kills more sessions than it saves because it fires on intentional Cmd+Q, auto-updater swaps, and startup crash loops. Mandatory guards: (1) platform check, (2) packaged-only check, (3) clean-quit lock written by `before-quit`, (4) updater-in-progress lock, (5) minimum parent uptime (rules out startup crash loops), (6) relaunch frequency cap (e.g. ≤3 relaunches per hour). See `electron/crash-watchdog.js` for the canonical implementation. If you're adding another supervisor process for a different reason, copy this guard pattern verbatim.
