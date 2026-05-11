// Docked top-right panel. Three visible states:
//   - 'pill'     — small "Finish setup X/N · Continue →" pill
//   - 'expanded' — full card with title/desc/video preview/Show me + See all todos
//   - 'roadmap'  — full 10-step modal (delegated to OnboardingRoadmapModal)
//   - 'hidden'   — user-dismissed; only re-shows via Settings → Restart tour
//
// When a step completes, we render a one-time celebration overlay (check
// icon + strike-through over the title) for ~1500ms before crossfading to
// the next step's card. justCompletedStepId in Redux drives this; the
// useEffect below clears it on a timer.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Box, Typography, IconButton, Button, ButtonBase } from '@mui/material';
import RemoveIcon from '@mui/icons-material/Remove';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { useOnboardingProgress } from './hooks/useOnboardingProgress';
import { clearJustCompleted } from './OnboardingProgressSlice';
import { STEPS, findStepById } from './steps';
import { STAGE_LABELS } from './steps/types';
import { onboardingDirector } from './OnboardingDirector';
import { report } from './telemetry';
import { cursorStore } from './ac/cursorStore';
import OnboardingRoadmapModal from './OnboardingRoadmapModal';

const PANEL_WIDTH = 320;
// Long enough to register the strike-through + check, short enough that
// it doesn't feel like waiting before the next step appears.
const CELEBRATION_MS = 900;

