# AGENTS.md · Sard (سرد) Engineering Rulebook

This file is the single source of truth for every AI coding agent working in this
repository. Read it fully before changing anything. After reading it, you should
rarely need extra human instructions.

## Maintaining This Document

Whenever an AI agent changes the project in a way that affects architecture,
conventions, tooling, workflows, APIs, testing strategy, folder structure,
deployment, security, coding standards, dependencies, or development practices,
the agent MUST update this AGENTS.md within the same task.

- AGENTS.md must always remain synchronized with the repository.
- If multiple instructions conflict, this document becomes the source of truth
  after being updated.
- Never leave this document outdated after making structural project changes.
- Treat AGENTS.md as living documentation, not static documentation.

## Project Overview

- **Product:** Sard (Arabic سرد, "narration, the flow of a story"), an AI meeting
  notetaker that runs **100% locally**. Formerly named Scrivano; the rename is
  complete and the old name must not appear in new user-visible text.
- **Purpose:** record or import a meeting, transcribe it on-device with Whisper,
  and have the user's own local LLM write structured, honest notes, answer
  questions about the meeting (Chat/RAG), and organize meetings into groups with
  a cross-meeting group chat and derived memory. ALL of this runs in the browser
  against the user's local Ollama; there is no server in the shipped product.
  The `server/` Django app is optional legacy for multi-user self-hosting only.
- **Business goal:** free, open-source, reputation-building product. There is
  **no paid tier**; never add pricing, billing, upsells, or "founding access"
  language anywhere (an earlier SaaS plan was deliberately removed by the owner).
- **Users:** individuals and small teams who cannot or will not send meeting
  audio to a cloud.
- **Web presence:** https://sard.alaasi.dev serves ONLY the static landing page.
  The application itself is never hosted on the web; users run it locally.
- **Prime rule (product philosophy):** *the transcript determines what happened;
  approved memory explains why it matters.* Every AI claim must be cited to real
  transcript segments. Owners and deadlines are NEVER invented. "Not in the
  transcript" is a first-class, honest answer. No placeholder or fake data is
  ever presented as real output.
- **Major technologies:** TypeScript + Vite (vanilla DOM, no framework),
  transformers.js Whisper, runtime-agnostic local LLM client; Django 6 + DRF +
  SQLite/Postgres(pgvector) backend; Cloudflare Pages (landing only).

## Repository Structure

| Path | Purpose | Belongs there | Never put there |
|---|---|---|---|
| `src/` | The SPA. Entry `main.ts` (state + render + events), `style.css` (whole design system) | UI logic, brand CSS | Server code, secrets |
| `src/lib/` | Browser services: `db.ts` (IndexedDB: meetings, groups, settings), `llm.ts` (local LLM detection/generation), `recorder.ts`, `transcriber.ts` (Whisper + dtype fallback), `rag.ts` (in-browser retrieval + prompts + citation validation for Chat and Group Chat). `api.ts` is LEGACY (server client, unused by the app) | One capability per file, pure helpers exported for tests | React/framework code, UI rendering |
| `src/shared/` | Pure, DOM-free logic: `notesEngine.ts` (prompts/parsing), `format.ts`, `types.ts` (Meeting, Group, ChatMessage, Citation) | Deterministic functions with unit tests | fetch/DOM/IndexedDB access |
| `src/cloud/` | LEGACY `ui.ts`: the old server-backed workspace panel. NOT imported by the app anymore; kept for reference. Do not wire it back without owner approval | nothing new | new features (build them in the browser instead) |
| `server/` | LEGACY optional Django backend (`scrivano_server` + apps `tenancy`, `groups`, `meetings`, `intelligence`, `chat`, `memory`) for multi-user self-hosting. The shipped app never calls it | Models, DRF viewsets, per-app `test_*.py` | Frontend assets, credentials |
| `public/` | Static assets copied verbatim by Vite: `favicon.svg` (the brand mark), `landing.html` | Static files only | Anything imported by TS |
| `docs/` | `ARCHITECTURE.md`, `DATA-MODEL.md`, `MVP-PLAN.md`, `BRAND.md`, `MARKETING.md` | Design/brand/marketing docs | Code |
| `marketing/carousel/` | Six 1200×750 brand slides (`.html` sources + captured `.png`) | Marketing visuals | App code |
| `dist/` | Build output (gitignored) | Nothing manually | Committed files |
| `site/` | Scratch folder for landing-only web deploys (gitignored) | Generated deploy content | Source files |

