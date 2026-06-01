import { useEffect, useRef, useState } from 'react';

/**
 * Smoothly reveals streamed text at a steady cadence instead of painting bursty
 * network chunks as they land. Decouples DISPLAY rate from ARRIVAL rate the way
 * claude.ai does, so generated text reads like it's being typed rather than
 * dumped in clumps.
 *
 * Why the old "reveal backlog/4, floor 3 chars/frame" version felt like
 * "pump pump pump": that floor (~180 chars/sec) is FASTER than a model
 * generates (~90 chars/sec), so the display kept sprinting to catch up, then
 * FROZE waiting for the next token. Freeze-sprint-freeze at token frequency is
 * the choppiness.
 *
 * This version is a buffered constant-velocity controller:
 *   - It deliberately stays ~TARGET_LAG seconds BEHIND the latest text, so there
 *     is always a buffer to reveal and it never runs dry between tokens.
 *   - Reveal is TIME-based (chars = rate * elapsed), so it's frame-rate
 *     independent and survives a dropped frame without a visible jump.
 *   - The reveal RATE is EMA-smoothed, so a burst ramps the speed up gently and
 *     a lull ramps it down gently; the rate never steps, so the flow never pulses.
 * The rAF loop runs only while there's a backlog and parks at zero cost once
 * caught up. Zero added TTFT: the first characters still reveal in-render on the
 * very first frame content exists.
 */

const TARGET_LAG_S = 0.35;   // stay this far behind = the buffer that prevents stalls
const RATE_SMOOTH_S = 0.25;  // how fast the reveal speed eases toward its target
const MAX_CPS = 1000;        // cap so a huge paste/burst still reveals smoothly, not instantly
const MAX_DT_S = 0.05;       // clamp elapsed after a frame drop / tab switch so we don't leap

export function useSmoothText(target: string, enabled: boolean): string {
  const [shownLen, setShownLen] = useState(enabled ? 0 : target.length);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  // Controller state lives in refs so the rAF loop reads the latest without the
  // effect re-subscribing every character.
  const posRef = useRef<number>(enabled ? 0 : target.length); // float reveal position
  const cpsRef = useRef<number>(0);                            // current reveal speed
  const lastRef = useRef<number>(0);                           // last frame timestamp
  const shownRef = useRef<number>(shownLen);
  shownRef.current = shownLen;

  // ONE persistent loop, keyed only on `enabled`. It must NOT restart per token:
  // an effect that depends on target.length tears the rAF down and rebuilds it on
  // every delta, and that churn is what stalls the reveal. So the loop runs every
  // frame for the life of the stream, reads the latest text from a ref, and just
  // advances by 0 when it happens to be caught up (cheap, no stall, no parking).
  useEffect(() => {
    if (!enabled) {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      posRef.current = targetRef.current.length;
      setShownLen(targetRef.current.length);
      return;
    }

    const tick = (now: number) => {
      const full = targetRef.current.length;
      const dtRaw = lastRef.current ? (now - lastRef.current) / 1000 : 0.016;
      lastRef.current = now;
      const dt = dtRaw > MAX_DT_S ? MAX_DT_S : dtRaw;

      const backlog = Math.max(0, full - posRef.current);
      const desired = backlog / TARGET_LAG_S;            // speed that holds the lag steady (0 when caught up)
      const k = Math.min(1, dt / RATE_SMOOTH_S);
      let cps = cpsRef.current + (desired - cpsRef.current) * k; // EMA-smooth the speed itself, both up and down
      if (cps > MAX_CPS) cps = MAX_CPS;
      if (cps < 0) cps = 0;
      cpsRef.current = cps;

      if (backlog > 0) {
        posRef.current = Math.min(full, posRef.current + cps * dt);
        const nextLen = Math.floor(posRef.current);
        if (nextLen !== shownRef.current) setShownLen(nextLen);
      }
      rafRef.current = requestAnimationFrame(tick); // keep running for the whole stream
    };

    lastRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [enabled]);

  // Target shrank (new turn / reset / branch switch): re-sync so we don't slice
  // past the end of a shorter string and so a fresh turn starts from zero.
  useEffect(() => {
    if (posRef.current > target.length) {
      posRef.current = enabled ? 0 : target.length;
      cpsRef.current = 0;
      lastRef.current = 0;
      setShownLen(enabled ? 0 : target.length);
    }
  }, [target.length, enabled]);

  // ZERO added TTFT: on the very first frame content exists, reveal a few chars
  // in-render instead of waiting a frame for the first rAF tick.
  if (!enabled) return target;
  const effectiveShown = (shownLen === 0 && target.length > 0)
    ? Math.min(3, target.length)
    : shownLen;
  return target.slice(0, effectiveShown);
}
