import { collectText, rangeForOffsets } from "./dom-text";
import { compareSourcePoints, readSourcePoint, SOURCE_SELECTOR, type SourcePoint } from "./editor-position";
import { MARKUP_CHARACTERS } from "./markdown-syntax";
import { offsetAtSourcePoint, sourcePointAtOffset } from "./source-lines";
import { anchorFromVerifiedOffsets, digest, exactSnapshotPosition, type AnchorPosition, type AnnotationDocument, type TextAnchor } from "./text-anchoring";

/** A frozen view of one observed editor session, usable after editor unmount. */
export interface ObservedEditorChanges {
  initialDocument: string;
  finalDocument: string;
  /** Follows `length` original source characters; null unless every one of them survives untouched. */
  mapTextPoint: (point: SourcePoint, length?: number) => SourcePoint | null;
}

export interface PassageRefresh {
  id: string;
  basis: TextAnchor;
  anchor: TextAnchor;
}

/** One highlight followed two ways. Either part may be lost; a passage with neither is dropped. */
interface TrackedPassage {
  id: string;
  basis: TextAnchor;
  /** Its block: first text character, rendered text (a claim keeps the hash) and the passage's offsets in it. */
  block: { point: SourcePoint; text: string; start: number; end: number } | null;
  /** The passage's own first source character, known only for a plain-text run. */
  run: SourcePoint | null;
}

export interface HighlightCapture {
  source: string;
  blocks: TrackedPassage[];
}

type BlockText = ReturnType<typeof collectText>;
function cached<K, V>(cache: Map<K, V>, key: K, make: (key: K) => V): V {
  let value = cache.get(key);
  if (value === undefined) { value = make(key); cache.set(key, value); }
  return value;
}

const pointKey = (point: SourcePoint) => `${point.line}:${point.column}`;

// Smart punctuation curls quotes one for one. Its other substitutions change
// the text's length and so fail the comparison below.
const straightQuotes = (text: string) => text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

/**
 * True when a block's source, from its first text character (`origin`) for
 * `length` characters, is plain text shown as written. Without a markup
 * character nothing in it can be hidden, so each rendered character is the
 * source character at the same offset: the passage's source is known, not guessed.
 */
function plainRun(source: string, origin: number, rendered: string, length: number): boolean {
  const run = source.slice(origin, origin + length);
  return !MARKUP_CHARACTERS.test(run) && straightQuotes(run) === straightQuotes(rendered.slice(0, length));
}

// Note/color edits retain the position object; Choose passage replaces it, even
// when the person confirms the same bytes. A newer attachment always wins.
export function hasPassageBasis(current: TextAnchor, basis: TextAnchor): boolean {
  return current.position === basis.position && current.exact === basis.exact
    && current.prefix === basis.prefix && current.suffix === basis.suffix;
}

export function captureHighlightBlocks(container: HTMLElement, source: string, evidence: AnnotationDocument,
  highlights: readonly (TextAnchor & { id: string })[]): HighlightCapture {
  const index = collectText(container);
  const blocks: TrackedPassage[] = [];
  const blockText = new Map<HTMLElement, BlockText>();
  for (const highlight of highlights) {
    const position = exactSnapshotPosition(highlight, evidence, index.text);
    if (!position) continue;
    const range = rangeForOffsets(index.spans, position.start, position.end);
    if (!range) continue;
    const common = range.commonAncestorContainer;
    const element = common.nodeType === Node.ELEMENT_NODE ? common as HTMLElement : common.parentElement;
    const block = element?.closest<HTMLElement>(SOURCE_SELECTOR);
    if (!block || !container.contains(block)) continue;
    const point = readSourcePoint(block);
    if (!point) continue;
    const content = cached(blockText, block, collectText);
    const first = content.spans.find(s => s.node === range.startContainer);
    const last = content.spans.find(s => s.node === range.endContainer);
    if (!first || !last) continue;
    const start = first.start + range.startOffset, end = last.start + range.endOffset;
    if (content.text.slice(start, end) !== highlight.exact) continue;
    const origin = offsetAtSourcePoint(source, point);
    blocks.push({ id: highlight.id, basis: highlight, block: { point, text: content.text, start, end },
      run: plainRun(source, origin, content.text, end) ? sourcePointAtOffset(source, origin + start) : null });
  }
  return { source, blocks };
}

