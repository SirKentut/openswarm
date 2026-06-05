from backend.apps.agents.browser.browser_fast_path import (
    _normalize_for_classifier,
    _parse_verdict_and_brief,
    compose_task,
    dispatch_failed,
    fast_path_eligible,
    recovery_task,
)


def test_browsy_first_messages_are_eligible():
    for p in (
        "go to tyler chen's linkedin hes in entrepreneurs first and text him 'hi'",
        "open hacker news and tell me the top story",
        "look up on amazon how much a herman miller aeron costs",
        "check https://example.com/pricing and summarize the tiers",
    ):
        assert fast_path_eligible(p, "agent", "dash1", True, False), p


def test_non_browsy_or_gated_messages_fall_through():
    assert not fast_path_eligible("write me a poem about autumn", "agent", "dash1", True, False)
    assert not fast_path_eligible("fix the bug in agent_manager.py", "agent", "dash1", True, False)
    browsy = "open hacker news and tell me the top story"
    assert not fast_path_eligible(browsy, "chat", "dash1", True, False)
    assert not fast_path_eligible(browsy, "agent", None, True, False)
    assert not fast_path_eligible(browsy, "agent", "dash1", False, False)
    assert not fast_path_eligible(browsy, "agent", "dash1", True, True)
    assert not fast_path_eligible("", "agent", "dash1", True, False)


def test_verdict_parsing_is_strict():
    v, brief = _parse_verdict_and_brief("READ\nENTRY: https://news.ycombinator.com\n1. read top story")
    assert v == "read" and brief.startswith("ENTRY:") and "top story" in brief
    assert _parse_verdict_and_brief("ACT\nENTRY: https://x.com")[0] == "act"
    assert _parse_verdict_and_brief("yes") == ("act", "")
    assert _parse_verdict_and_brief("NO") == ("no", "")
    assert _parse_verdict_and_brief("Maybe\nENTRY: x") == ("no", "")
    assert _parse_verdict_and_brief("") == ("no", "")
    long_brief = "ACT\n" + "x" * 2000
    assert len(_parse_verdict_and_brief(long_brief)[1]) == 700


def test_fast_read_entry_extraction_and_thin_detection():
    from backend.apps.agents.browser.browser_fast_read import extract_entry_url, page_is_thin
    brief = "ENTRY: https://news.ycombinator.com/\n1. Load the page\n2. Read the top story"
    assert extract_entry_url(brief) == "https://news.ycombinator.com/"
    assert extract_entry_url("1. just steps, no entry") == ""
    assert extract_entry_url("entry: HTTPS://example.com/a).") == "HTTPS://example.com/a"
    assert page_is_thin("")
    assert page_is_thin("HTTP error 403 fetching https://x.com")
    assert page_is_thin("Refused to fetch http://169.254.169.254: private address")
    assert page_is_thin("Title\n\nshort body")
    assert not page_is_thin("Title\n\n" + "real content " * 60)


def test_compose_task_keeps_user_words_first():
    assert compose_task("go to hn", "") == "go to hn"
    composed = compose_task("go to hn", "ENTRY: https://news.ycombinator.com")
    assert composed.startswith("go to hn\n\n[routing brief")
    assert composed.endswith("ENTRY: https://news.ycombinator.com")


def test_dispatch_failure_detection_is_fail_closed():
    assert dispatch_failed("")
    assert dispatch_failed("Error: browser card was deleted")
    assert dispatch_failed("Could not find the thread. OUTCOME: NOT DONE - login wall")
    assert dispatch_failed(
        "I was not able to complete this task (the browser became unresponsive "
        "(the tab hung or was closed); it needs a fresh browser to continue)."
    )
    assert dispatch_failed("Found the page and clicked around a bit.")
    assert not dispatch_failed("Sent it. OUTCOME: DONE - bubble visible at 12:05 PM")
    assert not dispatch_failed("Completed via learned skill replay (3 steps, no LLM).")


def test_recovery_task_verifies_before_repeating():
    t = recovery_task("text bob 'hi' on linkedin", "OUTCOME: NOT DONE - hung before confirming send")
    assert "text bob 'hi' on linkedin" in t
    assert "hung before confirming" in t
    assert "do NOT repeat it" in t
    assert "no report (the browser died)" in recovery_task("go to hn", "")


def test_text_normalizes_to_message_without_phone_number():
    assert (
        _normalize_for_classifier("go to maya's linkedin and text her thanks")
        == "go to maya's linkedin and message her thanks"
    )
    assert _normalize_for_classifier("keep texting until he replies").startswith("keep message")
    sms = "text 4085551234 saying im running late"
    assert _normalize_for_classifier(sms) == sms
    count = "count messages containing the exact text r10-os"
    assert "message r10-os" in _normalize_for_classifier(count)


def test_dispatch_refused_instantly_when_no_dashboard_connected():
    import asyncio
    from backend.apps.agents.browser.browser_agent import run_browser_agents
    from backend.apps.agents.core.ws_manager import ws_manager

    assert not ws_manager.global_connections
    results = asyncio.run(run_browser_agents(tasks=[{"task": "go to example.com"}], model="sonnet"))
    assert len(results) == 1
    assert results[0]["summary"].startswith("Error: no dashboard window is connected")
    assert dispatch_failed(results[0]["summary"])
