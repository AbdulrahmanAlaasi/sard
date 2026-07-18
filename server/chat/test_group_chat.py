"""Increment 9 — Group Intelligence: group-scoped retrieval over active
memory + transcripts + decisions, non-active memory excluded, scope
indicator, typed citations (spec §28–29)."""

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


@pytest.fixture
def ctx(db):
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=bearer())
    ws = c.post("/api/workspaces/", {"name": "W"}, format="json").data
    g = c.post("/api/groups/", {"workspace": ws["id"], "name": "Acme"}, format="json").data
    m = c.post("/api/meetings/", {"group": g["id"], "title": "Kickoff"}, format="json").data
    c.post(
        f"/api/meetings/{m['id']}/segments/",
        {"segments": [
            {"sequence": 0, "start_ms": 0, "end_ms": 5000,
             "text": "The launch deadline is the end of September."},
        ]},
        format="json",
    )
    segs = c.get(f"/api/meetings/{m['id']}/segments/").data
    # approve one memory, reject another
    c.post(
        f"/api/meetings/{m['id']}/memory-suggestions/",
        {"suggestions": [
            {"statement": "Acme launch deadline is end of September.", "category": "deadline",
             "citations": [{"segment_id": segs[0]["id"]}]},
            {"statement": "Rejected rumor about launch pricing.", "category": "fact",
             "citations": [{"segment_id": segs[0]["id"]}]},
        ]},
        format="json",
    )
    review = c.get(f"/api/groups/{g['id']}/memory/review/").data["pending"]
    approved = c.post(
        f"/api/memory-suggestions/{review[0]['id']}/resolve/", {"action": "approve"}, format="json"
    ).data["memory"]
    c.post(
        f"/api/memory-suggestions/{review[1]['id']}/resolve/", {"action": "reject"}, format="json"
    )
    return {"client": c, "group": g, "meeting": m, "segs": segs, "memory": approved}


def test_group_ask_returns_scoped_sources_with_indicator(ctx):
    r = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/ask/",
        {"question": "What is the launch deadline?"},
        format="json",
    )
    assert r.status_code == 200
    assert r.data["scope"]["group_name"] == "Acme"
    types = {s["source_type"] for s in r.data["sources"]}
    assert "memory" in types and "transcript" in types
    # rejected memory is never retrieved
    assert not any("rumor" in s["text"] for s in r.data["sources"])


def test_memory_citation_validation(ctx):
    old = ctx["memory"]
    ask = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/ask/",
        {"question": "What is the launch deadline?"},
        format="json",
    ).data
    # a valid active-memory citation works
    r = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/answer/",
        {"thread": ask["thread"], "text": "End of September.",
         "citations": [{"source_type": "memory", "id": old["id"], "quote": ""}]},
        format="json",
    )
    assert r.status_code == 200
    # a non-existent / non-active id is rejected
    r = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/answer/",
        {"thread": ask["thread"], "text": "Made-up claim.",
         "citations": [{"source_type": "memory", "id": str(uuid.uuid4()), "quote": ""}]},
        format="json",
    )
    assert r.status_code == 400 and "not a citable source" in str(r.data)


def test_group_answer_honest_not_found_and_isolation(ctx):
    ask = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/ask/",
        {"question": "What is the office wifi password?"},
        format="json",
    ).data
    r = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/answer/",
        {"thread": ask["thread"], "text": "Uncited claim.", "citations": []},
        format="json",
    )
    assert r.status_code == 400
    r = ctx["client"].post(
        f"/api/groups/{ctx['group']['id']}/chat/answer/",
        {"thread": ask["thread"],
         "text": "This group's sources do not contain that information.",
         "not_found": True},
        format="json",
    )
    assert r.status_code == 200 and r.data["not_found"] is True
    outsider = APIClient()
    outsider.credentials(HTTP_AUTHORIZATION=bearer())
    assert outsider.post(
        f"/api/groups/{ctx['group']['id']}/chat/ask/", {"question": "deadline?"}, format="json"
    ).status_code == 404
