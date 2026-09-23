import type { Db } from '../db/sqlite.js';

/**
 * Solar systems named in an answer, so the browser can offer to act on them.
 *
 * The hard part is not finding names, it is not finding them everywhere. EVE
 * has systems called Hope, Center and Reblier, and an answer full of false
 * links is worse than no links at all. Four rules keep it honest:
 *
 * - the match is case-sensitive, so the sentence word "hope" is not the system
 *   "Hope" and Russian prose never matches at all;
 * - it must stand alone between word boundaries, never inside a longer word,
 *   a URL, or a markdown link target;
 * - short names count only in the unmistakable nullsec shape (`F3R-IA`),
 *   because two- and three-letter names collide with ordinary abbreviations;
 * - the candidate must exist in the local SDE, matched exactly as stored.
 *
 * Multi-word names ("New Caldari", "Old Man Star") are matched by trying the
 * longest window first, so the longer name wins over its first word.
 */

const MAX_TEXT_CHARS = 20_000;
const MAX_MENTIONS = 40;
const MAX_NAME_WORDS = 3;
/** Below this, only the nullsec shape (letters, digits and a dash) qualifies. */
const MIN_PLAIN_NAME_CHARS = 4;
const NULLSEC_NAME = /^[A-Z0-9]{1,4}-[A-Z0-9]{1,4}$/;
/** One word of a possible system name: letters, digits, dashes, apostrophes. */
const WORD = /[A-Za-z0-9][A-Za-z0-9'-]*/g;

export type SystemMention = {
  systemId: number;
  name: string;
};

export function findSystemMentions(db: Db, text: string): SystemMention[] {
  if (!text) return [];
  const source = text.slice(0, MAX_TEXT_CHARS);
  const candidates = collectCandidates(stripUninterestingSpans(source));
  if (candidates.size === 0) return [];

  const names = [...candidates];
  const found = new Map<string, number>();
  // One statement, chunked: the candidate set is small, and an IN list keeps
  // this a single index lookup per chunk instead of a scan per word.
  for (let index = 0; index < names.length; index += 200) {
    const chunk = names.slice(index, index + 200);
    const rows = db.prepare(
      `SELECT system_id, name FROM sde_systems WHERE name IN (${chunk.map(() => '?').join(', ')})`,
    ).all(...chunk) as Array<{ system_id: number; name: string }>;
    for (const row of rows) found.set(row.name, row.system_id);
  }

  const mentions: SystemMention[] = [];
  // Report in the order the reader meets them, longest names first within a
  // position so "New Caldari" is offered rather than "New".
  for (const name of orderByFirstAppearance(source, found.keys())) {
    mentions.push({ systemId: found.get(name)!, name });
    if (mentions.length >= MAX_MENTIONS) break;
  }
  return mentions;
}

/**
 * Remove the spans where a name is not a mention: code, existing links, and
 * URLs. Replaced by spaces so every other offset stays where it was.
 */
function stripUninterestingSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => ' '.repeat(block.length))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
    .replace(/https?:\/\/\S+/g, (url) => ' '.repeat(url.length))
    .replace(/\]\([^)]*\)/g, (target) => ' '.repeat(target.length));
}

function collectCandidates(text: string): Set<string> {
  const words: string[] = [];
  for (const match of text.matchAll(WORD)) words.push(match[0]);

  const candidates = new Set<string>();
  for (let index = 0; index < words.length; index += 1) {
    for (let size = Math.min(MAX_NAME_WORDS, words.length - index); size >= 1; size -= 1) {
      const candidate = words.slice(index, index + size).join(' ');
      if (isPlausibleName(candidate)) candidates.add(candidate);
    }
  }
  return candidates;
}

function isPlausibleName(candidate: string): boolean {
  if (!/^[A-Z0-9]/.test(candidate)) return false;
  if (candidate.length >= MIN_PLAIN_NAME_CHARS) return true;
  return NULLSEC_NAME.test(candidate);
}

function orderByFirstAppearance(text: string, names: Iterable<string>): string[] {
  return [...names]
    .map((name) => ({ name, at: text.indexOf(name) }))
    .sort((left, right) => (left.at - right.at) || (right.name.length - left.name.length))
    .map((entry) => entry.name);
}
