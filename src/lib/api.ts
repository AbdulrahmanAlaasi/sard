/**
 * Sard 2.0 backend client (docs/ARCHITECTURE.md §1).
 *
 * Auth is Supabase (password grant via plain fetch, no SDK dependency);
 * the access token is sent as a Bearer JWT to the Django API. Everything is
 * optional: when no server is configured the app stays fully local-first.
 */

import type { TranscriptSegment } from '../shared/types';

export interface CloudConfig {
  apiUrl: string; // local Django server, e.g. http://localhost:8000
  // Optional: only for self-hosters using real Supabase auth instead of
  // the server's built-in local sign-in.
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  email: string;
}

const CONFIG_KEY = 'scrivano.cloud.config';
const SESSION_KEY = 'scrivano.cloud.session';

export function loadCloudConfig(): CloudConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as CloudConfig) : null;
  } catch {
    return null;
  }
}

export function saveCloudConfig(config: CloudConfig | null): void {
  if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  else localStorage.removeItem(CONFIG_KEY);
}

export function loadSession(): SessionTokens | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionTokens) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionTokens | null): void {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

/** Map local transcript segments to the idempotent ingestion payload. */
export function segmentsToPayload(
  segments: TranscriptSegment[],
): { sequence: number; start_ms: number; end_ms: number; text: string; speaker_label?: string }[] {
  return segments
    .filter((s) => s.text.trim().length > 0)
    .map((s, i) => ({
      sequence: i,
      start_ms: Math.max(0, Math.round(s.start * 1000)),
      end_ms: Math.max(Math.round(s.start * 1000) + 1, Math.round(s.end * 1000)),
      text: s.text.trim(),
    }));
}

export interface Excerpt {
  segment_id: string;
  sequence: number;
  speaker_label: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

/**
 * Map [n] markers in a model answer back to excerpt citations. Returns the
 * citations actually referenced; an answer with no valid markers has no
 * grounded support and must be sent as not_found (spec §27, honesty over
 * fluency).
 */
export function parseCitationMarkers(
  answer: string,
  excerpts: Excerpt[],
): { segment_id: string; quote: string }[] {
  const seen = new Set<number>();
  const out: { segment_id: string; quote: string }[] = [];
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= excerpts.length && !seen.has(n)) {
      seen.add(n);
      const ex = excerpts[n - 1];
      out.push({ segment_id: ex.segment_id, quote: ex.text.slice(0, 200) });
    }
  }
  return out;
}

/** Build the strict meeting-chat prompt: excerpts of THIS meeting only. */
export function buildMeetingChatPrompt(question: string, excerpts: Excerpt[]): string {
  const list = excerpts
    .map((e, i) => `[${i + 1}] (${e.speaker_label || 'speaker'} ${msToClock(e.start_ms)}–${msToClock(e.end_ms)}) ${e.text}`)
    .join('\n');
  return [
    'You answer questions about ONE meeting using ONLY the transcript excerpts below.',
    'Rules: cite every claim with its excerpt number like [1]. If the excerpts do not',
    'contain the answer, reply exactly: NOT_FOUND. Never use outside knowledge.',
    '',
    'Excerpts:',
    list || '(no relevant excerpts were found)',
    '',
    `Question: ${question}`,
    'Answer:',
  ].join('\n');
}

