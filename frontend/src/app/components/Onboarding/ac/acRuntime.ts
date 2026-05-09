// AC runtime — executes a step's ACOp[] sequence by calling into the
// AgenticCursor handle and the gesture/typing helpers. Runs ops sequentially
// with `await`; aborts cleanly when the AbortSignal fires (user dismisses
// panel mid-step, opens a different step, etc).
//
// Pure async. Not a class. Director (in OnboardingDirector.ts) is the
// caller — it owns the lifecycle (AbortController, AC ref, accent color
// resolution from the theme).

import type { Store } from '@reduxjs/toolkit';
import type { RootState } from '@/shared/state/store';
import {
  recordMultiChoice,
  markStepCompleted,
  clearJustCompleted,
  setRunning,
  setCurrentStep,
} from '../OnboardingProgressSlice';
import { report, markStepStarted, clearStepTiming } from '../telemetry';
import { onboardingBus, type OnboardingEvent } from '../eventBus';
// (gate bump done via onboardingBus.resetReplayGate at runStep entry)
import { waitForSelector } from '../selectors';
import {
  spawnGlowRect,
  spawnLiveTargetGlow,
  clickRipple,
  animateDragSelect,
  sleep,
} from './ACGestures';
import { typeInto } from './ACTypewriter';
import type {
  ACOp,
  AdvanceCondition,
  OnboardingStep,
} from '../steps/types';
import type { AgenticCursorHandle } from './AgenticCursor';

interface RunContext {
  ac: AgenticCursorHandle;
  store: Store<RootState>;
  spawnPoint: { x: number; y: number };
  accentColor: string;
  signal: AbortSignal;
  silent: boolean; // suppress popups during dependency re-walks
  stepId: string;
  // Resolver function for finding a step by id (avoids circular import).
  findStep: (id: string) => OnboardingStep | undefined;
  // Cleanup for the highlight_section big glow.
  highlightCleanup: { current: (() => void) | null };
  // Cleanup for the live "AC is pointing here" target ring. Spawned
  // alongside startTracking and disposed alongside stopTracking — gives
  // the user a clear visual cue of what AC is gesturing toward.
  targetGlowCleanup: { current: (() => void) | null };
}

export interface RunStepArgs {
  step: OnboardingStep;
  spawnPoint: { x: number; y: number };
  ac: AgenticCursorHandle;
  store: Store<RootState>;
  accentColor: string;
  signal: AbortSignal;
  findStep: (id: string) => OnboardingStep | undefined;
  // Optional gate — if step.dependsOn[i] doesn't need re-walking (the
  // dependency's outcome is still satisfied), the caller passes a function
  // that returns true to skip it.
  isDependencySatisfied?: (depId: string) => boolean;
}

