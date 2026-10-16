import type {
  SearchPassage,
  WorkspaceDocIndex,
  WorkspaceSearchHit,
} from "../types";
import {
  normalizeSearchText,
  normalizedIndexOf,
  searchTerms,
  searchText,
  textFingerprint,
  type NormalizedText,
} from "./search-text";
import { MAX_WORKSPACE_BODY_CHARS } from "./workspace-limits";

type Field = Pick<NormalizedText, "text" | "invalidBreaks" | "offsetsChanged">;
interface SearchableDocument {
  name: Field;
  title: Field;
  headings: Field[];
  blocks: { original: string; field: Field }[];
  haystack: string;
  fingerprint: string;
}
const prepared = new WeakMap<WorkspaceDocIndex, SearchableDocument>();
const MAX_PASSAGE_SPAN = 180;

/** Find the tightest window containing every term, advancing the earliest
 * occurrence each time. An early, distant occurrence must not hide a later pair. */
function nearbyTerms(field: Field, terms: string[]): { start: number; end: number } | null {
  const positions = terms.map(term => normalizedIndexOf(field, term));
  let best: { start: number; end: number } | null = null;
  while (positions.every(position => position >= 0)) {
    let first = 0;
    let end = 0;
    for (let i = 0; i < positions.length; i++) {
      if (positions[i] < positions[first]) first = i;
      end = Math.max(end, positions[i] + terms[i].length);
    }
    const start = positions[first];
    if (end - start <= MAX_PASSAGE_SPAN && (!best || end - start < best.end - best.start)) {
      best = { start, end };
    }
    positions[first] = normalizedIndexOf(field, terms[first], start + 1);
  }
  return best;
}
function field(text: string): Field {
  const {
    text: normalized,
    invalidBreaks,
    offsetsChanged,
  } = normalizeSearchText(text.trim(), true, false);
  return { text: normalized, invalidBreaks, offsetsChanged };
}
function searchable(doc: WorkspaceDocIndex): SearchableDocument {
  const cached = prepared.get(doc);
  if (cached) return cached;
  const name = field(doc.name),
    title = field(doc.title ?? "");
  const headings = doc.headings.map((heading) => field(heading.text));
  const blocks = doc.bodyText
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean)
    .map((original) => ({ original, field: field(original) }));
  const result = {
    name,
    title,
    headings,
    blocks,
    fingerprint: textFingerprint(doc.bodyText),
    haystack: [
      name.text,
      title.text,
      ...headings.map((h) => h.text),
      ...blocks.map((block) => block.field.text),
    ].join("\n"),
  };
  prepared.set(doc, result);
  return result;
}

export function searchWorkspaceDocs(
  docs: WorkspaceDocIndex[],
  query: string,
  recentBoostByPath: Map<string, number>,
  maxResults = 50,
): WorkspaceSearchHit[] {
  const terms = [...new Set(searchTerms(query))];
  const phrase = searchText(query.replace(/"/g, ""));
  const hits: WorkspaceSearchHit[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.path)) continue;
    seen.add(doc.path);
    if (!terms.length) {
      hits.push({
        path: doc.path,
        relPath: doc.relPath,
        name: doc.name,
        title: doc.title,
        problem: doc.problem,
        kind: "title",
        headingId: null,
        score: recentBoostByPath.get(doc.path) ?? 0,
        passages: [],
        passageCount: 0,
      });
      continue;
    }
    const { name, title, headings, blocks, haystack, fingerprint } =
      searchable(doc);
    if (terms.some((term) => !haystack.includes(term))) continue;
    if (
      terms.some(
        (term) =>
          ![
            name,
            title,
            ...headings,
            ...blocks.map((block) => block.field),
          ].some((field) => normalizedIndexOf(field, term) >= 0),
      )
    )
      continue;
    const nameMatch = terms.every((term) => normalizedIndexOf(name, term) >= 0);
    const titleMatch = terms.every(
      (term) => normalizedIndexOf(title, term) >= 0,
    );
    const passages: (SearchPassage & { score: number })[] = [];
    let passageCount = 0;
    let bestScore = 0;
    const occurrences = new Map<string, number>();
    for (const [blockIndex, { field, original }] of blocks.entries()) {
      const block = field.text;
      const blockOccurrence = occurrences.get(block) ?? 0;
      occurrences.set(block, blockOccurrence + 1);
      // Nearby unordered terms are one passage. Scattered terms remain a
      // document match; they must never become a misleading Find phrase.
      const exact = normalizedIndexOf(field, phrase) >= 0;
      let target = phrase;
      let score = 200;
      if (!exact) {
        const nearby = nearbyTerms(field, terms);
        if (!nearby) continue;
        target = block.slice(nearby.start, nearby.end);
        score = 140 - (nearby.end - nearby.start) / 10;
      }
      let from = 0,
        occurrence = 0;
      let offsets: NormalizedText | undefined;
      for (;;) {
        const index = normalizedIndexOf(field, target, from);
        if (index < 0) break;
        const matchOccurrence = occurrence++;
        from = index + target.length;
        passageCount++;
        bestScore = Math.max(bestScore, score);
        // Keep the best five as we go, including a later exact phrase.
        if (passages.length === 5 && passages[4].score >= score) continue;
        // Most extracted prose already has single spaces. Build offset arrays
        // only for displayed excerpts whose normalization changed their length.
        if (field.offsetsChanged && !offsets)
          offsets = normalizeSearchText(original);
        const originalStart = offsets ? offsets.starts[index] : index;
        const originalEnd = offsets ? offsets.ends[from - 1] : from;
        const snippetStart = Math.max(0, originalStart - 60),
          snippetEnd = Math.min(original.length, originalEnd + 90);
        passages.push({
          findQuery: exact ? target : undefined,
          phrase: target,
          block,
          blockOccurrence,
          matchOccurrence,
          blockPrefix:
            doc.bodyText.length === MAX_WORKSPACE_BODY_CHARS &&
            blockIndex === blocks.length - 1,
          fingerprint,
          score,
          snippet: `${snippetStart ? "…" : ""}${original.slice(snippetStart, snippetEnd)}${snippetEnd < original.length ? "…" : ""}`,
        });
        passages.sort((a, b) => b.score - a.score);
        if (passages.length > 5) passages.pop();
      }
    }
    const heading = !passages.length
      ? doc.headings.find((_, i) =>
          terms.every((term) => normalizedIndexOf(headings[i], term) >= 0),
        )
      : undefined;
    hits.push({
      path: doc.path,
      relPath: doc.relPath,
      name: doc.name,
      title: doc.title,
      problem: doc.problem,
      kind:
        nameMatch || titleMatch
          ? "title"
          : heading
            ? "heading"
            : passages.length
              ? "content"
              : "title",
      headingId: heading?.id ?? null,
      score:
        (nameMatch ? 300 : titleMatch ? 250 : bestScore || 80) +
        (recentBoostByPath.get(doc.path) ?? 0),
      snippet: nameMatch
        ? undefined
        : titleMatch
          ? (doc.title ?? undefined)
          : passages[0]?.snippet,
      passages,
      passage: nameMatch || titleMatch ? undefined : passages[0],
      passageCount,
    });
  }
  return hits.sort(compareSearchHits).slice(0, maxResults);
}
export function compareSearchHits(
  a: WorkspaceSearchHit,
  b: WorkspaceSearchHit,
): number {
  return b.score - a.score || a.relPath.localeCompare(b.relPath);
}
export function createRecentBoostMap(
  recentPaths: string[],
): Map<string, number> {
  return new Map(
    recentPaths.map((path, index) => [path, Math.max(0, 20 - index * 2)]),
  );
}
