import { describe, expect, it } from 'vitest';
import {
  MAX_TRANSCRIPT_CHARS,
  buildNotesPrompt,
  buildTitlePrompt,
  extractJsonObject,
  fitTranscript,
  parseNotesResponse,
  sanitizeTitle,
  transcriptToText,
} from './notesEngine';

describe('transcriptToText', () => {
  it('joins segments, trims, and collapses whitespace', () => {
    const text = transcriptToText([
      { start: 0, end: 2, text: '  Hello team.  ' },
      { start: 2, end: 4, text: '' },
      { start: 4, end: 6, text: "Let's   start." },
    ]);
    expect(text).toBe("Hello team. Let's start.");
  });
});

describe('fitTranscript', () => {
  it('returns short transcripts unchanged', () => {
    expect(fitTranscript('short meeting', 100)).toBe('short meeting');
  });

  it('trims the middle of over-long transcripts, keeping head and tail', () => {
    const long = 'A'.repeat(600) + 'MIDDLE' + 'Z'.repeat(600);
    const fitted = fitTranscript(long, 300);
    expect(fitted.length).toBeLessThanOrEqual(320);
    expect(fitted.startsWith('AAA')).toBe(true);
    expect(fitted.endsWith('ZZZ')).toBe(true);
    expect(fitted).toContain('trimmed');
    expect(fitted).not.toContain('MIDDLE');
  });

  it('has a sane default cap', () => {
    expect(MAX_TRANSCRIPT_CHARS).toBeGreaterThan(10000);
  });
});

describe('buildNotesPrompt / buildTitlePrompt', () => {
  it('embeds the transcript and demands strict JSON', () => {
    const prompt = buildNotesPrompt('We agreed to ship Friday.');
    expect(prompt).toContain('We agreed to ship Friday.');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"actionItems"');
    expect(prompt).toContain('Never invent');
  });

  it('title prompt trims very long transcripts', () => {
    const prompt = buildTitlePrompt('x'.repeat(50000));
    expect(prompt.length).toBeLessThan(5000);
  });
});

describe('extractJsonObject', () => {
  it('extracts a bare JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts JSON from markdown fences', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nDone!')).toBe('{"a":1}');
  });

  it('extracts JSON preceded and followed by prose', () => {
    expect(extractJsonObject('Sure! {"a":{"b":2}} hope that helps')).toBe('{"a":{"b":2}}');
  });

  it('handles braces inside strings', () => {
    expect(extractJsonObject('{"text":"use {curly} braces"}')).toBe('{"text":"use {curly} braces"}');
  });

  it('returns null when no JSON is present', () => {
    expect(extractJsonObject('I could not process that.')).toBeNull();
  });
});

describe('parseNotesResponse', () => {
  const good = JSON.stringify({
    summary: 'The team aligned on the Q3 launch plan.',
    keyPoints: ['Launch moved to August', 'Budget approved'],
    actionItems: [
      { text: 'Draft the announcement', owner: 'Sara', due: 'Friday' },
      { text: 'Update the roadmap', owner: null, due: null },
    ],
    decisions: ['Ship on August 12'],
  });

  it('parses a well-formed response', () => {
    const result = parseNotesResponse(good);
    expect(result.ok).toBe(true);
    expect(result.notes!.summary).toContain('Q3 launch');
    expect(result.notes!.keyPoints).toHaveLength(2);
    expect(result.notes!.actionItems[0]).toEqual({ text: 'Draft the announcement', owner: 'Sara', due: 'Friday', done: false });
    expect(result.notes!.actionItems[1].owner).toBeNull();
    expect(result.notes!.decisions).toEqual(['Ship on August 12']);
  });

  it('parses a response wrapped in prose and fences', () => {
    const result = parseNotesResponse('Here are your notes:\n```json\n' + good + '\n```');
    expect(result.ok).toBe(true);
  });

  it('tolerates action items given as plain strings', () => {
    const result = parseNotesResponse(JSON.stringify({ summary: 'ok', actionItems: ['Email the client'] }));
    expect(result.ok).toBe(true);
    expect(result.notes!.actionItems[0]).toEqual({ text: 'Email the client', owner: null, due: null, done: false });
  });

  it('tolerates alternate action-item field names', () => {
    const result = parseNotesResponse(JSON.stringify({ summary: 'ok', actionItems: [{ task: 'Do it', assignee: 'Omar', deadline: 'Mon' }] }));
    expect(result.ok).toBe(true);
    expect(result.notes!.actionItems[0]).toEqual({ text: 'Do it', owner: 'Omar', due: 'Mon', done: false });
  });

  it('treats the string "null" as a null owner/due', () => {
    const result = parseNotesResponse(JSON.stringify({ summary: 'ok', actionItems: [{ text: 'Task', owner: 'null', due: 'NULL' }] }));
    expect(result.notes!.actionItems[0].owner).toBeNull();
    expect(result.notes!.actionItems[0].due).toBeNull();
  });

  it('fails cleanly on responses without JSON', () => {
    const result = parseNotesResponse('Sorry, I cannot do that.');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails cleanly on JSON missing a summary', () => {
    const result = parseNotesResponse('{"keyPoints":["a"]}');
    expect(result.ok).toBe(false);
  });

  it('drops malformed entries instead of failing the whole parse', () => {
    const result = parseNotesResponse(JSON.stringify({ summary: 'ok', keyPoints: ['good', 42, ''], actionItems: [{}, { text: 'real' }] }));
    expect(result.ok).toBe(true);
    expect(result.notes!.keyPoints).toEqual(['good']);
    expect(result.notes!.actionItems).toHaveLength(1);
  });
});

describe('sanitizeTitle', () => {
  it('strips quotes, bullets, and trailing punctuation', () => {
    expect(sanitizeTitle('"Q3 Launch Planning."')).toBe('Q3 Launch Planning');
    expect(sanitizeTitle('- Weekly Sync')).toBe('Weekly Sync');
  });

  it('takes only the first non-empty line', () => {
    expect(sanitizeTitle('\nBudget Review\nExtra commentary here')).toBe('Budget Review');
  });

  it('falls back on empty responses', () => {
    expect(sanitizeTitle('')).toBe('Untitled meeting');
  });
});