export async function runStep(args: RunStepArgs): Promise<void> {
  const { step, spawnPoint, ac, store, accentColor, signal, findStep } = args;

  store.dispatch(setRunning(true));
  store.dispatch(setCurrentStep(step.id));
  markStepStarted();
  // Bump the bus replay gate so any cached emits from prior steps (or
  // the user's exploration in between) can't accidentally satisfy this
  // step's wait_user gates. Subsequent once() subscriptions will only
  // match emits that happen AFTER this bump.
  onboardingBus.resetReplayGate();
  report('step_started', { step_id: step.id, stage: step.stage });

  const highlightCleanup: { current: (() => void) | null } = { current: null };
  const targetGlowCleanup: { current: (() => void) | null } = { current: null };
  const ctx: RunContext = {
    ac,
    store,
    spawnPoint,
    accentColor,
    signal,
    silent: false,
    stepId: step.id,
    findStep,
    highlightCleanup,
    targetGlowCleanup,
  };

  try {
    await ac.fadeIn(spawnPoint);

    // Pre-flight: if the step needs a dashboard route and the user is on
    // a different page (Settings closed but they're on /actions, /skills,
    // etc), walk them into a dashboard first. Without this, the very
    // first move_to of step 3/4/5/6/8 hits a missing target and the
    // cursor stalls or strands itself over unrelated UI.
    if (step.requiresDashboard && !isInDashboardRoute()) {
      await runOps(buildOpenDashboardOps(), ctx);
    }

    if (step.dependsOn?.length) {
      for (const dep of step.dependsOn) {
        if (args.isDependencySatisfied?.(dep.stepId)) continue;
        const depStep = findStep(dep.stepId);
        if (!depStep) continue;
        if (dep.reopen === 'walk_again') {
          report('dependency_walk', { step_id: step.id, dep_id: dep.stepId });
          await runOps(depStep.ops, { ...ctx, silent: true, stepId: depStep.id });
        }
      }
    }

    await runOps(step.ops, ctx);
    report('step_completed', { step_id: step.id });
    store.dispatch(markStepCompleted(step.id));
    // Belt-and-suspenders: dispatch clearJustCompleted from the runtime
    // 950ms after the celebration starts. The OnboardingPanel ALSO has
    // its own useEffect timer for this, but the runtime-side timer
    // guarantees the celebration unsticks even if the panel's effect
    // gets cancelled by a re-render race or AnimatePresence interaction
    // — both dispatches go through the same idempotent reducer, so
    // double-firing is harmless.
    window.setTimeout(() => {
      const cur = store.getState().onboardingProgress;
      if (cur?.justCompletedStepId === step.id) {
        store.dispatch(clearJustCompleted());
      }
    }, 950);
  } catch (err) {
    const isAbort =
      (err as DOMException)?.name === 'AbortError' || signal.aborted;
    const msg = (err as Error)?.message ?? String(err);
    const isSelectorTimeout = /^waitForSelector:/.test(msg);

    if (isAbort) {
      report('step_aborted', { step_id: step.id });
    } else if (isSelectorTimeout) {
      report('step_selector_timeout', { step_id: step.id, error: msg });
    } else {
      console.error('[onboarding] step failed', step.id, err);
      report('step_error', { step_id: step.id, error: msg });
    }

    // Re-show the panel IMMEDIATELY so the user sees it slide back in
    // alongside the cursor's friendly retreat. Otherwise the panel
    // stays hidden through the 1.8s recovery popup + fadeOut, which
    // looks like the onboarding has crashed.
    store.dispatch(setRunning(false));

    try {
      ac.hidePopup();
      ac.stopTracking();
      if (highlightCleanup.current) {
        highlightCleanup.current();
        highlightCleanup.current = null;
      }
      const showMessage = !signal.reason || signal.reason !== 'user-cancel';
      if (showMessage) {
        ac.showPopup(
          "No worries — feel free to explore. Tap Show me whenever you're ready.",
        );
        // 3.5s gives most readers enough time to actually parse the
        // recovery hint. Earlier 1.4s value was tuned for "snappy" but
        // the popup was vanishing before users could read it.
        await new Promise<void>((r) => window.setTimeout(r, 3500));
      }
    } catch {
      /* defensive — never let cleanup throw */
    }

    // Retreat to the original spawnPoint — that's the icon's home
    // position from before the panel hid itself, and after the
    // setRunning(false) above the panel slides back to that exact spot.
    // We previously re-read the live icon rect here, but that fires
    // mid-slide-animation and yields transient coordinates (sometimes
    // (0,0) if Framer hasn't applied the transform yet) — which is
    // why the cursor was landing in the title-bar / kill-button area.
    try {
      await ac.fadeOut(spawnPoint);
    } catch {
      /* swallow */
    }
  } finally {
    if (highlightCleanup.current) {
      highlightCleanup.current();
      highlightCleanup.current = null;
    }
    if (targetGlowCleanup.current) {
      targetGlowCleanup.current();
      targetGlowCleanup.current = null;
    }
    store.dispatch(setRunning(false));
    clearStepTiming();
  }
}

