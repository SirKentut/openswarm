import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step04: OnboardingStep = {
  id: 'use_browser',
  stage: 'get_started',
  index: 4,
  title: 'Use the built-in browser',
  description:
    'No more jumping between apps. You and your agents work in one place.',
  videoSrc: './onboarding-videos/v2/04.mp4',
  videoDurationLabel: '0:18',
  // Runtime auto-prepends a "click into a dashboard" hop when the user
  // isn't already on a #/dashboards/:id route. No need to repeat that in
  // ops — the previous version of this step pointed at the section
  // header (which only toggles the sidebar list) and never actually
  // navigated the user into a dashboard.
  requiresDashboard: true,
  ops: [
    { kind: 'move_to', target: S.browserButton },
    { kind: 'popup', text: 'Pop open a browser.' },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'browser:spawned' },
      timeoutMs: 60000,
    },
    { kind: 'outro' },
  ],
};
