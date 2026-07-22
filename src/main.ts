import './style.css';
import {
  deleteGroup,
  deleteMeeting,
  listGroups,
  listMeetings,
  loadSettings,
  saveGroup,
  saveMeeting,
  saveSettings,
} from './lib/db';
import { detectProvider, generate, type ProviderInfo } from './lib/llm';
import { startRecording, type RecorderHandle, type RecordingSource } from './lib/recorder';
import { transcribe, type TranscribeProgress } from './lib/transcriber';
import {
  buildNotesPrompt,
  buildTitlePrompt,
  fitTranscript,
  parseNotesResponse,
  sanitizeTitle,
  transcriptToText,
} from './shared/notesEngine';
import {
  formatDuration,
  formatTimestamp,
  groupMeetings,
  meetingToMarkdown,
  mergeSegments,
  newMeetingId,
  searchMeetings,
} from './shared/format';
import type { ChatMessage, Group, Meeting, MeetingSource, Settings } from './shared/types';
import {
  buildGroupPrompt,
  buildMeetingPrompt,
  groupMemory,
  resolveAnswer,
  retrieveGroupExcerpts,
  retrieveMeetingExcerpts,
} from './lib/rag';

const app = document.querySelector<HTMLDivElement>('#app')!;

// ---------- state ----------

type MeetingTab = 'notes' | 'transcript' | 'chat';

type View =
  | { kind: 'home' }
  | { kind: 'recording'; source: RecordingSource }
  | { kind: 'processing'; label: string; progress: number }
  | { kind: 'meeting'; id: string; tab: MeetingTab }
  | { kind: 'group'; id: string };

let meetings: Meeting[] = [];
let groups: Group[] = [];
let settings: Settings;
let provider: ProviderInfo = { reachable: false, kind: 'ollama', url: '', label: 'Local AI', models: [] };
let view: View = { kind: 'home' };
let searchQuery = '';
let recorder: RecorderHandle | null = null;
let recordTimer: number | null = null;
let settingsOpen = false;
let generating = false;
let chatBusy = false;

// ---------- helpers ----------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message: string) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 200);
  }, 2400);
}

async function refreshMeetings() {
  meetings = await listMeetings();
  groups = await listGroups();
}

function currentGroup(): Group | null {
  const v = view;
  if (v.kind !== 'group') return null;
  return groups.find((g) => g.id === v.id) ?? null;
}

function meetingsInGroup(groupId: string): Meeting[] {
  return meetings.filter((m) => m.groupId === groupId);
}

function newId(): string {
  return (crypto.randomUUID?.() ?? String(Date.now() + Math.random())).replace(/-/g, '').slice(0, 16);
}

async function refreshProvider() {
  provider = await detectProvider(settings.llmUrl);
  if (provider.reachable && provider.models.length > 0 && !provider.models.includes(settings.llmModel)) {
    settings.llmModel = provider.models[0];
    await saveSettings(settings);
  }
}

function currentMeeting(): Meeting | null {
  const v = view;
  if (v.kind !== 'meeting') return null;
  return meetings.find((m) => m.id === v.id) ?? null;
}

// ---------- render ----------