Ownership: single maintainer, Abdulrahman Alaasi (GitHub `AbdulrahmanAlaasi`).

## Architecture

- **Style:** local-first SPA. The entire product (capture, transcription, notes,
  Chat/RAG, groups, group memory) runs in the browser. The server is legacy and
  the SPA must never require it.
- **In-browser RAG (`src/lib/rag.ts`):** lexical retrieval (token overlap +
  phrase bonus) over a meeting's transcript units (long blocks split into
  sentences), or across a group's meetings (each excerpt tagged with its source
  meeting). Prompts demand `[n]` citations and `NOT_FOUND` honesty; `main.ts`
  generates via `lib/llm.ts` (Ollama etc.), then `resolveAnswer` enforces the
  rule: no valid citation means not-found (never an invented claim). Group
  "memory" is derived from the decisions + key points already in each meeting's
  notes, with no approval queue.
- **Frontend layering:** `shared/` (pure) ← `lib/` (browser services incl. rag) ←
  `main.ts` (state + rendering). Dependencies point inward only; `shared/`
  imports nothing from `lib/` or UI. `main.ts` persists chat history on the
  Meeting/Group records in IndexedDB.
- **Rendering model:** no framework. A single `view` discriminated union, one
  `render()` that rewrites `#app` innerHTML, then `wireEvents()` re-binds.
  All dynamic text goes through `escapeHtml`/`esc`. Follow this pattern; do not
  introduce a framework or a virtual DOM.
- **Backend layering:** models (with scoped managers) → DRF serializers/viewsets
  → `scrivano_server/urls.py`. No business logic in urls; retrieval logic lives
  in dedicated modules (`chat/retrieval.py`, `chat/group_retrieval.py`,
  `memory/similarity.py`, `scrivano_server/search.py`).
- **Tenancy boundary (non-negotiable):** every workspace-owned query goes
  through `Model.objects.visible_to(user)` (see `tenancy/models.py`). Views
  never run unscoped queries. Cross-workspace leaks must be structurally
  impossible, and tests assert it.
- **RAG isolation (non-negotiable):** Meeting Chat retrieval starts from
  `meeting.segments` only; Group Intelligence retrieval from the group's
  relations, active memory only. Citations are validated server-side; an
  uncited, non-`not_found` answer is rejected with 400.
- **AI providers:** never import a concrete provider in product code. Backend:
  `scrivano_server/providers.py` registry (`ollama` | `mock`; mock is
  deterministic and always labeled `provider="mock"`). Frontend: `lib/llm.ts`
  auto-detects Ollama/LM Studio/Jan/llamafile or any OpenAI-compatible URL.
- **LLM generation is client-side.** The server retrieves and validates; the
  browser generates with the user's local model, maps `[n]` markers to
  citations (`parseCitationMarkers`), and degrades honestly to not-found.
- **Auth:** `SupabaseJWTAuthentication` verifies HS256 bearer tokens. In local
  mode (`LOCAL_AUTH=1`, the DEBUG default) the server issues its own tokens via
  `POST /api/auth/local/` signed with the same secret, so one auth path serves
  both modes. Supabase is optional and only for self-hosters.
- **State:** frontend state is module-level variables in `main.ts` and class
  fields in `CloudPanel`; persistence is IndexedDB (`lib/db.ts`) and
  localStorage (`scrivano.cloud.config` / `scrivano.cloud.session` keys).
