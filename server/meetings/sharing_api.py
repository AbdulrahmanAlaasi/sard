"""Meeting sharing (spec §34, MVP increment 11).

- POST /api/meetings/{id}/shares/   {scope: workspace|user|external_link,
                                     shared_with?, expires_at?}
- GET  /api/meetings/{id}/shares/
- POST /api/shares/{id}/revoke/
- GET  /api/shared/{token}/          public, unauthenticated: the
  external-safe summary variant — title, date, duration, summary sections
  and decisions ONLY. Group context, memory, documents, tasks, chat and raw
  transcript are excluded by default (spec §34). Expired/revoked links 404.
"""

from django.http import Http404
from django.utils import timezone
from rest_framework import serializers, viewsets
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from tenancy.models import User
from .models import Meeting, MeetingShare


class ShareSerializer(serializers.ModelSerializer):
    class Meta:
        model = MeetingShare
        fields = ["id", "meeting", "scope", "shared_with", "token", "expires_at",
                  "revoked_at", "created_at"]
        read_only_fields = ["id", "meeting", "token", "revoked_at", "created_at"]


class MeetingShareViewSet(viewsets.ViewSet):
    """Nested under /api/meetings/<meeting_pk>/shares/."""

    def _meeting(self, request, meeting_pk):
        meeting = (
            Meeting.objects.visible_to(request.user)
            .filter(deleted_at__isnull=True, pk=meeting_pk)
            .select_related("group", "workspace")
            .first()
        )
        if meeting is None:
            raise Http404
        return meeting

    def list(self, request, meeting_pk=None):
        meeting = self._meeting(request, meeting_pk)
        return Response(ShareSerializer(meeting.shares.all(), many=True).data)

    def create(self, request, meeting_pk=None):
        meeting = self._meeting(request, meeting_pk)
        member = meeting.group.members.filter(user=request.user).first()
        if not member or member.role == "viewer":
            raise PermissionDenied("Viewers cannot share meetings.")
        scope = request.data.get("scope")
        if scope not in MeetingShare.Scope.values:
            raise ValidationError({"scope": f"one of {list(MeetingShare.Scope.values)}"})
        shared_with = None
        if scope == MeetingShare.Scope.USER:
            shared_with = User.objects.filter(
                pk=request.data.get("shared_with"),
                workspace_memberships__workspace=meeting.workspace,
            ).first()
            if shared_with is None:
                raise ValidationError({"shared_with": "must be a member of this workspace"})
        expires_at = None
        if request.data.get("expires_at"):
            expires_at = serializers.DateTimeField().to_internal_value(
                request.data["expires_at"]
            )
        elif scope == MeetingShare.Scope.EXTERNAL_LINK:
            raise ValidationError(
                {"expires_at": "external links must expire (spec §34)"}
            )
        share = MeetingShare.objects.create(
            workspace=meeting.workspace,
            created_by=request.user,
            meeting=meeting,
            scope=scope,
            shared_with=shared_with,
            expires_at=expires_at,
        )
        data = ShareSerializer(share).data
        if scope == MeetingShare.Scope.EXTERNAL_LINK:
            data["url"] = f"/api/shared/{share.token}/"
        return Response(data, status=201)


class ShareRevokeViewSet(viewsets.ViewSet):
    """/api/shares/{pk}/revoke/"""

    def revoke(self, request, pk=None):
        share = (
            MeetingShare.objects.visible_to(request.user)
            .filter(pk=pk)
            .select_related("meeting__group")
            .first()
        )
        if share is None:
            raise Http404
        member = share.meeting.group.members.filter(user=request.user).first()
        if not member or member.role == "viewer":
            raise PermissionDenied("Viewers cannot revoke shares.")
        share.revoked_at = timezone.now()
        share.save(update_fields=["revoked_at", "updated_at"])
        return Response(ShareSerializer(share).data)


class ExternalSharedMeetingView(APIView):
    """Public token endpoint — external-safe summary variant only."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get(self, request, token=None):
        share = (
            MeetingShare.objects.filter(
                token=token, scope=MeetingShare.Scope.EXTERNAL_LINK
            )
            .select_related("meeting")
            .first()
        )
        if share is None or not share.is_valid or share.meeting.deleted_at:
            raise Http404
        meeting = share.meeting
        # External-safe variant: no group context, no memory, no documents,
        # no tasks, no transcript — summary + decisions only (spec §34).
        sections = [
            {"kind": s.kind, "order": s.order, "body": s.body}
            for s in meeting.summarysections.all()
            if s.kind != "context_connections"
        ]
        return Response(
            {
                "title": meeting.title,
                "started_at": meeting.started_at,
                "duration_seconds": meeting.duration_seconds,
                "language": meeting.language,
                "summary_sections": sections,
                "decisions": [
                    {"statement": d.statement, "status": d.status}
                    for d in meeting.decisions.all()
                ],
                "external_safe": True,
                "expires_at": share.expires_at,
            }
        )
