import path from "node:path";
import { lineOffsets } from "../markdown/documentMap.js";
import { frontmatterTags, parseFrontmatter, type FrontmatterValue } from "../markdown/frontmatter.js";

export type SearchSimpleMatch = {
  match: { start: number; end: number; source: "filename" | "content" };
  context: string;
  heading?: string;
  terms?: string[];
};

export type SearchSimpleHit = {
  filename: string;
  score: number;
  matches: SearchSimpleMatch[];
  title: string;
  date: string;
  tags: string[];
  matchedTerms: string[];
  reasons: string[];
};

export type SearchSimpleResult = {
  result: SearchSimpleHit[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
};

type Term = { text: string; stems: string[] };
type Token = { stem: string; start: number; end: number };
type Field = "title" | "aliases" | "path" | "tags" | "headings" | "body";

export type SearchNote = {
  filename: string;
  content: string;
  bodyStart: number;
  title: string;
  date: string;
  tags: string[];
  aliases: string[];
  headings: Array<{ path: string; start: number }>;
  fields: Record<Field, Token[][]>;
};

const NAME_BOOST = 1;
const TAG_BOOST = 0.5;
const LOCATION_BOOST = 0.25;
const K1 = 1.2;
const BODY_LENGTH_NORMALIZATION = 0.75;
const MAX_EXCERPTS = 3;

const STOPWORDS = new Set([
  "a", "about", "after", "an", "and", "are", "as", "at", "be", "been", "before", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "not",
  "of", "on", "or", "our", "so", "than", "that", "the", "then", "there", "these", "this", "those", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "without", "you", "your"
]);

function parseSearchTerms(query: string): Term[] {
  const terms = new Map<string, Term>();
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const words = tokenize(match[1] ?? match[2] ?? "");
    if (words.length === 0 || (words.length === 1 && words[0] && STOPWORDS.has(words[0].word))) continue;
    const stems = words.map((token) => token.stem);
    terms.set(stems.join(" "), { text: match[1] ?? match[2] ?? "", stems });
  }
  return [...terms.values()];
}