// Tiny cursor-arrow SVG that mirrors the shape rendered by AgenticCursor
// so the AC visually appears to "come to life" out of this icon when the
// user clicks Show me.
const CursorIconSmall: React.FC<{ size?: number; color: string }> = ({
  size = 14,
  color,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 22 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden
    style={{ display: 'block' }}
  >
    <path
      d="M3 2 L3 18 L7.5 14 L10 19.5 L13 18 L10.5 12.5 L17 12 Z"
      fill={color}
      stroke="white"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

const OnboardingPanel: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const progress = useOnboardingProgress();
  const infoBtnRef = useRef<HTMLButtonElement | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  // Cursor icon inside the "Show me" button — used to calculate the AC
  // spawn point so the cursor visually flies out of this exact icon.
  const cursorIconRef = useRef<HTMLSpanElement | null>(null);
  // Cooldown for the Show me button so rapid double-clicks don't fire
  // multiple parallel step starts (each one re-triggering backend
  // seed/launch calls that already have an in-flight predecessor).
  const lastShowMeClickRef = useRef<number>(0);

  // Resolve current step. Prefer explicit currentStepId; fall back to
  // first uncompleted step.
  const currentStep = useMemo(() => {
    const explicit = progress.currentStepId
      ? findStepById(progress.currentStepId)
      : null;
    if (explicit && !progress.completedSteps.includes(explicit.id)) return explicit;
    return STEPS.find((s) => !progress.completedSteps.includes(s.id)) ?? null;
  }, [progress.currentStepId, progress.completedSteps]);

  // Stage-relative progress counts. Spec mockup shows "Get started 1/6"
  // (per-stage), not "1/10" (overall). The pill keeps overall.
  const stageOf = currentStep?.stage ?? 'get_started';
  const stageSteps = useMemo(
    () => STEPS.filter((s) => s.stage === stageOf),
    [stageOf],
  );
  const stageDone = stageSteps.filter((s) =>
    progress.completedSteps.includes(s.id),
  ).length;

  const total = STEPS.length;
  const done = progress.completedSteps.length;

  // Celebration banner — strike-through + check on the just-completed
  // step. Timer lives INSIDE CelebrationView so it can't be cancelled
  // by parent OnboardingPanel re-renders or AnimatePresence remounts.
  // Removed the parent-level useEffect that was here; it was vulnerable
  // to a "rapid re-render → cleanup → new timer → repeat" loop where
  // the celebration would never actually clear.
  const justDoneStepId = progress.justCompletedStepId;
  const justDoneStep = justDoneStepId ? findStepById(justDoneStepId) : null;

  const handleShowMe = async () => {
    if (!currentStep) return;
    // Click cooldown — without this, rapid double-clicks fire startStep
    // twice. Each invocation calls cancelStep() then starts fresh, but
    // any in-flight async ops (seed-orchestration-demo, agent launch,
    // etc) keep running because cancelStep only aborts the controller,
    // not pending backend fetches. Result: multiple stub agents
    // created, multiple agents launched, panel state thrashing. 600ms
    // is short enough not to feel laggy, long enough to absorb the
    // user's "is it broken" reflex re-click.
    const now = Date.now();
    if (now - lastShowMeClickRef.current < 600) return;
    lastShowMeClickRef.current = now;

    // If running flag is stuck at true (a prior step's runStep ended
    // without resetting it — possible after an unhandled error or HMR
    // cycle), forcibly cancel and reset before starting fresh. This
    // unsticks the "Show me does nothing" case without forcing the
    // user to reload the app.
    if (progress.running) {
      onboardingDirector.cancelStep();
      progress.setRunning(false);
      // Yield a tick so the running=false dispatch lands before we
      // start the new step (otherwise the runtime's first dispatch
      // races with the reset).
      await new Promise<void>((r) => window.setTimeout(r, 0));
    }
    const iconEl = cursorIconRef.current;
    const rect = iconEl?.getBoundingClientRect();
    // Sanity-check the rect: if the panel is mid-transition (Framer's
    // exit animation hasn't completed), getBoundingClientRect can return
    // (0,0,0,0) — which would land the cursor at the top-left corner
    // (over the macOS traffic lights). Fall back to a sensible
    // top-right anchor when the rect looks degenerate.
    const validRect =
      rect && (rect.width > 0 || rect.height > 0) && (rect.left > 0 || rect.top > 0);
    const spawnPoint = validRect
      ? { x: rect!.left + rect!.width / 2, y: rect!.top + rect!.height / 2 }
      : { x: window.innerWidth - 80, y: 110 };
    report('show_me_clicked', { step_id: currentStep.id });
    // Watchdog: if AC fails to become visible within 2s of Show me
    // (acRef.current was null after an HMR cycle, fadeIn silently
    // rejected, etc), the panel stays hidden because nothing resets
    // `running`. Check the cursorStore — if visible is still false,
    // recover so the panel comes back instead of stranding the user.
    const watchedStepId = currentStep.id;
    window.setTimeout(() => {
      const acVisible = cursorStore.get().visible;
      if (!acVisible) {
        onboardingDirector.cancelStep();
        progress.setRunning(false);
        report('show_me_watchdog_recovery', { step_id: watchedStepId });
      }
    }, 2000);
    await onboardingDirector.startStep(currentStep.id, spawnPoint);
  };

  if (!currentStep && !justDoneStep) return null;
  if (progress.panelMode === 'hidden') return null;

  // While AC is actively walking the user through a step, the panel
  // would otherwise sit on top of targets in the top-right corner
  // (Skills install button, "+ New app" on the Apps page, the Apps
  // toolbar button, etc). Slide it off-screen with a small fade so the
  // cursor has a clean canvas; it animates back when the step outros.
  // motion.div handles both directions of the transition.
  const panelHidden = progress.running;

  return (
    <>
      <Box
        component={motion.div}
        animate={{
          x: panelHidden ? PANEL_WIDTH + 48 : 0,
          opacity: panelHidden ? 0 : 1,
        }}
        transition={{ type: 'spring', stiffness: 280, damping: 32 }}
        sx={{
          position: 'fixed',
          // 38px title bar (drag region with traffic lights / OpenSwarm logo)
          // + 6px breathing room. Sits just below the title bar — clear of
          // the logo in the right corner but tighter to it than the
          // previous 54px so the pill doesn't visually float away from
          // the chrome.
          top: 44,
          right: 16,
          zIndex: 1200,
          fontFamily: c.font.sans,
          pointerEvents: panelHidden ? 'none' : 'auto',
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {progress.panelMode === 'pill' && (
            <motion.div
              key="pill"
              initial={{ opacity: 0, y: -6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              style={{ pointerEvents: 'auto' }}
            >
              <ButtonBase
                onClick={() => {
                  report('panel_expanded', { from: 'pill' });
                  progress.setPanelMode('expanded');
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.4,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  borderRadius: 999,
                  py: 0.65,
                  pl: 1.5,
                  pr: 1.4,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.10)',
                  textAlign: 'left',
                  transition: 'background 0.15s, box-shadow 0.15s',
                  '&:hover': {
                    bgcolor: c.bg.elevated ?? c.bg.surface,
                    boxShadow: '0 10px 24px rgba(0,0,0,0.14)',
                  },
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 500, color: c.text.primary }}>
                  Finish setup
                </Typography>
                <Typography sx={{ fontSize: 12, color: c.text.muted }}>
                  {done}/{total}
                </Typography>
                <Box sx={{ flexGrow: 1, minWidth: 8 }} />
                <Typography
                  sx={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: c.accent.primary,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.4,
                  }}
                >
                  Continue
                  <ArrowForwardIcon sx={{ fontSize: 14 }} />
                </Typography>
              </ButtonBase>
            </motion.div>
          )}

          {progress.panelMode === 'expanded' && (
            <motion.div
              key="expanded"
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.2 }}
              style={{ pointerEvents: 'auto' }}
            >
              <Box
                sx={{
                  width: PANEL_WIDTH,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  borderRadius: `${c.radius.lg}px`,
                  boxShadow: '0 12px 36px rgba(0,0,0,0.16)',
                  overflow: 'hidden',
                }}
              >
                {/* Header — stage label + minimize + progress bar. No
                    bottom border anymore: the progress bar IS the
                    visual divider between header and body, no need for
                    a second separator line below it. */}
                <Box
                  sx={{
                    px: 1.6,
                    pt: 1.2,
                    pb: 0.95,
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.7 }}>
                      <Typography
                        sx={{ fontSize: 12.5, fontWeight: 600, color: c.text.primary }}
                      >
                        {STAGE_LABELS[stageOf]}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: c.text.muted }}>
                        {stageDone}/{stageSteps.length}
                      </Typography>
                    </Box>
                    <IconButton
                      size="small"
                      onClick={() => {
                        report('panel_minimized', { from: 'expanded' });
                        progress.setPanelMode('pill');
                      }}
                      sx={{ color: c.text.tertiary, p: 0.4 }}
                      aria-label="Minimize"
                    >
                      <RemoveIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Box>
                  <Box
                    sx={{
                      mt: 0.7,
                      height: 3,
                      width: '100%',
                      borderRadius: 999,
                      bgcolor: c.bg.secondary,
                      overflow: 'hidden',
                    }}
                  >
                    <motion.div
                      key={`stage-progress-${stageOf}`}
                      initial={false}
                      animate={{
                        width: `${
                          stageSteps.length > 0
                            ? (stageDone / stageSteps.length) * 100
                            : 0
                        }%`,
                      }}
                      transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
                      style={{
                        height: '100%',
                        background: c.accent.primary,
                        borderRadius: 999,
                      }}
                    />
                  </Box>
                </Box>

                {/* Body — celebration overlay or current step. AnimatePresence
                    crossfades between them so step transitions feel smooth. */}
                <Box sx={{ position: 'relative' }}>
                  <AnimatePresence mode="wait" initial={false}>
                    {justDoneStep ? (
                      <motion.div
                        key={`celebrate-${justDoneStep.id}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                      >
                        <CelebrationView step={justDoneStep} accent={c.accent.primary} />
                      </motion.div>
                    ) : currentStep ? (
                      <motion.div
                        key={`step-${currentStep.id}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.22 }}
                      >
                        <StepCardBody
                          step={currentStep}
                          tokens={c}
                          cursorIconRef={cursorIconRef}
                          infoBtnRef={infoBtnRef}
                          onShowMe={handleShowMe}
                          onOpenRoadmap={() => {
                            report('roadmap_opened', { from: 'panel' });
                            progress.setPanelMode('roadmap');
                          }}
                          onToggleInfo={() => {
                            report('info_toggled', {
                              step_id: currentStep.id,
                              opening: !infoOpen,
                            });
                            setInfoOpen((v) => !v);
                          }}
                          running={progress.running}
                        />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="all-done"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      >
                        <AllDoneView accent={c.accent.primary} tokens={c} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Box>
              </Box>
            </motion.div>
          )}
        </AnimatePresence>
      </Box>

      {/* Floating "?" info popover, anchored to the info icon. Renders
          OUTSIDE the panel container so it can extend to the left without
          clipping. */}
      {infoOpen && currentStep && (
        <InfoPopover
          stepId={currentStep.id}
          anchorRef={infoBtnRef}
          onClose={() => setInfoOpen(false)}
          tokens={c}
        />
      )}

      <OnboardingRoadmapModal />
    </>
  );
};

