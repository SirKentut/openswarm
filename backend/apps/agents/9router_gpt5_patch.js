// Node-runtime patch loaded via `node --require <this>` before 9router boots.
//
// Why this exists
// ---------------
// OpenAI's GPT-5 family (gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.3-codex, …)
// rejects the legacy `max_tokens` parameter with HTTP 400, requiring
// `max_completion_tokens`. 9router (every released version, including 0.4.20)
// blindly forwards `max_tokens` in its Anthropic→OpenAI translator. We can't
// fix 9router from outside (env vars are ignored, baseUrl on the openai
// provider is hardcoded, prefix routing falls back). Instead we intercept
// the HTTPS write at the Node syscall layer — the actual boundary OpenAI
// sees — and rename the field on the way out.
//
// Safety contract
// ---------------
// • Scope: only requests whose hostname is `api.openai.com`. Every other
//   outbound HTTP/HTTPS call passes through unmodified.
// • Model gate: only requests whose body parses as JSON with
//   `model.startsWith("gpt-5")` (after stripping common prefixes 9router
//   adds). GPT-4 / Claude / etc. unaffected.
// • Failure mode: every step is wrapped in try/catch and falls back to the
//   unmodified original on any error. Worst case is "request behaves
//   exactly as it would without this patch" — never worse than baseline.
// • Idempotency: the patch self-flags so re-loading via multiple --require
//   doesn't double-wrap.
//
// Verification
// ------------
// Set OPENSWARM_DEBUG_GPT5_PATCH=1 in the env to log "[openswarm] 9router-
// gpt5-patch installed" on stderr and "rewrote max_tokens → max_completion_tokens"
// on each rewrite.

'use strict';

const _https = require('https');
const _http = require('http');

const TARGET_HOSTS = new Set(['api.openai.com']);
const DEBUG = process.env.OPENSWARM_DEBUG_GPT5_PATCH === '1';

function _log(msg) {
  if (DEBUG) {
    try { process.stderr.write('[openswarm-gpt5-patch] ' + msg + '\n'); } catch (_) { /* ignore */ }
  }
}

function isGpt5Model(model) {
  if (typeof model !== 'string') return false;
  let m = model.trim().toLowerCase();
  if (!m) return false;
  // Strip routing prefixes 9router may have added: cp-openai/, openai/,
  // cx/, openrouter/, or:openai/. Don't strip cp- (custom-provider) blindly
  // because cp-anything could match a non-OpenAI custom node.
  const prefixes = ['cp-openai/', 'openai/', 'cx/', 'openrouter/', 'or:openai/'];
  for (const p of prefixes) {
    if (m.startsWith(p)) { m = m.slice(p.length); break; }
  }
  return m.startsWith('gpt-5');
}

// Minimum completion-token budget for GPT-5 reasoning models.
// GPT-5 burns 8-30K tokens on internal reasoning BEFORE producing any
// user-visible output. The Anthropic CLI's default max_tokens (~4096) is
// way under that floor — OpenAI accepts the request, runs reasoning until
// it hits the cap, then returns "Could not finish the message because
// max_tokens or model output limit was reached" with zero user-visible
// content. Floor at 32K so reasoning has room AND the user gets an
// actual response. Cost is unaffected because OpenAI bills for
// tokens-consumed, not max_completion_tokens (which is just a cap).
//
// We use max(requestedValue, 32K) — never lower the user's value, only
// raise it. If the user explicitly sets a high value (e.g. 100K) we
// honor it untouched.
const GPT5_MIN_COMPLETION_TOKENS = 32768;

