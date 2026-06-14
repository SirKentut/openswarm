import { useEffect, useRef, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, expandSession, type AgentMessage } from '@/shared/state/agentsSlice';
import { placeCard, DEFAULT_CARD_W, EXPANDED_CARD_MIN_H } from '@/shared/state/dashboardLayoutSlice';
import { markWelcomeShown } from '@/shared/state/onboardingProgressSlice';
import { hasFreeTrialActive, hasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';

type SpawnOrigin = { x: number; y: number; type?: 'branch' };

// The proactive first-run greeting (static, no LLM). Seeded into the draft only; it never
// reaches the backend (launchAndSendFirstMessage.fulfilled swaps the draft for the server session).
const GREETING = "Hi, I'm your AI team. What do you want done?";

interface Args {
  dashboardId: string;
  isActive: boolean;
  /** layoutInitialized && no sessions/views/browsers on the canvas. */
  canvasEmpty: boolean;
  expandedSessionIds: string[];
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
}

// Once ever, for a genuinely fresh user with a way to run, auto-open a welcome chat card on the
// empty dashboard: a seeded greeting + quick-reply chips, ZERO run consumed until they answer.
// Fail-safe: any throw bails and the dashboard/chat keep working by hand.
export function useWelcomeDraft({
  dashboardId, isActive, canvasEmpty, expandedSessionIds,
  viewportRef, canvasStateRef, spawnOriginsRef,
}: Args): void {
  const dispatch = useAppDispatch();
  const createdRef = useRef(false);
  const eligible = useAppSelector(
    (s) =>
      s.settings.loaded &&
      (hasFreeTrialActive(s) || hasModelConnected(s)) &&
      !s.onboardingProgress.welcomeShown &&
      !(s.onboardingProgress.completedSteps ?? []).includes('launch_agent'),
  );
  const model = useAppSelector((s) => s.settings.data.default_model);

  useEffect(() => {
    if (createdRef.current) return;
    if (!isActive || !canvasEmpty || !eligible) return;
    createdRef.current = true;
    try {
      const greeting: AgentMessage = {
        id: 'welcome-greeting',
        role: 'assistant',
        content: GREETING,
        timestamp: new Date().toISOString(),
        branch_id: 'main',
        parent_id: null,
      };
      const action = dispatch(
        createDraftSession({ welcome: true, seededMessages: [greeting], model, mode: 'agent', dashboardId, setActive: true }),
      );
      const draftId = action.payload.draftId;

      // Center the card in the current viewport (canvas coords) so it pops in front of the user.
      const vp = viewportRef.current;
      const cs = canvasStateRef.current;
      if (vp && cs) {
        const vr = vp.getBoundingClientRect();
        const cx = (vr.width / 2 - cs.panX) / cs.zoom;
        const cy = (vr.height / 2 - cs.panY) / cs.zoom;
        if (spawnOriginsRef.current) spawnOriginsRef.current[draftId] = { x: cx, y: cy };
        dispatch(placeCard({
          sessionId: draftId,
          x: cx - DEFAULT_CARD_W / 2,
          y: cy - EXPANDED_CARD_MIN_H / 2,
          width: DEFAULT_CARD_W,
          height: EXPANDED_CARD_MIN_H,
          expandedSessionIds,
        }));
      }
      dispatch(expandSession(draftId));
      dispatch(markWelcomeShown());
      onboardingBus.emit('welcome:shown');
    } catch (err) {
      console.error('[welcome-draft] create failed', err);
    }
  }, [isActive, canvasEmpty, eligible, model, dashboardId, expandedSessionIds, dispatch, viewportRef, canvasStateRef, spawnOriginsRef]);
}
