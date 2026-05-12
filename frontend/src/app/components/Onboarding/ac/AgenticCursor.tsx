import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, useAnimationControls, AnimatePresence } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { cursorStore } from './cursorStore';
import { resolveSelector } from '../selectors';
import ACPopup from './ACPopup';
import ACMultiChoice from './ACMultiChoice';
import type { ACMultiChoiceOption } from '../steps/types';

export interface AgenticCursorHandle {
  fadeIn: (from: { x: number; y: number }) => Promise<void>;
  fadeOut: (to: { x: number; y: number }) => Promise<void>;
  /**
   * Animated jump to (x, y). Defaults to the spring used for normal hops;
   * pass an override (e.g. a tween) when the cursor needs to ride alongside
   * a CSS-transitioned visual like the drag-select rect, where spring
   * overshoot would visibly desync from the rect's bottom-right corner.
   */
  moveTo: (
    x: number,
    y: number,
    transition?: Record<string, unknown>,
  ) => Promise<void>;
  pressClick: () => Promise<void>;
  /**
   * Lock the cursor to a live data-onboarding selector. After this is
   * called the cursor re-resolves the selector and re-reads its rect on
   * every animation frame, pinning itself (and any attached popup) to
   * the element's current center. Survives reflows, scrolls, sidebar
   * collapses, and React node swaps (uninstalled-card → installed-card,
   * etc.) — the cursor follows the live target instead of stranding
   * itself at the rect we read at the time of move_to.
   *
   * Pass an offset to override the default (center-of-rect). Calling
   * startTracking again replaces any prior tracker; the next op that
   * physically moves the cursor (move_to / click / type_into /
   * drag_select / outro) calls stopTracking automatically.
   */
  startTracking: (selector: string, offset?: { x: number; y: number }) => void;
  stopTracking: () => void;
  /**
   * Show a non-blocking popup above the cursor. Returns immediately;
   * the popup stays visible until hidePopup() is called or another
   * showPopup replaces it. The runtime calls hidePopup() before any op
   * that physically moves the cursor or types, so the popup naturally
   * disappears when the cursor's "instruction" no longer applies.
   *
   * Placement is fixed: bubble centered on the cursor's x, sitting
   * directly above the cursor (auto-flips below if no room above).
   * See ACPopup for the full positioning logic.
   */
  showPopup: (text: string) => void;
  /**
   * Single-select multi-choice. Resolves with the chosen option id; the
   * panel that calls this can route the rest of the flow accordingly.
   */
  showMultiChoice: (q: string, opts: ACMultiChoiceOption[]) => Promise<string>;
  hidePopup: () => void;
  getPosition: () => { x: number; y: number };
}

interface PopupState {
  text: string;
}

interface MultiChoiceState {
  question: string;
  options: ACMultiChoiceOption[];
  resolve: (id: string) => void;
}

// Snappy spring — back to the tight 260/26 from before the 50%
// slowdown. The "calm" feel of the AC now comes from the popup's
// slower typewriter cadence + the 3s dwell floor; the cursor itself
// stays responsive so bubble-less moves (move_to → click, move_to →
// type_into, the canvas-controls tour) don't feel sluggish.
const SPRING = { type: 'spring' as const, stiffness: 260, damping: 26 };

