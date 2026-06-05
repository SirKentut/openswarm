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
    ok, brief = _parse_verdict_and_brief("YES\nENTRY: https://news.ycombinator.com\n1. read top story")
    assert ok and brief.startswith("ENTRY:") and "top story" in brief
    assert _parse_verdict_and_brief("yes") == (True, "")
    assert _parse_verdict_and_brief("NO") == (False, "")
    assert _parse_verdict_and_brief("Maybe\nENTRY: x") == (False, "")
    assert _parse_verdict_and_brief("") == (False, "")
    long_brief = "YES\n" + "x" * 2000
    assert len(_parse_verdict_and_brief(long_brief)[1]) == 700


def test_compose_task_keeps_user_words_first():
    assert compose_task("go to hn", "") == "go to hn"
    composed = compose_task("go to hn", "ENTRY: https://news.ycombinator.com")
    assert composed.startswith("go to hn\n\n[routing brief")
    assert composed.endswith("ENTRY: https://news.ycombinator.com")


def test_dispatch_failure_detection():
    assert dispatch_failed("")
    assert dispatch_failed("Error: browser card was deleted")
    assert dispatch_failed("Could not find the thread. OUTCOME: NOT DONE - login wall")
    assert not dispatch_failed("Sent it. OUTCOME: DONE - bubble visible at 12:05 PM")


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
