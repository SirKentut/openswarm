// Central registry of every data-onboarding (or data-select-type) string the
// onboarding v2 system targets. Step files import S.* — never inline literals
// — so a refactor that renames a selector breaks at type-check time and we
// can grep for usages.
//
// New keys added by v2 are commented; pre-existing keys (already wired in
// product code before v2) are noted with [existing].

export const S = {
  // [existing] sidebar / nav
  sidebarSkills: 'sidebar-skills',
  sidebarActions: 'sidebar-actions',
  sidebarModes: 'sidebar-modes',
  sidebarApps: 'sidebar-apps',

  // new — sidebar
  sidebarSettingsButton: 'sidebar-settings-button',
  sidebarDashboards: 'sidebar-dashboards',
  // First row inside the expanded Dashboards section. The "click into a
  // dashboard" hop targets this so the user lands inside a dashboard
  // route (where the toolbar + and browser button actually exist).
  dashboardRowFirst: 'dashboard-row-first',

  // [existing] dashboard toolbar
  newAgentButton: 'new-agent-button',
  browserButton: 'browser-button',
  canvasControls: 'canvas-controls',

  // new — dashboard toolbar
  dashboardToolbarApps: 'dashboard-toolbar-apps',

  // [existing] agent card
  agentCard: 'agent-card', // matched via data-select-type as fallback

  // new — settings modal
  settingsModelsTab: 'settings-models-tab',
  settingsCloseButton: 'settings-close-button',
  settingsProSection: 'settings-pro-section',
  settingsExternalSubs: 'settings-external-subs',
  settingsApiKeys: 'settings-api-keys',
  settingsRestartTour: 'settings-restart-tour',

  // new — agent chat input
  chatInput: 'chat-input',
  chatSendButton: 'chat-send-button',
  elementSelectionToggle: 'element-selection-toggle',

  // new — actions / tools page
  actionsRedditToggle: 'actions-reddit-toggle',
  actionsRedditChevron: 'actions-reddit-chevron',
  actionsSubredditsChevron: 'actions-subreddits-chevron',
  actionsPermissionToggle: 'actions-permission-toggle',
  actionsYoutubeToggle: 'actions-youtube-toggle',
  actionsYoutubeChevron: 'actions-youtube-chevron',

  // canvas controls toolbar — used by the inline tour-tip in step 5
  // that flags fit-to-view / tidy / minimap once the user has multiple
  // cards on the canvas.
  canvasFitToView: 'canvas-fit-to-view',
  canvasTidyLayout: 'canvas-tidy-layout',
  canvasMinimapToggle: 'canvas-minimap-toggle',
  // sidebar Customization section header — used by the runtime guard
  // that auto-expands it before targeting Actions / Skills / Modes
  // (which live inside the collapsed area).
  sidebarCustomization: 'sidebar-customization',

  // new — skills page
  skillItemPdf: 'skill-item-pdf',
  skillInstallButton: 'skill-install-button',
  skillBuilderFab: 'skill-builder-fab',

  // new — apps / views page
  appsNewButton: 'apps-new-button',
  appBuilderInput: 'app-builder-input',
  appBuilderSubmit: 'app-builder-submit',
  appCardLatest: 'app-card-latest',

  // new — browser card
  browserUrlBar: 'browser-url-bar',
} as const;

export type SelectorKey = (typeof S)[keyof typeof S];

// Selectors that may legitimately match multiple elements (one per agent
// card). For these we want the *newest* card — the one the user just
// spawned via the + button — not whichever agent happens to be earliest
// in DOM order. Without this scoping, step 6's "type into chat input"
// would hijack the existing "Open Swarm documentation" agent from step 5
// instead of the new orchestrator.
const PER_AGENT_SELECTORS = new Set([
  'chat-input',
  'chat-send-button',
  'element-selection-toggle',
]);

