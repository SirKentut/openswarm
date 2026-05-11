// Singleton glue between the Onboarding panel UI and the AC runtime.
//
// Lifecycle:
//   - OnboardingRoot mounts, calls Director.attach({ acRef, store, getAccentColor })
//   - Panel "Show me" click → Director.startStep(stepId, sourceRect)
//   - Director creates an AbortController, hands off to acRuntime.runStep
//   - User dismisses panel mid-step → Director.cancelStep() → controller.abort()
//
// The runtime is the only place that touches the cursor handle directly.
// The Director is just a thin policy layer — it picks the spawn point,
// resolves dependencies, and translates Redux state into "should we walk
// step 4 again before step 5."

import type { Store } from '@reduxjs/toolkit';
import type { RootState } from '@/shared/state/store';
import type { RefObject } from 'react';
import { runStep } from './ac/acRuntime';
import type { AgenticCursorHandle } from './ac/AgenticCursor';
import type { OnboardingStep } from './steps/types';
import { STEPS, findStepById } from './steps';
import { API_BASE } from '@/shared/config';
import { report } from './telemetry';

interface AttachArgs {
  acRef: RefObject<AgenticCursorHandle | null>;
  store: Store<RootState>;
  getAccentColor: () => string;
  // Resolves whether a dependency's outcome is still satisfied. If true,
  // the dependency's flow is skipped during walk_again. Step-5's depCheck,
  // for example, asks "is there still a live browser card on the canvas?"
  isDependencySatisfied: (depId: string) => boolean;
}

class OnboardingDirector {
  private acRef: RefObject<AgenticCursorHandle | null> | null = null;
  private store: Store<RootState> | null = null;
  private getAccentColor: () => string = () => '#E8927A';
  private isDependencySatisfied: (depId: string) => boolean = () => false;
  private currentAbort: AbortController | null = null;

  attach(args: AttachArgs) {
    this.acRef = args.acRef;
    this.store = args.store;
    this.getAccentColor = args.getAccentColor;
    this.isDependencySatisfied = args.isDependencySatisfied;
  }

  detach() {
    this.cancelStep();
    this.acRef = null;
    this.store = null;
  }

  isRunning(): boolean {
    return this.currentAbort !== null;
  }

  cancelStep(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  async startStep(
    stepId: string,
    spawnPoint: { x: number; y: number },
  ): Promise<void> {
    if (!this.acRef || !this.store) {
      console.warn('[onboarding] Director not attached');
      return;
    }
    const ac = this.acRef.current;
    if (!ac) {
      console.warn('[onboarding] AC ref not yet mounted');
      return;
    }
    const step = findStepById(stepId);
    if (!step) {
      console.warn('[onboarding] step not found', stepId);
      return;
    }

    this.cancelStep();
    const controller = new AbortController();
    this.currentAbort = controller;

    // Adaptive abort hooks — fire controller.abort() so the runtime's
    // existing cleanup path takes over (cursor outros, popup retreats,
    // panel re-shows for the user to re-attempt).
    //
    // 1. Lost target — tracker fires this when its cached element has
    //    been disconnected for >2.5s (user navigated away, collapsed
    //    the section, swapped a card out from under us).
    // 2. Hash-route change — user clicked a sidebar entry / dashboard
    //    item / settings link mid-flow. Capture the route at start time
    //    and abort if it changes; lets the user explore freely without
    //    the AC stranding itself on the wrong page.
    const startHash = window.location.hash;
    const onLost = () => {
      report('step_aborted_lost_target', { step_id: stepId });
      controller.abort();
    };
    const onRouteChange = () => {
      if (window.location.hash !== startHash) {
        report('step_aborted_route_change', {
          step_id: stepId,
          from: startHash,
          to: window.location.hash,
        });
        controller.abort();
      }
    };
    window.addEventListener('openswarm:onboarding:lost_target', onLost);
    window.addEventListener('hashchange', onRouteChange);

    try {
      // Fire the pre-step hook in the BACKGROUND instead of awaiting it.
      // For step 6, the hook posts `seed-orchestration-demo` which can
      // take 15-30s when Anthropic is rate-limiting (the meta-generation
      // it triggers internally hits 429s and retries). Awaiting it
      // blocked the entire AC flow — user sees no cursor, no popup,
      // appears completely frozen.
      //
      // Now: hook fires in parallel with AC's intro animation + first
      // popup + user clicks. By the time AC reaches the drag_select op
      // that actually needs the stub agent (several user interactions
      // in), the seed has long since completed. If the seed fails
      // outright, drag_select's waitForSelector will time out into the
      // normal recovery path — same as any other "target not found"
      // case. Never blocks the user-visible startup.
      this.runPreStepHook(step).catch((err) => {
        console.warn('[onboarding] preStepHook failed', step.id, err);
        report('pre_step_hook_failed', {
          step_id: step.id,
          error: String(err),
        });
      });

      await runStep({
        step,
        spawnPoint,
        ac,
        store: this.store,
        accentColor: this.getAccentColor(),
        signal: controller.signal,
        findStep: findStepById,
        isDependencySatisfied: this.isDependencySatisfied,
      });
    } finally {
      window.removeEventListener('openswarm:onboarding:lost_target', onLost);
      window.removeEventListener('hashchange', onRouteChange);
      if (this.currentAbort === controller) {
        this.currentAbort = null;
      }
    }
  }

  private async runPreStepHook(step: OnboardingStep): Promise<void> {
    if (!this.store) return;

    if (step.id === 'agent_control_agents') {
      await this.ensureStubResearchAgent();
    }
  }

  /**
   * Step 6 needs a pre-existing "research" agent on the canvas so the
   * spec's "say you already have an agent that did some work for you"
   * narrative makes sense. We look for any existing session named
   * "OpenSwarm research" (the seed endpoint uses that name) and only
   * call seed-orchestration-demo when nothing matches — so re-running
   * step 6 doesn't keep adding stub agents.
   *
   * In-flight dedup: rapid Show me clicks used to fire N parallel
   * seed calls because Redux state didn't update until the FIRST one
   * completed (and synced back via websocket). The promise cache
   * collapses concurrent callers to a single backend POST.
   */
  private seedInFlight: Promise<void> | null = null;

  private async ensureStubResearchAgent(): Promise<void> {
    if (this.seedInFlight) return this.seedInFlight;

    const state = this.store!.getState();
    const sessions = (state as any).agents?.sessions ?? {};
    const alreadySeeded = Object.values(sessions).some(
      (s: any) => s?.name === 'OpenSwarm research',
    );
    if (alreadySeeded) return;

    const dashboardId =
      (state as any).tempState?.lastDashboardId ??
      Object.keys((state as any).dashboards?.items ?? {})[0] ??
      null;
    if (!dashboardId) return;

    this.seedInFlight = (async () => {
      try {
        await fetch(
          `${API_BASE}/dashboards/${dashboardId}/seed-orchestration-demo`,
          { method: 'POST' },
        );
        report('stub_research_agent_seeded', { step_id: 'agent_control_agents' });
      } catch (err) {
        console.warn('[onboarding] seed-orchestration-demo failed', err);
      } finally {
        this.seedInFlight = null;
      }
    })();
    return this.seedInFlight;
  }
}

export const onboardingDirector = new OnboardingDirector();

// Convenience: return the ordered roadmap (1..10) so callers don't import STEPS
// directly when they just need the schedule. STEPS itself is the source of truth.
export function getRoadmap(): OnboardingStep[] {
  return STEPS;
}
