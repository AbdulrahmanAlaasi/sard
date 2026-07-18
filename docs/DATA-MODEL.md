# Scrivano 2.0 — Database Schema (Supabase Postgres + pgvector)

All tables carry: `id uuid pk`, `created_at`, `updated_at`, `created_by`,
`updated_by`, and (below workspace level) `workspace_id` FK; group-scoped
tables also carry `group_id`. Soft delete via `deleted_at` where marked ⌫.
RLS policies scope every workspace-owned table by membership.

## Identity & tenancy
- **users** — mirrors Supabase Auth (`auth.users`); profile, language, tz.
- **sessions** — managed by Supabase Auth.
- **workspaces** ⌫ — name, logo, owner, settings JSONB (AI, recording,
  consent policy, retention), billing fields.
- **workspace_members** — user, workspace, role
  (`owner|admin|member`), unique (workspace,user).
- **invitations** — email, role, token, expires_at, accepted_at.

## Groups & context
- **groups** ⌫ — workspace, name, type, description, purpose, status, owner,
  dates, default_language, default_template; `is_inbox bool` (the "Meeting
  Inbox" default group, one per workspace, undeletable).
- **group_members** — group, user, role (`owner|member|viewer`).
- **group_context_fields / group_context_values** — versioned structured
  context (business, scope, milestones, constraints, glossary, task
  standards…); field defs are per group-type templates, values are versioned.
- **people / group_people** — external + internal people directory (name,
  email, org, title, role, tz, internal/external), linked to groups.
- **group_documents** ⌫ — filename, source_type, version, visibility,
  processing/indexing status, storage path (private bucket), superseded flag.
- **document_versions** — immutable version rows.
- **document_chunks** — text, page, heading, `embedding vector(768)`,
  FTS tsvector, document + group + workspace FKs.

## Memory
- **group_memories** — statement, category (fact|goal|requirement|decision|
  preference|constraint|responsibility|client_expectation|technical|process|
  risk|historical|deadline|scope|terminology), status (suggested|approved|
  temporary|disputed|outdated|superseded|rejected|archived), source refs,
  citation, people, effective/review/expiration dates, approved_by/at,
  confidence, version, superseded_by FK, `embedding vector(768)`.
- **memory_versions** — full history of every edit.
- **memory_suggestions** — proposed statement, category, source meeting,
  transcript excerpt + speaker + timestamps, confidence, conflict candidates,
  suggested action, reason, resolution, dedupe_key unique.
- **memory_conflicts** — existing memory, new statement + source, status
  (open|resolved), resolution action, note.

## Meetings & capture
- **meetings** ⌫ — group, workspace, title, type, template, scheduled/actual
  times, duration, status, sharing status, language, participants summary.
- **meeting_participants** — meeting, person/user, role, speaker mapping.
- **recordings / recording_tracks** — storage path, mime, duration, mode
  (mic|system|mixed|upload), checksum, retention.
- **consent_records** — meeting, method, confirmed_by, timestamp, policy.
- **transcript_segments** — meeting, sequence, speaker_id, speaker_label,
  speaker_confidence, start_ms, end_ms, original_text, corrected_text,
  language, confidence, `embedding vector(768)`, FTS tsvector,
  dedupe_key unique (idempotent reprocessing).
- **transcript_edits** — segment, editor, before/after, timestamp.
- **manual_notes** — meeting, author, markdown body.

## Derived intelligence (all with `citations` and `dedupe_key`)
- **meeting_summaries / summary_sections** — overview, executive summary,
  objectives (stated vs inferred), follow-up plan, context connections.
- **discussion_topics** — title, body, citation list.
- **decisions** — statement, status (proposed|discussed|tentative|approved|
  rejected|deferred|reversed), owner, reason, alternatives, impact,
  effective date, related goal/requirement, confidence, approval status.
- **action_items** — title, description, owner (nullable — never invented),
  owner_suggested bool, due_date (nullable), due_source, priority, status,
  definition_of_done, dependencies, why, expected outcome, risk_if_delayed,
  meeting/group/decision FKs, external_task_id, sync status.
- **commitments** — text, person, due, recipient, status, citation.
- **questions** — text, status (answered|unanswered|deferred|needs_external|
  needs_client), answer, citation.
- **risks** — risk, impact, owner, mitigation, related milestone/task.
- **citations** — polymorphic (owner_type, owner_id) → transcript segment /
  document chunk / memory, with span metadata. Every AI claim links here.

## Chat
- **meeting_chat_threads / meeting_chat_messages** — meeting-scoped; message
  stores role, text, retrieved segment ids, citation list, not_found flag.
- **group_chat_threads / group_chat_messages** — group-scoped; message stores
  scope filters (dates, meetings, participants, source types) + citations.

## Platform
- **meeting_templates** — scope (personal|group|workspace), agenda, summary
  structure, extraction rules.
- **reusable_ai_actions** — name, prompt template, declared scope
  (meeting|meeting+context|group).
- **calendar_connections / calendar_events** — Phase 2.
- **integrations / integration_sync_records** — Phase 3.
- **notifications** — user, type, payload, channels, read_at, dedupe_key.
- **audit_logs** — actor, action, object type/id, workspace, metadata, ip.
- **processing_jobs** — meeting, stage, status, attempt, error, timing;
  unique (meeting_id, stage).
- **usage_records / subscriptions / billing_records** — stubs, Phase 4.
- **desktop_devices / meeting_detection_events** — Phase 2.

## Indexing
- ivfflat/hnsw on all `embedding` columns; GIN on tsvectors; btree on every
  (workspace_id), (group_id), (meeting_id) FK; partial indexes on active
  memory status and open tasks.
