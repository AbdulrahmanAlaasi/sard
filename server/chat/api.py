"""Meeting Chat API (spec §26–27).

Flow (generation is client-side, on the user's local LLM):
1. POST  /api/meetings/{id}/chat/ask/     {question, thread?}
     → stores the user turn, runs meeting-isolated retrieval, returns the
       excerpts the client may use — transcript of THIS meeting only.
2. POST  /api/meetings/{id}/chat/answer/  {thread, text, citations, not_found}
     → validates every citation resolves to a segment of THIS meeting;
       a non-not_found answer with zero valid citations is rejected —
       the honest fallback is not_found=true (spec §27).
3. GET   /api/meetings/{id}/chat/?thread= → history.
"""

from django.http import Http404
from rest_framework import serializers, viewsets
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from groups.models import Group
from meetings.models import Meeting
from .group_retrieval import retrieve_group_sources, valid_group_citation_ids
from .models import (
    GroupChatMessage,
    GroupChatThread,
    MeetingChatMessage,
    MeetingChatThread,
)
from .retrieval import retrieve_meeting_segments


class ChatCitationSerializer(serializers.Serializer):
    segment_id = serializers.UUIDField()
    quote = serializers.CharField(required=False, allow_blank=True, default="")


class MessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = MeetingChatMessage
        fields = ["id", "thread", "role", "text", "citations", "not_found", "created_at"]


class MeetingChatViewSet(viewsets.ViewSet):
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

    def _thread(self, request, meeting, thread_id, create_title=""):
        if thread_id:
            thread = meeting.chat_threads.filter(pk=thread_id).first()
            if thread is None:
                raise ValidationError({"thread": "unknown thread for this meeting"})
            return thread
        return MeetingChatThread.objects.create(
            workspace=meeting.workspace,
            meeting=meeting,
            created_by=request.user,
            title=create_title[:300],
        )

    def list(self, request, meeting_pk=None):
        meeting = self._meeting(request, meeting_pk)
        qs = MeetingChatMessage.objects.filter(meeting=meeting)
        if request.query_params.get("thread"):
            qs = qs.filter(thread_id=request.query_params["thread"])
        return Response(MessageSerializer(qs, many=True).data)

    def ask(self, request, meeting_pk=None):
        meeting = self._meeting(request, meeting_pk)
        member = meeting.group.members.filter(user=request.user).first()
        if not member:
            raise PermissionDenied("Not a member of this meeting's group.")
        question = str(request.data.get("question", "")).strip()
        if not question:
            raise ValidationError({"question": "required"})
        thread = self._thread(request, meeting, request.data.get("thread"), question)
        segments = retrieve_meeting_segments(meeting, question)
        msg = MeetingChatMessage.objects.create(
            workspace=meeting.workspace,
            meeting=meeting,
            thread=thread,
            created_by=request.user,
            role=MeetingChatMessage.Role.USER,
            text=question,
            retrieved_segment_ids=[str(s.pk) for s in segments],
        )
        return Response(
            {
                "thread": str(thread.pk),
                "message": str(msg.pk),
                # Meeting Chat context = this meeting's transcript, nothing else
                # (no documents, no Group Memory, no other meetings — spec §26).
                "excerpts": [
                    {
                        "segment_id": str(s.pk),
                        "sequence": s.sequence,
                        "speaker_label": s.speaker_label,
                        "start_ms": s.start_ms,
                        "end_ms": s.end_ms,
                        "text": s.text,
                    }
                    for s in segments
                ],
            }
        )

    def answer(self, request, meeting_pk=None):
        meeting = self._meeting(request, meeting_pk)
        thread = self._thread(request, meeting, request.data.get("thread"))
        text = str(request.data.get("text", "")).strip()
        not_found = bool(request.data.get("not_found", False))
        if not text:
            raise ValidationError({"text": "required"})
        ser = ChatCitationSerializer(data=request.data.get("citations", []), many=True)
        ser.is_valid(raise_exception=True)
        valid_ids = set(
            str(pk) for pk in meeting.segments.values_list("pk", flat=True)
        )
        citations = []
        for c in ser.validated_data:
            if str(c["segment_id"]) not in valid_ids:
                raise ValidationError(
                    {"citations": f"segment {c['segment_id']} is not part of this meeting"}
                )
            citations.append({"segment_id": str(c["segment_id"]), "quote": c["quote"]})
        if not not_found and not citations:
            raise ValidationError(
                {"citations": "an answer must cite this meeting's transcript; if the transcript does not contain the answer, set not_found=true"}
            )
        msg = MeetingChatMessage.objects.create(
            workspace=meeting.workspace,
            meeting=meeting,
            thread=thread,
            created_by=request.user,
            role=MeetingChatMessage.Role.ASSISTANT,
            text=text,
            citations=citations,
            not_found=not_found,
        )
        return Response(MessageSerializer(msg).data)


