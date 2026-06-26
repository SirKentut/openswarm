import { getWebview } from '@/shared/browserRegistry';

// Zoom the active-tab page of a browser card like a real browser (Ctrl/Cmd +/-/0), independent of the
// dashboard canvas zoom. dir: 1 = in, -1 = out, 0 = reset. Step + clamp must match wherever this is
// called so guest-focused and host-focused zoom never drift apart. Clamp ~0.5x..2.5x.
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;

export function applyBrowserZoom(browserId: string, dir: -1 | 0 | 1): void {
  const wv = getWebview(browserId);
  if (!wv) return;
  try {
    if (dir === 0) {
      wv.setZoomLevel(0);
      return;
    }
    const raw = typeof wv.getZoomLevel === 'function' ? wv.getZoomLevel() : 0;
    const current = typeof raw === 'number' && isFinite(raw) ? raw : 0;
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current + dir * ZOOM_STEP));
    wv.setZoomLevel(next);
  } catch {
    // torn-down webview; nothing to zoom
  }
}
