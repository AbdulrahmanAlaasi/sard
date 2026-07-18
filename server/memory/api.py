"""Memory workflow API (spec §6–9).

- POST /api/meetings/{id}/memory-suggestions/   pipeline ingestion (cited,
  deduped); conflict candidates detected against ACTIVE memories and
  materialized as open MemoryConflict rows — nothing silently overwritten.
- GET  /api/groups/{id}/memory/review/          pending queue + open conflicts.
- POST /api/memory-suggestions/{id}/resolve/    approve | edit | reject |
  temporary | merge | replace.
- GET  /api/groups/{id}/memory/                 active memories.
- GET  /api/memory/{id}/history/                full version history.
- POST /api/memory-conflicts/{id}/resolve/      keep_existing |
  replace_existing | keep_both.
"""

import hashlib

from django.db import transaction
from django.http import Http404
from django.utils import timezone
from rest_framework import serializers, viewsets
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from groups.models import Group
from meetings.models import Meeting, ProcessingJob
from .models import CATEGORIES, GroupMemory, MemoryConflict, MemorySuggestion, MemoryVersion
from .similarity import find_conflict_candidates


class CitationSerializer(serializers.Serializer):
    segment_id = serializers.UUIDField()
    quote = serializers.CharField(required=False, allow_blank=True, default="")


class SuggestionInSerializer(serializers.Serializer):
    statement = serializers.CharField()
    category = serializers.ChoiceField(choices=CATEGORIES)
    citations = CitationSerializer(many=True, allow_empty=False)
    confidence = serializers.FloatField(required=False, allow_null=True, default=None)


class SuggestionOutSerializer(serializers.ModelSerializer):
    class Meta:
        model = MemorySuggestion
        fields = [
            "id", "group", "meeting", "statement", "category", "citations",
            "confidence", "conflict_candidates", "resolution", "memory", "created_at",
        ]


class MemorySerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupMemory
        fields = [
            "id", "group", "statement", "category", "status", "citations",
            "source_meeting", "confidence", "approved_at", "expires_at",
            "version", "superseded_by", "created_at",
        ]


def _member(group, user, allow_viewer=False):
    m = group.members.filter(user=user).first()
    if not m or (m.role == "viewer" and not allow_viewer):
        raise PermissionDenied("Insufficient group role.")
    return m


def _record_version(memory, user, note=""):
    MemoryVersion.objects.create(
        workspace=memory.workspace,
        created_by=user,
        memory=memory,
        version=memory.version,
        statement=memory.statement,
        category=memory.category,
        status=memory.status,
        changed_by=user,
        note=note,
    )


class MeetingMemorySuggestionViewSet(viewsets.ViewSet):
    """Nested under /api/meetings/<meeting_pk>/memory-suggestions/."""

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
        return Response(
            SuggestionOutSerializer(meeting.memory_suggestions.all(), many=True).data
        )

    @transaction.atomic
    def create(self, request, meeting_pk=None):
        meeting = self._meeting(request, meeting_pk)
        _member(meeting.group, request.user)
        ser = SuggestionInSerializer(data=request.data.get("suggestions", []), many=True)
        ser.is_valid(raise_exception=True)
        segment_ids = set(str(pk) for pk in meeting.segments.values_list("pk", flat=True))
        active = list(GroupMemory.active(meeting.group))
        created = 0
        for item in ser.validated_data:
            for c in item["citations"]:
                if str(c["segment_id"]) not in segment_ids:
                    raise ValidationError(
                        {"suggestions": f"citation segment {c['segment_id']} is not a segment of this meeting"}
                    )
            digest = hashlib.sha256(
                f"{item['category']}|{item['statement'].strip().lower()}".encode()
            ).hexdigest()[:32]
            dedupe = f"{meeting.id}:memsug:{digest}"
            if MemorySuggestion.objects.filter(dedupe_key=dedupe).exists():
                continue
            candidates = find_conflict_candidates(item["statement"], active)
            suggestion = MemorySuggestion.objects.create(
                workspace=meeting.workspace,
                created_by=request.user,
                group=meeting.group,
                meeting=meeting,
                statement=item["statement"],
                category=item["category"],
                citations=[
                    {"segment_id": str(c["segment_id"]), "quote": c["quote"]}
                    for c in item["citations"]
                ],
                confidence=item["confidence"],
                conflict_candidates=[str(m.pk) for m in candidates],
                dedupe_key=dedupe,
            )
            for mem in candidates:
                MemoryConflict.objects.get_or_create(
                    existing_memory=mem,
                    suggestion=suggestion,
                    defaults=dict(
                        workspace=meeting.workspace,
                        created_by=request.user,
                        group=meeting.group,
                    ),
                )
            created += 1
        job, _ = ProcessingJob.objects.get_or_create(
            meeting=meeting,
            stage=ProcessingJob.Stage.MEMORY_SUGGESTED,
            defaults={"workspace": meeting.workspace, "created_by": request.user},
        )
        job.status = ProcessingJob.Status.COMPLETE
        job.attempt += 1
        job.save(update_fields=["status", "attempt"])
        return Response({"created": created})