- **Data flow (workspace):** capture → Whisper → local notes → optional sync:
  `createMeeting` → idempotent `postSegments` → `finish` → intelligence/chat/
  memory endpoints, each cited and deduped.

## Coding Standards

- **Naming:** TS uses `camelCase` functions/vars, `PascalCase` types/classes,
  `SCREAMING_SNAKE` constants; files are `lowerCamel.ts` or kebab where already
  used. Python follows PEP 8 (`snake_case`, `PascalCase` models).
- **Formatting:** 2-space TS, 4-space Python, ~100-column soft limit. No
  formatter is configured; match surrounding code exactly.
  TODO: adopt Prettier/ruff configs if the owner wants enforced formatting.
- **Comments:** only for constraints the code cannot express (spec references
  like "spec §27", invariants, why-nots). Never narrate what a line does, never
  reference the PR/review process. Docstrings on Django modules explain the
  contract.
- **Copy rule (owner-mandated): no em dashes anywhere** in user-visible text,
  docs, or marketing. Use commas, colons, or a middle dot (·).
- **Functions:** small, single-purpose; pure logic goes to `src/shared/` or a
  backend helper module so it is unit-testable.
- **Async:** `async/await` only; fire-and-forget uses `void promise` in TS.
- **Error handling:** frontend surfaces failures via `showToast`/`onToast` with
  actionable text; never swallow errors silently. Backend raises DRF
  `ValidationError`/`PermissionDenied`/`Http404`; cross-tenant access returns
  404 (not 403) to avoid existence leaks.
- **Logging:** no telemetry, ever. Backend uses default Django logging.
- **Imports:** TS import order: styles, libs, shared, types; Python: stdlib,
  Django/DRF, first-party. No circular imports.
- **Constants/config:** frontend defaults in `shared/types.ts`
  (`DEFAULT_SETTINGS`); backend config only via environment variables read in
  `settings.py` (see `.env.example`). Never hardcode URLs/secrets in logic.
- **Enums:** Django `TextChoices` on the model; TS string literal unions.
- **Immutability/DI:** prefer returning new arrays/objects in shared logic;
  pass dependencies as parameters (`CloudDeps`) instead of importing globals.
- **Reuse:** before writing anything, grep for an existing helper
  (`_tokens`, `_score`, `esc`, `bearer()` test helper, `visible_to`). Duplication
  of these is a review failure.
- **TypeScript specifics:** `strict` with `erasableSyntaxOnly`: constructor
  parameter properties (`constructor(private x)`) are FORBIDDEN; declare fields
  explicitly. `verbatimModuleSyntax`: use `import type` for types. No `any`
  unless interfacing with untyped JSON, and narrow immediately.
- **Python specifics:** Django 6 / DRF. Use `update_fields` on saves.
  TODO: type hints are partial; extend them opportunistically, do not churn.

## Framework Conventions

### Vite SPA (no UI framework)
- One entry (`main.ts`), views as template strings, events wired after render.
- New views: add to the `View` union, a `render<Name>()` function, a `case` in
  `renderView()`, and bindings in `wireEvents()`.
- Assets in `public/` are referenced by absolute path (`/favicon.svg`).

### Django + DRF
- One app per domain; every new app needs: `apps.py`, `models.py`, `api.py`,
  `migrations/`, `test_*.py`, registration in `INSTALLED_APPS`, and routes in
  `scrivano_server/urls.py` (router for flat resources, explicit `path()` for
  nested `/api/meetings/<uuid:meeting_pk>/...` actions).
- Serializers restrict writable fields; per-request queryset scoping happens in
  `get_queryset`/helpers, never in the serializer.
- Idempotency: any pipeline-produced artifact carries a deterministic
  `dedupe_key` (`sha256` of normalized content, prefixed with owning id) and is
  upserted with `get_or_create`.

## UI Conventions (Sard design system)

Defined entirely in `src/style.css` via `:root` tokens; `docs/BRAND.md` is the
authority. Key tokens:

