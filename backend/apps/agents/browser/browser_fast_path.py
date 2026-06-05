"""
Browser fast path: skip the orchestrator for plainly browser-only requests.

The orchestrator LLM is ~2/3 of the token bill on a single-browser task and
adds two model turns of latency, all to decide "delegate this to a browser
agent" and then restate the agent's own outcome. When the request is clearly
just browsing, dispatch the browser sub-agent directly and let its OUTCOME
line be the reply.

Three gates, all conservative; any miss falls through to the orchestrator:
1. eligibility: first message of an agent session on a dashboard, no
   attachments/images/skills/forced tools (those need the orchestrator).
2. a zero-cost wordlist prefilter, so non-browsy chats never pay the
   classifier's latency.
3. a cheap-tier aux YES/NO classifier (provider-agnostic, timeboxed); only
   an unambiguous YES takes the fast path.
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

# Zero-cost smell test: only prompts that mention the web at all are worth a
# classifier call. False negatives just take the normal path.
_BROWSY_RE = re.compile(
    r"https?://|www\.|\b[a-z0-9-]+\.(com|org|net|io|co|ai|dev|app)\b"
    r"|\b(browse|browser|website|web ?page|webpage|site|url|tab)\b"
    r"|\b(go to|open|visit|navigate|log ?in|sign ?in|search on|look up on|check on)\b"
    r"|\b(linkedin|twitter|x\.com|facebook|instagram|reddit|youtube|amazon|gmail|github"
    r"|google|wikipedia|hacker ?news|tiktok|tinder|slack|notion|ebay|etsy|zillow|airbnb)\b",
    re.I,
)

_CLASSIFIER_SYSTEM = (
    "You route requests to a web-browsing agent. It drives a real signed-in browser: "
    "navigating sites, reading or extracting or counting what is on pages, clicking, "
    "typing, and acting inside web apps (sending messages on LinkedIn or any site, "
    "posting, ordering, booking, filling forms).\n"
    "When a website or web app is the context, 'text/message/DM someone' means "
    "sending the message inside that site, which is browsing. Treat 'text' as SMS "
    "only when a phone number is given or no site is involved.\n"
    "Line 1 of your reply is exactly one word: READ, ACT, or NO.\n"
    "READ: the request only needs information from a PUBLIC page, no sign-in, no "
    "account-specific data ('my' anything), and nothing on the page changes.\n"
    "ACT: browsing completes it but it involves signing in, account data, "
    "changing state (sending, posting, filling, booking, buying, opening the "
    "user's own messages/feed), or the user wants a page left open on their "
    "screen as the goal ('open X', 'pull up X', 'show me X'). When torn "
    "between READ and ACT, say ACT.\n"
    "NO: any part clearly needs something a browser cannot do: local files or "
    "folders, writing or running code, a terminal, creating documents or "
    "spreadsheets, SMS to a phone number, or other desktop apps. Also NO for "
    "plain conversation or questions answerable without visiting any site.\n"
    "Examples:\n"
    "'go to maya's linkedin and text her thanks' -> ACT\n"
    "'open hacker news and tell me the top story' -> READ (the answer is the "
    "goal, not the open page)\n"
    "'search wikipedia for tardigrades and open the article' -> ACT\n"
    "'count the messages in my linkedin thread with bob' -> ACT\n"
    "'find the report on stripe.com and save it to my desktop' -> NO\n"
    "'text 555-0102 that I'm late' -> NO\n"
    "If line 1 is NO, reply with exactly the word NO and nothing else.\n"
    "If line 1 is READ or ACT, follow it with a short browsing brief:\n"
    "ENTRY: the best starting URL; use a direct deep/search URL when the site's "
    "pattern is well known (LinkedIn people search is "
    "https://www.linkedin.com/search/results/people/?keywords=NAME).\n"
    "Then 3-6 numbered steps, one short action each.\n"
    "Copy any text the user wants typed, sent, or posted EXACTLY, character for "
    "character. Never invent names, values, or wording the user did not give."
)


def fast_path_eligible(
    prompt: str,
    mode: str,
    dashboard_id: str | None,
    is_first_message: bool,
    has_attachments: bool,
) -> bool:
    """Pure gate: cheap, no I/O. Follow-ups are excluded because the sub-agent
    only receives the prompt text; the orchestrator carries the history a
    follow-up usually leans on."""
    if mode != "agent" or not dashboard_id or not is_first_message or has_attachments:
        return False
    if not prompt or not prompt.strip():
        return False
    return bool(_BROWSY_RE.search(prompt))


def _parse_verdict_and_brief(text: str) -> tuple[str, str]:
    """Line 1 carries READ/ACT/NO; the rest is the routing brief. Anything
    unparseable is 'no' (normal path)."""
    lines = (text or "").strip().splitlines()
    head = lines[0].strip().upper() if lines else ""
    if head.startswith("READ"):
        verdict = "read"
    elif head.startswith("ACT") or head.startswith("YES"):
        verdict = "act"
    else:
        return "no", ""
    brief = "\n".join(line for line in lines[1:] if line.strip()).strip()
    return verdict, brief[:700]


def compose_task(prompt: str, brief: str) -> str:
    """User's words first and authoritative; the brief is advisory routing.
    Skill replay keys on the parent's user message, so brief variance is safe."""
    if not brief:
        return prompt
    return (
        f"{prompt}\n\n"
        "[routing brief from a fast pre-pass; follow it unless the live page disagrees]\n"
        f"{brief}"
    )