/** Follows each passage's block and, for a plain-text run, its own characters through the observed changes. */
function followPassages(passages: TrackedPassage[], changes: ObservedEditorChanges): TrackedPassage[] {
  return passages.flatMap(item => {
    const point = item.block && changes.mapTextPoint(item.block.point);
    const block = item.block && point ? { ...item.block, point } : null;
    const run = item.run && changes.mapTextPoint(item.run, item.basis.exact.length);
    return block || run ? [{ ...item, block, run }] : [];
  });
}

/**
 * A block qualifies only with identical rendered text; a run only while its own
 * characters are untouched plain text. There is deliberately no text alignment.
 */
export function refreshHighlightBlocks(capture: HighlightCapture, changes: ObservedEditorChanges,
  container: HTMLElement, source: string, evidence: AnnotationDocument): PassageRefresh[] {
  if (capture.source !== changes.initialDocument || source !== changes.finalDocument) return [];
  return matchBlocks(followPassages(capture.blocks, changes), container, source, evidence, (tracked, text) => text === tracked);
}

/** The single verifier for observed (in-memory) and claimed (persisted) passages. `source` is the rendered document. */
function matchBlocks(items: TrackedPassage[], container: HTMLElement, source: string, evidence: AnnotationDocument,
  sameText: (tracked: string, text: string) => boolean): PassageRefresh[] {
  const whole = collectText(container);
  if (whole.text !== evidence.text) return [];
  const globalSpans = new Map(whole.spans.map(s => [s.node, s]));
  const index = new Map<string, HTMLElement[]>();
  const points: SourcePoint[] = [];
  for (const block of container.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
    const point = readSourcePoint(block);
    if (!point) continue;
    const blocks = index.get(pointKey(point));
    if (blocks) blocks.push(block);
    else { index.set(pointKey(point), [block]); points.push(point); }
  }
  const blockText = new Map<HTMLElement, BlockText>();
  const updates: PassageRefresh[] = [];
  for (const item of items) {
    // Byte-identical replacement/Undo already belongs to the snapshot path.
    if (exactSnapshotPosition(item.basis, evidence, whole.text)) continue;
    const { exact } = item.basis, { block, run } = item;
    const candidates = new Map<string, TextAnchor>();
    // `locate` gives the passage's offset in a block's rendered text, or null to refuse that block.
    const verify = (point: SourcePoint, locate: (text: string) => number | null) => {
      for (const element of index.get(pointKey(point)) ?? []) {
        const content = cached(blockText, element, collectText);
        const at = locate(content.text);
        if (at === null || content.text.slice(at, at + exact.length) !== exact) continue;
        const range = rangeForOffsets(content.spans, at, at + exact.length);
        if (!range) continue;
        const first = globalSpans.get(range.startContainer as Text), last = globalSpans.get(range.endContainer as Text);
        if (!first || !last) continue;
        const start = first.start + range.startOffset, end = last.start + range.endOffset;
        const anchor = anchorFromVerifiedOffsets(evidence, start, end);
        if (anchor?.exact === exact) candidates.set(`${start}:${end}`, anchor);
      }
    };
    if (block) verify(block.point, text => sameText(block.text, text) ? block.start : null);
    // The run's block is the last one starting at or before it. Nothing is assumed
    // about that block: the plain-text check from its first character must hold again.
    const home = run && points.reduce<SourcePoint | null>((best, point) =>
      compareSourcePoints(point, run) <= 0 && (!best || compareSourcePoints(best, point) < 0) ? point : best, null);
    if (run && home) {
      const origin = offsetAtSourcePoint(source, home), at = offsetAtSourcePoint(source, run) - origin;
      verify(home, text => plainRun(source, origin, text, at + exact.length) ? at : null);
    }
    // Both ways must agree: two different places are refused like none.
    if (candidates.size === 1) updates.push({ id: item.id, basis: item.basis, anchor: [...candidates.values()][0] });
  }
  return updates;
}

/** Rapid Read→Edit can carry an unapplied boundary only across exact documents. */
export function joinObservedChanges(first: ObservedEditorChanges, second: ObservedEditorChanges): ObservedEditorChanges | null {
  if (first.finalDocument !== second.initialDocument) return null;
  return { initialDocument: first.initialDocument, finalDocument: second.finalDocument,
    mapTextPoint(point, length) { const middle = first.mapTextPoint(point, length); return middle && second.mapTextPoint(middle, length); } };
}

