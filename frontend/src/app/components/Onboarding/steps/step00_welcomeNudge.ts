import type { OnboardingStep } from './types';
import { S } from '../selectors';

// Invisible first-run nudge (not part of the numbered tour): a beat after the welcome chat
// pops, the cursor points at the top-right "Continue" pill so the user knows the guided tour
// is there, then retreats. No click, no wait_user, so it's a one-shot gentle gesture.
export const welcomeNudgeStep: OnboardingStep = {
  id: 'welcome_nudge',
  stage: 'get_started',
  index: 0,
  title: 'Welcome',
  description: '',
  ops: [
    { kind: 'move_to', target: S.onboardingContinueButton },
    { kind: 'popup', text: 'Want a quick tour? Tap Continue any time.' },
    { kind: 'outro' },
  ],
};