async function runOps(ops: ACOp[], ctx: RunContext): Promise<void> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (ctx.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    // Op-level telemetry — gives drop-off granularity beyond
    // step_started / step_completed. Skipped during silent dependency
    // re-walks to avoid double-reporting.
    if (!ctx.silent) {
      report('op_started', {
        step_id: ctx.stepId,
        op_index: i,
        op_kind: op.kind,
      });
    }
    const opStart = Date.now();
    try {
      await runOp(op, ctx);
      if (!ctx.silent) {
        report('op_completed', {
          step_id: ctx.stepId,
          op_index: i,
          op_kind: op.kind,
          duration_ms: Date.now() - opStart,
        });
      }
    } catch (err) {
      if (!ctx.silent && (err as DOMException)?.name !== 'AbortError') {
        report('op_failed', {
          step_id: ctx.stepId,
          op_index: i,
          op_kind: op.kind,
          duration_ms: Date.now() - opStart,
          error: String(err),
        });
      }
      throw err;
    }
  }
}

async function runOp(op: ACOp, ctx: RunContext): Promise<void> {
  const { ac, store, signal, accentColor } = ctx;

  // Ops that physically move the cursor or change context implicitly
  // clear any active popup, sticky tracker, AND active highlight glow —
  // the previous instruction / pin / glow no longer applies once the
  // cursor is heading somewhere new. wait_user / delay / popup /
  // highlight_section / multi_choice keep all three visible (in
  // particular, wait_user keeps tracking so the cursor stays glued to
  // its target while we wait for the user's click).
  const clearsTransients =
    op.kind === 'move_to' ||
    op.kind === 'click' ||
    op.kind === 'type_into' ||
    op.kind === 'drag_select' ||
    op.kind === 'outro';
  if (clearsTransients) {
    ac.hidePopup();
    ac.stopTracking();
    if (ctx.highlightCleanup.current) {
      ctx.highlightCleanup.current();
      ctx.highlightCleanup.current = null;
    }
    if (ctx.targetGlowCleanup.current) {
      ctx.targetGlowCleanup.current();
      ctx.targetGlowCleanup.current = null;
    }
  }

  switch (op.kind) {
    case 'move_to': {
      const el = await waitForSelector(op.target);
      const scrolled = scrollIntoViewIfNeeded(el);
      // Cheaper rect-settle: instead of unconditionally sleeping 180ms
      // after every scroll AND a possible 200ms retry, read the rect
      // immediately and only wait if it actually looks bad. In the
      // happy path (target already in view, layout stable), this skips
      // both sleeps entirely.
      const offX = op.offset?.x ?? 0;
      const offY = op.offset?.y ?? 0;
      const TITLE_BAR_BOTTOM = 38;
      const looksDegenerate = (rr: DOMRect, y: number): boolean =>
        y < TITLE_BAR_BOTTOM ||
        y > window.innerHeight ||
        rr.width === 0 ||
        rr.height === 0;
      let r = el.getBoundingClientRect();
      let cx = r.left + r.width / 2 + offX;
      let cy = r.top + r.height / 2 + offY;
      if (scrolled || looksDegenerate(r, cy)) {
        // Either we just kicked off a smooth scroll, or the rect looks
        // mid-commit. Wait one frame's worth (16ms) and re-read; only
        // fall back to the longer wait if it's still bad.
        await sleep(scrolled ? 180 : 16);
        r = el.getBoundingClientRect();
        cx = r.left + r.width / 2 + offX;
        cy = r.top + r.height / 2 + offY;
        if (looksDegenerate(r, cy)) {
          await sleep(160);
          r = el.getBoundingClientRect();
          cx = r.left + r.width / 2 + offX;
          cy = r.top + r.height / 2 + offY;
        }
      }
      if (looksDegenerate(r, cy)) {
        throw new Error(`waitForSelector: "${op.target}" rect did not settle`);
      }
      await ac.moveTo(cx, cy);
      ac.startTracking(op.target, op.offset);
      // Live target glow — gives the user a clear "this is what AC
      // is pointing at" visual. Replaces any previous target glow.
      if (ctx.targetGlowCleanup.current) {
        ctx.targetGlowCleanup.current();
      }
      ctx.targetGlowCleanup.current = spawnLiveTargetGlow(el, accentColor);
      return;
    }
    case 'popup': {
      if (ctx.silent) return;
      ac.showPopup(op.text);
      return;
    }
    case 'multi_choice': {
      if (ctx.silent) return;
      const id = await ac.showMultiChoice(op.question, op.options);
      if (id) {
        store.dispatch(
          recordMultiChoice({ stepId: ctx.stepId, opId: op.opId, answerId: id }),
        );
        report('multi_choice_answered', {
          step_id: ctx.stepId,
          op_id: op.opId,
          answer_id: id,
        });
      }
      const choice = op.options.find((o) => o.id === id);
      if (choice?.thenOps?.length) {
        await runOps(choice.thenOps, ctx);
      }
      return;
    }
    case 'highlight_section': {
      const el = await waitForSelector(op.target);
      // Replace any previous highlight first so we don't stack glows.
      if (ctx.highlightCleanup.current) {
        ctx.highlightCleanup.current();
        ctx.highlightCleanup.current = null;
      }
      const cleanup = spawnGlowRect(el, accentColor);
      ctx.highlightCleanup.current = cleanup;
      // Only show the popup if one was supplied — the runtime relies on
      // the next op (typically wait_user) to keep the glow visible while
      // the user reads. The glow is cleared by the next clearsTransients
      // op (move_to / click / type_into / drag_select / outro) or at
      // step-end in the runStep finally block.
      if (op.popup && !ctx.silent) {
        ac.showPopup(op.popup);
      }
      // Optional minimum dwell so very-fast paths still register the
      // glow visually. Defaults to a short beat; explicit durationMs
      // overrides.
      await sleep(op.durationMs ?? 600);
      return;
    }
    case 'type_into': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      const r = el.getBoundingClientRect();
      await ac.moveTo(Math.min(r.right - 14, r.left + r.width / 2), r.top + r.height / 2);
      ac.startTracking(op.target, { x: 0, y: 0 });
      if (ctx.targetGlowCleanup.current) ctx.targetGlowCleanup.current();
      ctx.targetGlowCleanup.current = spawnLiveTargetGlow(el, accentColor);
      await typeInto(el, op.text, { speedMs: op.speedMs });
      return;
    }
    case 'click': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      await ac.moveTo(x, y);
      await ac.pressClick();
      clickRipple(x, y, accentColor);
      if (op.simulate !== false) {
        try {
          el.click();
        } catch {
          /* swallow — degrade to visual-only */
        }
      }
      // Do NOT start tracking after a click. Many click targets are
      // ephemeral — chat send buttons morph into stop buttons after
      // submit, modal triggers unmount when the modal opens, etc.
      // Tracking a disappearing element triggers lost-target → step
      // abort, which kills the step before outro runs and prevents
      // markStepCompleted from firing (the user is stuck on the same
      // step forever). The cursor's last-set position from moveTo holds
      // steady until the next op explicitly moves it.
      return;
    }
    case 'drag_select': {
      const el = await waitForSelector(op.target);
      if (scrollIntoViewIfNeeded(el)) {
        await sleep(180);
      }
      const r = el.getBoundingClientRect();
      const fromX = r.left - 12;
      const fromY = r.top - 12;
      const toX = r.right + 12;
      const toY = r.bottom + 12;
      await ac.moveTo(fromX, fromY);
      await animateDragSelect({ fromX, fromY, toX, toY }, accentColor);
      await ac.moveTo(toX, toY);
      // No tracking after drag_select — the visual ends at a calculated
      // bottom-right corner, not the center of any element. Next op
      // (typically wait_user or move_to) takes over positioning.
      return;
    }
    case 'wait_user': {
      await waitForCondition(op.condition, signal, store, op.timeoutMs);
      ac.hidePopup();
      // Quick layout-settle — one frame is enough in 95% of cases
      // (React commits on the next animation frame). The move_to
      // op also has its own settle if the rect comes out degenerate,
      // so this is just a cheap "let the click handler run" beat.
      await sleep(16);
      return;
    }
    case 'delay': {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, op.ms);
        const onAbort = () => {
          window.clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort);
      });
      return;
    }
    case 'outro': {
      await ac.fadeOut(ctx.spawnPoint);
      return;
    }
  }
}

