export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface ActionItem {
  text: string;
  owner: string | null;
  due: string | null;
  done: boolean;
}

export interface AiNotes {
  summary: string;
  keyPoints: string[];
  actionItems: ActionItem[];
  decisions: string[];
  model: string;
  generatedAt: string;
}

export type MeetingSource = 'microphone' | 'tab-audio' | 'upload' | 'pasted';

/** One cited source behind a chat answer. `label` is the [n] marker number. */
export interface Citation {
  label: number;
  quote: string;
  time?: string; // mm:ss within the source meeting
  meetingId?: string; // set for group chat, so answers point back to a meeting
  meetingTitle?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations: Citation[];
  notFound: boolean;
  at: string; // ISO
}

export interface Meeting {
  id: string;
  title: string;
  createdAt: string; // ISO
  durationSec: number;
  source: MeetingSource;
  segments: TranscriptSegment[];
  notes: AiNotes | null;
  groupId?: string | null; // optional local grouping
  chat?: ChatMessage[]; // per-meeting RAG chat history
}

/** A local group: organizes meetings and enables cross-meeting chat + memory.
 * Everything lives in the browser; there is no server and no account. */
export interface Group {
  id: string;
  name: string;
  createdAt: string; // ISO
  chat?: ChatMessage[]; // group-level chat history
}

export interface Settings {
  /** Custom local AI server URL. Empty string = auto-detect Ollama / LM Studio / Jan / llamafile. */
  llmUrl: string;
  llmModel: string;
  whisperModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  llmUrl: '',
  llmModel: '',
  whisperModel: 'onnx-community/whisper-base',
};

/** Migrate settings stored by earlier versions that were Ollama-specific. */
export function migrateSettings(raw: Partial<Settings> & { ollamaUrl?: string; ollamaModel?: string }): Settings {
  const llmUrl =
    raw.llmUrl ??
    // The old default pointed explicitly at Ollama; treat it as "auto-detect" now.
    (raw.ollamaUrl && raw.ollamaUrl !== 'http://localhost:11434' ? raw.ollamaUrl : '');
  return {
    llmUrl,
    llmModel: raw.llmModel ?? raw.ollamaModel ?? '',
    whisperModel: raw.whisperModel ?? DEFAULT_SETTINGS.whisperModel,
  };
}