- Colors: canvas `#faf6ef`, surface `#f2ecdf`/`#f7f2e8`, ink `#221d16`,
  saffron primary `#b3541e` (pressed `#94431a`), hairlines `#e5dcc9`/`#cbbfa6`,
  tints sand/sky/olive/peach. Light theme only.
- Typography: Fraunces (display, via `--font-display`), Inter (UI), Noto Naskh
  Arabic for سرد. Headings automatically use Fraunces.
- The Arabic wordmark سرد appears beside "Sard" (class `brand-ar`); keep it.
- Motion: ease `var(--ease-out)` = `cubic-bezier(0.22,1,0.36,1)`; views animate
  `fade-up 0.4s`; hover lifts 2 to 4px; ALWAYS honor `prefers-reduced-motion`
  (a global reduce block exists; do not break it).
- Landing page (`public/landing.html`): self-contained file, scroll-reveal via
  IntersectionObserver **with the safety-net timeout that forces visibility
  after 2.5s**. Never ship reveal animations without that fallback (the page
  once rendered empty because of it).
- Accessibility: `aria-label` on icon-only controls, `lang="ar"` on Arabic
  text, focus-visible styles exist; keep escaping all user text.
- Components reuse existing classes: `btn`/`btn-primary`/`btn-ghost`/`btn-small`
  /`btn-link`, `pill`/`pill-warn`, `cloud-card`, `tabs`/`tab`/`active`, `toast`.

## Backend Conventions

- Auth: bearer JWT through `SupabaseJWTAuthentication`; local tokens from
  `tenancy/local_auth.py` (enabled by `LOCAL_AUTH`, default on in DEBUG,
  password-less by design because the server is user-owned and local).
- Permissions: workspace membership via scoped managers; group roles
  (`owner|member|viewer`) checked in views; viewers are read-only.
- CORS: `scrivano_server/cors.py` (dependency-free) allows only
  `CORS_ALLOWED_ORIGINS` (local Vite ports by default). Extend via env var,
  never with `*`.
- Validation: citations must resolve to segments of the SAME meeting (or typed
  group sources); owner/due fields accepted only with `source="stated"` at
  ingestion or set by humans via PATCH (recorded `"manual"`).
- Processing pipeline: `ProcessingJob` rows per `(meeting, stage)`; endpoints
  that complete a stage upsert the job to `complete`.
- Throttling: DRF anon/user throttles are configured globally; keep them.
- File uploads: validated by size + magic bytes (`MAX_DOCUMENT_BYTES`); storage
  local by default, Supabase bucket optional.
- No queues/workers/emails exist. TODO: background jobs if ever needed.

## API Standards

- REST under `/api/`, DRF routers + nested paths; trailing slashes required.
- No versioning yet (single consumer). TODO: version prefix before any
  third-party consumers exist.
- Errors: DRF-standard bodies; 400 validation, 401 unauthenticated, 403 role
  denial, 404 out-of-scope or missing. Error messages must explain the rule
  (e.g. why an uncited answer was rejected).
- Response shape: flat JSON objects/arrays mirroring serializers; ids are UUID
  strings; timestamps ISO 8601; dates `YYYY-MM-DD`.
- Pagination: none currently (local single-user scale). TODO: add DRF
  pagination if lists grow.
- The public share endpoint `/api/shared/<token>/` is the ONLY unauthenticated
  data endpoint besides `/api/auth/local/`; it serves the external-safe summary
  variant exclusively.
- Documentation: the API surface list in `README.md` must be kept accurate.

## Database

- Base classes: `TimeStampedModel` (UUID pk, created/updated) and
  `WorkspaceScopedModel` (adds workspace FK, created_by, scoped manager). Every
  workspace-owned table extends the latter.
- Soft delete via `deleted_at` where modeled (workspaces, groups, meetings,
  documents); queries must filter `deleted_at__isnull=True`. Deleting a meeting
  hard-deletes its segments so retrieval indexes forget it immediately.
- Migrations: every model change ships a migration in the same commit
  (`manage.py makemigrations <app>`); never edit an applied migration.
