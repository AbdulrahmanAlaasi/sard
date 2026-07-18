"""Group-scoped retrieval (spec §28–29, docs/ARCHITECTURE.md §5).

Sources, all hard-scoped to one group via its relation managers:
- ACTIVE Group Memory only (approved / unexpired temporary — spec §9);
  rejected/superseded/outdated/archived rows are structurally excluded;
- indexed document chunks;
- meeting transcript segments;
- decisions.

Every hit is returned as a typed source card so the client can render the
scope indicator ("Answering from: <Group>") and per-claim citations.
"""

from memory.models import GroupMemory
from .retrieval import _tokens


def _score(q_tokens: set[str], q_list: list[str], text: str) -> float:
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


def retrieve_group_sources(group, question: str, k: int = 8):
    q_list = _tokens(question)
    q_tokens = set(q_list)
    if not q_tokens:
        return []
    cards = []

    for mem in GroupMemory.active(group):  # active memory only (spec §9)
        s = _score(q_tokens, q_list, mem.statement)
        if s > 0:
            cards.append((s + 0.1, {  # small trust bonus for approved memory
                "source_type": "memory", "id": str(mem.pk),
                "text": mem.statement, "category": mem.category,
                "status": mem.status,
            }))

    for chunk in group.chunks.filter(document__deleted_at__isnull=True,
                                     document__is_superseded=False):
        s = _score(q_tokens, q_list, chunk.text)
        if s > 0:
            cards.append((s, {
                "source_type": "document", "id": str(chunk.pk),
                "text": chunk.text, "document": chunk.document.filename,
                "heading": chunk.heading,
            }))

    for meeting in group.meetings.filter(deleted_at__isnull=True):
        for seg in meeting.segments.all():
            s = _score(q_tokens, q_list, seg.text)
            if s > 0:
                cards.append((s, {
                    "source_type": "transcript", "id": str(seg.pk),
                    "text": seg.text, "meeting": meeting.title,
                    "meeting_id": str(meeting.pk), "speaker_label": seg.speaker_label,
                    "start_ms": seg.start_ms, "end_ms": seg.end_ms,
                }))

    for dec in group.decisions.all():
        s = _score(q_tokens, q_list, dec.statement)
        if s > 0:
            cards.append((s, {
                "source_type": "decision", "id": str(dec.pk),
                "text": dec.statement, "status": dec.status,
                "meeting_id": str(dec.meeting_id),
            }))

    cards.sort(key=lambda t: -t[0])
    return [c for _, c in cards[:k]]


def valid_group_citation_ids(group):
    """Every id an answer may cite, by source type — active memory only."""
    return {
        "memory": {str(pk) for pk in GroupMemory.active(group).values_list("pk", flat=True)},
        "document": {str(pk) for pk in group.chunks.values_list("pk", flat=True)},
        "transcript": {
            str(pk)
            for meeting in group.meetings.filter(deleted_at__isnull=True)
            for pk in meeting.segments.values_list("pk", flat=True)
        },
        "decision": {str(pk) for pk in group.decisions.values_list("pk", flat=True)},
    }