// Bring the target into view if any part of it is outside the viewport.
// Returns true if a scroll was actually triggered, false otherwise — the
// runtime uses this to decide whether to wait the smooth-scroll-settle
// beat. Scrolling-already-visible-element + 180ms wait would be pure
// added latency on every cursor move (~10s across the whole tour).
function scrollIntoViewIfNeeded(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const PAD = 24;
  const offTop = r.top < PAD;
  const offBottom = r.bottom > vh - PAD;
  const offLeft = r.left < PAD;
  const offRight = r.right > vw - PAD;
  if (!offTop && !offBottom && !offLeft && !offRight) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } catch {
    // Older webview / jsdom — fall back to instant scroll.
    try {
      el.scrollIntoView();
    } catch {
      /* nothing to do — tracker will still try to pin once visible */
    }
  }
  return true;
}

// True when the current URL is `#/dashboard/<id>` (a specific dashboard,
// where the toolbar with + / browser / etc. mounts). False on `#/`
// (dashboard list), `#/skills`, etc. HashRouter only — production app
// uses HashRouter so window.location.hash is the source of truth.
//
// Note: path is singular `/dashboard/`, not `/dashboards/` — that mismatch
// previously had the runtime thinking the user was always in a dashboard
// (since neither shape ever matched), which is why "Show me" from the
// Actions/Skills pages would barrel into a missing-+ button.
function isInDashboardRoute(): boolean {
  const h = window.location.hash || '';
  return /^#\/dashboard\/[^/?#]+/.test(h);
}