const AgenticCursor = forwardRef<AgenticCursorHandle>((_props, ref) => {
  const c = useClaudeTokens();
  const controls = useAnimationControls();
  const posRef = useRef({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [multiChoice, setMultiChoice] = useState<MultiChoiceState | null>(null);

  // Active sticky-tracker handle. Set by startTracking, cleared by
  // stopTracking. Survives renders via ref so the rAF loop can be
  // cancelled cleanly even if the component re-renders mid-flight.
  const trackerRef = useRef<{ stop: () => void } | null>(null);

  // Mirror the cursor's logical position into the cursorStore so popups
  // can follow without re-running through Framer's animation pipeline.
  const writePos = (x: number, y: number, vis = true) => {
    posRef.current = { x, y };
    cursorStore.set({ x, y, visible: vis });
  };

  // Stop any sticky tracker. Idempotent.
  const stopTrackingInternal = () => {
    if (trackerRef.current) {
      trackerRef.current.stop();
      trackerRef.current = null;
    }
  };

  // Defensive: if the AC unmounts mid-flow (Director.detach, panel
  // hidden), the rAF callback would otherwise keep firing and pinning a
  // dead component's `controls` to the live target every frame. The
  // unmount cleanup cancels it.
  useEffect(() => {
    return () => stopTrackingInternal();
  }, []);

  useImperativeHandle(ref, () => ({
    async fadeIn(from) {
      stopTrackingInternal();
      writePos(from.x, from.y, true);
      controls.set({ x: from.x, y: from.y, opacity: 0, scale: 0.5 });
      setVisible(true);
      await controls.start({
        opacity: 1,
        scale: 1,
        transition: { duration: 0.32, ease: 'easeOut' },
      });
    },
    async moveTo(x, y, transition) {
      // moveTo is for animated jumps to a fixed coord. Stop any prior
      // tracker first so it doesn't keep snapping the cursor back to its
      // old anchor mid-animation. The runtime calls startTracking after
      // the await resolves, re-pinning to the live target.
      stopTrackingInternal();
      await controls.start({
        x,
        y,
        transition: transition ?? SPRING,
      });
      writePos(x, y, true);
    },
    async fadeOut(to) {
      stopTrackingInternal();
      await controls.start({ x: to.x, y: to.y, transition: SPRING });
      writePos(to.x, to.y, true);
      await controls.start({
        opacity: 0,
        scale: 0.5,
        transition: { duration: 0.28, ease: 'easeIn' },
      });
      cursorStore.set({ visible: false });
      setVisible(false);
    },
    async pressClick() {
      await controls.start({ scale: 0.78, transition: { duration: 0.08 } });
      await controls.start({ scale: 1, transition: { duration: 0.14 } });
    },
    startTracking(selector, offset) {
      stopTrackingInternal();
      const offX = offset?.x ?? 0;
      const offY = offset?.y ?? 0;
      let cancelled = false;
      let rafId = 0;
      // Cache the resolved node by reference. Re-querying every frame
      // would make the cursor flicker between transient duplicate matches
      // when React re-renders (e.g. Reddit Card hover state, Switch
      // animation, install-toggle transition). Holding the node stable
      // means the cursor follows the SAME element through reflows; we
      // only re-query when the cached node leaves the document.
      let cachedEl: HTMLElement | null = resolveSelector(selector);
      let lastX = posRef.current.x;
      let lastY = posRef.current.y;
      // Lost-target tracking. If the cached element disconnects (user
      // navigates away, collapses the section, etc) and we can't re-find
      // it for >LOST_TIMEOUT_MS, fire the lost-target event so the
      // runtime can outro gracefully and offer a recovery hint.
      let lostSinceMs: number | null = null;
      const LOST_TIMEOUT_MS = 2500;
      const EPSILON = 0.5;
      // Drop frames where the resolved rect would teleport the cursor by
      // more than this. Real reflows move elements a few px per frame;
      // 600px instantly is a sign of a stale/transient rect mid-commit.
      const MAX_JUMP_PX = 600;
      // Title-bar drag region (38px in AppShell). Pinning the cursor
      // there lands it on the macOS traffic lights / Electron drag-area
      // — never an intentional onboarding target. Skip those frames.
      const TITLE_BAR_BOTTOM = 38;
      // Throttle the rAF tracker to ~30fps. The browser fires rAF at the
      // monitor refresh (60-144Hz typically), and re-querying rects +
      // applying transforms every single frame is wasted work for what
      // is fundamentally a "follow this rect" loop. 30fps still feels
      // glued because the visible jitter threshold for static UI is
      // higher than for animated UI. Halves rAF callback cost during
      // pinned ops.
      let lastTickAt = 0;
      const TICK_INTERVAL_MS = 33; // ~30fps
      const tick = () => {
        if (cancelled) return;
        const now = performance.now();
        if (now - lastTickAt < TICK_INTERVAL_MS) {
          rafId = requestAnimationFrame(tick);
          return;
        }
        lastTickAt = now;

        if (!cachedEl || !cachedEl.isConnected) {
          cachedEl = resolveSelector(selector);
          if (!cachedEl) {
            // Element vanished. Start (or continue) the lost-target
            // countdown — once we exceed the timeout, signal the
            // runtime to abort.
            const now = Date.now();
            if (lostSinceMs === null) lostSinceMs = now;
            if (now - lostSinceMs > LOST_TIMEOUT_MS) {
              cancelled = true;
              cancelAnimationFrame(rafId);
              // Custom event the runtime listens for. Decoupled from
              // controls/Promise machinery so we can fire from inside
              // a rAF tick without races.
              window.dispatchEvent(
                new CustomEvent('openswarm:onboarding:lost_target', {
                  detail: { selector },
                }),
              );
              return;
            }
          } else {
            // Re-acquired — clear the countdown.
            lostSinceMs = null;
          }
        } else {
          lostSinceMs = null;
        }

        if (cachedEl) {
          const r = cachedEl.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            const cx = r.left + r.width / 2 + offX;
            const cy = r.top + r.height / 2 + offY;
            // Viewport guards: skip frames where pinning would land the
            // cursor outside the visible window OR inside the title-bar
            // drag region. These don't help the user — they're symptoms
            // of a stale read or a hidden/overflowed target — and the
            // next legitimate frame will pin correctly.
            const offWindow =
              cx < 0 ||
              cy < 0 ||
              cx > window.innerWidth ||
              cy > window.innerHeight;
            const inTitleBar = cy < TITLE_BAR_BOTTOM;
            if (!offWindow && !inTitleBar) {
              const dx = Math.abs(cx - lastX);
              const dy = Math.abs(cy - lastY);
              const teleport = dx > MAX_JUMP_PX || dy > MAX_JUMP_PX;
              if (!teleport && (dx > EPSILON || dy > EPSILON)) {
                controls.set({ x: cx, y: cy });
                writePos(cx, cy, true);
                lastX = cx;
                lastY = cy;
              }
            }
          }
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
      trackerRef.current = {
        stop: () => {
          cancelled = true;
          cancelAnimationFrame(rafId);
        },
      };
    },
    stopTracking() {
      stopTrackingInternal();
    },
    showPopup(text) {
      // Non-blocking — replaces any existing popup. Caller advances the
      // flow; popup auto-clears on the next op that physically moves the
      // cursor (move_to / click / type_into / drag_select / outro).
      setPopup({ text });
    },
    showMultiChoice(question, options) {
      return new Promise<string>((resolve) => {
        setMultiChoice({
          question,
          options,
          resolve: (id) => {
            setMultiChoice(null);
            resolve(id);
          },
        });
      });
    },
    hidePopup() {
      setPopup(null);
      if (multiChoice) {
        // Defensive — multi_choice is supposed to resolve via user pick,
        // but if the runtime aborts mid-question we don't want a dangling
        // promise. Resolve with '' so callers can detect dismissal.
        multiChoice.resolve('');
        setMultiChoice(null);
      }
    },
    getPosition() {
      return { ...posRef.current };
    },
  }));

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* Cursor body — animated by Framer Motion. pointer-events:none so it
          never blocks user interaction with the underlying app. */}
      <motion.div
        animate={controls}
        onUpdate={(latest) => {
          const x = typeof latest.x === 'number' ? latest.x : posRef.current.x;
          const y = typeof latest.y === 'number' ? latest.y : posRef.current.y;
          // Avoid React re-renders on every frame; just push to the external
          // store so popups (which subscribe via useSyncExternalStore) follow.
          if (visible) cursorStore.set({ x, y });
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 10500,
          pointerEvents: 'none',
          // Translate origin: top-left of viewport. The animated x/y is the
          // cursor tip's logical position.
          transformOrigin: 'top left',
          // Visual offset so the arrow's "tip" sits at (x,y) — the SVG below
          // is drawn from its top-left, so shift it slightly up-and-left to
          // align the pointer.
        }}
      >
        {visible && (
          <motion.div
            animate={{
              // Subtle idle pulse — closer to a soft heartbeat than a
              // bouncing scale. Stays out of the way visually.
              scale: [1, 1.04, 1],
            }}
            transition={{
              duration: 1.8,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
            style={{
              transform: 'translate(-2px, -2px)',
              // Two-layer glow: tight inner ring + softer outer halo.
              // Tuned so the cursor reads clearly against light AND dark
              // canvases without being distracting.
              filter: `drop-shadow(0 0 6px ${c.accent.primary}cc) drop-shadow(0 0 14px ${c.accent.primary}55)`,
            }}
          >
            <CursorArrow color={c.accent.primary} />
          </motion.div>
        )}
      </motion.div>

      {/* Popups portaled separately so their pointer-events:auto isn't
          inherited from the cursor wrapper's pointer-events:none. They
          subscribe to cursorStore to track the live position. */}
      <AnimatePresence>
        {popup && <ACPopup key="popup" text={popup.text} />}
        {multiChoice && (
          <ACMultiChoice
            key="multi-choice"
            question={multiChoice.question}
            options={multiChoice.options}
            onAnswer={multiChoice.resolve}
          />
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
});

AgenticCursor.displayName = 'AgenticCursor';
export default AgenticCursor;

// Standard arrow cursor shape — 22x22, drawn pointing down-right.
const CursorArrow: React.FC<{ color: string }> = ({ color }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 22 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden
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
