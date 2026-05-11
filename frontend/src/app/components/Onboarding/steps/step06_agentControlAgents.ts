import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step06: OnboardingStep = {
  id: 'agent_control_agents',
  stage: 'learn_features',
  index: 6,
  title: 'Have an agent control other agents',
  description: 'Let an agent orchestrate other agents.',
  videoSrc: '/onboarding-videos/v2/06.mp4',
  videoDurationLabel: '0:34',
  requiresDashboard: true,
  ops: [
    // The OnboardingRoot pre-runs `seed-orchestration-demo` before a step-6
    // start so a stub "research" agent already exists on the canvas. The
    // popup below tells the user to imagine they made it themselves.
    {
      kind: 'popup',
      text: "Pretend this chat already did the homework. Now we'll have a fresh one boss it around.",
    },
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: "Make a new chat. This one's the boss." },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    // See step05 — same nudge so the cursor's visual body center sits
    // over the select-mode icon, not the adjacent paperclip.
    { kind: 'move_to', target: S.elementSelectionToggle, offset: { x: -10, y: -10 } },
    { kind: 'popup', text: 'Tap here to hook in the older chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.elementSelectionToggle },
    },
    // Same auto-fit as step 5: the new orchestrator chat triggers
    // Dashboard's autoFocusSessionId, which often pushes the older
    // research card off-screen. Click fit-to-view first so both cards
    // are visible together for the drag-select demo.
    { kind: 'move_to', target: S.canvasFitToView },
    { kind: 'click', target: S.canvasFitToView, simulate: true },
    { kind: 'delay', ms: 350 },
    { kind: 'drag_select', target: 'agent-card' },
    {
      kind: 'popup',
      text: 'Now you try! Drag a box around the chat to make it a helper.',
    },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'agent:attached_to_browser' },
      // Reuses the same attached event as step 5 for now — backend emits
      // it for any element-selection attachment regardless of element type.
      timeoutMs: 90000,
    },
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'type_into',
      target: S.chatInput,
      text: 'Create a pdf report of the research and save it to my downloads',
      speedMs: 12,
    },
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    // Wait for the user's message to actually go out — short wait, just
    // to confirm the orchestration kicked off. Don't wait for the agent
    // to fully finish: orchestrators legitimately run for minutes,
    // sub-agents loop while doing real work, and trapping the user
    // in step 6 until everything settles is the worst possible UX.
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 30000,
    },
    {
      kind: 'popup',
      text: "On it! Your PDF will pop into Downloads when everyone's done. Go poke around in the meantime.",
    },
    { kind: 'delay', ms: 4000 },
    { kind: 'outro' },
  ],
};