// Ops the runtime prepends when a step requires being inside a dashboard
// but the user isn't. First click expands the Dashboards section in the
// sidebar (so the rows render), second click selects the first row to
// navigate into that dashboard. Both clicks are user-driven — we don't
// teleport — so the user understands where they ended up.
function buildOpenDashboardOps(): ACOp[] {
  return [
    { kind: 'move_to', target: 'sidebar-dashboards' },
    { kind: 'popup', text: 'Open the Dashboards list.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: 'sidebar-dashboards' },
      timeoutMs: 60000,
    },
    { kind: 'move_to', target: 'dashboard-row-first' },
    { kind: 'popup', text: 'Click into a dashboard to continue.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: 'dashboard-row-first' },
      timeoutMs: 60000,
    },
  ];
}

function waitForCondition(
  cond: AdvanceCondition,
  signal: AbortSignal,
  store: Store<RootState>,
  timeoutMs?: number,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let cleanup: () => void = () => {};
    let timer: number | null = null;

    const finish = () => {
      cleanup();
      if (timer !== null) window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => {
      cleanup();
      if (timer !== null) window.clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort);

    if (timeoutMs && timeoutMs > 0) {
      timer = window.setTimeout(() => {
        cleanup();
        signal.removeEventListener('abort', onAbort);
        // Treat timeout as soft-success — the user may have done the thing
        // without our condition firing (e.g. they opened the page some other
        // way). Better than freezing the panel.
        resolve();
      }, timeoutMs);
    }

    switch (cond.kind) {
      case 'click_target': {
        const handler = (e: Event) => {
          const el = e.target as HTMLElement | null;
          if (
            el?.closest(
              `[data-onboarding="${cond.target}"], [data-select-type="${cond.target}"]`,
            )
          ) {
            finish();
          }
        };
        document.addEventListener('click', handler, true);
        cleanup = () => document.removeEventListener('click', handler, true);
        return;
      }
      case 'redux_predicate': {
        const check = () => {
          const value = cond.selector(store.getState());
          const ok =
            cond.equals !== undefined
              ? value === cond.equals
              : cond.truthy
                ? Boolean(value)
                : Boolean(value);
          if (ok) finish();
        };
        check();
        const unsub = store.subscribe(check);
        cleanup = unsub;
        return;
      }
      case 'event_bus': {
        const off = onboardingBus.once(cond.event as OnboardingEvent, () =>
          finish(),
        );
        cleanup = off;
        return;
      }
    }
  });
}
