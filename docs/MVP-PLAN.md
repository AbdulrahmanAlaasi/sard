# Scrivano 2.0 — Phase 1 Implementation Plan

Ordered increments; each ends deployable with tests green. Nothing ships as a
placeholder (§49/§50).

1. **Backend scaffold** — Django 5 + DRF in `server/`, settings split
   (local/production), Supabase Postgres via `DATABASE_URL` (pgvector), local
   fallback documented, pytest + factory fixtures, seed command, CI job.
2. **Auth & tenancy** — Supabase Auth JWT verification middleware, users
   mirror, workspaces, members, roles, invitations; scoped managers +
   permission tests (§47 "Permissions").
3. **Groups & context** — groups (incl. Meeting Inbox), guided setup API,
   structured context versioning, people, glossary, task standards.
4. **Documents** — private-bucket upload via signed URLs, chunking,
   embeddings via provider registry (local Ollama embedder; labeled mock
   fallback), indexing status.
5. **Meetings & capture** — manual meeting creation, audio upload, browser
   mic recording; client-side Whisper posts transcript segments (STT provider
   = browser); consent record; processing_jobs state machine.
6. **Derived intelligence** — summary, topics, decisions, tasks (context-aware
   rules: never invent owner/deadline; label suggestions), commitments,
   questions, risks — all cited, all idempotent (dedupe_key).
7. **Meeting Chat** — hybrid retrieval hard-filtered by meeting_id, citation
   validation, honest not-found; isolation test suite (§47).
8. **Memory** — suggestions, review queue, approval/edit/reject/temporary/
   merge/replace, conflicts, version history.
9. **Group Intelligence** — group-scoped retrieval excluding non-active
   memory, scope indicator, filters.
10. **Search** — global + group hybrid search over the same scoped managers.
11. **Sharing** — group/workspace/user shares, expiring external links,
    external-safe summary variant.
12. **Frontend evolution** — extend the existing Vite SPA: auth screens,
    dashboard, groups UI, meeting tabs, memory review, search, settings;
    design system refresh (original identity, light/dark, RTL-ready).
13. **Landing page** (§38) + docs (env vars, migrations, seed, local setup,
    deploy, security) + production-readiness checklist.

## Environment variables (initial)
```
DATABASE_URL=postgres://…           # Supabase or local Postgres w/ pgvector
SUPABASE_URL=…                      # auth JWT issuer + storage
SUPABASE_JWT_SECRET=…               # verify access tokens
SUPABASE_SERVICE_KEY=…              # server-side storage signing (never client)
EMBEDDINGS_PROVIDER=ollama|openai_compatible|mock
EMBEDDINGS_URL=http://localhost:11434
EMBEDDINGS_MODEL=nomic-embed-text
DJANGO_SECRET_KEY=…
DJANGO_DEBUG=1                      # local only
```
