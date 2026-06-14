"""Tests for the .swarm bundle engine: skill round-trip, secret redaction, and
the zip-hardening rejections. The skills store writes to ~/.claude/skills, so we
monkeypatch it into a temp dir per test (the conftest only isolates browser
state)."""
import io
import json
import os
import zipfile

import pytest

from backend.apps.skills import skills as store
from backend.apps.swarm import closure
from backend.apps.swarm.models import EntityType
from backend.apps.swarm.redact import find_denied_keys, scrub_payload
from backend.apps.swarm.ziputil import BundleError, pack, unpack


@pytest.fixture
def skill_store(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setattr(store, "SKILLS_DIR", str(d))
    monkeypatch.setattr(store, "INDEX_PATH", str(d / ".skills_index.json"))
    return d


def _make_skill(d, slug, name, content, description="desc"):
    (d / f"{slug}.md").write_text(content, encoding="utf-8")
    index = store._load_index()
    index[slug] = {"name": name, "description": description, "command": slug}
    store._save_index(index)


def test_skill_export_import_round_trip(skill_store):
    _make_skill(skill_store, "my-skill", "My Skill", "# hello\nbody text")
    raw, name = closure.build_bundle(EntityType.skill, "my-skill")
    assert name == "My Skill"
    assert zipfile.is_zipfile(io.BytesIO(raw))

    sandbox, manifest, warnings = closure.stage_upload(raw, "My Skill.swarm")
    try:
        assert manifest.root.type == EntityType.skill
        root_type, root_id, created, unresolved = closure.commit(sandbox, manifest, [])
    finally:
        import shutil
        shutil.rmtree(sandbox, ignore_errors=True)

    # Original is untouched, import lands under a fresh, non-clobbering slug.
    assert root_type == EntityType.skill
    assert root_id != "my-skill"
    assert (skill_store / "my-skill.md").exists()
    assert (skill_store / f"{root_id}.md").read_text(encoding="utf-8") == "# hello\nbody text"
    assert created == {"skill": [root_id]}


def test_bare_markdown_import(skill_store):
    sandbox, manifest, warnings = closure.stage_upload(b"# Just markdown", "Cool Trick.md")
    try:
        assert manifest.root.type == EntityType.skill
        assert manifest.root.name == "Cool Trick"
        _t, root_id, created, _u = closure.commit(sandbox, manifest, [])
    finally:
        import shutil
        shutil.rmtree(sandbox, ignore_errors=True)
    assert (skill_store / f"{root_id}.md").read_text(encoding="utf-8") == "# Just markdown"


def test_content_secret_redacted_in_bundle(skill_store):
    secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"
    _make_skill(skill_store, "leaky", "Leaky", f"use this key: {secret}")
    raw, _name = closure.build_bundle(EntityType.skill, "leaky")
    # Inspect the actual packed payload (zip entries are compressed, so grepping
    # the raw bytes proves nothing).
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        payload_name = next(n for n in zf.namelist() if n.endswith("payload.json"))
        payload = json.loads(zf.read(payload_name))
    assert secret not in payload["content"]
    assert "[redacted]" in payload["content"]


def test_redaction_drops_denied_keys():
    payload = {
        "name": "ok",
        "anthropic_api_key": "sk-ant-secret",
        "nested": {"openswarm_bearer_token": "abc", "keep": 1},
        "list": [{"oauth_tokens": {"x": 1}}, {"fine": 2}],
    }
    cleaned = scrub_payload(payload)
    assert find_denied_keys(cleaned) == []
    assert cleaned["name"] == "ok"
    assert cleaned["nested"]["keep"] == 1
    assert cleaned["list"][1]["fine"] == 2


def test_pack_refuses_denied_key():
    # Defense in depth: even if redaction were skipped, pack must not ship a secret.
    with pytest.raises(BundleError):
        pack({"format_version": 1}, {"bid1": {"api_key": "leak"}}, {})


def _zip_with(name, data=b"x"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(name, data)
    return buf.getvalue()


def test_zip_slip_rejected():
    with pytest.raises(BundleError):
        unpack(_zip_with("../escape.txt"))


def test_absolute_path_rejected():
    with pytest.raises(BundleError):
        unpack(_zip_with("/etc/evil"))


def test_too_many_entries_rejected():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i in range(5001):
            zf.writestr(f"f{i}.txt", b"x")
    with pytest.raises(BundleError):
        unpack(buf.getvalue())


def test_newer_format_version_rejected(skill_store):
    # A bundle from a future OpenSwarm should fail clearly, not half-import.
    buf = io.BytesIO()
    manifest = {
        "format_version": 999,
        "bundle_id": "b",
        "root": {"type": "skill", "bundle_id": "x", "name": "n", "path": "entities/x"},
        "entities": [{"type": "skill", "bundle_id": "x", "name": "n", "path": "entities/x"}],
        "preview": {"root_type": "skill", "root_name": "n"},
    }
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("entities/x/payload.json", json.dumps({"slug": "n", "name": "n", "content": "c"}))
    with pytest.raises(BundleError):
        closure.stage_upload(buf.getvalue(), "x.swarm")