function render() {
  const filtered = searchMeetings(meetings, searchQuery);
  const dateGroups = groupMeetings(filtered);
  const v = view; // const so it narrows inside .map() closures below
  app.innerHTML = `
    <div class="workspace">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/favicon.svg" alt="" width="24" height="24" />
          <span>Sard</span>
          <span class="brand-ar" lang="ar">سرد</span>
        </div>
        <button type="button" class="btn btn-primary btn-full" id="new-meeting">+ New meeting</button>
        <input type="search" class="sidebar-search" id="search" placeholder="Search meetings…" value="${escapeHtml(searchQuery)}" aria-label="Search meetings" />
        <nav class="meeting-nav" aria-label="Meetings and groups">
          <div class="nav-group">
            <div class="nav-group-head">
              <span class="nav-group-label">Groups</span>
              <button type="button" class="nav-add" id="new-group" title="New group" aria-label="New group">+</button>
            </div>
            ${
              groups.length === 0
                ? `<p class="nav-empty nav-empty-sm">No groups yet.</p>`
                : groups
                    .map(
                      (g) => `
                  <button type="button" class="nav-item ${v.kind === 'group' && v.id === g.id ? 'active' : ''}" data-group="${g.id}">
                    <span class="nav-item-title">🗂 ${escapeHtml(g.name)}</span>
                    <span class="nav-item-meta">${meetingsInGroup(g.id).length} meeting${meetingsInGroup(g.id).length === 1 ? '' : 's'}</span>
                  </button>`
                    )
                    .join('')
            }
          </div>
          ${
            filtered.length === 0
              ? `<p class="nav-empty">${meetings.length === 0 ? 'No meetings yet.' : 'No matches.'}</p>`
              : [...dateGroups.entries()]
                  .map(
                    ([label, items]) => `
                <div class="nav-group">
                  <span class="nav-group-label">${label}</span>
                  ${items
                    .map(
                      (m) => `
                    <button type="button" class="nav-item ${v.kind === 'meeting' && v.id === m.id ? 'active' : ''}" data-open="${m.id}">
                      <span class="nav-item-title">${escapeHtml(m.title)}</span>
                      <span class="nav-item-meta">${formatDuration(m.durationSec)}${m.notes ? ' · ✦ notes' : ''}${m.chat?.length ? ' · 💬' : ''}</span>
                    </button>`
                    )
                    .join('')}
                </div>`
                  )
                  .join('')
          }
        </nav>
        <div class="sidebar-foot">
          <button type="button" class="ollama-pill" id="open-settings" title="Settings">
            <span class="status-dot ${provider.reachable ? 'dot-ok' : 'dot-off'}"></span>
            <span>${provider.reachable ? `${provider.label} · ${settings.llmModel || 'no model'}` : 'Local AI offline'}</span>
            <span class="gear" aria-hidden="true">⚙</span>
          </button>
        </div>
      </aside>

      <main class="main-pane">
        ${renderView()}
      </main>
    </div>
    ${settingsOpen ? renderSettingsModal() : ''}
  `;
  wireEvents();
}

function renderView(): string {
  switch (view.kind) {
    case 'home':
      return renderHome();
    case 'recording':
      return renderRecording();
    case 'processing':
      return renderProcessing();
    case 'meeting':
      return renderMeeting();
    case 'group':
      return renderGroup();
  }
}

function renderHome(): string {
  return `
    <div class="home">
      <h1>Meeting notes that never leave your machine.</h1>
      <p class="home-sub">
        Record or import a meeting. Sard transcribes it on-device with Whisper and writes
        Notion-style AI notes with your own local AI model. No cloud, no accounts, no telemetry.
      </p>
      <div class="capture-grid">
        <button type="button" class="capture-card tint-lavender" id="cap-mic">
          <span class="capture-icon" aria-hidden="true">🎙️</span>
          <span class="capture-title">Record microphone</span>
          <span class="capture-desc">In-person meetings and voice memos</span>
        </button>
        <button type="button" class="capture-card tint-sky" id="cap-tab">
          <span class="capture-icon" aria-hidden="true">🖥️</span>
          <span class="capture-title">Record a meeting tab</span>
          <span class="capture-desc">Zoom / Meet in the browser, captures tab audio + your mic</span>
        </button>
        <button type="button" class="capture-card tint-mint" id="cap-upload">
          <span class="capture-icon" aria-hidden="true">📁</span>
          <span class="capture-title">Upload a recording</span>
          <span class="capture-desc">mp3, wav, m4a, webm, ogg</span>
        </button>
        <button type="button" class="capture-card tint-peach" id="cap-paste">
          <span class="capture-icon" aria-hidden="true">📋</span>
          <span class="capture-title">Paste a transcript</span>
          <span class="capture-desc">Already have text? Skip straight to AI notes</span>
        </button>
      </div>
      <input type="file" id="upload-input" accept="audio/*,video/webm" hidden />
      <div class="paste-panel" id="paste-panel" hidden>
        <textarea id="paste-text" rows="8" placeholder="Paste the meeting transcript here…" aria-label="Pasted transcript"></textarea>
        <div class="paste-actions">
          <button type="button" class="btn btn-primary" id="paste-save">Create meeting</button>
          <button type="button" class="btn btn-ghost" id="paste-cancel">Cancel</button>
        </div>
      </div>
      <p class="home-foot">First transcription downloads the Whisper model (~75&nbsp;MB) once, then it's cached offline.</p>
    </div>
  `;
}

function renderRecording(): string {
  return `
    <div class="recording">
      <div class="rec-indicator" aria-hidden="true"></div>
      <h1 id="rec-timer" class="rec-timer">0:00</h1>
      <p class="rec-label">${view.kind === 'recording' && view.source === 'tab-audio' ? 'Recording tab audio + microphone' : 'Recording microphone'}</p>
      <div class="rec-actions">
        <button type="button" class="btn btn-secondary" id="rec-pause">Pause</button>
        <button type="button" class="btn btn-primary" id="rec-stop">■ Stop &amp; transcribe</button>
        <button type="button" class="btn btn-ghost" id="rec-discard">Discard</button>
      </div>
    </div>
  `;
}

