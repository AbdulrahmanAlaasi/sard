"""Conflict-candidate detection (spec §8): a new statement conflicts with an
active memory when they talk about the same thing. We fuse two signals that
both work locally with zero credentials:

- lexical: Jaccard overlap of content tokens (works on any backend);
- semantic: cosine over embeddings from the configured provider registry
  (real when Ollama is configured; the deterministic mock is labeled and
  only ever a weak secondary signal).
"""

import re

STOP = {
    "the", "a", "an", "is", "are", "was", "were", "to", "of", "and", "or",
    "in", "on", "at", "for", "our", "we", "it", "this", "that", "be", "by",
}

LEXICAL_THRESHOLD = 0.4
EMBEDDING_THRESHOLD = 0.88


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[\w']+", text.lower()) if t not in STOP}


def lexical_similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def find_conflict_candidates(statement: str, active_memories, embedding=None):
    """Return the memories whose statements likely conflict with `statement`."""
    out = []
    for mem in active_memories:
        if lexical_similarity(statement, mem.statement) >= LEXICAL_THRESHOLD:
            out.append(mem)
            continue
        if (
            embedding is not None
            and mem.embedding
            and cosine(embedding, mem.embedding) >= EMBEDDING_THRESHOLD
        ):
            out.append(mem)
    return out
