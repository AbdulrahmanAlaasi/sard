"""Local-only auth: the server issues tokens that flow through the normal
auth path, so the whole workspace stack runs offline."""

import pytest
from rest_framework.test import APIClient


@pytest.fixture(autouse=True)
def local_mode(settings):
    settings.LOCAL_AUTH = True
    settings.SUPABASE_JWT_SECRET = "local-test-secret-0123456789abcdef"


def test_local_sign_in_gives_a_working_token(db):
    c = APIClient()
    r = c.post("/api/auth/local/", {"email": "Me@Example.com"}, format="json")
    assert r.status_code == 200 and r.data["local"] is True
    token = r.data["access_token"]
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    ws = c.post("/api/workspaces/", {"name": "Home"}, format="json")
    assert ws.status_code in (200, 201)
    # same email → same identity on a later sign-in
    r2 = c.post("/api/auth/local/", {"email": "me@example.com"}, format="json")
    c2 = APIClient()
    c2.credentials(HTTP_AUTHORIZATION=f"Bearer {r2.data['access_token']}")
    assert [w["name"] for w in c2.get("/api/workspaces/").data] == ["Home"]


def test_local_sign_in_disabled_outside_local_mode(db, settings):
    settings.LOCAL_AUTH = False
    r = APIClient().post("/api/auth/local/", {"email": "me@example.com"}, format="json")
    assert r.status_code == 403
