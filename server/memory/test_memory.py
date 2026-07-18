"""Increment 8 — memory suggestions, approval workflow, conflicts, versions
(spec §6–9)."""

import uuid

import jwt
import pytest
from django.conf import settings as dj_settings
from rest_framework.test import APIClient


@pytest.fixture(autouse=True)
def jwt_secret(settings):
    settings.SUPABASE_JWT_SECRET = "test-secret-0123456789abcdef0123456789abcdef"


def bearer():
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "aud": "authenticated"},
        dj_settings.SUPABASE_JWT_SECRET,
        algorithm="HS256",
    )
    return f"Bearer {token}"


SEGMENTS = [
    {"sequence": 0, "start_ms": 0, "end_ms": 5000, "text": "The launch deadline is the end of September."},
    {"sequence": 1, "start_ms": 5000, "end_ms": 9000, "text": "Acme prefers weekly written status updates."},
]


@pytest.fixture
def ctx(db):
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=bearer())
    ws = c.post("/api/workspaces/", {"name": "W"}, format="json").data
    g = c.post("/api/groups/", {"workspace": ws["id"], "name": "Acme"}, format="json").data
    m = c.post("/api/meetings/", {"group": g["id"], "title": "Kickoff"}, format="json").data
    c.post(f"/api/meetings/{m['id']}/segments/", {"segments": SEGMENTS}, format="json")
    segs = c.get(f"/api/meetings/{m['id']}/segments/").data
    return {"client": c, "group": g, "meeting": m, "segs": segs}


def suggest(ctx, statement, category="fact", i=0):
    return ctx["client"].post(
        f"/api/meetings/{ctx['meeting']['id']}/memory-suggestions/",
        {"suggestions": [{
            "statement": statement, "category": category,
            "citations": [{"segment_id": ctx["segs"][i]["id"], "quote": ""}],
        }]},
        format="json",
    )


def pending(ctx):
    return ctx["client"].get(f"/api/groups/{ctx['group']['id']}/memory/review/").data


def test_suggestion_ingestion_is_cited_and_deduped(ctx):
    r = suggest(ctx, "Launch deadline is end of September.", "deadline")
    assert r.status_code == 200 and r.data == {"created": 1}
    assert suggest(ctx, "Launch deadline is end of September.", "deadline").data == {"created": 0}
    # citation from another meeting rejected
    m2 = ctx["client"].post(
        "/api/meetings/", {"group": ctx["group"]["id"], "title": "Other"}, format="json"
    ).data
    r = ctx["client"].post(
        f"/api/meetings/{m2['id']}/memory-suggestions/",
        {"suggestions": [{"statement": "X", "category": "fact",
                          "citations": [{"segment_id": ctx["segs"][0]["id"]}]}]},
        format="json",
    )
    assert r.status_code == 400


def test_approve_creates_active_memory_with_version(ctx):
    suggest(ctx, "Acme prefers weekly written status updates.", "preference", 1)
    sug = pending(ctx)["pending"][0]
    r = ctx["client"].post(
        f"/api/memory-suggestions/{sug['id']}/resolve/", {"action": "approve"}, format="json"
    )
    assert r.status_code == 200 and r.data["memory"]["status"] == "approved"
    active = ctx["client"].get(f"/api/groups/{ctx['group']['id']}/memory/").data
    assert len(active) == 1
    hist = ctx["client"].get(f"/api/memory/{r.data['memory']['id']}/history/").data
    assert hist["versions"][0]["version"] == 1
    assert pending(ctx)["pending"] == []


def test_reject_and_temporary(ctx):
    suggest(ctx, "The deadline is end of September.", "deadline")
    sug = pending(ctx)["pending"][0]
    r = ctx["client"].post(
        f"/api/memory-suggestions/{sug['id']}/resolve/", {"action": "reject"}, format="json"
    )
    assert r.data["resolution"] == "rejected" and r.data["memory"] is None
    suggest(ctx, "Acme wants a demo environment.", "requirement", 1)
    sug = pending(ctx)["pending"][0]
    r = ctx["client"].post(
        f"/api/memory-suggestions/{sug['id']}/resolve/",
        {"action": "temporary", "expires_at": "2026-01-01T00:00:00Z"},
        format="json",
    )
    assert r.data["memory"]["status"] == "temporary"
    # expired temporary memory is NOT active
    active = ctx["client"].get(f"/api/groups/{ctx['group']['id']}/memory/").data
    assert active == []


def test_conflict_detected_and_replace_supersedes(ctx):
    suggest(ctx, "The launch deadline is the end of September.", "deadline")
    sug = pending(ctx)["pending"][0]
    old = ctx["client"].post(
        f"/api/memory-suggestions/{sug['id']}/resolve/", {"action": "approve"}, format="json"
    ).data["memory"]
    # a contradicting statement about the same subject → conflict candidate
    r = suggest(ctx, "The launch deadline moved to the end of October.", "deadline", 1)
    assert r.data == {"created": 1}
    review = pending(ctx)
    assert len(review["conflicts"]) == 1
    assert review["conflicts"][0]["existing_memory"]["id"] == old["id"]
    conflict_id = review["conflicts"][0]["id"]
    r = ctx["client"].post(
        f"/api/memory-conflicts/{conflict_id}/resolve/",
        {"action": "replace_existing", "note": "date moved"},
        format="json",
    )
    assert r.status_code == 200 and r.data["memory"]["statement"].endswith("October.")
    active = ctx["client"].get(f"/api/groups/{ctx['group']['id']}/memory/").data
    assert [m["statement"] for m in active] == ["The launch deadline moved to the end of October."]
    all_mem = ctx["client"].get(f"/api/groups/{ctx['group']['id']}/memory/?all=1").data
    superseded = [m for m in all_mem if m["status"] == "superseded"]
    assert len(superseded) == 1 and superseded[0]["superseded_by"] is not None


def test_edit_and_merge(ctx):
    suggest(ctx, "Acme prefers weekly written status updates.", "preference", 1)
    sug = pending(ctx)["pending"][0]
    edited = ctx["client"].post(
        f"/api/memory-suggestions/{sug['id']}/resolve/",
        {"action": "edit", "statement": "Acme requires weekly written status updates by email."},
        format="json",
    ).data["memory"]
    assert edited["statement"].endswith("by email.")
    # merge new evidence into the same memory
    suggest(ctx, "Acme wants weekly status updates in writing.", "preference")
    review = pending(ctx)
    sug2 = review["pending"][0]
    r = ctx["client"].post(
        f"/api/memory-suggestions/{sug2['id']}/resolve/",
        {"action": "merge", "target_memory": edited["id"]},
        format="json",
    )
    assert r.data["resolution"] == "merged"
    hist = ctx["client"].get(f"/api/memory/{edited['id']}/history/").data
    assert hist["memory"]["version"] == 2 and len(hist["memory"]["citations"]) == 2


def test_memory_is_workspace_isolated(ctx):
    outsider = APIClient()
    outsider.credentials(HTTP_AUTHORIZATION=bearer())
    gid = ctx["group"]["id"]
    assert outsider.get(f"/api/groups/{gid}/memory/").status_code == 404
    assert outsider.get(f"/api/groups/{gid}/memory/review/").status_code == 404
    suggest(ctx, "Secret fact.", "fact")
    sug = pending(ctx)["pending"][0]
    r = outsider.post(
        f"/api/memory-suggestions/{sug['id']}/resolve/", {"action": "approve"}, format="json"
    )
    assert r.status_code == 404