interface StepCardProps {
  step: ReturnType<typeof findStepById> & {};
  tokens: ReturnType<typeof useClaudeTokens>;
  cursorIconRef: React.MutableRefObject<HTMLSpanElement | null>;
  infoBtnRef: React.MutableRefObject<HTMLButtonElement | null>;
  onShowMe: () => void;
  onOpenRoadmap: () => void;
  onToggleInfo: () => void;
  running: boolean;
}

const StepCardBody: React.FC<StepCardProps> = ({
  step,
  tokens: c,
  cursorIconRef,
  infoBtnRef,
  onShowMe,
  onOpenRoadmap,
  onToggleInfo,
  running,
}) => {
  if (!step) return null;
  return (
    <Box sx={{ px: 1.6, pt: 1.2, pb: 1.6 }}>
      <Typography
        sx={{
          fontSize: 16,
          fontWeight: 600,
          color: c.text.primary,
          mb: 0.4,
          fontFamily: '"Charter", Georgia, serif',
        }}
      >
        {step.title}
      </Typography>
      <Typography
        sx={{
          fontSize: 12.5,
          color: c.text.secondary,
          mb: 1.4,
          lineHeight: 1.4,
        }}
      >
        {step.description}
      </Typography>

      <Box
        sx={{
          position: 'relative',
          borderRadius: `${c.radius.md}px`,
          overflow: 'hidden',
          aspectRatio: '16 / 9',
          mb: 1.5,
          background: `linear-gradient(135deg, ${c.accent.primary}22, ${c.accent.primary}08)`,
          border: `1px solid ${c.border.subtle}`,
        }}
      >
        {step.videoSrc && (
          <Box
            component="video"
            src={step.videoSrc}
            autoPlay
            muted
            loop
            playsInline
            onError={(e: React.SyntheticEvent<HTMLVideoElement>) => {
              (e.currentTarget as HTMLVideoElement).style.display = 'none';
            }}
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        )}
        {step.videoDurationLabel && (
          <Box
            sx={{
              position: 'absolute',
              top: 8,
              left: 8,
              bgcolor: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: 10.5,
              fontWeight: 600,
              px: 0.8,
              py: 0.2,
              borderRadius: 999,
              backdropFilter: 'blur(2px)',
            }}
          >
            {step.videoDurationLabel} - Demo
          </Box>
        )}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.4,
        }}
      >
        <Button
          onClick={onShowMe}
          disabled={running}
          sx={{
            textTransform: 'none',
            bgcolor: c.accent.primary,
            color: '#fff',
            fontWeight: 600,
            fontSize: 13,
            px: 1.4,
            py: 0.55,
            borderRadius: `${c.radius.md}px`,
            boxShadow: `0 4px 12px ${c.accent.primary}40`,
            '&:hover': { bgcolor: c.accent.hover ?? c.accent.primary },
            '&.Mui-disabled': { opacity: 0.6, color: '#fff' },
            display: 'flex',
            alignItems: 'center',
            gap: 0.7,
          }}
        >
          Show me
          <Box
            component="span"
            ref={cursorIconRef}
            data-onboarding="show-me-cursor-icon"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CursorIconSmall color="#fff" />
          </Box>
        </Button>
        <ButtonBase
          onClick={onOpenRoadmap}
          sx={{
            // mlAuto: pushes the help icon (next sibling) to the far
            // right while keeping "See all todos" tucked next to Show
            // me. Visual rhythm: [Show me]  See all todos ............ ?
            fontSize: 12.5,
            fontWeight: 500,
            color: c.text.secondary,
            '&:hover': { color: c.text.primary },
          }}
        >
          See all todos
        </ButtonBase>
        <IconButton
          size="small"
          ref={infoBtnRef}
          onClick={onToggleInfo}
          sx={{
            color: c.text.tertiary,
            p: 0.4,
            ml: 'auto',
            '&:hover': { color: c.text.secondary },
          }}
          aria-label="More info"
        >
          <HelpOutlineIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    </Box>
  );
};

