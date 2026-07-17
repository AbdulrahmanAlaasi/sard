import type { Meeting, TranscriptSegment } from './types';

export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatTimestamp(seconds: number): string {
  return formatDuration(seconds);
}

export type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

export function dateGroup(iso: string, now: Date = new Date()): DateGroup {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOfWeek = new Date(startOfToday.getTime() - 6 * 86400000);
  if (d >= startOfToday) return 'Today';
  if (d >= startOfYesterday) return 'Yesterday';
  if (d >= startOfWeek) return 'This week';
  return 'Earlier';
}

export function groupMeetings(meetings: Meeting[], now: Date = new Date()): Map<DateGroup, Meeting[]> {
  const order: DateGroup[] = ['Today', 'Yesterday', 'This week', 'Earlier'];
  const groups = new Map<DateGroup, Meeting[]>();
  const sorted = [...meetings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const m of sorted) {
    const g = dateGroup(m.createdAt, now);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  return new Map(order.filter((g) => groups.has(g)).map((g) => [g, groups.get(g)!]));
}

export function searchMeetings(meetings: Meeting[], query: string): Meeting[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return meetings;
  return meetings.filter((m) => {
    if (m.title.toLowerCase().includes(q)) return true;
    if (m.notes?.summary.toLowerCase().includes(q)) return true;
    return m.segments.some((s) => s.text.toLowerCase().includes(q));
  });
}

export function meetingToMarkdown(meeting: Meeting): string {
  const lines: string[] = [];
  lines.push(`# ${meeting.title}`);
  lines.push('');
  const date = new Date(meeting.createdAt);
  lines.push(`**Date:** ${date.toLocaleString()}  `);
  lines.push(`**Duration:** ${formatDuration(meeting.durationSec)}`);
  lines.push('');

  if (meeting.notes) {
    lines.push('## Summary');
    lines.push('');
    lines.push(meeting.notes.summary);
    lines.push('');

    if (meeting.notes.keyPoints.length > 0) {
      lines.push('## Key points');
      lines.push('');
      for (const p of meeting.notes.keyPoints) lines.push(`- ${p}`);
      lines.push('');
    }

    if (meeting.notes.actionItems.length > 0) {
      lines.push('## Action items');
      lines.push('');
      for (const a of meeting.notes.actionItems) {
        const meta = [a.owner ? `@${a.owner}` : null, a.due ? `due ${a.due}` : null].filter(Boolean).join(', ');
        lines.push(`- [${a.done ? 'x' : ' '}] ${a.text}${meta ? ` (${meta})` : ''}`);
      }
      lines.push('');
    }

    if (meeting.notes.decisions.length > 0) {
      lines.push('## Decisions');
      lines.push('');
      for (const d of meeting.notes.decisions) lines.push(`- ${d}`);
      lines.push('');
    }
  }

  if (meeting.segments.length > 0) {
    lines.push('## Transcript');
    lines.push('');
    for (const s of meeting.segments) {
      lines.push(`**[${formatTimestamp(s.start)}]** ${s.text.trim()}`);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function newMeetingId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mergeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
}
