"""Global + group hybrid search (spec §30, MVP increment 10).

Every query runs through the same `visible_to` scoped managers used by the
rest of the API — search cannot leak what a user could not otherwise open
(docs/ARCHITECTURE.md §7). Only ACTIVE memory is searchable; superseded /
rejected memory never surfaces as a current result.
"""

from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.retrieval import _tokens
from groups.models import DocumentChunk
from intelligence.models import ActionItem, Decision
from meetings.models import Meeting, TranscriptSegment
from memory.models import GroupMemory

ALL_TYPES = ["meeting", "transcript", "memory", "document", "decision", "task"]


def _score(q_tokens, q_list, text):
    s_list = _tokens(text)
    if not s_list:
        return 0.0
    overlap = q_tokens & set(s_list)
    if not overlap:
        return 0.0
    score = len(overlap) / (len(q_tokens) ** 0.5 * len(set(s_list)) ** 0.5)
    joined = " ".join(s_list)
    for a, b in zip(q_list, q_list[1:]):
        if f"{a} {b}" in joined:
            score += 0.15
    return score


class SearchView(APIView):
    """GET /api/search/?q=…&group=<id>&types=memory,transcript&limit=20"""

    def get(self, request):
        q = str(request.query_params.get("q", "")).strip()
        if not q:
            raise ValidationError({"q": "required"})
        q_list = _tokens(q)
        q_tokens = set(q_list)
        group_id = request.query_params.get("group")
        types = [
            t for t in str(request.query_params.get("types", "")).split(",") if t
        ] or ALL_TYPES
        limit = min(int(request.query_params.get("limit", 20)), 50)
        user = request.user
        results = []

        def add(score, item):
            if score > 0:
                results.append((score, item))

        def scoped(qs):
            return qs.filter(group_id=group_id) if group_id else qs

        if "meeting" in types:
            for m in scoped(Meeting.objects.visible_to(user).filter(deleted_at__isnull=True)):
                add(_score(q_tokens, q_list, m.title) * 1.2, {
                    "type": "meeting", "id": str(m.pk), "text": m.title,
                    "group_id": str(m.group_id),
                })
        if "transcript" in types:
            qs = TranscriptSegment.objects.visible_to(user).filter(
                meeting__deleted_at__isnull=True
            ).select_related("meeting")
            if group_id:
                qs = qs.filter(meeting__group_id=group_id)
            for s in qs:
                add(_score(q_tokens, q_list, s.text), {
                    "type": "transcript", "id": str(s.pk), "text": s.text,
                    "meeting_id": str(s.meeting_id), "meeting": s.meeting.title,
                    "group_id": str(s.meeting.group_id),
                    "start_ms": s.start_ms, "end_ms": s.end_ms,
                })
        if "memory" in types:
            qs = scoped(GroupMemory.objects.visible_to(user))
            for mem in qs:
                if not mem.is_active:  # active memory only
                    continue
                add(_score(q_tokens, q_list, mem.statement) * 1.1, {
                    "type": "memory", "id": str(mem.pk), "text": mem.statement,
                    "category": mem.category, "group_id": str(mem.group_id),
                })
        if "document" in types:
            qs = scoped(DocumentChunk.objects.visible_to(user).filter(
                document__deleted_at__isnull=True, document__is_superseded=False
            ).select_related("document"))
            for ch in qs:
                add(_score(q_tokens, q_list, ch.text), {
                    "type": "document", "id": str(ch.pk), "text": ch.text,
                    "document": ch.document.filename, "document_id": str(ch.document_id),
                    "group_id": str(ch.group_id),
                })
        if "decision" in types:
            for d in scoped(Decision.objects.visible_to(user)):
                add(_score(q_tokens, q_list, d.statement), {
                    "type": "decision", "id": str(d.pk), "text": d.statement,
                    "status": d.status, "meeting_id": str(d.meeting_id),
                    "group_id": str(d.group_id),
                })
        if "task" in types:
            for t in scoped(ActionItem.objects.visible_to(user)):
                add(_score(q_tokens, q_list, f"{t.title} {t.description}"), {
                    "type": "task", "id": str(t.pk), "text": t.title,
                    "status": t.status, "meeting_id": str(t.meeting_id),
                    "group_id": str(t.group_id),
                })

        results.sort(key=lambda t: -t[0])
        return Response({
            "query": q,
            "scope": {"group": group_id} if group_id else {"global": True},
            "results": [
                dict(item, score=round(score, 4)) for score, item in results[:limit]
            ],
        })