interface CelebrationProps {
  step: NonNullable<ReturnType<typeof findStepById>>;
  accent: string;
}

const CelebrationView: React.FC<CelebrationProps> = ({ step, accent }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Self-clearing timer: lives with the component instance and
  // dispatches clearJustCompleted on mount. Because this component
  // ONLY mounts when justCompletedStepId is set and unmounts when
  // it's cleared, the timer fires exactly once per celebration.
  // Cannot be cancelled by parent re-renders.
  useEffect(() => {
    const t = window.setTimeout(() => {
      dispatch(clearJustCompleted());
    }, CELEBRATION_MS);
    return () => window.clearTimeout(t);
    // Empty deps = fires once on mount, cleans up on unmount. The
    // dispatch ref is stable per redux store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Box sx={{ px: 1.6, pt: 1.6, pb: 1.6 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.8 }}>
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 240, damping: 16 }}
          style={{ display: 'flex' }}
        >
          <CheckCircleIcon sx={{ fontSize: 22, color: accent }} />
        </motion.div>
        <Typography
          sx={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: accent,
            textTransform: 'uppercase',
          }}
        >
          Done
        </Typography>
      </Box>
      <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <Typography
          sx={{
            fontSize: 16,
            fontWeight: 600,
            color: c.text.primary,
            fontFamily: '"Charter", Georgia, serif',
            position: 'relative',
            display: 'inline-block',
          }}
        >
          {step.title}
          <motion.span
            initial={{ width: 0 }}
            animate={{ width: '100%' }}
            transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
            style={{
              position: 'absolute',
              left: 0,
              top: '52%',
              height: 2,
              background: accent,
              transformOrigin: 'left center',
            }}
          />
        </Typography>
      </Box>
      <Typography
        sx={{
          mt: 1,
          fontSize: 12,
          color: c.text.muted,
          lineHeight: 1.4,
        }}
      >
        Loading next step…
      </Typography>
    </Box>
  );
};

