import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Hammer, PenLine, GraduationCap, ArrowLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useAppSelector } from '@/shared/hooks';
import {
  hasModelConnected,
  hasFreeTrialActive,
} from '@/app/components/Onboarding/steps/skipPredicates';

// The static self-intro the welcome types out (no LLM); the user answers in the chat.
const INTRO = "Hi, I'm your AI team. What do you want done?";

// One-shot typewriter for a fixed string. enabled=false shows it instantly (returning
// users); enabled=true reveals it char-by-char once. No infinite loop: it stops at the end.
function useTypewriter(text: string, enabled: boolean, speedMs = 34): { shown: string; done: boolean } {
  const [shown, setShown] = React.useState(enabled ? '' : text);
  React.useEffect(() => {
    if (!enabled) { setShown(text); return; }
    setShown('');
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, speedMs);
    return () => window.clearInterval(id);
  }, [text, enabled, speedMs]);
  return { shown, done: shown.length >= text.length };
}

// Two-level starters: pick a category, then its concrete prompts spawn. Every
// prompt is one-click-runnable (no [placeholders]) and free-trial-safe, it
// touches the web or the App Builder sandbox, never the user's files.
// target 'app-builder' opens the App Builder (live preview) with the prompt
// auto-sent; the rest run as a normal agent on the dashboard.
type StarterCategory = { id: string; label: string; Icon: LucideIcon; prompts: string[]; target?: 'app-builder' };
const STARTER_CATEGORIES: StarterCategory[] = [
  {
    id: 'research', label: 'Research', Icon: Search,
    prompts: [
      'Find today\'s top news and summarize it for me',
      'Compare the 3 best standing desks and recommend one',
      'Plan a weekend trip to Tokyo with a day-by-day itinerary',
      'Find the strangest world record I could actually break',
    ],
  },
  {
    id: 'build', label: 'Build', Icon: Hammer, target: 'app-builder',
    prompts: [
      'Build a focus timer that dings when the break starts',
      'Make a tip calculator that splits the bill',
      'Create a Snake game I can play right now',
      'Build a tiny Minecraft-style block world I can walk around in',
    ],
  },
  {
    id: 'write', label: 'Write', Icon: PenLine,
    prompts: [
      'Write a friendly email introducing myself to a new client',
      'Turn my rough notes into a polished update',
      'Write a product description for a coffee mug',
      'Write my morning routine as an epic fantasy quest',
    ],
  },
  {
    id: 'learn', label: 'Learn', Icon: GraduationCap,
    prompts: [
      'Explain how AI chatbots actually work, in plain English',
      'Teach me the basics of investing in 5 minutes',
      'Explain the stock market like I\'m five',
      'What would happen if the moon disappeared tomorrow?',
    ],
  },
];

