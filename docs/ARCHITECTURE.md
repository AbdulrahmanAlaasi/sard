# Scrivano 2.0 — System Architecture

> **Slogan:** Stop splitting your attention in meetings.
> **Promise:** Scrivano lets you remain fully present while it captures the conversation, understands the surrounding context, and turns every meeting into specific decisions, complete tasks, reliable follow-ups, and searchable organizational memory.
> **Prime rule:** *The transcript determines what happened. Approved Group Memory explains why it matters.*

Scrivano 2.0 evolves Scrivano 1.x (local-first, single-user note taker) into a
multi-tenant meeting-intelligence platform, **without abandoning its local-AI
identity**: speech-to-text still runs in the browser (Whisper via
transformers.js, with the q8→fp32 dtype fallback ladder), and LLM inference can
still run against any local runtime (Ollama, LM Studio, Jan, llamafile) or a
configured cloud provider.

## 1. High-level topology

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (SPA — Vite + TypeScript, evolved from Scrivano 1.x)      │
│  · Local Whisper STT (transformers.js, dtype fallback ladder)      │
│  · Local LLM provider layer (llm.ts: Ollama/LM Studio/Jan/…)       │
│  · Mic + tab-audio recorder · Meeting UI · Group UI · RAG chats    │
└──────────────┬─────────────────────────────────────────────────────┘
               │ HTTPS (JWT from Supabase Auth)
┌──────────────▼─────────────────────────────────────────────────────┐
│  Django backend (server/) — DRF API, hosted on Cloudflare;         │
│  runs locally with `manage.py runserver`                           │
│  · AuthZ middleware (workspace/group/meeting scoping)              │
│  · Processing pipeline orchestration (idempotent, retryable)       │
│  · RAG retrieval services (meeting-isolated + group-scoped)        │
│  · Memory suggestion / approval / conflict engine                  │
│  · Audit logging, notifications, exports                           │
└──────┬──────────────────────┬──────────────────────────────────────┘
       │                      │
┌──────▼───────────┐   ┌──────▼──────────────────────────────────────┐
│ Supabase         │   │ Supabase Storage (private buckets)          │
│ Postgres +       │   │ · recordings/  (audio, signed URLs)         │
│ pgvector, RLS    │   │ · documents/   (uploaded knowledge)         │
│ Supabase Auth    │   └─────────────────────────────────────────────┘
└──────────────────┘
```

**Why this split:** the browser does the *AI-heavy, privacy-sensitive* work
(audio never has to leave the machine for transcription); Django owns *truth
and authorization* (who may see what, what is approved memory, what the
pipeline state is); Supabase owns *storage primitives* (Postgres + pgvector,
auth, private object storage with signed URLs).

**Local development:** everything runs locally — Vite dev server + Django
`runserver` + either a local Postgres (with pgvector) or a Supabase project.
No cloud AI credentials are ever required: STT is in-browser and the LLM
provider layer targets local runtimes first. When embeddings need a provider
and none is configured, the backend runs in a clearly labeled **mock mode**
(deterministic hash embeddings) that is never presented as real.

## 2. AI provider abstraction (spec §41)

`server/scrivano/providers/` defines interfaces with swappable implementations
selected by environment configuration:

| Interface        | Default implementation                         | Alternatives |
|------------------|------------------------------------------------|--------------|
| SpeechToText     | **Client-side Whisper** (browser posts segments)| Server-side whisper.cpp, cloud STT |
| Diarization      | Heuristic channel/turn splitter (labeled)       | pyannote, cloud diarization |
| Embeddings       | Local (Ollama `nomic-embed-text` etc.)          | OpenAI-compatible endpoint; MockEmbedder (labeled) |
| LLM              | Local runtime via user's provider settings      | Any OpenAI-compatible endpoint |
| Reranker         | None (hybrid score fusion)                      | Cross-encoder endpoint |
| Translation      | LLM-backed                                      | — |

No product code imports a concrete provider; everything goes through the
interface + registry.

## 3. Processing state machine (spec §22)

A `processing_jobs` row tracks each meeting run. Stages (each idempotent,
individually retryable, keyed by `(meeting_id, stage)`):

```
UPLOADED → VALIDATED → STORED → TRANSCRIBED → DIARIZED → SEGMENTED
  → EMBEDDED → CONTEXT_RETRIEVED → SUMMARIZED → ENTITIES_EXTRACTED
  → MEMORY_SUGGESTED → CHAT_INDEXED → GROUP_INDEX_UPDATED → NOTIFIED → COMPLETE
                     ↘ any stage → FAILED(stage, error) → retry(stage)
