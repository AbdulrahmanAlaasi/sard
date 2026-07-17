import type { ActionItem, AiNotes, TranscriptSegment } from './types';

/** Max characters of transcript sent to the model in one request. Local models have
 * modest context windows (llama3.2 = 128k tokens but small models degrade long before
 * that); ~24k chars ≈ 6k tokens keeps quality high on 3B-8B models. */
export const MAX_TRANSCRIPT_CHARS = 24000;

export function transcriptToText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim an over-long transcript from the middle, keeping the opening and closing —
 * meetings put agendas up front and decisions/wrap-ups at the end. */
export function fitTranscript(text: string, maxChars: number = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 40;
  return `${text.slice(0, head)}\n\n[... middle of transcript trimmed ...]\n\n${text.slice(text.length - tail)}`;
}

export function buildNotesPrompt(transcript: string): string {
  return `You are a precise meeting-notes assistant. Read the meeting transcript below and produce structured notes.

Respond with ONLY a JSON object in exactly this shape (no markdown fences, no commentary):
{
  "summary": "one concise paragraph (3-5 sentences) covering what the meeting was about and its outcome",
  "keyPoints": ["4-8 short bullet points of the most important topics discussed"],
  "actionItems": [{"text": "the task", "owner": "person's name if stated, else null", "due": "due date/time if stated, else null"}],
  "decisions": ["each concrete decision that was made; empty array if none"]
}

Rules:
- Base everything strictly on the transcript. Never invent names, dates, or tasks.
- If the transcript contains no action items or decisions, return empty arrays for them.
- Keep each key point under 20 words.

TRANSCRIPT:
${transcript}`;
}

export function buildTitlePrompt(transcript: string): string {
  return `Read this meeting transcript and respond with ONLY a short descriptive meeting title (3-7 words, no quotes, no punctuation at the end):

${fitTranscript(transcript, 4000)}`;
}

interface RawNotesShape {
  summary?: unknown;
  keyPoints?: unknown;
  actionItems?: unknown;
  decisions?: unknown;
}

/** Extract the first JSON object from a model response that may include stray prose
 * or markdown fences (small local models often disobey "JSON only"). */
export function extractJsonObject(response: string): string | null {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : response;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

function asActionItems(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) return [];
  const items: ActionItem[] = [];
  for (const raw of value) {
    if (typeof raw === 'string' && raw.trim().length > 0) {
      items.push({ text: raw.trim(), owner: null, due: null, done: false });
      continue;
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const text = asString(obj.text ?? obj.task ?? obj.item);
      if (text.length === 0) continue;
      const owner = asString(obj.owner ?? obj.assignee);
      const due = asString(obj.due ?? obj.deadline ?? obj.dueDate);
      items.push({
        text,
        owner: owner.length > 0 && owner.toLowerCase() !== 'null' ? owner : null,
        due: due.length > 0 && due.toLowerCase() !== 'null' ? due : null,
        done: false,
      });
    }
  }
  return items;
}

export interface ParseResult {
  ok: boolean;
  notes?: Omit<AiNotes, 'model' | 'generatedAt'>;
  error?: string;
}

export function parseNotesResponse(response: string): ParseResult {
  const json = extractJsonObject(response);
  if (!json) return { ok: false, error: 'The model response contained no JSON object.' };
  let raw: RawNotesShape;
  try {
    raw = JSON.parse(json) as RawNotesShape;
  } catch {
    return { ok: false, error: 'The model returned malformed JSON.' };
  }
  const summary = asString(raw.summary);
  if (summary.length === 0) return { ok: false, error: 'The model response was missing a summary.' };
  return {
    ok: true,
    notes: {
      summary,
      keyPoints: asStringArray(raw.keyPoints),
      actionItems: asActionItems(raw.actionItems),
      decisions: asStringArray(raw.decisions),
    },
  };
}

export function sanitizeTitle(response: string): string {
  const cleaned = response
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)[0] ?? '';
  return cleaned.replace(/^["'#*\-\s]+|["'.\s]+$/g, '').slice(0, 80) || 'Untitled meeting';
}
