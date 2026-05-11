// One-shot launch-time migrations. Runs synchronously before React
// mounts so any state-reset takes effect before the first selector
// reads it.
//
// Each migration is gated by a localStorage flag so it only runs once
// per install. Adding a new migration:
//   1. Append a new entry to MIGRATIONS below with a unique `key`.
//   2. The `run` function should be idempotent in case the flag check
//      races with a parallel reload.

interface Migration {
  /** Stable localStorage key. Never reused. */
  key: string;
  /** Human-readable description for telemetry / logs. */
  description: string;
  run: () => void;
}

const MIGRATIONS: Migration[] = [
  {
    key: 'openswarm.migrations.v131_force_relogin_and_reonboard',
    description:
      '1.0.31 — force every user to sign in again and walk the new ' +
      'onboarding flow, regardless of prior state',
    run: () => {
      try {
        // Clear the persisted auth token. SignInGate will see no token
        // and show the sign-in screen on next render. Electron's main
        // process still has a copy, but the renderer will refetch via
        // IPC after the user re-authenticates.
        window.localStorage.removeItem('openswarm.auth.token');
        // Clear onboarding-v2 state so the tour starts fresh from
        // step 1 even for users who completed it on a prior version.
        // The slice's loadFromStorage() will return null on next
        // mount and init() will fire with a clean slate.
        window.localStorage.removeItem('openswarm.onboarding.v2');
        // Also clear the legacy v1 onboarding flag so v1.0.29-era
        // users who never opened v2 get the new flow too.
        window.localStorage.removeItem('openswarm_onboarding_seen');
      } catch {
        // localStorage can throw in private mode / quota-exceeded —
        // non-fatal, user will just keep prior state.
      }
    },
  },
];

/**
 * Run any migrations that haven't fired on this install yet. Idempotent;
 * safe to call on every launch. Errors in individual migrations don't
 * block subsequent ones.
 */
export function runStartupMigrations(): void {
  if (typeof window === 'undefined') return;
  for (const m of MIGRATIONS) {
    try {
      if (window.localStorage.getItem(m.key) === 'done') continue;
      m.run();
      window.localStorage.setItem(m.key, 'done');
    } catch {
      // Don't block other migrations on one failing.
    }
  }
}