function maybeRewriteBody(bodyStr) {
  if (typeof bodyStr !== 'string' || bodyStr.length === 0) return bodyStr;
  let parsed;
  try { parsed = JSON.parse(bodyStr); } catch { return bodyStr; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyStr;
  if (!isGpt5Model(parsed.model)) return bodyStr;
  let mutated = false;
  // Both fields present (unlikely but possible): drop the legacy one so
  // OpenAI doesn't reject for "both specified".
  if ('max_tokens' in parsed && 'max_completion_tokens' in parsed) {
    delete parsed.max_tokens;
    mutated = true;
    _log('dropped redundant max_tokens for ' + parsed.model);
  } else if ('max_tokens' in parsed) {
    parsed.max_completion_tokens = parsed.max_tokens;
    delete parsed.max_tokens;
    mutated = true;
    _log('rewrote max_tokens → max_completion_tokens for ' + parsed.model);
  }
  // Floor max_completion_tokens at 32K for reasoning headroom. Only raise,
  // never lower — if the user explicitly set 100K, keep 100K.
  if (typeof parsed.max_completion_tokens === 'number' && parsed.max_completion_tokens < GPT5_MIN_COMPLETION_TOKENS) {
    const orig = parsed.max_completion_tokens;
    parsed.max_completion_tokens = GPT5_MIN_COMPLETION_TOKENS;
    mutated = true;
    _log('raised max_completion_tokens ' + orig + ' → ' + GPT5_MIN_COMPLETION_TOKENS + ' for ' + parsed.model + ' (reasoning headroom)');
  }
  return mutated ? JSON.stringify(parsed) : bodyStr;
}

function _hostFromOpts(opts) {
  if (!opts) return '';
  const raw = opts.hostname || opts.host || '';
  return String(raw).replace(/:\d+$/, '').toLowerCase();
}

function patchHttpRequest(orig) {
  return function patchedRequest() {
    const args = Array.prototype.slice.call(arguments);
    // First arg may be a URL string, URL object, or options object.
    let opts = args[0];
    let host = '';
    try {
      if (typeof opts === 'string') host = new URL(opts).hostname.toLowerCase();
      else if (opts instanceof URL) host = opts.hostname.toLowerCase();
      else host = _hostFromOpts(opts);
    } catch (_) { host = ''; }

    if (!TARGET_HOSTS.has(host)) {
      return orig.apply(this, args);
    }

    // Outbound request to OpenAI: intercept body. The Anthropic SDK and
    // 9router both call .write(body) then .end(), or .end(body) directly.
    let req;
    try { req = orig.apply(this, args); } catch (e) { throw e; }
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);
    const chunks = [];
    let isStringMode = null; // null until first chunk; then true=string, false=buffer

    function recordChunk(chunk) {
      if (chunk == null) return;
      if (typeof chunk === 'string') {
        if (isStringMode === false) {
          // Mixed mode — fall back: convert prior buffers to string
          for (let i = 0; i < chunks.length; i++) chunks[i] = chunks[i].toString('utf8');
        }
        isStringMode = true;
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        if (isStringMode === true) {
          // Mixed: convert prior strings to buffers
          for (let i = 0; i < chunks.length; i++) chunks[i] = Buffer.from(chunks[i], 'utf8');
        }
        isStringMode = false;
        chunks.push(chunk);
      } else {
        // Unknown shape — abandon interception
        throw new Error('unknown-chunk-shape');
      }
    }

    req.write = function patchedWrite(chunk) {
      const restArgs = Array.prototype.slice.call(arguments, 1);
      try {
        recordChunk(chunk);
        return true;
      } catch (_) {
        // Abandon interception — pass through immediately and disable buffering.
        // Flush anything we'd buffered so far.
        try {
          for (const c of chunks) origWrite(c);
          chunks.length = 0;
        } catch (_) { /* ignore */ }
        return origWrite.apply(req, [chunk].concat(restArgs));
      }
    };

    req.end = function patchedEnd(chunk) {
      const restArgs = Array.prototype.slice.call(arguments, 1);
      try {
        recordChunk(chunk);
        let bodyStr = '';
        if (isStringMode === true) bodyStr = chunks.join('');
        else if (isStringMode === false) bodyStr = Buffer.concat(chunks).toString('utf8');
        const rewritten = maybeRewriteBody(bodyStr);
        if (rewritten !== bodyStr) {
          const newBuf = Buffer.from(rewritten, 'utf8');
          try {
            if (req.getHeader && typeof req.getHeader === 'function' && req.getHeader('content-length')) {
              req.setHeader('Content-Length', newBuf.length);
            }
          } catch (_) { /* ignore */ }
          return origEnd.call(req, newBuf);
        }
        // No rewrite — send original body intact
        if (chunks.length === 0) return origEnd.apply(req, restArgs);
        if (isStringMode === true) return origEnd.call(req, chunks.join(''));
        return origEnd.call(req, Buffer.concat(chunks));
      } catch (_) {
        // Abandon — flush any buffered content + tail chunk
        try {
          for (const c of chunks) origWrite(c);
          chunks.length = 0;
        } catch (_) { /* ignore */ }
        if (chunk != null) return origEnd.apply(req, [chunk].concat(restArgs));
        return origEnd.apply(req, restArgs);
      }
    };

    return req;
  };
}

if (!_https.__openswarm_gpt5_patched) {
  try {
    _https.request = patchHttpRequest(_https.request);
    _http.request = patchHttpRequest(_http.request);
    _https.__openswarm_gpt5_patched = true;
    _http.__openswarm_gpt5_patched = true;
    _log('installed https.request + http.request interceptors');
  } catch (e) {
    // Patch failed — log and continue. 9router will work as normal,
    // GPT-5 calls will fail with the same 400 they did before. Never worse.
    _log('install failed: ' + (e && e.message ? e.message : String(e)));
  }
}

// Also patch global fetch (Node 18+). 9router uses fetch in some paths.
if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__openswarm_gpt5_patched) {
  try {
    const origFetch = globalThis.fetch;
    const patchedFetch = async function (input, init) {
      try {
        let url = '';
        if (typeof input === 'string') url = input;
        else if (input && typeof input === 'object') url = input.url || '';
        if (!url) return origFetch.call(this, input, init);
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return origFetch.call(this, input, init); }
        if (!TARGET_HOSTS.has(host)) return origFetch.call(this, input, init);
        if (init && typeof init.body === 'string') {
          const rewritten = maybeRewriteBody(init.body);
          if (rewritten !== init.body) {
            const newInit = Object.assign({}, init, { body: rewritten });
            const newLen = String(Buffer.byteLength(rewritten, 'utf8'));
            if (newInit.headers) {
              try {
                if (typeof Headers !== 'undefined' && newInit.headers instanceof Headers) {
                  if (newInit.headers.has('content-length')) newInit.headers.set('content-length', newLen);
                } else {
                  for (const k of Object.keys(newInit.headers)) {
                    if (k.toLowerCase() === 'content-length') newInit.headers[k] = newLen;
                  }
                }
              } catch (_) { /* ignore */ }
            }
            return origFetch.call(this, input, newInit);
          }
        }
        return origFetch.call(this, input, init);
      } catch (_) {
        return origFetch.call(this, input, init);
      }
    };
    patchedFetch.__openswarm_gpt5_patched = true;
    globalThis.fetch = patchedFetch;
    _log('installed fetch interceptor');
  } catch (e) {
    _log('fetch install failed: ' + (e && e.message ? e.message : String(e)));
  }
}
