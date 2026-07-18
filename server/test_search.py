"""Increment 10 — global + group search over scoped managers (spec §30)."""

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
    g1 = c.post("/api/groups/", {"workspace": ws["id"], "name": "Launch"}, format="json").data
    g2 = c.post("/api/groups/", {"workspace": ws["id"], "name": "Hiring"}, format="json").data
    m1 = c.post("/api/meetings/", {"group": g1["id"], "title": "Budget planning"}, format="json").data
    m2 = c.post("/api/meetings/", {"group": g2["id"], "title": "Interview loop"}, format="json").data
    c.post(
        f"/api/meetings/{m1['id']}/segments/",
        {"segments": [{"sequence": 0, "start_ms": 0, "end_ms": 5000,
                       "text": "The marketing budget is twenty thousand."}]},
        format="json",
    )
    c.post(
        f"/api/meetings/{m2['id']}/segments/",
        {"segments": [{"sequence": 0, "start_ms": 0, "end_ms": 5000,
                       "text": "The hiring budget covers two engineers."}]},
        format="json",
    )
    segs = c.get(f"/api/meetings/{m1['id']}/segments/").data
    c.post(
        f"/api/meetings/{m1['id']}/intelligence/",
        {"decisions": [{"statement": "Approve the marketing budget.", "status": "approved",
                        "citations": [{"segment_id": segs[0]["id"]}]}],
         "tasks": [{"title": "Publish budget breakdown",
                    "citations": [{"segment_id": segs[0]["id"]}]}]},
        format="json",
    )
    return {"client": c, "g1": g1, "g2": g2, "m1": m1}


def test_global_search_spans_types(ctx):
    r = ctx["client"].get("/api/search/?q=budget")
    assert r.status_code == 200
    types = {x["type"] for x in r.data["results"]}
    assert {"meeting", "transcript", "decision", "task"} <= types
    assert r.data["scope"] == {"global": True}


def test_group_scoped_search_filters(ctx):
    r = ctx["client"].get(f"/api/search/?q=budget&group={ctx['g1']['id']}")
    assert all(x["group_id"] == ctx["g1"]["id"] for x in r.data["results"])
    assert not any("hiring" in x["text"] for x in r.data["results"])


def test_type_filter_and_empty_query(ctx):
    r = ctx["client"].get("/api/search/?q=budget&types=decision")
    assert {x["type"] for x in r.data["results"]} == {"decision"}
    assert ctx["client"].get("/api/search/?q=").status_code == 400


def test_search_is_workspace_isolated(ctx):
    outsider = APIClient()
    outsider.credentials(HTTP_AUTHORIZATION=bearer())
    r = outsider.get("/api/search/?q=budget")
    assert r.status_code == 200 and r.data["results"] == []
