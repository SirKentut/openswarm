"""Free-trial dispatch injection: the pure-logic pieces that decide routing."""

import backend  # noqa: F401  (path sanity asserted below)

import pytest

from backend.apps.settings.models import AppSettings
from backend.apps.settings.credentials import proxy_auth
from backend.apps.agents.core.error_classify import (
    _is_free_trial_exhausted,
    _is_transient_capacity_error,
)
from backend.apps.agents.providers.registry import resolve_model_id_for_sdk
from backend.apps.subscription import free_trial as ft
from backend.apps.subscription.free_trial import _has_own_model, arm_free_trial, clear_free_trial


def test_proxy_auth_for_each_mode():
    assert proxy_auth(AppSettings()) == (None, None)

    pro = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bear",
        openswarm_proxy_url="https://api.openswarm.com",
    )
    assert proxy_auth(pro) == ("bear", "https://api.openswarm.com")

    free = AppSettings(
        connection_mode="free-trial",
        free_trial_token="ftk",
        openswarm_proxy_url="https://api.openswarm.com",
    )
    # Free-trial carries the /free segment so the same SDK lands on the metered route.
    assert proxy_auth(free) == ("ftk", "https://api.openswarm.com/free")


def test_free_trial_resolves_to_a_bare_anthropic_id():
    s = AppSettings(connection_mode="free-trial", free_trial_token="ftk")
    mid = resolve_model_id_for_sdk("sonnet", s)
    # The bug this fixes: without the free-trial branch this returns a cc/-prefixed
    # id that 401s when no Claude subscription is connected.
    assert "cc/" not in mid
    assert mid.startswith("claude-")


def test_exhaustion_is_classified_and_not_retried():
    assert _is_free_trial_exhausted(Exception("error type free_trial_exhausted"))
    assert _is_free_trial_exhausted(Exception("You've used your free OpenSwarm runs"))
    assert not _is_free_trial_exhausted(Exception("overloaded, try again"))
    # Must NOT look transient, or the agent loop would retry a spent trial forever.
    assert not _is_transient_capacity_error(Exception("free_trial_exhausted"))


def test_has_own_model_never_shadows_a_real_provider():
    assert not _has_own_model(AppSettings(connection_mode="free-trial", free_trial_token="x"))
    assert not _has_own_model(AppSettings())
    assert _has_own_model(AppSettings(anthropic_api_key="sk-ant-x"))
    assert _has_own_model(
        AppSettings(connection_mode="openswarm-pro", openswarm_bearer_token="b")
    )


@pytest.mark.asyncio
async def test_arm_waits_for_9router_before_shadowing_a_background_started_sub(monkeypatch):
    """The regression: 9Router starts in the background, so at first-boot mint time
    a real Claude sub is invisible. arm() must bring 9Router up (so the sub becomes
    visible) BEFORE deciding, instead of arming the free trial over it."""
    saved: list = []
    monkeypatch.setattr(ft, "save_settings_async", _record(saved))
    monkeypatch.setattr(ft, "_sync_routing", _noop)

    started = {"called": False}

    async def fake_ensure_running():
        started["called"] = True  # 9Router comes up here; the sub is now visible

    # The sub is only reachable AFTER ensure_running ran (mirrors the real race).
    async def sub_visible_after_start():
        return started["called"]

    import backend.apps.nine_router as nr
    monkeypatch.setattr(nr, "ensure_running", fake_ensure_running)
    monkeypatch.setattr(ft, "_has_connected_subscription", sub_visible_after_start)

    s = AppSettings()  # no key, own_key mode: a subscription-only user
    out = await arm_free_trial(s)

    assert started["called"], "arm must start 9Router before trusting the sub check"
    assert out["armed"] is False and out["reason"] == "has_model"
    assert s.connection_mode == "own_key"
    assert s.default_model != "haiku"


@pytest.mark.asyncio
async def test_clear_reverts_forced_haiku_so_it_doesnt_outlive_the_trial(monkeypatch):
    monkeypatch.setattr(ft, "save_settings_async", _noop)
    monkeypatch.setattr(ft, "_sync_routing", _noop)

    s = AppSettings(connection_mode="free-trial", free_trial_token="ftk", default_model="haiku")
    await clear_free_trial(s)
    assert s.connection_mode == "own_key"
    assert s.default_model == "sonnet"  # forced free-run pick handed back, not left on Haiku
    assert s.free_trial_token is None

    # A user who deliberately picked haiku OUTSIDE free-trial mode is left alone.
    s2 = AppSettings(connection_mode="own_key", default_model="haiku")
    await clear_free_trial(s2)
    assert s2.default_model == "haiku"


async def _noop(*_a, **_k):
    return None


def _record(bucket):
    async def _inner(obj, *_a, **_k):
        bucket.append(obj)
    return _inner
