import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { store } from '@/shared/state/store';
import { useAppDispatch } from '@/shared/hooks';
import {
  expandSession,
  launchAndSendFirstMessage,
  generateTitle,
  type AgentConfig,
} from '@/shared/state/agentsSlice';
import {
  placeCard,
  setCardPosition,
  setGlowingAgentCard,
  setGlowingBrowserCards,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  type CardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { generateDashboardName } from '@/shared/state/dashboardsSlice';
import type { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import type { CanvasActions } from '../interaction/useCanvasControls';
import type { useDashboardSelection } from '../state/useDashboardSelection';
import { useSpawnPlacement } from './useSpawnPlacement';

type SpawnOrigin = { x: number; y: number; type?: 'branch' };
type Selection = ReturnType<typeof useDashboardSelection>;

interface UseAgentSpawnArgs {
  cards: Record<string, CardPosition>;
  expandedSessionIds: string[];
  dashboardId: string;
  expandNewChats: boolean;
  selection: Selection;
  canvasActions: CanvasActions;
  viewportRef: RefObject<HTMLDivElement | null>;
  toolbarRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  handleHighlightCard: (cardId: string) => void;
  setToolbarOpen: Dispatch<SetStateAction<boolean>>;
  setAutoFocusSessionId: Dispatch<SetStateAction<string | null>>;
  setPendingSelectSessionId: Dispatch<SetStateAction<string | null>>;
  /** First run only: clicking New Agent spawns the welcome chat instead of the composer. */
  welcomeEligible?: boolean;
  onWelcomeNewAgent?: () => void;
}

export function useAgentSpawn({
  cards,
  expandedSessionIds,
  dashboardId,
  expandNewChats,
  selection,
  canvasActions,
  viewportRef,
  toolbarRef,
  canvasStateRef,
  spawnOriginsRef,
  handleHighlightCard,
  setToolbarOpen,
  setAutoFocusSessionId,
  setPendingSelectSessionId,
  welcomeEligible,
  onWelcomeNewAgent,
}: UseAgentSpawnArgs) {
  const dispatch = useAppDispatch();
  const getSpawnPlacement = useSpawnPlacement({ selection, viewportRef, canvasStateRef, expandedSessionIds });

  const handleBranchFromCard = useCallback(
    (sourceSessionId: string, newSessionId: string) => {
      const sourceCard = cards[sourceSessionId];
      if (!sourceCard) return;

      const targetX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      let targetY = sourceCard.y;

      const columnCards = Object.values(cards).filter(
        (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== newSessionId,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }

      spawnOriginsRef.current![newSessionId] = {
        x: sourceCard.x,
        y: sourceCard.y,
        type: 'branch' as const,
      };

      dispatch(placeCard({
        sessionId: newSessionId,
        x: targetX,
        y: targetY,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
        expandedSessionIds,
      }));

      if (expandedSessionIds.includes(sourceSessionId)) {
        dispatch(expandSession(newSessionId));
      }

      dispatch(setGlowingAgentCard({ sessionId: newSessionId, sourceId: sourceSessionId, label: 'Branch' }));
    },
    [cards, dispatch, expandedSessionIds],
  );

  const handleNewAgent = useCallback(() => {
    // First run: spawn the welcome chat (cursor-clicked or hand-clicked) instead of the composer.
    if (welcomeEligible && onWelcomeNewAgent) {
      onWelcomeNewAgent();
      return;
    }
    setToolbarOpen(true);
  }, [welcomeEligible, onWelcomeNewAgent, setToolbarOpen]);

  const handleToolbarCancel = useCallback(() => {
    setToolbarOpen(false);
  }, []);

  const handleToolbarSend = useCallback(
    (
      prompt: string,
      mode: string,
      model: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: ContextPath[],
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
      selectedAppIds?: string[],
    ) => {
      setToolbarOpen(false);
      report('dashboard', 'agent_created', { mode, model, has_images: !!images?.length, has_context: !!contextPaths?.length, has_browser: !!selectedBrowserIds?.length });

      const draftId = `draft-${Date.now().toString(36)}`;
      // Capture where the chat should land at click time (beside the selected card, else in front of the viewport). Applied on fulfilled, unless the single-selected-browser case below docks it left of that browser instead. Center on the height it will RENDER at (expanded chats are tall) so it lands vertically centered, not high-biased.
      const spawnPos = getSpawnPlacement(DEFAULT_CARD_W, expandNewChats ? EXPANDED_CARD_MIN_H : DEFAULT_CARD_H);

      const toolbarEl = toolbarRef.current;
      const vpEl = viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const toolbarCenterX = tr.left + tr.width / 2;
        const toolbarTopY = tr.top;
        const { panX, panY, zoom } = canvasStateRef.current!;
        spawnOriginsRef.current![draftId] = {
          x: (toolbarCenterX - vr.left - panX) / zoom,
          y: (toolbarTopY - vr.top - panY) / zoom,
        };
      }

      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };
      // Editing an existing app: bind the launch to it so the backend edits in place instead of seeding a duplicate empty app (App Builder mode only).
      if (selectedAppIds?.length) config.selected_app_output_ids = selectedAppIds;

      dispatch(
        launchAndSendFirstMessage({
          draftId,
          config,
          prompt,
          mode,
          model,
          images,
          contextPaths: contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })),
          forcedTools,
          attachedSkills,
          selectedBrowserIds,
          selectedAppIds,
          expand: expandNewChats,
        }),
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          // A single browser used as context docks the chat to ITS left; that intentional anchor wins over the generic spawn placement below.
          let dockedBesideBrowser = false;
          if (selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));

            if (selectedBrowserIds.length === 1) {
              const bc = store.getState().dashboardLayout.browserCards[selectedBrowserIds[0]];
              if (bc) {
                // Use placeCard (collision-aware) instead of setCardPosition (blind setter). The "left of the browser" anchor is the IDEAL spot, but if it's already taken by an existing chat (e.g. step 3's YouTube agent that's still on canvas when step 5 creates a new chat for the same browser), placeCard cascades to the nearest free cell instead of stacking on top.
                dispatch(placeCard({
                  sessionId: realId,
                  x: bc.x - DEFAULT_CARD_W - GRID_GAP * 12,
                  y: bc.y,
                  width: DEFAULT_CARD_W,
                  height: DEFAULT_CARD_H,
                  expandedSessionIds,
                }));
                dockedBesideBrowser = true;
              }
            }
          }
          // Place the chat beside the selected card / in front of the viewport. placeCard runs before reconcileSessions fires, so the card is created here at the right spot and never flashes through a top-left grid cell. spawnPos is already collision-resolved, so pin it exactly (placeCard grid-snaps internally, which would knock the chat off the precise center).
          if (!dockedBesideBrowser) {
            dispatch(placeCard({
              sessionId: realId,
              x: spawnPos.x,
              y: spawnPos.y,
              width: DEFAULT_CARD_W,
              height: DEFAULT_CARD_H,
              expandedSessionIds,
            }));
            dispatch(setCardPosition({ sessionId: realId, x: spawnPos.x, y: spawnPos.y }));
          }
          spawnOriginsRef.current![realId] = spawnOriginsRef.current![draftId];
          delete spawnOriginsRef.current![draftId];

          if (expandNewChats) {
            setAutoFocusSessionId(realId);
            dispatch(expandSession(realId));
          } else {
            setPendingSelectSessionId(realId);
          }

          setTimeout(() => {
            const card = store.getState().dashboardLayout.cards[realId];
            if (card) {
              // Fit against the height it actually renders at (expanded chats are taller than the stored collapsed height) so the centered fit frames it correctly.
              const renderH = expandNewChats ? Math.max(EXPANDED_CARD_MIN_H, card.height) : card.height;
              canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: renderH }], 1.15, true, undefined, true);
              handleHighlightCard(realId);
            }
          }, 200);

          if (dashboardId) {
            const currentSessions = store.getState().agents.sessions;
            const agentCount = Object.values(currentSessions).filter(
              (s) => s.status !== 'draft' && s.dashboard_id === dashboardId,
            ).length;
            const NAME_GEN_TRIGGERS = [1, 3, 6];
            const currentDash = store.getState().dashboards.items[dashboardId];
            const canAutoName =
              currentDash &&
              (currentDash.auto_named || currentDash.name === 'Untitled Dashboard');

            if (NAME_GEN_TRIGGERS.includes(agentCount) && canAutoName) {
              dispatch(generateDashboardName(dashboardId));
            }
          }
        } else {
          delete spawnOriginsRef.current![draftId];
        }
      });
    },
    [viewportRef, canvasActions, dispatch, dashboardId, expandNewChats, expandedSessionIds, getSpawnPlacement, handleHighlightCard],
  );

  return {
    handleBranchFromCard,
    handleNewAgent,
    handleToolbarCancel,
    handleToolbarSend,
  };
}
