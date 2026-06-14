import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { STARTER_CATEGORIES } from '@/shared/starterCategories';

// Quick-reply chips shown under the welcome greeting inside the first-run chat. Two-level:
// pick a category, then a concrete prompt. Research/Write/Learn -> onPick (runs the agent);
// Build -> onPickBuilder (opens App Builder). Pure UI; no run until the parent fires onPick.
const WelcomeQuickReplies: React.FC<{
  c: ClaudeTokens;
  onPick: (prompt: string) => void;
  onPickBuilder: (prompt: string) => void;
}> = ({ c, onPick, onPickBuilder }) => {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const currentCategory = STARTER_CATEGORIES.find((cat) => cat.id === expanded);
  const isAppBuilder = currentCategory?.target === 'app-builder';
  const currentPrompts = currentCategory?.prompts ?? [];

  const pick = (prompt: string) => {
    if (isAppBuilder) onPickBuilder(prompt);
    else onPick(prompt);
  };

  return (
    <Box sx={{ px: 1.5, pb: 1.5, pt: 0.5, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
      <AnimatePresence mode="wait" initial={false}>
        {expanded === null ? (
          <motion.div
            key="categories"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22 }}
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem', mb: 1 }}>
              pick one, or just type below
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              {STARTER_CATEGORIES.map((cat) => (
                <Box
                  component="button"
                  key={cat.id}
                  onClick={() => setExpanded(cat.id)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    px: 1.5, py: 1.05,
                    borderRadius: 2.2,
                    border: `1px solid ${c.border.medium}`,
                    background: c.bg.surface,
                    color: c.text.secondary,
                    fontSize: '0.9rem', fontWeight: 500,
                    cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'background 150ms, border-color 150ms',
                    '&:hover': { background: c.bg.elevated, borderColor: c.border.strong },
                  }}
                >
                  <cat.Icon size={16} />
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
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            <Box
              component="button"
              onClick={() => setExpanded(null)}
              sx={{
                display: 'inline-flex', alignItems: 'center', gap: 0.5,
                alignSelf: 'flex-start', mb: 0.9, px: 0.6, py: 0.3,
                border: 'none', background: 'transparent',
                color: c.text.ghost, fontSize: '0.85rem',
                cursor: 'pointer', fontFamily: 'inherit',
                '&:hover': { color: c.text.secondary },
              }}
            >
              <ArrowLeft size={14} /> back
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.7 }}>
              {currentPrompts.map((prompt) => (
                <Box
                  component="button"
                  key={prompt}
                  onClick={() => pick(prompt)}
                  sx={{
                    textAlign: 'left',
                    px: 1.4, py: 0.95,
                    borderRadius: 1.8,
                    border: `1px solid ${c.border.medium}`,
                    background: c.bg.surface,
                    color: c.text.secondary,
                    fontSize: '0.88rem',
                    cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'background 150ms, border-color 150ms',
                    '&:hover': { background: c.bg.elevated, borderColor: c.border.strong },
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
  );
};

export default WelcomeQuickReplies;