def dispatch_failed(summary: str) -> bool:
    """Fail-closed: only an explicit DONE line or a skill replay counts as
    success; framework failures ('I was not able to complete this task (the
    browser became unresponsive...)') carry no OUTCOME line at all, and the
    recovery task's verify-first wording makes a rare redundant retry safe."""
    s = (summary or "").strip()
    return not ("OUTCOME: DONE" in s.upper() or "learned skill replay" in s)


NO_DASHBOARD_REPLY = (
    "I can't drive a browser right now because no OpenSwarm window is connected. "
    "Open the app window and send this again."
)


def recovery_task(prompt: str, first_report: str) -> str:
    """One informed retry, replacing the orchestrator's recovery role. Verify-
    first wording keeps a maybe-already-sent irreversible step from repeating."""
    report = (first_report or "").strip()[:600] or "no report (the browser died)"
    return (
        "A previous browser attempt at this task did not finish. It reported:\n"
        f"{report}\n\n"
        f"Finish the task: {prompt}\n\n"
        "If that attempt may have already performed an irreversible step "
        "(send/submit/post/pay), FIRST verify on the page whether it happened; "
        "if it did, do NOT repeat it, report DONE with that proof."
    )


def _normalize_for_classifier(prompt: str) -> str:
    """Haiku reads bare 'text him' as SMS even with a site as context. In the
    browsy-prefiltered pool, text-with-no-phone-number is in-site messaging,
    so spell it out for the small model. Only the classifier sees this."""
    if re.search(r"\d{7,}", prompt):
        return prompt
    return re.sub(r"\btext(ing|ed|s)?\b", "message", prompt, flags=re.I)


async def classify_and_brief(prompt: str, settings, primary_api: str | None) -> tuple[str, str]:
    """One cheap aux call returns a READ/ACT/NO verdict plus a routing brief
    (entry URL + step outline), timeboxed; any failure means NO (normal path)."""
    try:
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model

        aux_model, _ = await resolve_aux_model(
            settings, preferred_tier="haiku", primary_api=primary_api,
        )
        client = get_anthropic_client_for_model(settings, aux_model)
        resp = await asyncio.wait_for(
            client.messages.create(
                model=aux_model,
                max_tokens=250,
                temperature=0,
                system=_CLASSIFIER_SYSTEM,
                messages=[{"role": "user", "content": _normalize_for_classifier(prompt[:2000])}],
            ),
            timeout=8.0,
        )
        from backend.apps.agents.core.aux_llm import _safe_resp_text
        verdict, brief = _parse_verdict_and_brief(_safe_resp_text(resp))
        logger.info(f"[browser-fast-path] classifier: {verdict.upper()} brief={len(brief)}ch")
        return verdict, brief
    except Exception as e:
        logger.warning(f"[browser-fast-path] classifier unavailable, normal path: {e}")
        return "no", ""
