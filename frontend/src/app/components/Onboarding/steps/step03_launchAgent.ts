import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasAnyAgentLaunched, isYoutubeEnabled } from './skipPredicates';

// Primary: YouTube summary (needs MCP from step 2). Fallback uses built-in web tools (no MCP).
const YOUTUBE_PROMPT =
  'What is this youtube video about: https://youtu.be/_NKj8KQMY-k?si=rEk4KO2bOpa5Vo0z. Do not use browser agents.';
const FALLBACK_PROMPT =
  'Find the latest news about AI from the web and give me a short summary.';

export const step03: OnboardingStep = {
  id: 'launch_agent',
  stage: 'get_started',
  // Value first: this is now step 1. With the free trial armed it runs with no
  // model connected and no sign-in, so the user sees an agent work immediately.
  index: 1,
  title: 'Launch your first Agent',
  description: 'Click the chat bubble to fire up a new Agent in a dashboard.',
  videoSrc: './onboarding-videos/v2/03.mp4',
  videoDurationLabel: '0:24',
  skipIf: hasAnyAgentLaunched,
  requiresDashboard: true,
  ops: [
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Tap the chat bubble to start a fresh chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    {
      kind: 'type_into',
      target: S.chatInput,
      // YouTube prompt bans browser agents (MCP handles it); fallback uses web tools by design.
      text: (state) => (isYoutubeEnabled(state) ? YOUTUBE_PROMPT : FALLBACK_PROMPT),
      speedMs: 12,
    },
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
