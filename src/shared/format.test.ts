import { describe, expect, it } from 'vitest';
import {
  dateGroup,
  formatDuration,
  groupMeetings,
  meetingToMarkdown,
  mergeSegments,
  newMeetingId,
  searchMeetings,
} from './format';
import type { Meeting } from './types';

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm_test',
    title: 'Weekly Sync',
    createdAt: '2026-07-11T10:00:00.000Z',
    durationSec: 1830,
    source: 'microphone',
    segments: [
      { start: 0, end: 5, text: 'Welcome everyone.' },
      { start: 5, end: 12, text: 'Today we discuss the launch.' },
    ],
    notes: {
      summary: 'The team reviewed the launch plan.',
      keyPoints: ['Launch is on track'],
      actionItems: [{ text: 'Send recap email', owner: 'Sara', due: 'Friday', done: false }],
      decisions: ['Keep the August date'],
      model: 'llama3.2',
      generatedAt: '2026-07-11T10:31:00.000Z',
    },
    ...overrides,
  };
}

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(1830)).toBe('30:30');
  });

  it('adds an hours part for long meetings', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('clamps negatives to zero', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('dateGroup', () => {
  const now = new Date('2026-07-11T15:00:00');

  it('classifies today, yesterday, this week, and earlier', () => {
    expect(dateGroup('2026-07-11T09:00:00', now)).toBe('Today');
    expect(dateGroup('2026-07-10T23:00:00', now)).toBe('Yesterday');
    expect(dateGroup('2026-07-07T12:00:00', now)).toBe('This week');
    expect(dateGroup('2026-06-01T12:00:00', now)).toBe('Earlier');
  });
});

describe('groupMeetings', () => {
  it('groups in fixed order and sorts newest-first within groups', () => {
    const now = new Date('2026-07-11T15:00:00');
    const meetings = [
      makeMeeting({ id: 'a', createdAt: '2026-06-01T10:00:00' }),
      makeMeeting({ id: 'b', createdAt: '2026-07-11T08:00:00' }),
      makeMeeting({ id: 'c', createdAt: '2026-07-11T12:00:00' }),
    ];
    const groups = groupMeetings(meetings, now);
    const keys = [...groups.keys()];
    expect(keys).toEqual(['Today', 'Earlier']);
    expect(groups.get('Today')!.map((m) => m.id)).toEqual(['c', 'b']);
  });
});

describe('searchMeetings', () => {
  const meetings = [
    makeMeeting({ id: 'a', title: 'Budget Review' }),
    makeMeeting({ id: 'b', title: 'Standup', segments: [{ start: 0, end: 1, text: 'The database migration is blocked.' }] }),
  ];

  it('returns everything for a blank query', () => {
    expect(searchMeetings(meetings, '  ')).toHaveLength(2);
  });

  it('matches titles case-insensitively', () => {
    expect(searchMeetings(meetings, 'budget').map((m) => m.id)).toEqual(['a']);
  });

  it('matches transcript text', () => {
    expect(searchMeetings(meetings, 'migration').map((m) => m.id)).toEqual(['b']);
  });

  it('matches AI summary text', () => {
    expect(searchMeetings(meetings, 'launch plan').length).toBeGreaterThan(0);
  });
});

describe('meetingToMarkdown', () => {
  it('renders title, metadata, notes sections, and timestamped transcript', () => {
    const md = meetingToMarkdown(makeMeeting());
    expect(md).toContain('# Weekly Sync');
    expect(md).toContain('**Duration:** 30:30');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Key points');
    expect(md).toContain('- [ ] Send recap email (@Sara, due Friday)');
    expect(md).toContain('## Decisions');
    expect(md).toContain('**[0:00]** Welcome everyone.');
  });

  it('marks completed action items with x', () => {
    const meeting = makeMeeting();
    meeting.notes!.actionItems[0].done = true;
    expect(meetingToMarkdown(meeting)).toContain('- [x] Send recap email');
  });

  it('omits notes sections when no notes exist', () => {
    const md = meetingToMarkdown(makeMeeting({ notes: null }));
    expect(md).not.toContain('## Summary');
    expect(md).toContain('## Transcript');
  });
});

describe('mergeSegments', () => {
  it('drops empty segments and sorts by start time', () => {
    const merged = mergeSegments([
      { start: 10, end: 12, text: 'later' },
      { start: 0, end: 2, text: '  ' },
      { start: 2, end: 4, text: 'earlier' },
    ]);
    expect(merged.map((s) => s.text)).toEqual(['earlier', 'later']);
  });
});

describe('newMeetingId', () => {
  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newMeetingId()));
    expect(ids.size).toBe(50);
  });
});
