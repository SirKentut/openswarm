// Onboarding v2 — step / op / advance-condition schema.
//
// Steps are pure data: a sequence of ACOps (cursor primitives) interleaved
// with wait_user gates that block until an AdvanceCondition fires. The
// runtime in ../ac/acRuntime.ts is the only place that knows how to
// execute these; step files import only this module.

import type { RootState } from '@/shared/state/store';

export type Selector = string; // matches data-onboarding="<v>" or data-select-type="<v>"

export type ACMultiChoiceOption = {
  id: string;
  label: string;
  // Optional branching — if present, picking this option queues additional
  // ops to run before the rest of the step's ops continue. Lets one step
  // diverge based on user choice without splitting into N steps.
  thenOps?: ACOp[];
};

export type ACOp =
  | { kind: 'move_to'; target: Selector; offset?: { x: number; y: number } }
  | { kind: 'popup'; text: string; cta?: string }
  | { kind: 'multi_choice'; opId: string; question: string; options: ACMultiChoiceOption[] }
  | { kind: 'highlight_section'; target: Selector; popup?: string; durationMs?: number }
  | { kind: 'type_into'; target: Selector; text: string; speedMs?: number }
  | { kind: 'click'; target: Selector; simulate?: boolean }
  | { kind: 'drag_select'; target: Selector }
  | { kind: 'wait_user'; condition: AdvanceCondition; hint?: string; timeoutMs?: number }
  | { kind: 'delay'; ms: number }
  | { kind: 'outro' };

export type AdvanceCondition =
  | { kind: 'click_target'; target: Selector }
  | { kind: 'redux_predicate'; selector: (s: RootState) => unknown; equals?: unknown; truthy?: boolean }
  | { kind: 'event_bus'; event: string };

export type StepStage = 'get_started' | 'learn_features';

export interface StepDependency {
  stepId: string;
  reopen: 'walk_again' | 'just_resume';
}

export interface OnboardingStep {
  id: string;
  stage: StepStage;
  index: number; // 1..N (currently 1..8)
  title: string;
  description: string;
  videoSrc?: string;
  videoDurationLabel?: string; // e.g. "0:24" — shown in the panel preview chip
  ops: ACOp[];
  dependsOn?: StepDependency[];
  // skipIf is evaluated on launch (and on each Show me click) to mark a step
  // already-done without running its flow. Lets existing v1.0.29 users
  // upgrade and have already-completed milestones pre-checked.
  skipIf?: (state: RootState) => boolean;
  // True if the step's ops target dashboard-toolbar elements (+, browser,
  // chat input, send, element-selection toggle, apps button). The runtime
  // auto-prepends a "click into a dashboard" hop when the user isn't
  // already on a #/dashboards/:id route. Without this, every "Show me"
  // from the actions/skills/apps pages would hang on a missing target.
  requiresDashboard?: boolean;
}

export const STAGE_LABELS: Record<StepStage, string> = {
  get_started: 'Get started',
  learn_features: 'Learn the features',
};
