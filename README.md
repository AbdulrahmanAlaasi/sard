# Scrivano

**Live demo:** https://scrivano.alaasi.dev · **Primary use:** run it locally (below)

![Scrivano screenshot](docs/screenshot.png)

## Purpose

Scrivano is a local-first AI meeting-notes app — the Notion AI Notes experience, but
private. It records meetings (or imports audio / pasted transcripts), transcribes them
**on-device** with Whisper, and generates structured AI notes — summary, key points,
action items with owners and due dates, and decisions — using **your own local AI
model** (Ollama, LM Studio, Jan, llamafile, or any OpenAI-compatible server; Scrivano
auto-detects whichever is running). Nothing ever leaves your machine: no accounts, no
cloud, no telemetry.

## How the AI works (all local)

| Job | Engine | Where it runs |
|---|---|---|
| Speech-to-text | Whisper via [transformers.js](https://github.com/huggingface/transformers.js) (ONNX, WebGPU/WASM) | In your browser. Model (~75 MB) downloads once, then is cached offline. |
| Summaries, action items, decisions, auto-titles | Any local model via [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), [Jan](https://jan.ai), [llamafile](https://github.com/Mozilla-Ocho/llamafile), or any OpenAI-compatible server | On your machine — auto-detected on the standard ports, or set a custom URL in Settings. |

## Features

- **Four capture modes:** record your microphone; record a meeting tab (browser Zoom/
  Meet — captures tab audio *mixed with* your mic); upload an audio file; or paste an
  existing transcript
- **On-device transcription** with timestamps, live progress for both model download
  and transcription, and a choice of Whisper sizes (tiny / base / small) in Settings.
  If the optimized (quantized) model fails to load on a device — a known onnxruntime-web
  issue on some hardware — Scrivano automatically falls back to the full-precision model
  and remembers what worked
- **AI notes** in Notion's structure: one-paragraph summary, key points, action items
  (with `@owner` and due pills, checkbox state that persists), and decisions — plus
  automatic meeting titling
- **Notion-style dashboard:** sidebar with date-grouped meetings (Today / Yesterday /
  This week / Earlier), full-text search across titles, summaries, and transcripts,
  tabbed AI Notes / Transcript views, editable titles
- **Runtime-agnostic local AI:** auto-detects Ollama (native API) *and* OpenAI-compatible
  servers (LM Studio, Jan, llamafile, vLLM, LocalAI…), lists available models in a
  picker, and shows setup guidance when nothing is running — transcription works fully
  without any LLM server
- **Export** any meeting as Markdown (copy or `.md` download)
- Everything stored in IndexedDB on your machine

## Run it locally (recommended)

```bash
git clone https://github.com/AbdulrahmanAlaasi/scrivano.git
cd scrivano
npm install
npm run dev        # open http://localhost:5173
```

### Set up a local AI server (for AI notes)

Scrivano works with whichever local runtime you already use — it probes the standard
ports automatically (Ollama `11434`, LM Studio `1234`, Jan `1337`, llamafile `8080`),
or you can point it at any OpenAI-compatible URL in Settings.

**Quickest start (Ollama):**

1. Install from [ollama.com](https://ollama.com), then pull a model — `llama3.2` (2 GB)
   is a great default; `qwen2.5:7b` is stronger if you have the RAM:
   ```bash
   ollama pull llama3.2
   ```
2. Make sure it's running. The status pill in Scrivano's sidebar footer turns green.

**Already using LM Studio / Jan / llamafile?** Just start its local server — Scrivano
finds it. For anything else OpenAI-compatible, paste its base URL (ending in `/v1`)
into Settings.

> **Using the hosted demo instead?** Browsers block a website from calling a local
> server unless it allows the origin. For Ollama:
> `OLLAMA_ORIGINS=https://scrivano.alaasi.dev ollama serve`
> (Windows PowerShell: `$env:OLLAMA_ORIGINS="https://scrivano.alaasi.dev"; ollama serve`).
> LM Studio has a CORS toggle in its server settings. Transcription works on the demo
> with no setup at all.

## Scrivano 2.0 — optional self-hosted backend (`server/`)

The SPA above is complete on its own. Scrivano 2.0 adds an **optional** multi-tenant
backend (Django 6 + DRF + Supabase Postgres/pgvector/Auth) that turns meetings into
searchable, cited organizational memory. The app shows a "Cloud workspace" panel once
you point it at a server (sidebar → ☁); until then nothing changes.

Design docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/DATA-MODEL.md](docs/DATA-MODEL.md) · [docs/MVP-PLAN.md](docs/MVP-PLAN.md).
Prime rule: *the transcript determines what happened; approved Group Memory explains
why it matters.* Every AI artifact the API accepts must cite real transcript
segments; owners and deadlines are never invented; Meeting Chat retrieval is
hard-scoped to one meeting; only approved/temporary memory influences answers.

### Backend quick start

```bash
cd server
python -m venv .venv && .venv/Scripts/activate   # or source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # fill in the variables below (SQLite works with none)
python manage.py migrate
python manage.py runserver
```

Environment variables (`server/.env`):

```
DATABASE_URL=postgres://…        # Supabase or local Postgres w/ pgvector; omit for SQLite
SUPABASE_URL=…                   # Supabase project URL (auth + storage)
SUPABASE_JWT_SECRET=…            # verifies user access tokens
SUPABASE_SERVICE_KEY=…           # server-side storage signing only — never ship to a client
DJANGO_SECRET_KEY=…              # required in production
DJANGO_DEBUG=1                   # local only
EMBEDDINGS_PROVIDER=ollama|mock  # "mock" is deterministic and clearly labeled
EMBEDDINGS_URL=http://localhost:11434
EMBEDDINGS_MODEL=nomic-embed-text
```

Backend tests (58, isolation-focused): `DATABASE_URL=sqlite:///db.sqlite3 python -m pytest`

### API surface (all under `/api/`, Supabase JWT bearer auth)

workspaces · groups (+ versioned context, documents) · meetings (+ idempotent
`segments`, `finish`, `jobs`) · `meetings/{id}/intelligence` (cited summary/decisions/
tasks/commitments/questions/risks with dedupe keys) · `meetings/{id}/chat` (strictly
meeting-isolated RAG with citation validation and honest not-found) ·
`meetings/{id}/memory-suggestions` + review/approve/conflict workflow ·
`groups/{id}/chat` (Group Intelligence over active memory) · `tasks` · `search` ·
`meetings/{id}/shares` + expiring external links (`/api/shared/{token}/`, external-safe
summary only).

### Security posture

- Every query path goes through `visible_to` scoped managers — cross-workspace access
  is structurally impossible and covered by tests, not filtered after the fact.
- Citation validation server-side: artifacts and chat answers citing anything outside
  their meeting/group are rejected with 400.
- Production hardening (HSTS, secure cookies, DEBUG-off secret enforcement) activates
  automatically when `DJANGO_DEBUG` is unset; DRF throttling is on by default.
- External share links must carry an expiry and can be revoked; they serve a summary
  variant that excludes group context.

## Testing

```bash
npm test
```

36 unit tests cover the correctness-critical core: transcript flattening and middle-out
trimming for long meetings, prompt construction, robust JSON extraction from imperfect
local-model output (markdown fences, surrounding prose, braces inside strings), notes
parsing with tolerant field aliases (`task`/`assignee`/`deadline`), title sanitization,
duration/date-group formatting, search, Markdown export (including checked action
items), and segment merging.

## Architecture

- `src/shared/notesEngine.ts` — pure prompt builders + response parsers. Local models
  often disobey "JSON only", so `extractJsonObject` does a string-aware brace walk to
  recover the object from fenced or prose-wrapped responses, and the parser tolerates
  alternate field names and drops malformed entries instead of failing the whole parse.
- `src/shared/format.ts` — pure formatting: durations, date grouping, search, Markdown
  export, segment merging.
- `src/lib/transcriber.ts` — lazy-loads transformers.js on first use; decodes any
  browser-supported audio to 16 kHz mono PCM via `OfflineAudioContext`, then transcribes
  in 28-second windows with per-chunk progress.
- `src/lib/recorder.ts` — MediaRecorder wrapper; tab-audio mode mixes `getDisplayMedia`
  audio with the mic through the Web Audio API so both sides of a call are captured.
- `src/lib/llm.ts` — provider-agnostic local AI client: probes Ollama's native API and
  OpenAI-compatible endpoints, normalizes model lists, and routes generation to
  whichever server was detected.
- `src/lib/db.ts` — IndexedDB stores for meetings and settings.
- `src/main.ts` — the workspace shell (sidebar + views) as a small state machine.
- `src/style.css` — Notion's design language: `#37352f` charcoal ink, `#f6f5f4` sidebar,
  purple `#5645d4` primary, pastel capture cards; Inter UI with Source Serif 4 titles.

## Verified end-to-end

The full flow was verified against a **real local model** (`qwen3-coder:30b` via
Ollama): pasted a realistic staff-meeting transcript → generated notes correctly
extracted all three action items with the right owners and due mentions, both
decisions, and auto-titled the meeting — then survived a full page reload from
IndexedDB, checkbox state included.

## Privacy & security

- No network calls except: Google Fonts (UI), one-time Whisper model download from
  Hugging Face, and your own local AI server on localhost. A strict CSP enforces
  exactly that list.
- All user text is escaped before rendering; nothing is ever transmitted to any server.

## Current limitations

- Transcription is batch (after recording stops), not live-streaming captions.
- English-optimized defaults (`whisper-tiny.en` option is English-only; base/small are
  multilingual).
- No speaker diarization — segments are timestamped but not attributed to speakers.
- Browser-tab capture requires a Chromium browser (`getDisplayMedia` audio).

## Future improvements

- Live streaming transcription with rolling AI notes during the meeting.
- Speaker diarization.
- Ask-your-meeting chat (RAG over past transcripts with local embeddings).
- Obsidian/Notion export integrations.

## Professional skills demonstrated

Local-model integration (Ollama REST + defensive parsing of imperfect LLM output),
on-device ML inference (Whisper via ONNX/WASM with chunked processing and progress
reporting), Web Audio (recording, mixing display+mic streams, offline resampling),
IndexedDB persistence, and privacy-first product architecture.
