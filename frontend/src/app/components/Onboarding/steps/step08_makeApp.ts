import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step08: OnboardingStep = {
  id: 'make_app',
  stage: 'learn_features',
  index: 8,
  title: 'Make an App',
  description: 'Prompt interactive applications into existence.',
  videoSrc: '/onboarding-videos/v2/08.mp4',
  videoDurationLabel: '0:42',
  ops: [
    { kind: 'move_to', target: S.sidebarApps },
    { kind: 'popup', text: 'Swing by Apps.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarApps },
    },
    { kind: 'move_to', target: S.appsNewButton },
    { kind: 'popup', text: 'Spin up a fresh one.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.appsNewButton },
    },
    // After clicking +, the /apps/new route mounts ViewEditor which
    // asynchronously renders AgentChat in the left pane (model probe
    // + initial fetch). Without this delay AC tries to type into an
    // input that's either not yet mounted or mounted-but-not-wired
    // to the App Builder agent's state machine. Characters land in
    // the DOM but get discarded on first render commit.
    //
    // 1500ms covers the typical mount + model probe round-trip even
    // under main-thread starvation from concurrent agent streams.
    // waitForSelector below ALSO retries on its own, so this is a
    // belt-and-suspenders preflight, not the primary wait.
    {
      kind: 'popup',
      text: 'Loading the App Builder...',
    },
    { kind: 'delay', ms: 1500 },
    // The App Builder chat lives in the left pane on /apps/new — a
    // regular ChatInput instance, so data-onboarding="chat-input"
    // resolves to it.
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'type_into',
      target: S.chatInput,
      text: 'Make me a pdf previewer app',
      speedMs: 12,
    },
    // AC auto-clicks send per spec ("the AC should auto send this").
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    // Wait only for chat:message_sent (the prompt actually going out).
    // Don't wait for app:generation_done — the App Builder agent can
    // take any of several legitimate paths: save as a standalone HTML
    // to ~/Downloads and open in the system browser, save as an
    // OpenSwarm Output, or skip saving entirely. We can't reliably
    // detect every completion shape, and trapping the user in step 8
    // until a specific one happens is the worst possible UX.
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 30000,
    },
    {
      kind: 'popup',
      text: "Cooking up your app! It'll pop up in a sec. Go explore while it brews.",
    },
    { kind: 'delay', ms: 4000 },
    { kind: 'outro' },
  ],
};
