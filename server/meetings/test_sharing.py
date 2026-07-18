"""Increment 11 — sharing: expiring external links serving only the
external-safe summary variant; revocation (spec §34)."""

import uuid
from datetime import timedelta

import jwt
import pytest
from django.conf import settings as dj_settings
from django.utils import timezone
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


def future(hours=24):
    return (timezone.now() + timedelta(hours=hours)).isoformat()


@pytest.fixture
def ctx(db):
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=bearer())
    ws = c.post("/api/workspaces/", {"name": "W"}, format="json").data
    g = c.post("/api/groups/", {"workspace": ws["id"], "name": "Site"}, format="json").data
    m = c.post("/api/meetings/", {"group": g["id"], "title": "Client review"}, format="json").data
    c.post(
        f"/api/meetings/{m['id']}/segments/",
        {"segments": [{"sequence": 0, "start_ms": 0, "end_ms": 5000,
                       "text": "We agreed to ship the redesign next month."}]},
        format="json",
    )
    segs = c.get(f"/api/meetings/{m['id']}/segments/").data
    c.post(
        f"/api/meetings/{m['id']}/intelligence/",
        {"summary_sections": [
            {"kind": "overview", "body": "Redesign review.", "citations": [{"segment_id": segs[0]["id"]}]},
            {"kind": "context_connections", "body": "Internal group context.", "citations": [{"segment_id": segs[0]["id"]}]},
         ],
         "decisions": [{"statement": "Ship the redesign next month.", "status": "approved",
                        "citations": [{"segment_id": segs[0]["id"]}]}],
         "tasks": [{"title": "Prepare release notes", "citations": [{"segment_id": segs[0]["id"]}]}]},
        format="json",
    )
    return {"client": c, "meeting": m}


def test_external_link_serves_external_safe_variant(ctx):
    c, mid = ctx["client"], ctx["meeting"]["id"]
    r = c.post(
        f"/api/meetings/{mid}/shares/",
        {"scope": "external_link", "expires_at": future()},
        format="json",
    )
    assert r.status_code == 201 and "url" in r.data
    anon = APIClient()
    page = anon.get(r.data["url"])
    assert page.status_code == 200
    assert page.data["external_safe"] is True
    assert page.data["decisions"][0]["statement"] == "Ship the redesign next month."
    # group-context section and tasks/transcript are excluded
    kinds = [s["kind"] for s in page.data["summary_sections"]]
    assert "context_connections" not in kinds and kinds == ["overview"]
    assert "tasks" not in page.data and "segments" not in page.data


def test_external_link_requires_expiry_and_expires(ctx):
    c, mid = ctx["client"], ctx["meeting"]["id"]
    r = c.post(f"/api/meetings/{mid}/shares/", {"scope": "external_link"}, format="json")
    assert r.status_code == 400
    r = c.post(
        f"/api/meetings/{mid}/shares/",
        {"scope": "external_link",
         "expires_at": (timezone.now() - timedelta(hours=1)).isoformat()},
        format="json",
    )
    assert APIClient().get(r.data["url"]).status_code == 404


def test_revoked_link_stops_working(ctx):
    c, mid = ctx["client"], ctx["meeting"]["id"]
    r = c.post(
        f"/api/meetings/{mid}/shares/",
        {"scope": "external_link", "expires_at": future()},
        format="json",
    )
    assert APIClient().get(r.data["url"]).status_code == 200
    assert c.post(f"/api/shares/{r.data['id']}/revoke/").status_code == 200
    assert APIClient().get(r.data["url"]).status_code == 404


def test_user_share_requires_workspace_member(ctx):
    c, mid = ctx["client"], ctx["meeting"]["id"]
    r = c.post(
        f"/api/meetings/{mid}/shares/",
        {"scope": "user", "shared_with": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400
    # workspace scope needs no expiry
    r = c.post(f"/api/meetings/{mid}/shares/", {"scope": "workspace"}, format="json")
    assert r.status_code == 201
    listed = c.get(f"/api/meetings/{mid}/shares/").data
    assert len(listed) == 1


def test_outsider_cannot_create_or_list_shares(ctx):
    outsider = APIClient()
    outsider.credentials(HTTP_AUTHORIZATION=bearer())
    mid = ctx["meeting"]["id"]
    assert outsider.get(f"/api/meetings/{mid}/shares/").status_code == 404
    assert (
        outsider.post(
            f"/api/meetings/{mid}/shares/",
            {"scope": "external_link", "expires_at": future()},
            format="json",
        ).status_code
        == 404
    )
