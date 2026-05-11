// Type a string into a target input or contentEditable element one character
// at a time, dispatching events that React's reconciler observes so the
// product's controlled input state stays in sync.
//
// React intercepts native value setters on <input>/<textarea> via a
// prototype-level descriptor, then dispatches 'input' events to its own
// synthetic event system. To make a fake change visible to React, we
// have to invoke the native setter via the prototype descriptor and then
// dispatch a real 'input' event. Setting `el.value = ...` directly is
// silently ignored by React's onChange.

const INPUT_PROTO_VALUE_DESC =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )
    : undefined;

const TEXTAREA_PROTO_VALUE_DESC =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )
    : undefined;

function nativeSetValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLInputElement && INPUT_PROTO_VALUE_DESC?.set) {
    INPUT_PROTO_VALUE_DESC.set.call(el, value);
  } else if (
    el instanceof HTMLTextAreaElement &&
    TEXTAREA_PROTO_VALUE_DESC?.set
  ) {
    TEXTAREA_PROTO_VALUE_DESC.set.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
}

function dispatchInput(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// contentEditable fields (the agent chat input is one) need a different
// path. Setting textContent doesn't fire any of the events React's
// onInput handler listens for, AND it nukes any rich-content children
// (skill pills, etc). document.execCommand('insertText') is the
// idiomatic way to programmatically type into a contentEditable — it
// fires the same `input` events a real keystroke would.
function insertContentEditableText(el: HTMLElement, ch: string): void {
  el.focus();
  // Place caret at end so insertion appends rather than overwrites.
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // execCommand is deprecated but still the only cross-browser way to
  // get React-friendly synthetic input events into a contentEditable.
  // Falls back to direct text-node append if execCommand is rejected
  // (some embedded webviews disable it).
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, ch);
  } catch {
    ok = false;
  }
  if (!ok) {
    el.appendChild(document.createTextNode(ch));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
  }
}

export interface TypeIntoOptions {
  speedMs?: number;
  // Optional callback fired after each character — lets the cursor
  // re-align to the input's right edge as text grows.
  onTick?: () => void;
}

function readEffectiveText(el: HTMLElement): string {
  if (el.isContentEditable) return (el.textContent ?? '').trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (el.value ?? '').trim();
  }
  return (el.textContent ?? '').trim();
}

export async function typeInto(
  el: HTMLElement,
  text: string,
  opts: TypeIntoOptions = {},
): Promise<void> {
  // Default char-cadence — faster than the original 40ms (which felt
  // like watching molasses for long URLs). 18ms is still slow enough to
  // read live but doesn't make typing the main bottleneck of the step.
  const speed = opts.speedMs ?? 18;
  el.focus();

  // Branch on element kind. contentEditable (the agent ChatInput uses
  // a contentEditable div for skill-pill support) requires execCommand;
  // <input>/<textarea> require the React-prototype-setter dance.
  if (el.isContentEditable) {
    for (const ch of text) {
      insertContentEditableText(el, ch);
      opts.onTick?.();
      await new Promise((r) => window.setTimeout(r, speed));
    }
  } else {
    let acc = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      acc = el.value ?? '';
    }
    for (const ch of text) {
      acc += ch;
      nativeSetValue(el, acc);
      dispatchInput(el);
      opts.onTick?.();
      await new Promise((r) => window.setTimeout(r, speed));
    }
  }

  // Post-type verification. Under heavy main-thread load (many agents
  // streaming concurrently), execCommand('insertText') can silently
  // no-op while React's reconciler is starved — AC "types" but the
  // characters never land in the controlled input. Without this check,
  // step 8 (App Builder) would "complete" with an empty draft and the
  // user would see no app get built.
  //
  // After typing, give React up to 500ms to commit, then re-read the
  // effective text. If it's missing most of what we typed, fall back
  // to a single-shot insert that's much more reliable under load.
  const target = text.trim();
  if (!target) return;
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => window.setTimeout(r, 100));
    const got = readEffectiveText(el);
    if (got.length >= Math.floor(target.length * 0.8)) return;
  }

  // Fallback: nuke contents and insert the full string in one shot.
  // Loses the typing animation but preserves the user-visible outcome.
  try {
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      try {
        document.execCommand('delete', false);
      } catch {
        /* fall through */
      }
      try {
        const ok = document.execCommand('insertText', false, text);
        if (!ok) {
          el.textContent = text;
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: text,
              inputType: 'insertText',
            }),
          );
        }
      } catch {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement
    ) {
      nativeSetValue(el, text);
      dispatchInput(el);
    }
  } catch {
    /* best-effort — runtime's wait_user will time out and recover */
  }
}
