import './style.css';
import { deleteMeeting, listMeetings, loadSettings, saveMeeting, saveSettings } from './lib/db';
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
import type { Meeting, MeetingSource, Settings } from './shared/types';
import { CloudPanel } from './cloud/ui';

const app = document.querySelector<HTMLDivElement>('#app')!;

// ---------- state ----------

type View =
  | { kind: 'home' }
  | { kind: 'recording'; source: RecordingSource }
  | { kind: 'processing'; label: string; progress: number }
  | { kind: 'meeting'; id: string; tab: 'notes' | 'transcript' }
  | { kind: 'workspace' };

let meetings: Meeting[] = [];
let settings: Settings;
let provider: ProviderInfo = { reachable: false, kind: 'ollama', url: '', label: 'Local AI', models: [] };
let view: View = { kind: 'home' };
let searchQuery = '';
let recorder: RecorderHandle | null = null;
let recordTimer: number | null = null;
let settingsOpen = false;
let generating = false;

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
  const groups = groupMeetings(filtered);

  const wasWorkspace = view.kind === 'workspace';
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
        <nav class="meeting-nav" aria-label="Meetings">
          ${
            filtered.length === 0
              ? `<p class="nav-empty">${meetings.length === 0 ? 'No meetings yet.' : 'No matches.'}</p>`
              : [...groups.entries()]
                  .map(
                    ([group, items]) => `
                <div class="nav-group">
                  <span class="nav-group-label">${group}</span>
                  ${items
                    .map(
                      (m) => `
                    <button type="button" class="nav-item ${view.kind === 'meeting' && view.id === m.id ? 'active' : ''}" data-open="${m.id}">
                      <span class="nav-item-title">${escapeHtml(m.title)}</span>
                      <span class="nav-item-meta">${formatDuration(m.durationSec)}${m.notes ? ' · ✦ notes' : ''}</span>
                    </button>`
                    )
                    .join('')}
                </div>`
                  )
                  .join('')
          }
        </nav>
        <div class="sidebar-foot">
          <button type="button" class="ollama-pill" id="open-workspace" title="Groups, memory, and Meeting Chat via a server on this machine">
            <span>🗂 Local workspace</span>
          </button>
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
  if (wasWorkspace) mountWorkspace();
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
    case 'workspace':
      return `<div class="cloud-pane" id="cloud-root"></div>`;
  }
}

// Local workspace panel (groups, memory, Meeting Chat, search) served by a
// Django server running on THIS machine (server/, LOCAL_AUTH mode).
function mountWorkspace() {
  const container = document.querySelector<HTMLElement>('#cloud-root');
  if (!container) return;
  const panel = new CloudPanel({
    container,
    getSettings: () => settings,
    getLocalMeetings: () => meetings,
    onToast: showToast,
    onClose: () => {
      view = { kind: 'home' };
      render();
    },
  });
  void panel.open();
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
          <button type="button" class="btn btn-secondary btn-sm" id="copy-md">Copy Markdown</button>
          <button type="button" class="btn btn-secondary btn-sm" id="download-md">Export .md</button>
          <button type="button" class="btn btn-ghost btn-sm" id="delete-meeting">Delete</button>
        </div>
      </div>

      <div class="tabs" role="tablist">
        <button type="button" class="tab ${tab === 'notes' ? 'active' : ''}" data-tab="notes" role="tab">✦ AI Notes</button>
        <button type="button" class="tab ${tab === 'transcript' ? 'active' : ''}" data-tab="transcript" role="tab">Transcript</button>
      </div>

      ${tab === 'notes' ? renderNotesTab(m) : renderTranscriptTab(m)}
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

  document.querySelector('#open-workspace')?.addEventListener('click', () => {
    view = { kind: 'workspace' };
    render();
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
        view = { ...view, tab: btn.dataset.tab as 'notes' | 'transcript' };
        render();
      }
    });
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