class GroupMemoryViewSet(viewsets.ViewSet):
    """Nested under /api/groups/<group_pk>/memory/."""

    def _group(self, request, group_pk):
        group = (
            Group.objects.visible_to(request.user)
            .filter(deleted_at__isnull=True, pk=group_pk)
            .first()
        )
        if group is None:
            raise Http404
        return group

    def list(self, request, group_pk=None):
        group = self._group(request, group_pk)
        qs = GroupMemory.active(group)
        if request.query_params.get("category"):
            qs = qs.filter(category=request.query_params["category"])
        if request.query_params.get("all") == "1":
            qs = GroupMemory.objects.filter(group=group)
        return Response(MemorySerializer(qs, many=True).data)

    def review(self, request, group_pk=None):
        group = self._group(request, group_pk)
        pending = MemorySuggestion.objects.filter(
            group=group, resolution=MemorySuggestion.Resolution.PENDING
        )
        conflicts = MemoryConflict.objects.filter(
            group=group, status=MemoryConflict.Status.OPEN
        ).select_related("existing_memory", "suggestion")
        return Response(
            {
                "pending": SuggestionOutSerializer(pending, many=True).data,
                "conflicts": [
                    {
                        "id": str(c.pk),
                        "existing_memory": MemorySerializer(c.existing_memory).data,
                        "suggestion": SuggestionOutSerializer(c.suggestion).data,
                    }
                    for c in conflicts
                ],
            }
        )


class SuggestionResolveViewSet(viewsets.ViewSet):
    """/api/memory-suggestions/{pk}/resolve/"""

    ACTIONS = {"approve", "edit", "reject", "temporary", "merge", "replace"}

    @transaction.atomic
    def resolve(self, request, pk=None):
        suggestion = (
            MemorySuggestion.objects.visible_to(request.user)
            .filter(pk=pk)
            .select_related("group", "workspace", "meeting")
            .first()
        )
        if suggestion is None:
            raise Http404
        _member(suggestion.group, request.user)
        if suggestion.resolution != MemorySuggestion.Resolution.PENDING:
            raise ValidationError({"resolution": "suggestion already resolved"})
        act = request.data.get("action")
        if act not in self.ACTIONS:
            raise ValidationError({"action": f"one of {sorted(self.ACTIONS)}"})
        now = timezone.now()
        statement = str(request.data.get("statement", "")).strip() or suggestion.statement
        memory = None

        def make_memory(status, expires_at=None):
            m = GroupMemory.objects.create(
                workspace=suggestion.workspace,
                created_by=request.user,
                group=suggestion.group,
                statement=statement,
                category=suggestion.category,
                status=status,
                citations=suggestion.citations,
                source_meeting=suggestion.meeting,
                confidence=suggestion.confidence,
                approved_by=request.user,
                approved_at=now,
                expires_at=expires_at,
            )
            _record_version(m, request.user, note=f"created via {act}")
            return m

        if act == "approve":
            memory = make_memory(GroupMemory.Status.APPROVED)
            suggestion.resolution = MemorySuggestion.Resolution.APPROVED
        elif act == "edit":
            if statement == suggestion.statement:
                raise ValidationError({"statement": "edited statement required"})
            memory = make_memory(GroupMemory.Status.APPROVED)
            suggestion.resolution = MemorySuggestion.Resolution.EDITED
        elif act == "temporary":
            expires = request.data.get("expires_at")
            if not expires:
                raise ValidationError({"expires_at": "required for temporary memories"})
            memory = make_memory(
                GroupMemory.Status.TEMPORARY,
                expires_at=serializers.DateTimeField().to_internal_value(expires),
            )
            suggestion.resolution = MemorySuggestion.Resolution.TEMPORARY
        elif act == "reject":
            suggestion.resolution = MemorySuggestion.Resolution.REJECTED
        elif act in {"merge", "replace"}:
            target = GroupMemory.objects.filter(
                pk=request.data.get("target_memory"), group=suggestion.group
            ).first()
            if target is None:
                raise ValidationError({"target_memory": "required and must belong to this group"})
            if act == "merge":
                # fold the new evidence into the existing memory
                target.statement = statement if statement != suggestion.statement else target.statement
                target.citations = list(target.citations) + list(suggestion.citations)
                target.version += 1
                target.save(update_fields=["statement", "citations", "version", "updated_at"])
                _record_version(target, request.user, note="merged suggestion")
                memory = target
                suggestion.resolution = MemorySuggestion.Resolution.MERGED
            else:
                memory = make_memory(GroupMemory.Status.APPROVED)
                target.status = GroupMemory.Status.SUPERSEDED
                target.superseded_by = memory
                target.version += 1
                target.save(update_fields=["status", "superseded_by", "version", "updated_at"])
                _record_version(target, request.user, note="superseded by replacement")
                suggestion.resolution = MemorySuggestion.Resolution.REPLACED

        suggestion.memory = memory
        suggestion.resolved_by = request.user
        suggestion.resolved_at = now
        suggestion.save(
            update_fields=["resolution", "memory", "resolved_by", "resolved_at", "updated_at"]
        )
        # resolving the suggestion closes its conflicts
        suggestion.conflicts.filter(status=MemoryConflict.Status.OPEN).update(
            status=MemoryConflict.Status.RESOLVED,
            resolved_by=request.user,
            resolved_at=now,
            resolution_action=(
                MemoryConflict.Action.REPLACE_EXISTING
                if act == "replace"
                else MemoryConflict.Action.KEEP_BOTH
                if act in {"approve", "edit", "temporary", "merge"}
                else MemoryConflict.Action.KEEP_EXISTING
            ),
        )
        return Response(
            {
                "resolution": suggestion.resolution,
                "memory": MemorySerializer(memory).data if memory else None,
            }
        )