// Resolve a selector string to a live DOM node, falling back to data-select-type
// if data-onboarding doesn't match. Returns null if not found.
//
// Per-agent selectors get special treatment: querySelectorAll all matches
// and pick the one inside the LAST agent-card in DOM order (cards mount
// at the end as they're created, so the last is the newest). Single-match
// selectors are unchanged.
export function resolveSelector(target: string): HTMLElement | null {
  const escaped = (window as any).CSS?.escape?.(target) ?? target;

  if (PER_AGENT_SELECTORS.has(target)) {
    const all = document.querySelectorAll<HTMLElement>(
      `[data-onboarding="${escaped}"]`,
    );
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    // Priority 1: the App Builder's AgentChat scope on /apps/. The
    // App Builder mounts a regular AgentChat in the left pane —
    // not wrapped in [data-select-type="agent-card"] — so without
    // this explicit scope, step 8's chat-input would fall through
    // to "last DOM match" and AC would type into nothing visible.
    const appBuilderScope = document.querySelector<HTMLElement>(
      '[data-onboarding-scope="app-builder"]',
    );
    if (appBuilderScope) {
      const scoped = appBuilderScope.querySelector<HTMLElement>(
        `[data-onboarding="${escaped}"]`,
      );
      if (scoped) return scoped;
    }
    // Priority 2: the dock toolbar's ChatInput, when open. This is the
    // "draft agent" the user just opened by clicking + — higher
    // priority than any existing agent-card so step 5/6's chat-input /
    // send-button / element-selection-toggle ops route to the dock,
    // not whichever agent-card is freshest in the DOM.
    const dockScope = document.querySelector<HTMLElement>(
      '[data-onboarding-scope="dock"]',
    );
    if (dockScope) {
      const scoped = dockScope.querySelector<HTMLElement>(
        `[data-onboarding="${escaped}"]`,
      );
      if (scoped) return scoped;
    }

    // Priority 2: the agent-card with the newest data-onboarding-spawn-ms
    // (set from session.created_at). Used during/after the dock has been
    // collapsed and a real agent card exists.
    const cards = document.querySelectorAll<HTMLElement>(
      '[data-select-type="agent-card"]',
    );
    let newestCard: HTMLElement | null = null;
    let newestSpawnMs = -Infinity;
    cards.forEach((card) => {
      const raw = card.getAttribute('data-onboarding-spawn-ms');
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > newestSpawnMs) {
        newestSpawnMs = n;
        newestCard = card;
      }
    });
    if (!newestCard && cards.length > 0) {
      newestCard = cards[cards.length - 1];
    }
    if (newestCard) {
      const scoped = (newestCard as HTMLElement).querySelector<HTMLElement>(
        `[data-onboarding="${escaped}"]`,
      );
      if (scoped) return scoped;
    }
    return all[all.length - 1];
  }

  const el =
    (document.querySelector(`[data-onboarding="${escaped}"]`) as HTMLElement | null) ??
    (document.querySelector(`[data-select-type="${escaped}"]`) as HTMLElement | null);
  return el;
}

// Wait for a selector to appear in the DOM. Resolves with the element, or
// rejects after timeoutMs. Used by acRuntime when a target is expected to
// mount asynchronously (e.g. settings modal, just-spawned card).
//
// Default bumped to 15s because under heavy main-thread load (many agents
// streaming, App Builder /apps/new mounting AgentChat with its own model
// probe + fetches), 8s was sometimes not enough and AC would abort into
// the recovery popup just before the target finally rendered.
export function waitForSelector(
  target: string,
  timeoutMs = 15000,
): Promise<HTMLElement> {
  const existing = resolveSelector(target);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const obs = new MutationObserver(() => {
      const el = resolveSelector(target);
      if (el) {
        obs.disconnect();
        resolve(el);
      } else if (Date.now() - start > timeoutMs) {
        obs.disconnect();
        reject(new Error(`waitForSelector: "${target}" did not appear within ${timeoutMs}ms`));
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    // Also poll as a safety net — MutationObserver misses nothing in practice
    // but the timeout path needs a way to fire even if the DOM is quiet.
    setTimeout(() => {
      const el = resolveSelector(target);
      if (el) {
        obs.disconnect();
        resolve(el);
      } else {
        obs.disconnect();
        reject(new Error(`waitForSelector: "${target}" did not appear within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}