const DashboardEmptyState: React.FC<{
  c: ClaudeTokens;
  onLaunch?: (prompt: string, mode: string, model: string) => void;
  // Open the composer with the prompt typed in (translucent, unsent) on click.
  // Optional mode opens it in a specific mode (Build -> 'view-builder').
  onStarter?: (prompt: string, mode?: string) => void;
}> = ({ c, onLaunch, onStarter }) => {
  const model = useAppSelector((s) => s.settings.data.default_model);
  const mode = useAppSelector((s) => s.settings.data.default_mode);
  const canRun = useAppSelector((s) => hasFreeTrialActive(s) || hasModelConnected(s));
  // Type the intro only for a fresh user (first agent not launched yet); returning
  // users see it instantly so it isn't re-typed on every empty dashboard.
  const introTyping = useAppSelector(
    (s) => !(s.onboardingProgress?.completedSteps ?? []).includes('launch_agent'),
  );
  const { shown: introShown, done: introDone } = useTypewriter(INTRO, introTyping);
  const [launching, setLaunching] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const currentCategory = STARTER_CATEGORIES.find((cat) => cat.id === expanded);
  const currentPrompts = currentCategory?.prompts ?? [];

  // Only offer chips once a run can actually succeed (free trial armed or a real
  // model connected); otherwise fall back to the plain hint.
  const showChips = !!onLaunch && canRun;

  const isAppBuilder = currentCategory?.target === 'app-builder';

  const launch = (prompt: string) => {
    if (launching) return;
    // App Builder opens its own surface, so prefill its composer (the user reviews,
    // then builds). Everything else fires immediately: a pick is one tap to a running agent.
    if (isAppBuilder) {
      if (onStarter) onStarter(prompt, 'view-builder');
      return;
    }
    if (onLaunch) {
      setLaunching(true); // empty state unmounts on first session, but guard a fast double-click
      onLaunch(prompt, mode, model);
      return;
    }
    if (onStarter) onStarter(prompt);
  };

  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <style>{`@keyframes welcome-caret { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }`}</style>
      {/* The welcome pops in (scale + fade), then the intro types itself out. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 460, damping: 26 }}
        style={{ display: 'flex', justifyContent: 'center' }}
      >
        <Typography
          sx={{
            color: c.text.secondary, fontSize: '1.45rem', fontWeight: 500, mb: 2.4,
            minHeight: '1.9rem', textAlign: 'center',
          }}
        >
          {introShown}
          {!introDone && (
            <Box component="span" sx={{ ml: '1px', color: c.accent.primary, animation: 'welcome-caret 1s step-end infinite' }}>
              ▌
            </Box>
          )}
        </Typography>
      </motion.div>

      {showChips && introDone ? (
        // Chips reveal only after the intro finishes typing, so it reads as one beat.
        <Box sx={{ width: '100%', maxWidth: 560, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <AnimatePresence mode="wait" initial={false}>
            {expanded === null ? (
              <motion.div
                key="categories"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22 }}
                style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
              >
                <Typography sx={{ color: c.text.ghost, fontSize: '0.9rem', mb: 1.4 }}>
                  pick one, or just tell me below
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.2, width: '100%', maxWidth: 460 }}>
                  {STARTER_CATEGORIES.map((cat) => (
                    <Box
                      component="button"
                      key={cat.id}
                      onClick={() => setExpanded(cat.id)}
                      sx={{
                        display: 'flex', alignItems: 'center', gap: 1.1,
                        px: 1.9, py: 1.3,
                        borderRadius: 2.5,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.secondary,
                        fontSize: '0.98rem', fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit',
                        transition: 'background 150ms, border-color 150ms',
                        '&:hover': { background: c.bg.elevated, borderColor: c.border.strong },
                      }}
                    >
                      <cat.Icon size={18} />
                      {cat.label}
                    </Box>
                  ))}
                </Box>
              </motion.div>
            ) : (
              <motion.div
                key="specifics"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
              >
                <Box
                  component="button"
                  onClick={() => setExpanded(null)}
                  sx={{
                    display: 'inline-flex', alignItems: 'center', gap: 0.5,
                    mb: 1.2, px: 1, py: 0.4,
                    border: 'none', background: 'transparent',
                    color: c.text.ghost, fontSize: '0.9rem',
                    cursor: 'pointer', fontFamily: 'inherit',
                    '&:hover': { color: c.text.secondary },
                  }}
                >
                  <ArrowLeft size={15} /> back
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.9, width: '100%', maxWidth: 480 }}>
                  {currentPrompts.map((prompt) => (
                    <Box
                      component="button"
                      key={prompt}
                      onClick={() => launch(prompt)}
                      disabled={launching}
                      sx={{
                        textAlign: 'left',
                        px: 1.8, py: 1.1,
                        borderRadius: 2,
                        border: `1px solid ${c.border.medium}`,
                        background: c.bg.surface,
                        color: c.text.secondary,
                        fontSize: '0.95rem',
                        cursor: launching ? 'default' : 'pointer',
                        opacity: launching ? 0.5 : 1,
                        fontFamily: 'inherit',
                        transition: 'background 150ms, border-color 150ms',
                        '&:hover': launching ? {} : { background: c.bg.elevated, borderColor: c.border.strong },
                      }}
                    >
                      {prompt}
                    </Box>
                  ))}
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
        </Box>
      ) : (
        introDone && (
          <Typography sx={{ color: c.text.ghost, fontSize: '0.95rem' }}>
            Connect a model in Settings to get started.
          </Typography>
        )
      )}
    </Box>
  );
};

export default DashboardEmptyState;