class MemoryHistoryViewSet(viewsets.ViewSet):
    """/api/memory/{pk}/history/"""

    def history(self, request, pk=None):
        memory = GroupMemory.objects.visible_to(request.user).filter(pk=pk).first()
        if memory is None:
            raise Http404
        return Response(
            {
                "memory": MemorySerializer(memory).data,
                "versions": [
                    {
                        "version": v.version,
                        "statement": v.statement,
                        "category": v.category,
                        "status": v.status,
                        "note": v.note,
                        "created_at": v.created_at,
                    }
                    for v in memory.versions.all()
                ],
            }
        )


class ConflictResolveViewSet(viewsets.ViewSet):
    """/api/memory-conflicts/{pk}/resolve/ — resolve a conflict card directly."""

    @transaction.atomic
    def resolve(self, request, pk=None):
        conflict = (
            MemoryConflict.objects.visible_to(request.user)
            .filter(pk=pk)
            .select_related("existing_memory", "suggestion", "group", "workspace")
            .first()
        )
        if conflict is None:
            raise Http404
        _member(conflict.group, request.user)
        if conflict.status == MemoryConflict.Status.RESOLVED:
            raise ValidationError({"status": "conflict already resolved"})
        act = request.data.get("action")
        if act not in MemoryConflict.Action.values:
            raise ValidationError({"action": f"one of {list(MemoryConflict.Action.values)}"})
        now = timezone.now()
        suggestion = conflict.suggestion
        memory = None
        if act == MemoryConflict.Action.KEEP_EXISTING:
            suggestion.resolution = MemorySuggestion.Resolution.REJECTED
        else:
            memory = GroupMemory.objects.create(
                workspace=conflict.workspace,
                created_by=request.user,
                group=conflict.group,
                statement=suggestion.statement,
                category=suggestion.category,
                status=GroupMemory.Status.APPROVED,
                citations=suggestion.citations,
                source_meeting=suggestion.meeting,
                confidence=suggestion.confidence,
                approved_by=request.user,
                approved_at=now,
            )
            _record_version(memory, request.user, note=f"conflict resolved: {act}")
            suggestion.resolution = MemorySuggestion.Resolution.APPROVED
            if act == MemoryConflict.Action.REPLACE_EXISTING:
                old = conflict.existing_memory
                old.status = GroupMemory.Status.SUPERSEDED
                old.superseded_by = memory
                old.version += 1
                old.save(update_fields=["status", "superseded_by", "version", "updated_at"])
                _record_version(old, request.user, note="superseded via conflict resolution")
        suggestion.memory = memory
        suggestion.resolved_by = request.user
        suggestion.resolved_at = now
        suggestion.save(
            update_fields=["resolution", "memory", "resolved_by", "resolved_at", "updated_at"]
        )
        conflict.status = MemoryConflict.Status.RESOLVED
        conflict.resolution_action = act
        conflict.note = str(request.data.get("note", ""))
        conflict.resolved_by = request.user
        conflict.resolved_at = now
        conflict.save(
            update_fields=[
                "status", "resolution_action", "note", "resolved_by", "resolved_at", "updated_at"
            ]
        )
        return Response(
            {"status": conflict.status, "action": act,
             "memory": MemorySerializer(memory).data if memory else None}
        )
