import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { store } from '@/shared/state/store';
import { updateDashboardThumbnail } from '@/shared/state/dashboardsSlice';
import { captureDashboardThumbnail } from './geometry/captureDashboardThumbnail';

interface UseDashboardThumbnailArgs {
  isActive: boolean;
  dashboardId: string;
  layoutInitialized: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}

export function useDashboardThumbnail({
  isActive,
  dashboardId,
  layoutInitialized,
  viewportRef,
  contentRef,
}: UseDashboardThumbnailArgs) {
  // Capture a thumbnail screenshot of the dashboard.
  // Uses Electron's native capturePage for pixel-perfect results.
  // Captures current viewport as-is (no DOM mutation) to avoid visual flashes.
  // Re-captures when layout is saved (piggybacking on the save debounce).
  const pendingThumbnailRef = useRef<string | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureNow = useCallback(() => {
    const viewportEl = viewportRef.current;
    const contentEl = contentRef.current;
    if (!viewportEl || !contentEl) return;
    const layoutState = store.getState().dashboardLayout;
    const allCards = {
      cards: layoutState.cards,
      viewCards: layoutState.viewCards,
      browserCards: layoutState.browserCards,
    };
    const hasCards = Object.keys(allCards.cards).length > 0
      || Object.keys(allCards.viewCards).length > 0
      || Object.keys(allCards.browserCards).length > 0;
    if (!hasCards) {
      // Empty dashboard , queue a thumbnail clear (sent on exit alongside
      // the existing capture-update path). Backend treats '' as "set to
      // empty"; null in PUT body means "don't update".
      pendingThumbnailRef.current = '';
      return;
    }
    captureDashboardThumbnail(viewportEl, contentEl, allCards)
      .then((thumbnail) => { if (thumbnail) pendingThumbnailRef.current = thumbnail; })
      .catch(() => {});
  }, [viewportRef, contentRef]);

  useEffect(() => {
    if (!isActive) return;  // Skip thumbnail capture when dashboard is hidden
    if (!dashboardId || !layoutInitialized) return;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, 2000);
    return () => { if (captureTimerRef.current) clearTimeout(captureTimerRef.current); };
  }, [isActive, dashboardId, layoutInitialized, captureNow]);

  // On exit, save the captured thumbnail to the backend
  useEffect(() => {
    if (!dashboardId) return;
    const exitingId = dashboardId;
    return () => {
      const thumbnail = pendingThumbnailRef.current;
      // null = no pending change; '' = pending clear; other = pending update.
      if (thumbnail !== null) {
        store.dispatch(updateDashboardThumbnail({ id: exitingId, thumbnail }));
        pendingThumbnailRef.current = null;
      }
    };
  }, [dashboardId]);

  return { captureNow };
}