export function msToClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export class ApiClient {
  private config: CloudConfig;
  private session: SessionTokens | null;

  constructor(config: CloudConfig, session: SessionTokens | null = loadSession()) {
    this.config = config;
    this.session = session;
  }

  get email(): string | null {
    return this.session?.email ?? null;
  }

  get signedIn(): boolean {
    return this.session !== null;
  }

  /** Password-less sign-in against the LOCAL server (LOCAL_AUTH mode). */
  async localSignIn(email: string): Promise<void> {
    const resp = await fetch(`${this.config.apiUrl}/api/auth/local/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new ApiError(resp.status, data.detail || 'Local sign-in failed. Is the server running with LOCAL_AUTH?');
    }
    this.session = { accessToken: data.access_token, refreshToken: '', email: data.email };
    saveSession(this.session);
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.config.supabaseUrl || !this.config.supabaseAnonKey) {
      return this.localSignIn(email);
    }
    const resp = await fetch(
      `${this.config.supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.config.supabaseAnonKey,
        },
        body: JSON.stringify({ email, password }),
      },
    );
    const data = await resp.json();
    if (!resp.ok) {
      throw new ApiError(resp.status, data.error_description || data.msg || 'Sign-in failed');
    }
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      email,
    };
    saveSession(this.session);
  }

  async signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    if (!this.config.supabaseUrl || !this.config.supabaseAnonKey) {
      await this.localSignIn(email);
      return { needsConfirmation: false };
    }
    const resp = await fetch(`${this.config.supabaseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.config.supabaseAnonKey,
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new ApiError(resp.status, data.error_description || data.msg || 'Sign-up failed');
    }
    if (data.access_token) {
      this.session = { accessToken: data.access_token, refreshToken: data.refresh_token, email };
      saveSession(this.session);
      return { needsConfirmation: false };
    }
    return { needsConfirmation: true };
  }

  signOut(): void {
    this.session = null;
    saveSession(null);
  }

  private async refresh(): Promise<boolean> {
    if (!this.session || !this.session.refreshToken) return false;
    if (!this.config.supabaseUrl || !this.config.supabaseAnonKey) return false;
    const resp = await fetch(
      `${this.config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.config.supabaseAnonKey,
        },
        body: JSON.stringify({ refresh_token: this.session.refreshToken }),
      },
    );
    if (!resp.ok) return false;
    const data = await resp.json();
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      email: this.session.email,
    };
    saveSession(this.session);
    return true;
  }

  async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    if (!this.session) throw new ApiError(401, 'Not signed in');
    const resp = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.session.accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (resp.status === 401 && !retried && (await this.refresh())) {
      return this.request<T>(method, path, body, true);
    }
    if (resp.status === 204) return undefined as T;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new ApiError(resp.status, JSON.stringify(data));
    return data as T;
  }

  // --- typed convenience wrappers ---
  listWorkspaces() {
    return this.request<{ id: string; name: string }[]>('GET', '/api/workspaces/');
  }
  createWorkspace(name: string) {
    return this.request<{ id: string; name: string }>('POST', '/api/workspaces/', { name });
  }
  listGroups() {
    return this.request<CloudGroup[]>('GET', '/api/groups/');
  }
  createGroup(workspace: string, name: string, group_type = 'project') {
    return this.request<CloudGroup>('POST', '/api/groups/', { workspace, name, group_type });
  }
  listMeetings(group?: string) {
    return this.request<CloudMeeting[]>('GET', `/api/meetings/${group ? `?group=${group}` : ''}`);
  }
  createMeeting(group: string, title: string) {
    return this.request<CloudMeeting>('POST', '/api/meetings/', { group, title });
  }
  postSegments(meetingId: string, segments: ReturnType<typeof segmentsToPayload>) {
    return this.request<{ created: number; total: number }>(
      'POST', `/api/meetings/${meetingId}/segments/`, { segments },
    );
  }
  finishMeeting(meetingId: string) {
    return this.request<CloudMeeting>('POST', `/api/meetings/${meetingId}/finish/`);
  }
  getIntelligence(meetingId: string) {
    return this.request<Intelligence>('GET', `/api/meetings/${meetingId}/intelligence/`);
  }
  postIntelligence(meetingId: string, payload: unknown) {
    return this.request<{ created: Record<string, number> }>(
      'POST', `/api/meetings/${meetingId}/intelligence/`, payload,
    );
  }
  chatAsk(meetingId: string, question: string, thread?: string) {
    return this.request<{ thread: string; message: string; excerpts: Excerpt[] }>(
      'POST', `/api/meetings/${meetingId}/chat/ask/`, { question, thread },
    );
  }
  chatAnswer(
    meetingId: string,
    thread: string,
    text: string,
    citations: { segment_id: string; quote: string }[],
    notFound: boolean,
  ) {
    return this.request<ChatMessage>('POST', `/api/meetings/${meetingId}/chat/answer/`, {
      thread, text, citations, not_found: notFound,
    });
  }
  memoryReview(groupId: string) {
    return this.request<MemoryReview>('GET', `/api/groups/${groupId}/memory/review/`);
  }
  groupMemory(groupId: string) {
    return this.request<Memory[]>('GET', `/api/groups/${groupId}/memory/`);
  }
  resolveSuggestion(id: string, action: string, extra: Record<string, unknown> = {}) {
    return this.request<{ resolution: string }>(
      'POST', `/api/memory-suggestions/${id}/resolve/`, { action, ...extra },
    );
  }
  resolveConflict(id: string, action: string, note = '') {
    return this.request<{ status: string }>(
      'POST', `/api/memory-conflicts/${id}/resolve/`, { action, note },
    );
  }
  postMemorySuggestions(meetingId: string, suggestions: unknown[]) {
    return this.request<{ created: number }>(
      'POST', `/api/meetings/${meetingId}/memory-suggestions/`, { suggestions },
    );
  }
  search(q: string, group?: string) {
    const params = new URLSearchParams({ q });
    if (group) params.set('group', group);
    return this.request<{ results: SearchResult[] }>('GET', `/api/search/?${params}`);
  }
}

// --- response shapes (mirror the DRF serializers) ---
export interface CloudGroup {
  id: string;
  name: string;
  group_type: string;
  workspace: string;
  is_inbox: boolean;
}
export interface CloudMeeting {
  id: string;
  group: string;
  title: string;
  status: string;
  duration_seconds: number;
  segment_count: number;
  created_at: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations: { segment_id: string; quote: string }[];
  not_found: boolean;
}
export interface Memory {
  id: string;
  statement: string;
  category: string;
  status: string;
  version: number;
}
export interface MemoryReview {
  pending: {
    id: string;
    statement: string;
    category: string;
    citations: { segment_id: string; quote: string }[];
    conflict_candidates: string[];
  }[];
  conflicts: {
    id: string;
    existing_memory: Memory;
    suggestion: { id: string; statement: string; category: string };
  }[];
}
export interface Intelligence {
  summary_sections: { kind: string; order: number; body: string; citations: unknown[] }[];
  topics: { title: string; body: string }[];
  decisions: { statement: string; status: string }[];
  tasks: { id: string; title: string; status: string; owner_name: string | null; due_date: string | null }[];
  commitments: { text: string; status: string }[];
  questions: { text: string; status: string }[];
  risks: { risk: string; impact: string }[];
}
export interface SearchResult {
  type: string;
  id: string;
  text: string;
  group_id: string;
  meeting_id?: string;
  score: number;
}
