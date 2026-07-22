import { describe, expect, it } from 'vitest';

import {
  buildMeetingPrompt,
  groupMemory,
  parseCitations,
  resolveAnswer,
  retrieveGroupExcerpts,
  retrieveMeetingExcerpts,
  toUnits,
} from './rag';
import type { Meeting } from '../shared/types';

function meeting(id: string, title: string, texts: string[], groupId?: string): Meeting {
  return {
    id,
    title,
    createdAt: new Date().toISOString(),
    durationSec: 0,
    source: 'pasted',
    segments: texts.map((t, i) => ({ start: i * 10, end: i * 10 + 8, text: t })),
    notes: null,
    groupId,
  };
}

describe('toUnits', () => {
  it('keeps short segments and splits a long pasted block', () => {
    const short = toUnits([{ start: 5, end: 9, text: 'Budget is twenty thousand.' }]);
    expect(short).toHaveLength(1);
    expect(short[0].startSec).toBe(5);
    const long = 'First sentence here. '.repeat(30);
    const split = toUnits([{ start: 0, end: 0, text: long }]);
    expect(split.length).toBeGreaterThan(1);
  });
});

describe('retrieveMeetingExcerpts', () => {
  const m = meeting('m1', 'Sync', [
    'The marketing budget for the launch is twenty thousand.',
    'We will ship the redesign at the end of October.',
    'Lunch was good.',
  ]);

  it('ranks the relevant segment first and labels excerpts 1..n', () => {
    const ex = retrieveMeetingExcerpts(m, 'what is the budget?');
    expect(ex[0].label).toBe(1);
    expect(ex[0].text).toContain('twenty thousand');
    expect(ex[0].time).toBe('00:00');
  });

  it('returns nothing for an empty question', () => {
    expect(retrieveMeetingExcerpts(m, '   ')).toEqual([]);
  });
});

describe('group retrieval and memory', () => {
  const a = meeting('a', 'Budget call', ['The launch budget is twenty thousand.']);
  const b = meeting('b', 'Hiring call', ['The hiring budget covers two engineers.']);

  it('tags each excerpt with its source meeting', () => {
    const ex = retrieveGroupExcerpts([a, b], 'budget');
    expect(ex.some((e) => e.meetingTitle === 'Budget call')).toBe(true);
    expect(ex.every((e) => e.meetingId === 'a' || e.meetingId === 'b')).toBe(true);
  });

  it('derives memory from existing notes only', () => {
    a.notes = {
      summary: 's', keyPoints: ['Budget is 20k'], actionItems: [],
      decisions: ['Launch in October'], model: 'x', generatedAt: '',
    };
    const mem = groupMemory([a, b]);
    expect(mem.map((f) => f.statement)).toContain('Launch in October');
    expect(mem.every((f) => f.meetingTitle === 'Budget call')).toBe(true);
  });
});

describe('citations and honesty', () => {
  const ex = retrieveMeetingExcerpts(
    meeting('m', 'M', ['The budget is twenty thousand.', 'We ship in October.']),
    'budget and ship date',
  );

  it('maps [n] markers to real excerpts, deduped', () => {
    const cites = parseCitations('20k [1][1] and October [2].', ex);
    expect(cites.map((c) => c.label)).toEqual([1, 2]);
  });

  it('treats an uncited answer as not found', () => {
    const r = resolveAnswer('It is twenty thousand.', ex, 'Not in this transcript.');
    expect(r.notFound).toBe(true);
    expect(r.text).toBe('Not in this transcript.');
  });

  it('treats an explicit NOT_FOUND as not found', () => {
    const r = resolveAnswer('NOT_FOUND', ex, 'Not in this transcript.');
    expect(r.notFound).toBe(true);
  });

  it('keeps a properly cited answer', () => {
    const r = resolveAnswer('The budget is twenty thousand [1].', ex, 'nope');
    expect(r.notFound).toBe(false);
    expect(r.citations).toHaveLength(1);
    expect(r.text).toContain('[1]');
  });
});

describe('buildMeetingPrompt', () => {
  it('numbers excerpts and demands NOT_FOUND honesty', () => {
    const ex = retrieveMeetingExcerpts(meeting('m', 'M', ['Budget is 20k.']), 'budget');
    const prompt = buildMeetingPrompt('What is the budget?', ex);
    expect(prompt).toContain('[1] (00:00)');
    expect(prompt).toContain('NOT_FOUND');
    expect(prompt).toContain('ONLY the transcript excerpts');
  });
});