- Constraints express invariants (unique dedupe keys, one inbox group per
  workspace, unique `(meeting, stage)`); prefer constraints over app checks.
- Embeddings are JSON columns (SQLite-compatible) mirrored to pgvector on
  Postgres; keep both paths working.
- Dev DB: SQLite via `DATABASE_URL=sqlite:///db.sqlite3`. Seed data: none;
  tests build their own fixtures through the API.

## Testing

- **Backend:** pytest + pytest-django, files `server/<app>/test_*.py` plus
  `server/test_search.py`. Style: build state through the real API with
  `APIClient` and a `bearer()` JWT helper; assert behavior, statuses, and
  isolation (every feature has an "outsider gets 404 / empty" test). Run:
  `DATABASE_URL=sqlite:///db.sqlite3 python -m pytest` from `server/`.
  Current count: 60. New features require tests in the same commit.
- **Frontend:** Vitest, colocated `*.test.ts` next to the module, covering the
  pure logic (`shared/`, `lib/rag.ts` retrieval/citations, `lib/llm.ts` parsing).
  Current count: 65. DOM rendering (Chat tab, groups) is verified by driving the
  built app in a browser against a real local Ollama, not unit tests.
- Isolation tests are sacred: never weaken or delete a test that asserts
  meeting/workspace/memory-status scoping.
- Coverage: no numeric gate. TODO: set thresholds if the owner wants them.

## Security

- **Never commit secrets.** `server/.env` is gitignored; `.env.example` holds
  placeholders only. Known issue: the Supabase credentials for project
  `nykejrrnwjjsgtslyjie` passed through chat and should be rotated by the owner.
- All user text is HTML-escaped before insertion (`escapeHtml`/`esc`); keep it.
- SQL injection is prevented by exclusive ORM use; raw SQL is forbidden.
- Production hardening block in `settings.py` (HSTS, secure cookies, secret
  enforcement) activates when `DEBUG` is off; do not weaken it.
- External share links must always carry an expiry and be revocable.
- PII: meeting audio never leaves the machine; transcripts stay in IndexedDB or
  the user's own server. Do not add telemetry, analytics, or third-party
  scripts (Google Fonts on the landing/app pages is the accepted exception).
- Dependency security: keep the dependency count minimal (see Dependency
  Policy); prefer stdlib/no-dep solutions (e.g. the CORS middleware).

## Performance

- Whisper and LLM work is the dominant cost; keep the UI thread free (workers
  are managed inside transformers.js).
- Bundle: single chunk ~600kB dominated by transformers.js; a size warning is
  known/accepted. Do not add heavy dependencies to the SPA.
- Retrieval is lexical and in-memory per request; fine at local scale.
  TODO: pgvector + FTS fusion behind the same retrieval interfaces for large
  datasets.
- Use `select_related`/`prefetch_related` on list endpoints (existing patterns
  show how).

## Git Workflow

- Default branch `main`; work happens on worktree branches like
  `claude/<name>` and is fast-forward merged (`git merge --ff-only`) into main.
- Commit messages: historical convention is an `autonomous-project:` prefix with
  an imperative summary and the passing test count, e.g.
  `autonomous-project: sharing (58 tests passing)`. Keep commit messages free
  of em dashes going forward. Commits authored by agents end with the
  Co-Authored-By Claude trailer.
- Push after each green increment. Never push red.
- No PR process (single maintainer); no semantic versioning yet.
  TODO: releases/tagging policy.

## CI/CD

