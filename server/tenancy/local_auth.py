"""Local, offline sign-in (no Supabase, no cloud).

When `LOCAL_AUTH` is enabled (the default in DEBUG), the server issues its
own HS256 tokens so the whole workspace stack (groups, context, memory,
Meeting Chat, search) runs 100% on this machine. The token is signed with
the same secret `SupabaseJWTAuthentication` verifies against, so no other
code changes: locally issued tokens flow through the exact same auth path.

This endpoint is intentionally password-less: it only exists on a server
you run yourself, bound to localhost, for your own data. It is disabled
whenever LOCAL_AUTH is off (production against real Supabase).
"""

import datetime
import uuid

import jwt
from django.conf import settings
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

# Stable namespace so the same email always maps to the same local user id.
_LOCAL_NS = uuid.UUID("6b2d5c1e-8f3a-4b6f-9d2e-a1b2c3d4e5f6")


class LocalSignInSerializer(serializers.Serializer):
    email = serializers.EmailField()


class LocalSignInView(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]

    def post(self, request):
        if not settings.LOCAL_AUTH:
            raise PermissionDenied("Local auth is disabled on this server.")
        ser = LocalSignInSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        email = ser.validated_data["email"].lower()
        subject = str(uuid.uuid5(_LOCAL_NS, email))
        now = datetime.datetime.now(datetime.timezone.utc)
        token = jwt.encode(
            {
                "sub": subject,
                "aud": "authenticated",
                "email": email,
                "iat": now,
                "exp": now + datetime.timedelta(days=30),
                "iss": "sard-local",
            },
            settings.SUPABASE_JWT_SECRET,
            algorithm="HS256",
        )
        return Response({"access_token": token, "email": email, "local": True})
