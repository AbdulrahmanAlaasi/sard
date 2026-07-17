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

export interface Meeting {
  id: string;
  title: string;
  createdAt: string; // ISO
  durationSec: number;
  source: MeetingSource;
  segments: TranscriptSegment[];
  notes: AiNotes | null;
}

export interface Settings {
  ollamaUrl: string;
  ollamaModel: string;
  whisperModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  whisperModel: 'onnx-community/whisper-base',
};