- No CI pipeline exists in this repo yet. Validation is local (see Commands).
  TODO: GitHub Actions for vitest + pytest + tsc (note: pushing workflow files
  requires the `workflow` OAuth scope on the owner's gh CLI).
- **Deployment (landing page ONLY):** build the site folder
  (`cp public/landing.html site/index.html && cp public/favicon.svg site/`) and
  `wrangler pages deploy site --project-name sard --branch main`. The
  Cloudflare account MUST be `arkom.293@gmail.com` (verify with
  `wrangler whoami`); never use `graduationproject3mem@gmail.com`. Custom
  domains are attached via the Cloudflare dashboard (wrangler cannot).
- **Never deploy the application (`dist/` with the app) to the web.** The app
  is local-only by owner decision. Rollback for the landing: redeploy a
  previous Pages deployment from the dashboard.

## Commands

| Task | Command (from repo root unless noted) |
|---|---|
| Frontend dev server | `npm run dev` (http://localhost:5173) |
| Frontend tests | `npm test` |
| Typecheck | `npx tsc --noEmit` |
| Production build | `npm run build` (runs tsc first) |
| Preview build | `npm run preview` |
| Backend setup | `cd server && python -m venv .venv && .venv/Scripts/activate && pip install -r requirements.txt` |
| Backend migrate | `cd server && DATABASE_URL=sqlite:///db.sqlite3 python manage.py migrate` |
| Backend run (local mode) | `cd server && python manage.py runserver` (LOCAL_AUTH on by default in DEBUG) |
| Backend tests | `cd server && DATABASE_URL=sqlite:///db.sqlite3 python -m pytest -q` |
| Landing deploy | see CI/CD section (site folder + wrangler) |
| Carousel export | open `marketing/carousel/slideN-*.html` at 1200×750 and screenshot to the matching `.png` |

No Docker, no linters configured. TODO: eslint/ruff if desired.

## Dependency Policy

- Frontend runtime deps: `@huggingface/transformers` ONLY. Dev: vite,
  typescript, vitest. Backend: Django, DRF, dj-database-url, python-dotenv,
  PyJWT, pytest(-django) (see `server/requirements.txt`).
- Adding ANY new dependency requires explicit owner approval in the task
  request. Prefer writing small utilities in-repo (precedent: the CORS
  middleware, the Supabase auth client done with plain `fetch`).
- Forbidden without discussion: UI frameworks, state libraries, CSS frameworks,
  ORMs other than Django's, cloud SDKs, analytics/telemetry of any kind.
- License: repo has a `LICENSE` file at root; dependencies must be
  MIT/BSD/Apache-compatible. TODO: confirm license type before distribution
  claims.

## Documentation Standards

- `README.md` is user-facing: keep the run instructions, API surface summary,
  and test counts accurate whenever behavior changes.
- `docs/ARCHITECTURE.md` and `docs/DATA-MODEL.md` describe the design; update
  them when structure changes (they still use the historical spec § numbers;
  keep those references intact).
- `docs/BRAND.md` governs all visual/copy decisions; `docs/MARKETING.md` holds
  launch collateral (keep it free of paid offers).
- Inline comments follow the Coding Standards rules. Migration notes go in the
  commit message.

## Domain Knowledge

- Terminology: **Group** = context container (every meeting belongs to one; the
  undeletable per-workspace default is the **Meeting Inbox**). **Memory** =
  approved durable fact; only `approved` or unexpired `temporary` memories are
  "active" and may influence AI output. **Citation** = `{segment_id, quote}` or
  typed `{source_type, id, quote}`. **Dedupe key** = idempotency hash.
- Business rules that must never regress:
  1. Uncited artifacts/answers are rejected server-side.
  2. Owners/deadlines only from the transcript (`stated`) or a human (`manual`).
  3. Meeting Chat sees one meeting's transcript, nothing else.
  4. Rejected/superseded/outdated/archived memory is never citable as current.
  5. Nothing is silently overwritten: replacement supersedes + versions.
  6. External shares expire and exclude group context.
  7. Mock embeddings are always labeled and never presented as real.
- Edge cases handled and to preserve: zero-length segments get `end_ms >
  start_ms` (`segmentsToPayload`), re-posting segments/artifacts is a no-op,
  answers with out-of-range `[n]` markers become honest not-found.
- Assumption: single human user per local server; multi-user roles exist for
  self-hosted team deployments.

## Known Technical Debt

- Retrieval is lexical token-overlap, not pgvector ANN (interfaces ready).
- No UI for group context editing, documents upload, people directory,
  transcript editing, or meeting templates (backend APIs exist).
- No client-side pipeline that publishes cited intelligence/memory suggestions
  from locally generated notes (endpoints exist and are tested).
- `src/cloud/ui.ts` naming still uses "Cloud*" identifiers internally though the
  product surface says "Local workspace"; rename opportunistically.
- Legacy Pages project `scrivano` still exists (its custom domain
  `scrivano.alaasi.dev` no longer resolves); do not delete infra without owner
  approval.
- Supabase credentials rotation pending (owner action).
- No CI, no linters, no LICENSE confirmation (see TODOs above).

## Agent Workflow (mandatory, in order)

1. Understand the request; restate it to yourself in one sentence.
2. Inspect the repository (this file, then the relevant folder).
3. Find existing patterns for the change you are making.
4. Reuse the existing architecture; extend, do not fork it.
5. Avoid duplication; grep before writing helpers.
6. Plan minimal changes.
7. Implement.
8. Update or add tests in the same change.
9. Update README/docs affected by the change.
10. Update AGENTS.md if anything structural changed.
11. Run validation (Commands table): `npx tsc --noEmit`, `npm test`,
    `npm run build`, and backend pytest when `server/` changed.
12. Verify no regressions (all suites green, app still loads).
13. Summarize changes honestly, including anything skipped or failing.

Environment note for agents in this workspace: local pre-tool hooks
("Fact-Forcing Gate") may deny the first write/edit of a file or the first
shell command and ask for facts; state the facts and retry the identical
operation. This is expected, not an error.

## Validation Checklist (before declaring done)

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes (55+ tests)
- [ ] `npm run build` succeeds
- [ ] backend `pytest` passes (60+ tests) when server code changed
- [ ] migrations included for any model change
- [ ] documentation updated (README/docs)
- [ ] AGENTS.md updated if conventions/structure changed
- [ ] no secrets committed, `.env` untouched by git
- [ ] no new dependencies without approval
- [ ] no em dashes introduced in user-visible copy
- [ ] no unintentional TODOs left in code

## Never Do

- Never commit secrets, tokens, or `server/.env`.
- Never add pricing, billing, upsells, or paid-tier language.
- Never deploy the application to the web; only the landing page goes online.
- Never present AI output without citations, or invent owners/deadlines.
- Never weaken or delete isolation/citation tests.
- Never bypass the scoped managers with unscoped queries in views.
- Never ignore failing tests or mark red work as done.
- Never disable TypeScript strict options or the reduced-motion support.
- Never introduce a UI framework, CSS framework, or state library.
- Never add telemetry, analytics, or third-party trackers.
- Never rewrite unrelated code or reformat files you are not changing.
- Never duplicate existing helpers instead of importing them.
- Never hardcode configuration; use env vars (backend) or Settings (frontend).
- Never commit generated artifacts (`dist/`, `site/`, sqlite DBs).
- Never change database schema without a migration in the same commit.
- Never remove a test without an equivalent replacement.
- Never rename public API routes without updating the client and README.
- Never use em dashes in copy, docs, or marketing text.
- Never use the wrong Cloudflare account (only `arkom.293@gmail.com`).
- Never delete or overwrite existing Pages projects, DNS records, or repos.
- Never introduce circular imports or upward dependencies (`shared/` stays pure).

## Decision Making

When several solutions exist, prioritize in this order: correctness,
maintainability, simplicity, readability, consistency with existing patterns,
performance, extensibility, developer experience. Only optimize for performance
after correctness is proven. Honesty of AI output outranks feature richness.

## Conflict Resolution

Priority order when instructions conflict:

1. Direct user (owner) instruction in the current task
2. Security (secrets, isolation, privacy invariants)
3. This AGENTS.md
4. Existing project conventions observed in the code
5. Language/framework best practices

If a user instruction contradicts this document, follow the user, then update
this document in the same task so it becomes consistent again.
