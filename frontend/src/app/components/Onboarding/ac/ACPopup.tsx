import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCursorPosition } from './cursorStore';

interface Props {
  text: string;
  /** Offset from cursor tip in px when there's room. */
  offset?: { x: number; y: number };
}

const SAFE_PAD = 8;
// Slight bump to APPROX_W to match the larger font — keeps line-wrap
// behavior similar to before. The runtime measures the real rect via
// ref so this is just an initial-mount estimate.
const APPROX_W = 320;
const APPROX_H = 70;
// Distance from the bubble edge to the rounded corner radius — the
// tail's anchor x is clamped between TAIL_PAD and (w - TAIL_PAD) so
// the tail never juts past the corner.
const TAIL_PAD = 16;

// Pokémon-dialog cadence — letters pop in steadily, punctuation gets
// a small extra pause so sentences "land" instead of slurring together.
// Slowed 50% (was 20ms/char) so the popup reads at a more deliberate
// pace, matching the AC cursor's calmer motion.
const STREAM_MS_PER_CHAR = 30;
const STREAM_PUNCT_EXTRA_MS = 210; // after . , ! ? ; : (also +50%)
const STREAM_MIN_CHARS = 5;

/**
 * Tiny popup that follows the cursor. Non-blocking — no CTA.
 *
 * Streams text character-by-character like an RPG dialog box (modulo
 * very short strings, which appear instantly to avoid visual jank on
 * single-word popups).
 *
 * Positioning: vertical-only — the bubble sits DIRECTLY ABOVE the
 * cursor (centered horizontally on the cursor's actual x), with the
 * tail pointing down at the target icon. Flips to BELOW the cursor
 * only when there isn't room above. This places the popup "over" the
 * thing it's referring to instead of beside it, so adjacent siblings
 * (toolbar [+ grid globe history note], chat-input [cursor-circle clip
 * mic], etc.) are never covered by the bubble's body.
 *
 * The tail anchors at the cursor's actual x relative to the bubble's
 * (possibly clamped) left edge, so it still points at the icon even
 * when the bubble is shifted by the viewport-edge clamp.
 */
