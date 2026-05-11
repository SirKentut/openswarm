import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasAnyAgentLaunched } from './skipPredicates';

export const step03: OnboardingStep = {
  id: 'launch_agent',
  stage: 'get_started',
  index: 3,
  title: 'Launch your first Agent',
  description: 'Click + to fire up a new Agent in a dashboard.',
  videoSrc: './onboarding-videos/v2/03.mp4',
  videoDurationLabel: '0:24',
  skipIf: hasAnyAgentLaunched,
  requiresDashboard: true,
  ops: [
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Tap the plus to start a fresh chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    // Chat input mounts asynchronously after + is clicked. waitForSelector
    // inside the runtime handles the small delay before type_into runs.
    {
      kind: 'type_into',
      target: S.chatInput,
      // Anti-browser-agent directive: the YouTube summary can be
      // answered entirely from the youtube transcript MCP without
      // spawning a browser-agent. Browser agents misbehave under
      // load (ReportProgress violation loops, rate-limit retries)
      // and tank dashboard responsiveness. The transcript is plenty.
      text: 'What is this youtube video about: https://youtu.be/_NKj8KQMY-k?si=rEk4KO2bOpa5Vo0z. Do not use browser agents.',
      speedMs: 12,
    },
    // Auto-send the prompt — same pattern as steps 5/6/8. Without this,
    // the user lands on a typed-but-unsent prompt and has to hit send
    // themselves, which is awkward and out-of-line with the other steps.
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 30000,
    },
    { kind: 'outro' },
  ],
};