function renderProcessing(): string {
  if (view.kind !== 'processing') return '';
  const pct = view.progress >= 0 ? Math.round(view.progress * 100) : null;
  return `
    <div class="processing">
      <div class="spinner" aria-hidden="true"></div>
      <h2>${escapeHtml(view.label)}</h2>
      <div class="progress-track" role="progressbar" ${pct !== null ? `aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"` : ''}>
        <div class="progress-fill ${pct === null ? 'indeterminate' : ''}" style="${pct !== null ? `width:${pct}%` : ''}"></div>
      </div>
      <p class="processing-hint">Everything runs locally, nothing is uploaded.</p>
    </div>
  `;
}

function renderMeeting(): string {
  const m = currentMeeting();
  if (!m) return `<div class="home"><h1>Meeting not found</h1></div>`;
  const tab = view.kind === 'meeting' ? view.tab : 'notes';
  const date = new Date(m.createdAt);

  return `
    <div class="meeting">
      <div class="meeting-head">
        <input class="title-input" id="title-input" value="${escapeHtml(m.title)}" aria-label="Meeting title" maxlength="120" />
        <div class="meeting-meta">
          <span>${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <span>·</span>
          <span>${formatDuration(m.durationSec)}</span>
          <span>·</span>
          <span>${m.source === 'pasted' ? 'pasted transcript' : m.source.replace('-', ' ')}</span>
        </div>
        <div class="meeting-actions">
          <label class="group-assign">
            <span class="group-assign-label">Group</span>
            <select id="assign-group" aria-label="Assign meeting to a group">
              <option value="">None</option>
              ${groups.map((g) => `<option value="${g.id}" ${m.groupId === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
              <option value="__new__">+ New group…</option>
            </select>
          </label>
          <button type="button" class="btn btn-secondary btn-sm" id="copy-md">Copy Markdown</button>
          <button type="button" class="btn btn-secondary btn-sm" id="download-md">Export .md</button>
          <button type="button" class="btn btn-ghost btn-sm" id="delete-meeting">Delete</button>
        </div>
      </div>

      <div class="tabs" role="tablist">
        <button type="button" class="tab ${tab === 'notes' ? 'active' : ''}" data-tab="notes" role="tab">✦ AI Notes</button>
        <button type="button" class="tab ${tab === 'transcript' ? 'active' : ''}" data-tab="transcript" role="tab">Transcript</button>
        <button type="button" class="tab ${tab === 'chat' ? 'active' : ''}" data-tab="chat" role="tab">💬 Chat</button>
      </div>

      ${tab === 'notes' ? renderNotesTab(m) : tab === 'transcript' ? renderTranscriptTab(m) : renderChatTab(m)}
    </div>
  `;
}

// Renders one chat thread (used by both meeting and group chat).
function renderChatThread(messages: ChatMessage[], placeholder: string, emptyHint: string): string {
  const log = messages
    .map((msg) => {
      if (msg.role === 'user') {
        return `<div class="chat-msg chat-user"><p>${escapeHtml(msg.text)}</p></div>`;
      }
      const cites = msg.notFound
        ? `<span class="pill pill-warn">not in the transcript</span>`
        : msg.citations
            .map(
              (c) =>
                `<span class="cite-chip" title="${escapeHtml(c.quote)}">${c.meetingTitle ? `${escapeHtml(c.meetingTitle)} ` : ''}${escapeHtml(c.time ?? '')} [${c.label}]</span>`
            )
            .join(' ');
      return `<div class="chat-msg chat-assistant"><p>${escapeHtml(msg.text)}</p><div class="chat-cites">${cites}</div></div>`;
    })
    .join('');
  return `
    <p class="chat-hint">${escapeHtml(emptyHint)}</p>
    <div class="chat-log" id="chat-log">${log || '<p class="cloud-hint" style="text-align:center">Ask your first question below.</p>'}</div>
    <form class="chat-form" id="chat-form">
      <input name="q" id="chat-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" ${chatBusy || !provider.reachable ? 'disabled' : ''} />
      <button type="submit" class="btn btn-primary" ${chatBusy || !provider.reachable ? 'disabled' : ''}>${chatBusy ? 'Thinking…' : 'Ask'}</button>
    </form>
    ${provider.reachable ? '' : '<p class="cloud-hint">Start your local AI (Ollama, LM Studio, Jan) to use Chat. Detected models power the answers.</p>'}
  `;
}

function renderChatTab(m: Meeting): string {
  if (m.segments.length === 0) {
    return `<div class="notes-empty"><p>No transcript to chat with yet.</p></div>`;
  }
  return `<div class="chat">${renderChatThread(
    m.chat ?? [],
    'Ask about this meeting…',
    'Answers come from your local AI over this meeting’s transcript only. If it is not in the transcript, Sard says so.'
  )}</div>`;
}

function renderGroup(): string {
  const g = currentGroup();
  if (!g) return `<div class="home"><h1>Group not found</h1></div>`;
  const gm = meetingsInGroup(g.id);
  const memory = groupMemory(gm);
  return `
    <div class="meeting">
      <div class="meeting-head">
        <input class="title-input" id="group-title-input" value="${escapeHtml(g.name)}" aria-label="Group name" maxlength="120" />
        <div class="meeting-meta">
          <span>🗂 Group</span><span>·</span><span>${gm.length} meeting${gm.length === 1 ? '' : 's'}</span>
          <span>·</span><span>${memory.length} fact${memory.length === 1 ? '' : 's'} in memory</span>
        </div>
        <div class="meeting-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="delete-group">Delete group</button>
        </div>
      </div>

      <div class="group-body">
        <section class="note-block">
          <h3>Meetings in this group</h3>
          ${
            gm.length === 0
              ? '<p class="cloud-hint">Open a meeting and set its Group to add it here.</p>'
              : `<ul class="group-meetings">${gm
                  .map((m) => `<li><button type="button" class="btn btn-link" data-open="${m.id}">${escapeHtml(m.title)}</button> <span class="nav-item-meta">${m.notes ? '✦ notes' : 'no notes yet'}</span></li>`)
                  .join('')}</ul>`
          }
        </section>

        <section class="note-block">
          <h3>Group memory <span class="cloud-hint" style="font-weight:400">derived from your notes</span></h3>
          ${
            memory.length === 0
              ? '<p class="cloud-hint">Generate AI notes on the meetings above, and their decisions and key points collect here.</p>'
              : `<ul>${memory.map((f) => `<li>${escapeHtml(f.statement)} <span class="cite-chip">${escapeHtml(f.meetingTitle)}</span></li>`).join('')}</ul>`
          }
        </section>

        <section class="note-block">
          <h3>Ask across this group</h3>
          <div class="chat">${renderChatThread(
            g.chat ?? [],
            'Ask across every meeting in this group…',
            'Answers draw on all transcripts and facts in this group, cited to the meeting they came from.'
          )}</div>
        </section>
      </div>
    </div>
  `;
}

function renderNotesTab(m: Meeting): string {
  if (!m.notes) {
    return `
      <div class="notes-empty">
        <p>No AI notes yet for this meeting.</p>
        ${
          provider.reachable
            ? `<div class="generate-row">
                <select id="model-select" class="model-select" aria-label="Local AI model">
                  ${provider.models.map((mo) => `<option value="${escapeHtml(mo)}" ${mo === settings.llmModel ? 'selected' : ''}>${escapeHtml(mo)}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-primary" id="generate-notes" ${generating ? 'disabled' : ''}>${generating ? 'Generating…' : '✦ Generate AI notes'}</button>
              </div>`
            : `<div class="ollama-help">
                <p><strong>No local AI server found.</strong> ${escapeHtml(provider.error ?? '')}</p>
                <p class="mono-block">Works with <code>Ollama</code>, <code>LM Studio</code>, <code>Jan</code>, <code>llamafile</code>, or any OpenAI-compatible server. Quickest start: install Ollama, then <code>ollama pull llama3.2</code>.</p>
                <button type="button" class="btn btn-secondary btn-sm" id="retry-ollama">Retry detection</button>
              </div>`
        }
      </div>
    `;
  }

  const n = m.notes;
  return `
    <div class="notes">
      <section class="note-block">
        <h3>Summary</h3>
        <p>${escapeHtml(n.summary)}</p>
      </section>
      ${
        n.keyPoints.length > 0
          ? `<section class="note-block"><h3>Key points</h3><ul>${n.keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></section>`
          : ''
      }
      ${
        n.actionItems.length > 0
          ? `<section class="note-block"><h3>Action items</h3>
              <div class="action-list">
                ${n.actionItems
                  .map(
                    (a, i) => `
                  <label class="action-item">
                    <input type="checkbox" data-action-idx="${i}" ${a.done ? 'checked' : ''} />
                    <span class="action-text ${a.done ? 'done' : ''}">${escapeHtml(a.text)}${a.owner ? ` <span class="pill">@${escapeHtml(a.owner)}</span>` : ''}${a.due ? ` <span class="pill pill-due">${escapeHtml(a.due)}</span>` : ''}</span>
                  </label>`
                  )
                  .join('')}
              </div>
            </section>`
          : ''
      }
      ${
        n.decisions.length > 0
          ? `<section class="note-block"><h3>Decisions</h3><ul>${n.decisions.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul></section>`
          : ''
      }
      <p class="notes-meta">Generated locally by ${escapeHtml(n.model)} · ${new Date(n.generatedAt).toLocaleString()}
        <button type="button" class="btn btn-ghost btn-sm" id="regen-notes" ${generating ? 'disabled' : ''}>${generating ? 'Regenerating…' : 'Regenerate'}</button>
      </p>
    </div>
  `;
}

function renderTranscriptTab(m: Meeting): string {
  if (m.segments.length === 0) return `<div class="notes-empty"><p>No transcript for this meeting.</p></div>`;
  return `
    <div class="transcript">
      ${m.segments
        .map(
          (s) => `
        <div class="seg">
          <span class="seg-time">${formatTimestamp(s.start)}</span>
          <p class="seg-text">${escapeHtml(s.text.trim())}</p>
        </div>`
        )
        .join('')}
    </div>
  `;
}

function renderSettingsModal(): string {
  return `
    <div class="modal-overlay" id="settings-overlay">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" class="modal-close" id="close-settings" aria-label="Close">✕</button>
        </div>
        <label class="field">
          <span>Local AI server URL (blank = auto-detect Ollama, LM Studio, Jan, llamafile)</span>
          <input id="set-url" type="text" value="${escapeHtml(settings.llmUrl)}" placeholder="auto-detect" />
        </label>
        <label class="field">
          <span>Default model ${provider.reachable ? `(${provider.models.length} available via ${provider.label})` : '(no local AI server detected)'}</span>
          ${
            provider.reachable && provider.models.length > 0
              ? `<select id="set-model">${provider.models.map((mo) => `<option value="${escapeHtml(mo)}" ${mo === settings.llmModel ? 'selected' : ''}>${escapeHtml(mo)}</option>`).join('')}</select>`
              : `<input id="set-model" type="text" value="${escapeHtml(settings.llmModel)}" placeholder="llama3.2" />`
          }
        </label>
        <label class="field">
          <span>Whisper model (larger = more accurate, slower)</span>
          <select id="set-whisper">
            <option value="onnx-community/whisper-tiny.en" ${settings.whisperModel.includes('tiny') ? 'selected' : ''}>whisper-tiny.en (~40 MB, fastest)</option>
            <option value="onnx-community/whisper-base" ${settings.whisperModel.includes('base') ? 'selected' : ''}>whisper-base (~75 MB, recommended)</option>
            <option value="onnx-community/whisper-small" ${settings.whisperModel.includes('small') ? 'selected' : ''}>whisper-small (~250 MB, most accurate)</option>
          </select>
        </label>
        <button type="button" class="btn btn-primary btn-full" id="save-settings">Save settings</button>
      </div>
    </div>
  `;
}

// ---------- flows ----------

async function beginRecording(source: RecordingSource) {
  try {
    recorder = await startRecording(source);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Could not start recording.');
    return;
  }
  view = { kind: 'recording', source };
  render();
  recordTimer = window.setInterval(() => {
    const el = document.querySelector('#rec-timer');
    if (el && recorder) el.textContent = formatDuration(recorder.elapsedSec());
  }, 500);
}

function stopTimer() {
  if (recordTimer !== null) {
    clearInterval(recordTimer);
    recordTimer = null;
  }
}

async function finishRecording(discard: boolean) {
  if (!recorder) return;
  stopTimer();
  const durationSec = recorder.elapsedSec();
  const source: MeetingSource = view.kind === 'recording' && view.source === 'tab-audio' ? 'tab-audio' : 'microphone';
  const blob = await recorder.stop();
  recorder = null;
  if (discard) {
    view = { kind: 'home' };
    render();
    return;
  }
  await processAudio(blob, durationSec, source);
}

async function processAudio(blob: Blob, durationSec: number, source: MeetingSource) {
  view = { kind: 'processing', label: 'Preparing…', progress: -1 };
  render();

  const onProgress = (p: TranscribeProgress) => {
    view = { kind: 'processing', label: p.detail, progress: p.progress };
    const label = document.querySelector('.processing h2');
    const fill = document.querySelector<HTMLDivElement>('.progress-fill');
    if (label) label.textContent = p.detail;
    if (fill) {
      if (p.progress >= 0) {
        fill.classList.remove('indeterminate');
        fill.style.width = `${Math.round(p.progress * 100)}%`;
      } else {
        fill.classList.add('indeterminate');
      }
    }
  };

  let segments;
  try {
    segments = await transcribe(blob, settings.whisperModel, onProgress);
  } catch (err) {
    showToast(err instanceof Error ? `Transcription failed: ${err.message}` : 'Transcription failed.');
    view = { kind: 'home' };
    render();
    return;
  }

  const meeting: Meeting = {
    id: newMeetingId(),
    title: `Meeting, ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    createdAt: new Date().toISOString(),
    durationSec: Math.round(durationSec),
    source,
    segments: mergeSegments(segments),
    notes: null,
  };
  await saveMeeting(meeting);
  await refreshMeetings();
  view = { kind: 'meeting', id: meeting.id, tab: 'transcript' };
  render();
  showToast('Transcript ready');
  if (provider.reachable) void generateNotes(meeting.id);
}

async function createFromPaste(text: string) {
  const meeting: Meeting = {
    id: newMeetingId(),
    title: `Meeting, ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    createdAt: new Date().toISOString(),
    durationSec: 0,
    source: 'pasted',
    segments: [{ start: 0, end: 0, text: text.trim() }],
    notes: null,
  };
  await saveMeeting(meeting);
  await refreshMeetings();
  view = { kind: 'meeting', id: meeting.id, tab: 'notes' };
  render();
  if (provider.reachable) void generateNotes(meeting.id);
}

async function generateNotes(meetingId: string) {
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting || generating) return;
  const model = (document.querySelector<HTMLSelectElement>('#model-select')?.value ?? settings.llmModel).trim();
  if (!model) {
    showToast('Pick a local AI model first (Settings).');
    return;
  }
  generating = true;
  render();

  const transcript = fitTranscript(transcriptToText(meeting.segments));
  try {
    const response = await generate(provider, model, buildNotesPrompt(transcript));
    const parsed = parseNotesResponse(response);
    if (!parsed.ok) {
      showToast(`Notes failed: ${parsed.error}`);
      return;
    }
    meeting.notes = { ...parsed.notes!, model, generatedAt: new Date().toISOString() };

    // Auto-title untitled meetings.
    if (meeting.title.startsWith('Meeting, ')) {
      try {
        const titleRaw = await generate(provider, model, buildTitlePrompt(transcript));
        meeting.title = sanitizeTitle(titleRaw);
      } catch {
        /* keep default title */
      }
    }
    await saveMeeting(meeting);
    await refreshMeetings();
    if (view.kind === 'meeting' && view.id === meetingId) view = { kind: 'meeting', id: meetingId, tab: 'notes' };
    showToast('AI notes ready ✦');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Local AI request failed.');
  } finally {
    generating = false;
    render();
  }
}

// ---------- chat + groups ----------

function activeModel(): string {
  return (settings.llmModel || provider.models[0] || '').trim();
}

async function askMeetingChat(meetingId: string, question: string) {
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting || chatBusy) return;
  const model = activeModel();
  if (!provider.reachable || !model) {
    showToast('Start your local AI first (Ollama, LM Studio, Jan).');
    return;
  }
  meeting.chat = meeting.chat ?? [];
  meeting.chat.push({ id: newId(), role: 'user', text: question, citations: [], notFound: false, at: new Date().toISOString() });
  chatBusy = true;
  render();
  try {
    const excerpts = retrieveMeetingExcerpts(meeting, question);
    const raw = await generate(provider, model, buildMeetingPrompt(question, excerpts));
    const result = resolveAnswer(raw, excerpts, 'This meeting’s transcript does not contain that information.');
    meeting.chat.push({ id: newId(), role: 'assistant', text: result.text, citations: result.citations, notFound: result.notFound, at: new Date().toISOString() });
    await saveMeeting(meeting);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Local AI request failed.');
  } finally {
    chatBusy = false;
    render();
    scrollChatToEnd();
  }
}

async function askGroupChat(groupId: string, question: string) {
  const group = groups.find((g) => g.id === groupId);
  if (!group || chatBusy) return;
  const model = activeModel();
  if (!provider.reachable || !model) {
    showToast('Start your local AI first (Ollama, LM Studio, Jan).');
    return;
  }
  group.chat = group.chat ?? [];
  group.chat.push({ id: newId(), role: 'user', text: question, citations: [], notFound: false, at: new Date().toISOString() });
  chatBusy = true;
  render();
  try {
    const gm = meetingsInGroup(groupId);
    const excerpts = retrieveGroupExcerpts(gm, question);
    const memory = groupMemory(gm).map((f) => `${f.statement} (${f.meetingTitle})`);
    const raw = await generate(provider, model, buildGroupPrompt(question, excerpts, memory));
    const result = resolveAnswer(raw, excerpts, 'No meeting in this group covers that.');
    group.chat.push({ id: newId(), role: 'assistant', text: result.text, citations: result.citations, notFound: result.notFound, at: new Date().toISOString() });
    await saveGroup(group);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Local AI request failed.');
  } finally {
    chatBusy = false;
    render();
    scrollChatToEnd();
  }
}

function scrollChatToEnd() {
  const log = document.querySelector('#chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

async function createGroup(name: string): Promise<Group | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const group: Group = { id: newId(), name: trimmed, createdAt: new Date().toISOString() };
  await saveGroup(group);
  await refreshMeetings();
  return group;
}

// ---------- events ----------

function wireEvents() {
  document.querySelector('#new-meeting')?.addEventListener('click', () => {
    view = { kind: 'home' };
    render();
  });

  const search = document.querySelector<HTMLInputElement>('#search');
  search?.addEventListener('input', () => {
    searchQuery = search.value;
    const cursorPos = search.selectionStart;
    render();
    const newSearch = document.querySelector<HTMLInputElement>('#search');
    newSearch?.focus();
    if (cursorPos !== null) newSearch?.setSelectionRange(cursorPos, cursorPos);
  });

  document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view = { kind: 'meeting', id: btn.dataset.open!, tab: 'notes' };
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view = { kind: 'group', id: btn.dataset.group! };
      render();
    });
  });

  document.querySelector('#new-group')?.addEventListener('click', async () => {
    const name = prompt('New group name');
    if (name === null) return;
    const g = await createGroup(name);
    if (g) {
      view = { kind: 'group', id: g.id };
      render();
    }
  });

  document.querySelector('#open-settings')?.addEventListener('click', async () => {
    settingsOpen = true;
    await refreshProvider();
    render();
  });

  document.querySelector('#close-settings')?.addEventListener('click', () => {
    settingsOpen = false;
    render();
  });

  document.querySelector('#settings-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'settings-overlay') {
      settingsOpen = false;
      render();
    }
  });

  document.querySelector('#save-settings')?.addEventListener('click', async () => {
    settings.llmUrl = (document.querySelector<HTMLInputElement>('#set-url')?.value ?? settings.llmUrl).trim();
    settings.llmModel = (document.querySelector<HTMLInputElement | HTMLSelectElement>('#set-model')?.value ?? '').trim();
    settings.whisperModel = document.querySelector<HTMLSelectElement>('#set-whisper')?.value ?? settings.whisperModel;
    await saveSettings(settings);
    await refreshProvider();
    settingsOpen = false;
    render();
    showToast('Settings saved');
  });

  // Home capture cards
  document.querySelector('#cap-mic')?.addEventListener('click', () => void beginRecording('microphone'));
  document.querySelector('#cap-tab')?.addEventListener('click', () => void beginRecording('tab-audio'));
  document.querySelector('#cap-upload')?.addEventListener('click', () => document.querySelector<HTMLInputElement>('#upload-input')?.click());
  document.querySelector<HTMLInputElement>('#upload-input')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await processAudio(file, 0, 'upload');
  });
  document.querySelector('#cap-paste')?.addEventListener('click', () => {
    const panel = document.querySelector<HTMLDivElement>('#paste-panel');
    if (panel) {
      panel.hidden = false;
      document.querySelector<HTMLTextAreaElement>('#paste-text')?.focus();
    }
  });
  document.querySelector('#paste-cancel')?.addEventListener('click', () => {
    const panel = document.querySelector<HTMLDivElement>('#paste-panel');
    if (panel) panel.hidden = true;
  });
  document.querySelector('#paste-save')?.addEventListener('click', () => {
    const text = document.querySelector<HTMLTextAreaElement>('#paste-text')?.value ?? '';
    if (text.trim().length < 20) {
      showToast('Paste at least a few sentences of transcript.');
      return;
    }
    void createFromPaste(text);
  });

  // Recording controls
  document.querySelector('#rec-stop')?.addEventListener('click', () => void finishRecording(false));
  document.querySelector('#rec-discard')?.addEventListener('click', () => void finishRecording(true));
  document.querySelector('#rec-pause')?.addEventListener('click', (e) => {
    if (!recorder) return;
    const btn = e.target as HTMLButtonElement;
    if (recorder.isPaused()) {
      recorder.resume();
      btn.textContent = 'Pause';
    } else {
      recorder.pause();
      btn.textContent = 'Resume';
    }
  });

  // Meeting view
  const titleInput = document.querySelector<HTMLInputElement>('#title-input');
  titleInput?.addEventListener('change', async () => {
    const m = currentMeeting();
    if (!m) return;
    m.title = titleInput.value.trim() || 'Untitled meeting';
    await saveMeeting(m);
    await refreshMeetings();
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (view.kind === 'meeting') {
        view = { ...view, tab: btn.dataset.tab as MeetingTab };
        render();
      }
    });
  });

  // Assign the current meeting to a group (or create one inline).
  document.querySelector<HTMLSelectElement>('#assign-group')?.addEventListener('change', async (e) => {
    const sel = e.target as HTMLSelectElement;
    const m = currentMeeting();
    if (!m) return;
    if (sel.value === '__new__') {
      const name = prompt('New group name');
      const g = name ? await createGroup(name) : null;
      m.groupId = g ? g.id : (m.groupId ?? null);
    } else {
      m.groupId = sel.value || null;
    }
    await saveMeeting(m);
    await refreshMeetings();
    render();
  });

  // Chat form (works for both meeting and group chat).
  document.querySelector('#chat-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#chat-input');
    const q = input?.value.trim() ?? '';
    if (!q) return;
    if (view.kind === 'meeting') void askMeetingChat(view.id, q);
    else if (view.kind === 'group') void askGroupChat(view.id, q);
  });

  // Group view controls.
  const groupTitle = document.querySelector<HTMLInputElement>('#group-title-input');
  groupTitle?.addEventListener('change', async () => {
    const g = currentGroup();
    if (!g) return;
    g.name = groupTitle.value.trim() || 'Untitled group';
    await saveGroup(g);
    await refreshMeetings();
    render();
  });

  document.querySelector('#delete-group')?.addEventListener('click', async () => {
    const g = currentGroup();
    if (!g) return;
    if (!confirm(`Delete group "${g.name}"? Meetings stay, they are just ungrouped.`)) return;
    for (const m of meetingsInGroup(g.id)) {
      m.groupId = null;
      await saveMeeting(m);
    }
    await deleteGroup(g.id);
    await refreshMeetings();
    view = { kind: 'home' };
    render();
    showToast('Group deleted');
  });

  document.querySelector('#generate-notes')?.addEventListener('click', () => {
    if (view.kind === 'meeting') void generateNotes(view.id);
  });
  document.querySelector('#regen-notes')?.addEventListener('click', () => {
    if (view.kind === 'meeting') void generateNotes(view.id);
  });
  document.querySelector('#retry-ollama')?.addEventListener('click', async () => {
    await refreshProvider();
    render();
    showToast(provider.reachable ? `${provider.label} connected` : 'Still no local AI server found');
  });

  document.querySelectorAll<HTMLInputElement>('[data-action-idx]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const m = currentMeeting();
      if (!m?.notes) return;
      const idx = Number(cb.dataset.actionIdx);
      m.notes.actionItems[idx].done = cb.checked;
      await saveMeeting(m);
      render();
    });
  });

  document.querySelector('#copy-md')?.addEventListener('click', async () => {
    const m = currentMeeting();
    if (!m) return;
    await navigator.clipboard.writeText(meetingToMarkdown(m));
    showToast('Markdown copied');
  });

  document.querySelector('#download-md')?.addEventListener('click', () => {
    const m = currentMeeting();
    if (!m) return;
    const blob = new Blob([meetingToMarkdown(m)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${m.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'meeting'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.querySelector('#delete-meeting')?.addEventListener('click', async () => {
    const m = currentMeeting();
    if (!m) return;
    if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
    await deleteMeeting(m.id);
    await refreshMeetings();
    view = { kind: 'home' };
    render();
    showToast('Meeting deleted');
  });
}

// ---------- boot ----------

async function boot() {
  settings = await loadSettings();
  await refreshMeetings();
  render();
  await refreshProvider();
  render();
}

void boot();