```

Idempotency: every derived artifact (summary sections, tasks, decisions,
memory suggestions, transcript segments, notifications) carries a
deterministic `dedupe_key` (`meeting_id + stage + content_hash`); retries
upsert, never duplicate. Partial completion is a first-class visible state.

## 4. Meeting RAG flow (spec §26–27) — strict isolation

```
question → normalize → permission check (workspace, meeting)
  → retrieve WHERE workspace_id = W AND meeting_id = M      ← hard filter
      (hybrid: pgvector cosine + Postgres FTS keyword, fused)
  → expand with neighboring segments (prev/next)
  → build prompt: transcript excerpts + manual notes + meeting summary ONLY
  → generate (user's LLM provider) → validate citations against segment ids
  → unsupported-claim check → answer with [speaker, mm:ss–mm:ss] citations
      or the honest not-found response
```

Group documents, Group Memory, other meetings, and general model knowledge are
**never** placed in the Meeting Chat prompt. Automated isolation tests assert
the retrieval layer cannot return a row whose `meeting_id ≠ M` (§47).

## 5. Group RAG flow (spec §28–29)

Same shape, filter `workspace_id = W AND group_id = G`, sources = approved
**active** memories, documents, structured context, meeting
transcripts/summaries, decisions, tasks, commitments, risks, questions.
Memories with status `rejected | superseded | outdated | archived` are
excluded at query time; superseded facts can be *mentioned as history*, never
asserted as current. Every answer shows the scope indicator ("Answering from:
&lt;Group&gt;") and per-claim citations.

## 6. Memory approval flow (spec §6–9)

```
pipeline emits MemorySuggestion (statement, category, citation, confidence,
                                 conflict candidates via embedding similarity)
   → Memory Review queue → user action:
        approve | edit+approve | reject | temporary | merge | replace | delay
   → approved ⇒ group_memories row (version 1, status=approved)
   → replace ⇒ old memory status=superseded, superseded_by set, version kept
conflict detection: new statement vs active memories (semantic + entity match)
   → memory_conflicts row → conflict card UI → user resolves; nothing is
     silently overwritten; full version history retained
```

Only `approved`/`temporary` (until expiry) memories influence AI output.

## 7. Permission model (spec §35)

Roles: Workspace Owner ▸ Workspace Admin ▸ Group Owner ▸ Group Member ▸
Meeting Editor ▸ Viewer ▸ External Guest. Enforcement is layered:

1. Supabase Auth JWT → Django middleware resolves user + workspace membership.
2. Every ORM query goes through scoped managers
   (`Meeting.objects.visible_to(user)`) — no raw unscoped queries in views.
3. Postgres RLS as defense-in-depth on Supabase (workspace_id policies).
4. External guests see only explicitly shared meetings/summaries; the
   external summary variant excludes Group context by default (§34).
5. Search and RAG retrieval reuse the same scoped managers, so leaks are
   structurally impossible rather than filtered after the fact.

## 8. Page map (spec §36)

```
/                    Landing (§38)
/auth/*              sign up · sign in · verify · reset
/onboarding          workspace → first group → context → upload → invite
/app                 Home dashboard
/app/meetings        list/cards + filters
/app/meetings/:id    Overview · Notes · Transcript · Tasks · Decisions ·
                     Questions · Risks · Memory Suggestions · Meeting Chat ·
                     Recording · Activity · Share
/app/groups          group cards
/app/groups/:id      Overview · Context · Meetings · Intelligence · Tasks ·
                     Decisions · Documents · People · Timeline · Memory · Settings
/app/memory-review   pending suggestions · conflicts · outdated · history
/app/tasks           my/all/by-group/due/overdue/unassigned views
/app/search          global search
/app/settings/*      profile · language · notifications · recording · AI ·
                     integrations · workspace · members · retention · audit
```

Every meeting belongs to a Group; the default Group is **Meeting Inbox**.

## 9. Phase plan (spec §46)

- **Phase 1 (now):** functional core — auth, workspaces, groups, context,
  documents, manual meetings, upload + browser recording, transcription,
  structured notes, context-aware tasks, strict Meeting Chat, Group
  Intelligence, citations, memory suggestions/approval, search, permissions,
  basic sharing.
- **Phase 2:** desktop companion (Tauri), auto meeting detection, system
  audio, calendars, group suggestion engine, recurring-meeting memory,
  pre-meeting briefs, templates.
- **Phase 3:** Slack/Teams/Notion/Jira/Linear/etc. integrations.
- **Phase 4:** SSO, SCIM, retention/legal holds, public API, webhooks.

Nothing unfinished is presented as functional; missing integrations simply do
not appear in the UI.