const AllDoneView: React.FC<{ accent: string; tokens: ReturnType<typeof useClaudeTokens> }> = ({
  accent,
  tokens: c,
}) => (
  <Box sx={{ px: 1.6, pt: 2, pb: 2, textAlign: 'center' }}>
    <motion.div
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 14 }}
      style={{ display: 'inline-flex', justifyContent: 'center' }}
    >
      <CheckCircleIcon sx={{ fontSize: 40, color: accent }} />
    </motion.div>
    <Typography
      sx={{
        mt: 1.2,
        fontSize: 16,
        fontWeight: 600,
        color: c.text.primary,
        fontFamily: '"Charter", Georgia, serif',
      }}
    >
      You're all set up
    </Typography>
    <Typography sx={{ mt: 0.4, fontSize: 12.5, color: c.text.secondary }}>
      You've finished the OpenSwarm tour. You can re-run it anytime from Settings → General.
    </Typography>
  </Box>
);

interface InfoPopoverProps {
  stepId: string;
  anchorRef: React.MutableRefObject<HTMLButtonElement | null>;
  onClose: () => void;
  tokens: ReturnType<typeof useClaudeTokens>;
}

const InfoPopover: React.FC<InfoPopoverProps> = ({ stepId, anchorRef, onClose, tokens: c }) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const calc = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const POPOVER_W = 280;
      const POPOVER_H = 240;
      // Anchor below-and-to-the-left of the info button so the popover
      // sits to the LEFT of the panel — matches figma image #66.
      const top = Math.min(r.bottom + 8, window.innerHeight - POPOVER_H - 8);
      const left = Math.max(8, r.right - POPOVER_W);
      setPos({ top, left });
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, [anchorRef]);

  // Click-away listener.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      // If click landed inside the popover, leave it open.
      const pop = document.getElementById('onboarding-info-popover');
      if (pop?.contains(t)) return;
      onClose();
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [anchorRef, onClose]);

  if (!pos) return null;
  const text = INFO_BY_STEP_ID[stepId] ?? 'More information coming soon.';
  return (
    <motion.div
      id="onboarding-info-popover"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 1250,
        width: 280,
      }}
    >
      <Box
        sx={{
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.md}px`,
          boxShadow: '0 14px 40px rgba(0,0,0,0.18)',
          p: 1.6,
          fontFamily: c.font.sans,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.8 }}>
          <HelpOutlineIcon sx={{ fontSize: 14, color: c.text.muted }} />
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 700,
              color: c.text.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            More info
          </Typography>
        </Box>
        <Typography
          sx={{
            fontSize: 11.8,
            color: c.text.secondary,
            lineHeight: 1.55,
            whiteSpace: 'pre-line',
          }}
        >
          {text}
        </Typography>
      </Box>
    </motion.div>
  );
};

const INFO_BY_STEP_ID: Record<string, string> = {
  connect_model: `Open Swarm works with any AI model.

If you already have a subscription to ChatGPT, Claude, or Gemini, plug it directly into Open Swarm.

We also offer an Open Swarm subscription that gives you the same usage as those providers.

Or use your own API keys.`,
  enable_actions: `Actions are the capabilities available to your AI agents.

Every tool an agent uses (reading a file, sending an email, searching the web) is an action.

Every action has a permission policy. It decides whether an agent can use it on its own or whether it needs your approval first.

The Actions page is where you turn integrations on, sign in, and tune those permissions.`,
  launch_agent: `An agent in Open Swarm can do anything you can do on your computer.

It can read and write files, run commands, search the web, control a browser, send emails, manage your calendar, and handle long, multi step tasks on its own.

Think of each agent as a teammate you can brief on a task and let loose, while you watch it work in real time.`,
  use_browser: `Open Swarm has built in browsers so you never have to jump between apps. One place, one workspace, for you and your agents.

The browsers aren't just for you. Your agents can use them too. By default an agent can spin up and use its own browser whenever it needs one.

In the next step we'll see how to hand off a browser you're using to an agent.`,
  agent_use_browser: `This shows how to give an agent control of a browser already on your canvas. Agents can also spin up their own browsers whenever they need one.

In this demo you handed off a single browser, but you can also hand off multiple browsers at once.

Under the hood, each browser is run by its own specialized agent that talks back to the agent you handed it to.`,
  agent_control_agents: `Just like browsers, you can pick which agents work together. Or an agent can spin up its own helpers whenever it needs to.

When a task gets too big for one agent, it spins up sub agents to share the load.

When a sub agent finishes, it collapses back into its parent. You can always reopen it from the parent chat by clicking "Reveal in dashboard".`,
  install_skill: `An agent on its own is a strong general purpose reasoner. It can do a lot, but it doesn't know the specifics of your workflows, your output formats, or your domain.

Skills fill that gap.

A skill is a set of instructions that teach an agent how to handle a specific kind of task. When a skill is active, the agent follows its guidance and produces better, more consistent results in that area.`,
  make_app: `Apps are interactive, AI generated web applications that live inside OpenSwarm.

Instead of paying for software or spending weeks building a UI, you describe what you want and an agent writes it for you. A live, runnable app appears in seconds.

Once it's made, you can pop the App into your canvas alongside agents and browsers.`,
};

export default OnboardingPanel;
