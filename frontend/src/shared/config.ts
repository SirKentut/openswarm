const port = (window as any).__OPENSWARM_PORT__ || 8324;
const host = window.location.hostname || 'localhost';

export const API_BASE = `http://${host}:${port}/api`;
export const WS_BASE = `ws://${host}:${port}`;
export const OPENSWARM_DEFAULT_PROXY_URL = 'https://api.openswarm.ai';

// Per-install auth token. Fetched from Electron's main process via the
// preload contextBridge. We cache it after first resolution so every
// API/WS call is synchronous. On Electron hot-reload the token rotates;
// call `refreshAuthToken()` from a 4401 WS handler to pick up a new
// one without a full page reload.
let _authTokenCache: string = '';
let _authTokenPromise: Promise<string> | null = null;

export function getAuthToken(): string {
  return _authTokenCache;
}

export async function refreshAuthToken(): Promise<string> {
  const ow = (window as any).openswarm;
  if (ow && typeof ow.getAuthToken === 'function') {
    try {
      const tok = await ow.getAuthToken();
      _authTokenCache = typeof tok === 'string' ? tok : '';
    } catch {
      _authTokenCache = '';
    }
  }
  return _authTokenCache;
}

// Resolve-once helper: the first call kicks off the IPC request; any
// concurrent calls reuse the same promise. Frontend bootstrap awaits
// this before the first API call so the token is ready.
export function ensureAuthToken(): Promise<string> {
  if (_authTokenPromise) return _authTokenPromise;
  _authTokenPromise = refreshAuthToken();
  return _authTokenPromise;
}

// Install a global fetch interceptor so every fetch(API_BASE + ...)
// call site gets the Authorization header without touching each site.
// Covers the analytics, settings, agents, dashboards, etc. fetches.
// Only applies to requests that target our own API_BASE — pass-through
// for every other URL (3rd-party APIs, asset CDNs, etc.).
function _installAuthFetchInterceptor() {
  if ((window as any).__OPENSWARM_FETCH_PATCHED__) return;
  (window as any).__OPENSWARM_FETCH_PATCHED__ = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // Only attach token for our own API. Everything else flows through.
      const isOurApi = url.startsWith(API_BASE) || url.startsWith(`http://${host}:${port}/`);
      if (!isOurApi) return originalFetch(input, init);

      // Don't override an explicit Authorization the caller already set.
      const existingHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (existingHeaders.has('Authorization') || existingHeaders.has('authorization')) {
        return originalFetch(input, init);
      }

      const token = _authTokenCache || (await ensureAuthToken());
      if (!token) return originalFetch(input, init);

      existingHeaders.set('Authorization', `Bearer ${token}`);
      const newInit: RequestInit = { ...(init ?? {}), headers: existingHeaders };
      return originalFetch(input, newInit);
    } catch {
      return originalFetch(input, init);
    }
  };
}

// Call immediately on module load — config.ts is imported by the main
// entry point, so this runs before any component-level fetch.
_installAuthFetchInterceptor();
// Kick off token resolution in the background so it's warm by the
// time the first request goes out.
ensureAuthToken();
