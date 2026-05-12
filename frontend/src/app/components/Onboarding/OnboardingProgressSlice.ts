// Redux slice mirroring the persisted onboarding-v2 state. A thin
// subscriber in OnboardingRoot writes back to localStorage on change
// (debounced 200ms) so the in-memory state is the source of truth at
// runtime and disk is just for resume-after-restart.

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

const STORAGE_KEY = 'openswarm.onboarding.v2';
const SCHEMA_VERSION = 2 as const;

export type PanelMode = 'pill' | 'expanded' | 'roadmap' | 'hidden';

export interface PerStepState {
  lastViewedAt: number;
  videoWatched?: boolean;
  // For multi-choice steps: which option the user picked (used for branching
  // and analytics).
  multiChoiceAnswers?: Record<string, string>;
}

export interface OnboardingProgressState {
  version: typeof SCHEMA_VERSION;
  startedAt: number;
  completedSteps: string[];
  currentStepId: string | null;
  panelMode: PanelMode;
  dismissedAt: number | null;
  perStepState: Record<string, PerStepState>;
  // Runtime-only — not persisted. True while AC is actively executing a
  // step's ops. The panel hides chrome and the user can't open the roadmap
  // mid-flow without first cancelling.
  running: boolean;
  // Set on first launch detection so we don't re-init from defaults on
  // every mount.
  initialized: boolean;
  // Set briefly when a step completes so the panel can render a one-time
  // strike-through + celebration animation before transitioning to the
  // next step. Cleared by clearJustCompleted (the panel calls this from
  // a 1500ms timeout after the animation plays).
  justCompletedStepId: string | null;
  // True after the user explicitly restarts the tour from Settings.
  // Suppresses skipIf-based auto-marking for the rest of this tour run
  // so the user gets a true fresh experience even if their prior data
  // (existing skills, sessions, configured tools) would otherwise
  // satisfy the predicates. False during normal first-launch detection
  // so legitimately upgrading v1.0.29 users still see their already-
  // configured pieces correctly pre-marked.
  disableSkipIf: boolean;
}

export function loadFromStorage(): OnboardingProgressState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingProgressState>;
    if (parsed.version !== SCHEMA_VERSION) return null;
    return {
      version: SCHEMA_VERSION,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
      completedSteps: Array.isArray(parsed.completedSteps) ? parsed.completedSteps : [],
      currentStepId: typeof parsed.currentStepId === 'string' ? parsed.currentStepId : null,
      panelMode: parsed.panelMode ?? 'expanded',
      dismissedAt: typeof parsed.dismissedAt === 'number' ? parsed.dismissedAt : null,
      perStepState: (parsed.perStepState as Record<string, PerStepState>) ?? {},
      running: false,
      initialized: true,
      justCompletedStepId: null,
      disableSkipIf: Boolean((parsed as any).disableSkipIf),
    };
  } catch {
    return null;
  }
}

export function persistToStorage(state: OnboardingProgressState): void {
  try {
    const { running: _r, initialized: _i, ...persisted } = state;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    /* localStorage unavailable */
  }
}

const initialState: OnboardingProgressState = {
  version: SCHEMA_VERSION,
  startedAt: 0,
  completedSteps: [],
  currentStepId: null,
  // Default to expanded — users land on the dashboard with the full
  // step card visible so they see the next milestone + video preview
  // without having to click into the pill first.
  panelMode: 'expanded',
  dismissedAt: null,
  perStepState: {},
  running: false,
  initialized: false,
  justCompletedStepId: null,
  disableSkipIf: false,
};

const slice = createSlice({
  name: 'onboardingProgress',
  initialState,
  reducers: {
    init(
      state,
      action: PayloadAction<{
        currentStepId: string | null;
        preCompleted: string[];
        disableSkipIf?: boolean;
      }>,
    ) {
      if (state.initialized) return;
      state.version = SCHEMA_VERSION;
      state.startedAt = Date.now();
      state.completedSteps = action.payload.preCompleted;
      state.currentStepId = action.payload.currentStepId;
      state.panelMode = 'pill';
      state.dismissedAt = null;
      state.perStepState = {};
      state.running = false;
      state.initialized = true;
      state.disableSkipIf = Boolean(action.payload.disableSkipIf);
    },
    hydrate(state, action: PayloadAction<OnboardingProgressState>) {
      // Replace from localStorage on launch.
      Object.assign(state, action.payload, { running: false, initialized: true });
    },
    setPanelMode(state, action: PayloadAction<PanelMode>) {
      state.panelMode = action.payload;
      if (action.payload === 'hidden') {
        state.dismissedAt = Date.now();
      } else {
        state.dismissedAt = null;
      }
    },
    setCurrentStep(state, action: PayloadAction<string | null>) {
      state.currentStepId = action.payload;
      if (action.payload) {
        const ps = state.perStepState[action.payload] ?? { lastViewedAt: 0 };
        ps.lastViewedAt = Date.now();
        state.perStepState[action.payload] = ps;
      }
    },
    markStepCompleted(state, action: PayloadAction<string>) {
      if (!state.completedSteps.includes(action.payload)) {
        state.completedSteps.push(action.payload);
        // Trigger the celebration / strike-through animation. The panel
        // listens for this and clears it ~1.5s later via clearJustCompleted.
        state.justCompletedStepId = action.payload;
      }
    },
    clearJustCompleted(state) {
      state.justCompletedStepId = null;
    },
    unmarkStepCompleted(state, action: PayloadAction<string>) {
      state.completedSteps = state.completedSteps.filter((id) => id !== action.payload);
    },
    setRunning(state, action: PayloadAction<boolean>) {
      state.running = action.payload;
    },
    recordMultiChoice(
      state,
      action: PayloadAction<{ stepId: string; opId: string; answerId: string }>,
    ) {
      const { stepId, opId, answerId } = action.payload;
      const ps = state.perStepState[stepId] ?? { lastViewedAt: Date.now() };
      ps.multiChoiceAnswers = { ...(ps.multiChoiceAnswers ?? {}), [opId]: answerId };
      state.perStepState[stepId] = ps;
    },
    resetTour(state) {
      state.completedSteps = [];
      state.currentStepId = null;
      state.panelMode = 'expanded';
      state.dismissedAt = null;
      state.perStepState = {};
      state.running = false;
      state.startedAt = Date.now();
      // Tour was explicitly restarted — give the user a true fresh
      // experience by suppressing skipIf for the rest of this run.
      // Otherwise residual data (existing skills installed during a
      // prior tour, leftover seed-orchestration-demo agents, etc)
      // would auto-mark steps complete the moment Redux state ticks.
      state.disableSkipIf = true;
    },
  },
});

export const {
  init,
  hydrate,
  setPanelMode,
  setCurrentStep,
  markStepCompleted,
  clearJustCompleted,
  unmarkStepCompleted,
  setRunning,
  recordMultiChoice,
  resetTour,
} = slice.actions;

export default slice.reducer;