class GroupCitationSerializer(serializers.Serializer):
    source_type = serializers.ChoiceField(
        choices=["memory", "document", "transcript", "decision"]
    )
    id = serializers.UUIDField()
    quote = serializers.CharField(required=False, allow_blank=True, default="")


class GroupMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupChatMessage
        fields = ["id", "thread", "role", "text", "citations", "not_found", "created_at"]


class GroupChatViewSet(viewsets.ViewSet):
    """Group Intelligence (spec §28–29). Same ask/answer shape as Meeting
    Chat, but sources span the whole group — ACTIVE memory, documents,
    transcripts, decisions — and every response carries the scope
    indicator."""

    def _group(self, request, group_pk):
        group = (
            Group.objects.visible_to(request.user)
            .filter(deleted_at__isnull=True, pk=group_pk)
            .select_related("workspace")
            .first()
        )
        if group is None:
            raise Http404
        return group

    def _thread(self, request, group, thread_id, create_title=""):
        if thread_id:
            thread = group.chat_threads.filter(pk=thread_id).first()
            if thread is None:
                raise ValidationError({"thread": "unknown thread for this group"})
            return thread
        return GroupChatThread.objects.create(
            workspace=group.workspace,
            group=group,
            created_by=request.user,
            title=create_title[:300],
        )

    def list(self, request, group_pk=None):
        group = self._group(request, group_pk)
        qs = GroupChatMessage.objects.filter(group=group)
        if request.query_params.get("thread"):
            qs = qs.filter(thread_id=request.query_params["thread"])
        return Response(GroupMessageSerializer(qs, many=True).data)

    def ask(self, request, group_pk=None):
        group = self._group(request, group_pk)
        member = group.members.filter(user=request.user).first()
        if not member:
            raise PermissionDenied("Not a member of this group.")
        question = str(request.data.get("question", "")).strip()
        if not question:
            raise ValidationError({"question": "required"})
        thread = self._thread(request, group, request.data.get("thread"), question)
        sources = retrieve_group_sources(group, question)
        msg = GroupChatMessage.objects.create(
            workspace=group.workspace,
            group=group,
            thread=thread,
            created_by=request.user,
            role=GroupChatMessage.Role.USER,
            text=question,
            retrieved_sources=sources,
        )
        return Response(
            {
                "thread": str(thread.pk),
                "message": str(msg.pk),
                "scope": {"group": str(group.pk), "group_name": group.name},
                "sources": sources,
            }
        )

    def answer(self, request, group_pk=None):
        group = self._group(request, group_pk)
        thread = self._thread(request, group, request.data.get("thread"))
        text = str(request.data.get("text", "")).strip()
        not_found = bool(request.data.get("not_found", False))
        if not text:
            raise ValidationError({"text": "required"})
        ser = GroupCitationSerializer(data=request.data.get("citations", []), many=True)
        ser.is_valid(raise_exception=True)
        valid = valid_group_citation_ids(group)
        citations = []
        for c in ser.validated_data:
            if str(c["id"]) not in valid[c["source_type"]]:
                raise ValidationError(
                    {"citations": f"{c['source_type']} {c['id']} is not a citable source of this group (superseded/rejected memory is never citable as current)"}
                )
            citations.append(
                {"source_type": c["source_type"], "id": str(c["id"]), "quote": c["quote"]}
            )
        if not not_found and not citations:
            raise ValidationError(
                {"citations": "an answer must cite this group's sources; if they do not contain the answer, set not_found=true"}
            )
        msg = GroupChatMessage.objects.create(
            workspace=group.workspace,
            group=group,
            thread=thread,
            created_by=request.user,
            role=GroupChatMessage.Role.ASSISTANT,
            text=text,
            citations=citations,
            not_found=not_found,
        )
        return Response(GroupMessageSerializer(msg).data)