const ACPopup: React.FC<Props> = ({ text, offset = { x: 0, y: 14 } }) => {
  const c = useClaudeTokens();
  const { x, y, visible } = useCursorPosition();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    x: number;
    y: number;
    tailLeft: number;
    flipY: boolean;
  }>({
    x: x - APPROX_W / 2,
    y: y - APPROX_H - offset.y,
    tailLeft: APPROX_W / 2,
    flipY: true,
  });

  // Streaming text state — grows from 0 to text.length char-by-char.
  // Use chained setTimeout (not setInterval) so we can vary the delay
  // per character — punctuation gets an extra beat, mimicking the
  // pacing of Pokémon-style dialog boxes where sentences "land."
  const [streamCount, setStreamCount] = useState<number>(
    text.length < STREAM_MIN_CHARS ? text.length : 0,
  );
  useEffect(() => {
    if (text.length < STREAM_MIN_CHARS) {
      setStreamCount(text.length);
      return;
    }
    setStreamCount(0);
    let i = 0;
    let timer: number | null = null;
    const tick = () => {
      i += 1;
      setStreamCount(i);
      if (i >= text.length) {
        timer = null;
        return;
      }
      // Look at the char we *just* revealed — if it's punctuation,
      // wait an extra beat before the next one. Mirrors Pokémon's
      // "..." and end-of-sentence pacing.
      const justShown = text[i - 1];
      const isPunct = /[.,!?;:]/.test(justShown);
      const delay = STREAM_MS_PER_CHAR + (isPunct ? STREAM_PUNCT_EXTRA_MS : 0);
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, STREAM_MS_PER_CHAR);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [text]);

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? APPROX_W;
    const h = el?.offsetHeight ?? APPROX_H;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: bubble centered on cursor's x, sitting above the cursor.
    // Flip below only when there isn't room above.
    let nx = x - w / 2;
    let ny = y - h - offset.y;
    let flipY = true;
    if (ny < SAFE_PAD) {
      ny = y + offset.y;
      flipY = false;
    }

    // Horizontal clamp — keep the bubble on-screen. The tail's anchor x
    // is computed AFTER clamping so the tail always points at the
    // cursor's actual position even when the bubble has been shoved
    // inward by the viewport edge.
    const nxClamped = Math.max(SAFE_PAD, Math.min(nx, vw - w - SAFE_PAD));
    const nyClamped = Math.max(SAFE_PAD, Math.min(ny, vh - h - SAFE_PAD));
    const tailRaw = x - nxClamped;
    const tailLeft = Math.max(TAIL_PAD, Math.min(tailRaw, w - TAIL_PAD));

    setPos({ x: nxClamped, y: nyClamped, tailLeft, flipY });
  }, [x, y, offset.y, text, streamCount]);

  if (!visible) return null;

  const displayText = text.slice(0, streamCount);
  // Reserve full width with invisible char to prevent the bubble from
  // jiggling as letters arrive — invisible character keeps wrap consistent.
  const isStreaming = streamCount < text.length;

  return (
    <motion.div
      key="ac-popup"
      ref={ref}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{
        opacity: 1,
        scale: 1,
        x: pos.x,
        y: pos.y,
      }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{
        // Slowed 50% from {0.14, stiffness 320, damping 32} — gives the
        // bubble a more deliberate arrival, in sync with the cursor's
        // gentler spring.
        opacity: { duration: 0.21 },
        scale: { duration: 0.21 },
        x: { type: 'spring', stiffness: 160, damping: 22 },
        y: { type: 'spring', stiffness: 160, damping: 22 },
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 10501,
        pointerEvents: 'none',
      }}
    >
      <Box
        sx={{
          position: 'relative',
          maxWidth: 320,
          minWidth: 110,
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.accent.primary}`,
          borderRadius: '14px',
          boxShadow: `0 14px 36px rgba(0,0,0,0.32), 0 0 16px ${c.accent.primary}33`,
          px: 1.6,
          py: 1.0,
          fontFamily: c.font.sans,
        }}
      >
        {/* Tail pointing back at the cursor. Centered on the cursor's
            actual x (via tailLeft) so the diamond's point lands on the
            target icon, regardless of whether the bubble itself was
            shifted by the viewport clamp. */}
        <Box
          sx={{
            position: 'absolute',
            width: 10,
            height: 10,
            bgcolor: c.bg.surface,
            border: `1px solid ${c.accent.primary}`,
            transform: 'rotate(45deg)',
            top: pos.flipY ? 'auto' : -5,
            bottom: pos.flipY ? -5 : 'auto',
            left: pos.tailLeft - 5,
            // flipY=true → bubble is above cursor, tail at bubble's
            // bottom edge → bottom-right corner borders visible so the
            // diamond points down at the cursor.
            // flipY=false → bubble is below cursor, tail at top edge →
            // top-left corner borders visible, diamond points up.
            borderRight: pos.flipY ? `1px solid ${c.accent.primary}` : 'none',
            borderBottom: pos.flipY ? `1px solid ${c.accent.primary}` : 'none',
            borderTop: pos.flipY ? 'none' : `1px solid ${c.accent.primary}`,
            borderLeft: pos.flipY ? 'none' : `1px solid ${c.accent.primary}`,
          }}
        />
        <Typography
          sx={{
            // Sized to feel like a Pokémon dialog — small but firm.
            // 0.85rem reads cleanly without dominating the screen,
            // and pairs with the bolder weight to stay legible.
            fontSize: '0.85rem',
            color: c.text.primary,
            fontWeight: 600,
            lineHeight: 1.4,
            whiteSpace: 'pre-line',
            position: 'relative',
          }}
        >
          {displayText}
          {isStreaming && (
            <Box
              component="span"
              sx={{
                opacity: 0,
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {text.slice(streamCount)}
            </Box>
          )}
        </Typography>
      </Box>
    </motion.div>
  );
};

export default ACPopup;
