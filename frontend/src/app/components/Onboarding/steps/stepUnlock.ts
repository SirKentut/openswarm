// Soft, earned unlocks for the onboarding panel. A locked step is still fully
// usable in the app, this only gates the guided spotlight + shows a lock icon
// with a one-line teaser, so the tour reveals things ONE AT A TIME instead of
// dumping the whole feature surface at once.
//
// Tiers:
//   - get_started (launch an agent, connect a model): unlocked from the start.
//   - Tier 1 "the basics": the FIRST feature unlocks on your first agent win.
//   - Tier 2 "going further": a CHAIN, each feature unlocks once you finish the
//     previous tour step, so the panel only ever surfaces the NEXT thing.
//
// Off-script still counts: doing a thing yourself (opening a browser, installing
// a skill) unlocks its step immediately, so exploring is never punished.

import { useMemo } from 'react';
import type { RootState } from '@/shared/state/store';
import { useAppSelector } from '@/shared/hooks';
import {
  hasAnyAgentLaunched,
  hasAnyBrowserSpawned,
  hasAnySkillInstalled,
} from './skipPredicates';
import { STEPS } from './index';

// Order features reveal in. Index 0 is tier 1 (first thing after the win); the
// rest are the tier-2 chain, each gated on finishing the one before it.
const FEATURE_CHAIN = [
  'enable_actions',
  'use_browser',
  'agent_use_browser',
  'agent_control_agents',
  'install_skill',
  'make_app',
];

// A feature can ALSO unlock when its real-world milestone is met off-script.
const OFF_SCRIPT: Record<string, (s: RootState) => boolean> = {
  use_browser: hasAnyBrowserSpawned,
  agent_use_browser: hasAnyBrowserSpawned,
  install_skill: hasAnySkillInstalled,
};

const HINTS: Record<string, string> = {
  enable_actions: 'Run your first agent',
  use_browser: 'Finish the step above',
  agent_use_browser: 'Finish the step above',
  agent_control_agents: 'Finish the step above',
  install_skill: 'Finish the step above',
  make_app: 'Finish the step above',
};

export function isStepUnlocked(stepId: string, s: RootState): boolean {
  const idx = FEATURE_CHAIN.indexOf(stepId);
  if (idx === -1) return true; // get_started entry points are always open
  if (idx === 0) return hasAnyAgentLaunched(s); // tier 1 opens on the first win
  const prevDone = (s.onboardingProgress?.completedSteps ?? []).includes(
    FEATURE_CHAIN[idx - 1],
  );
  return prevDone || (OFF_SCRIPT[stepId]?.(s) ?? false);
}

export function unlockHintFor(stepId: string): string | null {
  return HINTS[stepId] ?? null;
}

/** Set of currently-unlocked step ids. Keyed on a stable string so the selector
 *  only re-renders when the unlock set actually changes. */
export function useUnlockedStepIds(): Set<string> {
  const key = useAppSelector((s) =>
    STEPS.filter((st) => isStepUnlocked(st.id, s)).map((st) => st.id).join('|'),
  );
  return useMemo(() => new Set(key ? key.split('|') : []), [key]);
}