export function buildSearchNote(filename: string, content: string, mtimeMs: number): SearchNote {
  let data: Record<string, FrontmatterValue> = {};
  let bodyStart = 0;
  try {
    const frontmatter = parseFrontmatter(content);
    data = frontmatter.data;
    bodyStart = frontmatter.bodyEnd;
  } catch {
    bodyStart = 0;
  }
  const tags = new Set(frontmatterTags(data));
  const headings: Array<{ path: string; start: number }> = [];
  const stack: string[] = [];
  let inFence = false;
  for (const record of lineOffsets(content)) {
    if (record.start < bodyStart) continue;
    const line = record.text.replace(/\r?\n$/, "");
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading?.[1] && heading[2]) {
      stack.length = heading[1].length - 1;
      stack[heading[1].length - 1] = heading[2];
      headings.push({ path: stack.filter(Boolean).join("::"), start: record.start });
      continue;
    }
    for (const match of line.matchAll(/(?:^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
      if (match[1]) tags.add(match[1]);
    }
  }
  const basename = path.posix.basename(filename, ".md");
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : basename;
  const aliases = stringList(data.aliases ?? data.alias);
  const body = tokenize(content.slice(bodyStart)).map((token) => ({ stem: token.stem, start: token.start + bodyStart, end: token.end + bodyStart }));
  return {
    filename,
    content,
    bodyStart,
    title,
    date: noteDate(data, basename, mtimeMs),
    tags: [...tags].map((tag) => tag.replace(/^#/, "")).sort(),
    aliases,
    headings,
    fields: {
      title: [tokenize(title)],
      aliases: aliases.map((alias) => tokenize(alias)),
      path: [tokenize(filename.replace(/\.md$/, ""))],
      tags: [...tags].map((tag) => tokenize(tag)),
      headings: headings.map((heading) => tokenize(heading.path.split("::").at(-1) ?? "")),
      body: [body]
    }
  };
}

export function rankNotes(
  notes: SearchNote[],
  query: string,
  contextLength: number,
  offset: number,
  limit: number
): SearchSimpleResult {
  const terms = parseSearchTerms(query);
  const needle = query.trim().toLowerCase();
  const averageBodyLength = notes.reduce((sum, note) => sum + (note.fields.body[0]?.length ?? 0), 0) / Math.max(notes.length, 1);
  const hitsByNote = notes.map((note) => terms.map((term) => fieldHits(note, term)));
  const idf = terms.map((_, termIndex) => {
    const df = hitsByNote.filter((hits) => hits[termIndex]?.matched).length;
    return Math.log(1 + (notes.length - df + 0.5) / (df + 0.5));
  });

  const ranked: Array<{ note: SearchNote; hit: Omit<SearchSimpleHit, "matches"> }> = [];
  notes.forEach((note, noteIndex) => {
    const hits = hitsByNote[noteIndex] ?? [];
    const substring = note.content.toLowerCase().includes(needle) || path.posix.basename(note.filename, ".md").toLowerCase().includes(needle);
    const matchedIndexes = terms.map((_, index) => index).filter((index) => hits[index]?.matched);
    if (matchedIndexes.length === 0 && !substring) return;

    const bodyLength = note.fields.body[0]?.length ?? 0;
    const bodyNorm = 1 - BODY_LENGTH_NORMALIZATION + BODY_LENGTH_NORMALIZATION * bodyLength / Math.max(averageBodyLength, 1);
    let score = 0;
    for (const index of matchedIndexes) {
      const counts = hits[index]?.counts;
      if (!counts) continue;
      const body = counts.body ?? 0;
      let termScore = body / (body + K1 * bodyNorm);
      if (counts.title || counts.aliases) termScore += NAME_BOOST;
      if (counts.tags) termScore += TAG_BOOST;
      if (counts.path) termScore += LOCATION_BOOST;
      if (counts.headings) termScore += LOCATION_BOOST;
      score += (idf[index] ?? 0) * termScore;
    }
    const idfTotal = idf.reduce((sum, value) => sum + value, 0);
    if (substring && terms.length > 1) score += 0.5 * idfTotal / terms.length;
    if (terms.length === 0) score += 1;
    const matchedTerms = matchedIndexes.map((index) => terms[index]?.text ?? "");
    ranked.push({
      note,
      hit: {
        filename: note.filename,
        score: Number(score.toFixed(4)),
        title: note.title,
        date: note.date,
        tags: note.tags,
        matchedTerms,
        reasons: reasons(note, terms, hits, matchedIndexes, substring)
      }
    });
  });

  ranked.sort((a, b) => b.hit.score - a.hit.score || a.hit.filename.localeCompare(b.hit.filename));
  const page = ranked.slice(offset, offset + limit).map(({ note, hit }) => ({
    filename: hit.filename,
    score: hit.score,
    matches: excerpts(note, terms, needle, contextLength),
    title: hit.title,
    date: hit.date,
    tags: hit.tags,
    matchedTerms: hit.matchedTerms,
    reasons: hit.reasons
  }));
  const hasMore = offset + page.length < ranked.length;
  return {
    result: page,
    total: ranked.length,
    offset,
    limit,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {})
  };
}

function fieldHits(note: SearchNote, term: Term): { matched: boolean; counts: Partial<Record<Field, number>>; sources: Partial<Record<Field, number[]>> } {
  const counts: Partial<Record<Field, number>> = {};
  const sources: Partial<Record<Field, number[]>> = {};
  let matched = false;
  for (const field of Object.keys(note.fields) as Field[]) {
    note.fields[field].forEach((tokens, sourceIndex) => {
      const found = phrasePositions(tokens, term.stems).length;
      if (found === 0) return;
      matched = true;
      counts[field] = (counts[field] ?? 0) + found;
      (sources[field] ??= []).push(sourceIndex);
    });
  }
  return { matched, counts, sources };
}

function phrasePositions(tokens: Token[], stems: string[]): number[] {
  const positions: number[] = [];
  for (let index = 0; index + stems.length <= tokens.length; index += 1) {
    if (stems.every((stem, offset) => tokens[index + offset]?.stem === stem)) positions.push(index);
  }
  return positions;
}

function reasons(
  note: SearchNote,
  terms: Term[],
  hits: Array<ReturnType<typeof fieldHits>>,
  matchedIndexes: number[],
  substring: boolean
): string[] {
  const output: string[] = [];
  if (substring) output.push("contains the exact query text");
  const termsIn = (field: Field) => matchedIndexes.filter((index) => hits[index]?.counts[field]).map((index) => terms[index]?.text ?? "");
  const title = termsIn("title");
  if (title.length) output.push(`title matches: ${title.join(", ")}`);
  const aliasIndexes = new Set(matchedIndexes.flatMap((index) => hits[index]?.sources.aliases ?? []));
  for (const aliasIndex of aliasIndexes) {
    const matched = matchedIndexes.filter((index) => hits[index]?.sources.aliases?.includes(aliasIndex)).map((index) => terms[index]?.text ?? "");
    output.push(`alias "${note.aliases[aliasIndex]}" matches: ${matched.join(", ")}`);
  }
  const tags = termsIn("tags");
  if (tags.length) output.push(`tag matches: ${tags.join(", ")}`);
  const pathTerms = termsIn("path");
  if (pathTerms.length) output.push(`path matches: ${pathTerms.join(", ")}`);
  const headingTerms = termsIn("headings");
  if (headingTerms.length) output.push(`heading matches: ${headingTerms.join(", ")}`);
  const body = matchedIndexes.filter((index) => hits[index]?.counts.body);
  if (body.length) {
    const count = body.reduce((sum, index) => sum + (hits[index]?.counts.body ?? 0), 0);
    output.push(`body has ${body.length}/${terms.length} terms (${count} hits): ${body.map((index) => terms[index]?.text ?? "").join(", ")}`);
  }
  return output;
}

function excerpts(note: SearchNote, terms: Term[], needle: string, contextLength: number): SearchSimpleMatch[] {
  const output: SearchSimpleMatch[] = [];
  const basename = path.posix.basename(note.filename, ".md");
  const basenameIndex = basename.toLowerCase().indexOf(needle);
  if (basenameIndex >= 0) {
    output.push({ match: { start: basenameIndex, end: basenameIndex + needle.length, source: "filename" }, context: basename });
  }

  const body = note.fields.body[0] ?? [];
  const hits: Array<{ term: number; start: number; end: number }> = [];
  terms.forEach((term, termIndex) => {
    for (const position of phrasePositions(body, term.stems)) {
      const first = body[position];
      const last = body[position + term.stems.length - 1];
      if (first && last) hits.push({ term: termIndex, start: first.start, end: last.end });
    }
  });
  const lower = note.content.toLowerCase();
  for (let index = lower.indexOf(needle, note.bodyStart); index >= 0 && needle; index = lower.indexOf(needle, index + needle.length)) {
    hits.push({ term: -1, start: index, end: index + needle.length });
  }
  if (hits.length === 0) return output;

  const sections = new Map<number, typeof hits>();
  for (const hit of hits) {
    const section = sectionIndex(note, hit.start);
    const list = sections.get(section) ?? [];
    list.push(hit);
    sections.set(section, list);
  }
  const bestSections = [...sections.entries()]
    .map(([section, sectionHits]) => ({ section, sectionHits, distinct: distinctTerms(sectionHits).size }))
    .sort((a, b) => b.distinct - a.distinct || b.sectionHits.length - a.sectionHits.length || a.section - b.section)
    .slice(0, MAX_EXCERPTS);

  for (const { section, sectionHits } of bestSections) {
    const sectionStart = section < 0 ? note.bodyStart : note.headings[section]?.start ?? note.bodyStart;
    const sectionEnd = note.headings[section + 1]?.start ?? note.content.length;
    const anchor = sectionHits
      .map((hit) => ({ hit, distinct: distinctTerms(sectionHits.filter((other) => Math.abs(other.start - hit.start) <= contextLength)).size }))
      .sort((a, b) => b.distinct - a.distinct || (b.hit.end - b.hit.start) - (a.hit.end - a.hit.start) || a.hit.start - b.hit.start)[0]?.hit;
    if (!anchor) continue;
    const windowStart = Math.max(sectionStart, anchor.start - contextLength);
    const windowEnd = Math.min(sectionEnd, anchor.end + contextLength);
    const inWindow = sectionHits.filter((hit) => hit.start >= windowStart && hit.end <= windowEnd);
    const match: SearchSimpleMatch = {
      match: { start: anchor.start, end: anchor.end, source: "content" },
      context: note.content.slice(windowStart, windowEnd),
      terms: [...distinctTerms(inWindow)].map((index) => index < 0 ? needle : terms[index]?.text ?? "")
    };
    const heading = note.headings[section]?.path;
    if (section >= 0 && heading) match.heading = heading;
    output.push(match);
  }
  return output;
}

function sectionIndex(note: SearchNote, offset: number): number {
  let result = -1;
  note.headings.forEach((heading, index) => {
    if (heading.start <= offset) result = index;
  });
  return result;
}

function distinctTerms(hits: Array<{ term: number }>): Set<number> {
  return new Set(hits.map((hit) => hit.term));
}

function tokenize(text: string): Array<{ word: string; stem: string; start: number; end: number }> {
  const tokens: Array<{ word: string; stem: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0].toLowerCase();
    tokens.push({ word, stem: stem(word), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  let value = word;
  if (value.endsWith("ies") && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (value.endsWith("ing") && value.length - 3 >= 3) value = value.slice(0, -3);
  else if (value.endsWith("ed") && value.length - 2 >= 3) value = value.slice(0, -2);
  else if (value.endsWith("s") && !/(ss|us|is)$/.test(value)) value = value.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(value) && !/(ll|ss|zz)$/.test(value)) value = value.slice(0, -1);
  if (value.endsWith("e") && value.length > 3) value = value.slice(0, -1);
  return value;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function noteDate(data: Record<string, FrontmatterValue>, basename: string, mtimeMs: number): string {
  for (const key of ["created", "date"]) {
    const value = data[key] as unknown;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  const fromName = basename.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (fromName) return fromName;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}
