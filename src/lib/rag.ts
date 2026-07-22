/**
 * In-browser RAG for Sard. No server, no network beyond the user's own local
 * LLM. Retrieval is a lexical hybrid (token overlap + phrase bonus) over a
 * meeting's transcript, or across a group's meetings. Generation is done by
 * the caller via lib/llm.ts; this module only builds prompts and validates
 * the citations the model produces.
 *
 * Honesty rules (mirrored from the product spec): answers must cite real
 * excerpts, and when the transcript does not contain the answer the honest
 * result is "not found", never an invented claim.
 */

import type { Citation, Meeting, TranscriptSegment } from '../shared/types';

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or',
  'in', 'on', 'at', 'for', 'we', 'i', 'you', 'it', 'this', 'that', 'did', 'do',
  'does', 'what', 'who', 'when', 'where', 'why', 'how', 'will', 'our', 'my',
]);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\w']+/g) ?? []).filter((t) => !STOP.has(t));
}

function score(qTokens: Set<string>, qList: string[], text: string): number {
  const sList = tokens(text);
  if (sList.length === 0) return 0;
  const sSet = new Set(sList);
  const overlap = [...qTokens].filter((t) => sSet.has(t));
  if (overlap.length === 0) return 0;
  let s = overlap.length / (Math.sqrt(qTokens.size) * Math.sqrt(sSet.size));
  const joined = sList.join(' ');
  for (let i = 0; i < qList.length - 1; i++) {
    if (joined.includes(`${qList[i]} ${qList[i + 1]}`)) s += 0.15;
  }
  return s;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** A retrievable unit. Long segments (e.g. a pasted transcript) are split into
 * sentence-sized pieces so retrieval works regardless of how audio was chunked. */
export interface Unit {
  text: string;
  startSec: number;
  meetingId?: string;
  meetingTitle?: string;
}

export function toUnits(segments: TranscriptSegment[], meetingId?: string, meetingTitle?: string): Unit[] {
  const units: Unit[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (text.length <= 320) {
      units.push({ text, startSec: seg.start, meetingId, meetingTitle });
    } else {
      // split a long block into sentences, keeping the segment's start time
      const parts = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
      let buf = '';
      for (const p of parts) {
        buf += p;
        if (buf.length >= 160) {
          units.push({ text: buf.trim(), startSec: seg.start, meetingId, meetingTitle });
          buf = '';
        }
      }
      if (buf.trim()) units.push({ text: buf.trim(), startSec: seg.start, meetingId, meetingTitle });
    }
  }
  return units;
}

export interface Excerpt {
  label: number; // 1-based [n] marker
  text: string;
  time: string;
  startSec: number;
  meetingId?: string;
  meetingTitle?: string;
}

function rank(units: Unit[], question: string, k: number): Excerpt[] {
  const qList = tokens(question);
  const qTokens = new Set(qList);
  if (qTokens.size === 0) return [];
  const scored = units
    .map((u) => ({ u, s: score(qTokens, qList, u.text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  return scored.map((x, i) => ({
    label: i + 1,
    text: x.u.text,
    time: clock(x.u.startSec),
    startSec: x.u.startSec,
    meetingId: x.u.meetingId,
    meetingTitle: x.u.meetingTitle,
  }));
}

/** Meeting Chat: excerpts from THIS meeting's transcript only. */
export function retrieveMeetingExcerpts(meeting: Meeting, question: string, k = 6): Excerpt[] {
  return rank(toUnits(meeting.segments), question, k);
}

/** Group Chat: excerpts across every meeting in the group, each tagged with
 * its source meeting so answers cite where a fact came from. */
export function retrieveGroupExcerpts(meetings: Meeting[], question: string, k = 8): Excerpt[] {
  const units: Unit[] = [];
  for (const m of meetings) units.push(...toUnits(m.segments, m.id, m.title));
  return rank(units, question, k);
}

function excerptLine(e: Excerpt): string {
  const where = e.meetingTitle ? `${e.meetingTitle}, ` : '';
  return `[${e.label}] (${where}${e.time}) ${e.text}`;
}

export function buildMeetingPrompt(question: string, excerpts: Excerpt[]): string {
  return [
    'You answer questions about ONE meeting using ONLY the transcript excerpts below.',
    'Cite every claim with its excerpt number like [1]. If the excerpts do not',
    'contain the answer, reply with exactly: NOT_FOUND. Never use outside knowledge.',
    '',
    'Excerpts:',
    excerpts.length ? excerpts.map(excerptLine).join('\n') : '(no relevant excerpts were found)',
    '',
    `Question: ${question}`,
    'Answer:',
  ].join('\n');
}

export function buildGroupPrompt(question: string, excerpts: Excerpt[], memory: string[]): string {
  return [
    'You answer questions about a GROUP of meetings using ONLY the sources below.',
    'Cite every claim with its excerpt number like [1]. If the sources do not',
    'contain the answer, reply with exactly: NOT_FOUND. Never use outside knowledge.',
    '',
    memory.length ? `Known facts from this group:\n${memory.map((f) => `- ${f}`).join('\n')}\n` : '',
    'Excerpts:',
    excerpts.length ? excerpts.map(excerptLine).join('\n') : '(no relevant excerpts were found)',
    '',
    `Question: ${question}`,
    'Answer:',
  ].join('\n');
}

/** Map [n] markers in the model's answer back to real excerpts. An answer that
 * cites nothing valid has no grounded support, so callers treat it as not-found. */
export function parseCitations(answer: string, excerpts: Excerpt[]): Citation[] {
  const byLabel = new Map(excerpts.map((e) => [e.label, e]));
  const seen = new Set<number>();
  const out: Citation[] = [];
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    const e = byLabel.get(n);
    if (e && !seen.has(n)) {
      seen.add(n);
      out.push({
        label: n,
        quote: e.text.slice(0, 200),
        time: e.time,
        meetingId: e.meetingId,
        meetingTitle: e.meetingTitle,
      });
    }
  }
  return out;
}

export interface ChatResult {
  text: string;
  citations: Citation[];
  notFound: boolean;
}

/** Turn a raw model answer + the excerpts it was given into a stored result,
 * enforcing the honesty rule: no valid citation means not found. */
export function resolveAnswer(raw: string, excerpts: Excerpt[], notFoundText: string): ChatResult {
  const answer = raw.trim();
  const modelSaidNotFound = /NOT_FOUND/i.test(answer) || excerpts.length === 0;
  const citations = modelSaidNotFound ? [] : parseCitations(answer, excerpts);
  const notFound = modelSaidNotFound || citations.length === 0;
  return {
    text: notFound ? notFoundText : answer,
    citations,
    notFound,
  };
}

/** Group "memory": durable facts derived from the notes the user already has,
 * across the group's meetings. No approval queue, it simply reflects the
 * decisions and key points already generated locally. */
export function groupMemory(meetings: Meeting[]): { statement: string; meetingTitle: string }[] {
  const out: { statement: string; meetingTitle: string }[] = [];
  for (const m of meetings) {
    if (!m.notes) continue;
    for (const d of m.notes.decisions) out.push({ statement: d, meetingTitle: m.title });
    for (const p of m.notes.keyPoints) out.push({ statement: p, meetingTitle: m.title });
  }
  return out;
}
