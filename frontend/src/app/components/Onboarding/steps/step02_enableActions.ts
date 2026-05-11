import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasAnyToolEnabled, isYoutubeEnabled } from './skipPredicates';

export const step02: OnboardingStep = {
  id: 'enable_actions',
  stage: 'get_started',
  index: 2,
  title: 'Enable agentic actions',
  description: 'Allow agents to work across your apps.',
  videoSrc: './onboarding-videos/v2/02.mp4',
  videoDurationLabel: '0:24',
  skipIf: hasAnyToolEnabled,
  ops: [
    { kind: 'move_to', target: S.sidebarActions },
    { kind: 'popup', text: 'Peek at Actions.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarActions },
    },
    // YouTube toggle. Picked YouTube here (instead of Reddit) so the
    // tour has a consistent throughline — step 3 launches an Agent that
    // summarizes a YouTube video, so enabling the YouTube integration
    // here directly powers the next step. Wait on REDUX STATE (YouTube
    // enabled), not a single click — if the user toggles off then back
    // on, AC stays in sync.
    { kind: 'move_to', target: S.actionsYoutubeToggle },
    { kind: 'popup', text: 'Flip YouTube on.' },
    {
      kind: 'wait_user',
      condition: {
        kind: 'redux_predicate',
        selector: isYoutubeEnabled,
        truthy: true,
      },
      timeoutMs: 90000,
    },
    // Expand the YouTube row to reveal its actions list.
    { kind: 'move_to', target: S.actionsYoutubeChevron },
    { kind: 'popup', text: 'Tap to peek inside.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.actionsYoutubeChevron },
    },
    // Hover the permission toggle for the first listed action and
    // explain what it controls. No click required from the user.
    { kind: 'move_to', target: S.actionsPermissionToggle },
    {
      kind: 'popup',
      text: 'Wanna fine tune what each action can do? Right here.',
    },
    { kind: 'delay', ms: 3500 },
    { kind: 'outro' },
  ],
};