/** Hash-only continuation, inert until exactly the saved source is shown again. At least one part is present. */
export interface DepartureClaim {
  format: 1;
  sourceHash: string;
  /** Unchanged block: its first text character, the hash of its rendered text and the passage's offsets in it. */
  block?: { line: number; column: number; blockHash: string; start: number; end: number };
  /** Plain-text run: the passage's own first source character. */
  run?: { line: number; column: number };
  basis: Pick<AnchorPosition, "sourceHash" | "textHash" | "start" | "end">;
}
export interface PassageClaim { id: string; basis: TextAnchor; claim: DepartureClaim }

export function validDepartureClaim(value: unknown): value is DepartureClaim {
  if (!value || typeof value !== "object") return false;
  const c = value as DepartureClaim;
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const integer = (v: unknown, min: number) => Number.isSafeInteger(v) && (v as number) >= min;
  const point = (v: SourcePoint | null) => !!v && typeof v === "object" && integer(v.line, 1) && integer(v.column, 1);
  const block = c.block === undefined || (point(c.block) && hash(c.block.blockHash)
    && integer(c.block.start, 0) && integer(c.block.end, 1) && c.block.end > c.block.start);
  const run = c.run === undefined || point(c.run);
  return c.format === 1 && hash(c.sourceHash) && block && run && (c.block !== undefined || c.run !== undefined)
    && !!c.basis && hash(c.basis.sourceHash) && hash(c.basis.textHash)
    && integer(c.basis.start, 0) && integer(c.basis.end, 1) && c.basis.end > c.basis.start;
}

function claimHasBasis(claim: DepartureClaim, anchor: TextAnchor): boolean {
  const p = anchor.position, b = claim.basis;
  return !!p && p.format === 1 && p.sourceHash === b.sourceHash && p.textHash === b.textHash
    && p.start === b.start && p.end === b.end;
}

export async function departureClaims(capture: HighlightCapture, changes: ObservedEditorChanges): Promise<PassageClaim[]> {
  // An unchanged document needs no claim: every captured position is already exact for it.
  if (!capture.blocks.length || capture.source !== changes.initialDocument
    || changes.finalDocument === changes.initialDocument) return [];
  const followed = followPassages(capture.blocks, changes);
  if (!followed.length) return [];
  const sourceHash = await digest(changes.finalDocument);
  const hashes = new Map<string, Promise<string>>();
  const claimFor = async ({ id, basis, block, run }: TrackedPassage, p: AnchorPosition): Promise<PassageClaim> => ({ id, basis,
    claim: { format: 1, sourceHash,
      ...(block && { block: { ...block.point, blockHash: await cached(hashes, block.text, digest), start: block.start, end: block.end } }),
      ...(run && { run }),
      basis: { sourceHash: p.sourceHash, textHash: p.textHash, start: p.start, end: p.end } } });
  return Promise.all(followed.flatMap(item => item.basis.position ? [claimFor(item, item.basis.position)] : []));
}

/** `source` must be the document whose hash is `evidence.sourceHash`. */
export async function refreshDepartureClaims(highlights: readonly (TextAnchor & { id: string; continuity?: unknown })[],
  container: HTMLElement, source: string, evidence: AnnotationDocument): Promise<PassageRefresh[]> {
  const eligible = highlights.flatMap(highlight => {
    const claim = highlight.continuity;
    return validDepartureClaim(claim) && claim.sourceHash === evidence.sourceHash && claimHasBasis(claim, highlight)
      && !exactSnapshotPosition(highlight, evidence) ? [{ highlight, claim }] : [];
  });
  if (!eligible.length) return [];
  // Hash only blocks at claimed points, so a retained unmatched claim stays cheap.
  const claimed = new Set(eligible.flatMap(({ claim }) => claim.block ? [pointKey(claim.block)] : []));
  const hashes = new Map<string, string>();
  await Promise.all(Array.from(container.querySelectorAll<HTMLElement>(SOURCE_SELECTOR), async block => {
    const point = readSourcePoint(block);
    if (!point || !claimed.has(pointKey(point))) return;
    const text = collectText(block).text;
    if (!hashes.has(text)) hashes.set(text, await digest(text));
  }));
  const items = eligible.map(({ highlight, claim: { block, run } }): TrackedPassage => ({ id: highlight.id, basis: highlight,
    block: block ? { point: { line: block.line, column: block.column }, text: block.blockHash, start: block.start, end: block.end } : null,
    run: run ? { line: run.line, column: run.column } : null }));
  return matchBlocks(items, container, source, evidence, (tracked, text) => hashes.get(text) === tracked);
}
