import { collectText, rangeForOffsets } from "./dom-text";
import { readSourcePoint, type SourcePoint } from "./editor-position";
import { anchorFromVerifiedOffsets, digest, exactSnapshotPosition, type AnnotationDocument, type TextAnchor } from "./text-anchoring";

const SOURCE_BLOCKS = "[data-bindars-source-line][data-bindars-source-column]";

/** A frozen view of one observed editor session, usable after editor unmount. */
export interface ObservedEditorChanges {
  initialDocument: string;
  finalDocument: string;
  mapTextPoint: (point: SourcePoint) => SourcePoint | null;
}

export interface PassageRefresh {
  id: string;
  basis: TextAnchor;
  anchor: TextAnchor;
}

interface TrackedBlock {
  id: string;
  basis: TextAnchor;
  point: SourcePoint;
  text: string;
  start: number;
  end: number;
}

export interface HighlightCapture {
  source: string;
  blocks: TrackedBlock[];
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
  const blocks: TrackedBlock[] = [];
  const blockText = new Map<HTMLElement, ReturnType<typeof collectText>>();
  for (const highlight of highlights) {
    const position = exactSnapshotPosition(highlight, evidence, index.text);
    if (!position) continue;
    const range = rangeForOffsets(index.spans, position.start, position.end);
    if (!range) continue;
    const common = range.commonAncestorContainer;
    const element = common.nodeType === Node.ELEMENT_NODE ? common as HTMLElement : common.parentElement;
    const block = element?.closest<HTMLElement>(SOURCE_BLOCKS);
    if (!block || !container.contains(block)) continue;
    const point = readSourcePoint(block);
    if (!point) continue;
    let content = blockText.get(block);
    if (!content) { content = collectText(block); blockText.set(block, content); }
    const first = content.spans.find(s => s.node === range.startContainer);
    const last = content.spans.find(s => s.node === range.endContainer);
    if (!first || !last) continue;
    const start = first.start + range.startOffset, end = last.start + range.endOffset;
    if (content.text.slice(start, end) !== highlight.exact) continue;
    blocks.push({ id: highlight.id, basis: highlight, point, text: content.text, start, end });
  }
  return { source, blocks };
}

/** Only identical rendered blocks qualify. There is deliberately no in-block alignment. */
export function refreshHighlightBlocks(capture: HighlightCapture, changes: ObservedEditorChanges,
  container: HTMLElement, source: string, evidence: AnnotationDocument): PassageRefresh[] {
  if (capture.source !== changes.initialDocument || source !== changes.finalDocument) return [];
  return matchBlocks(capture.blocks.flatMap(item => {
    const point = changes.mapTextPoint(item.point);
    return point ? [{ ...item, point }] : [];
  }), container, evidence, (item, text) => text === item.text);
}

function matchBlocks(items: TrackedBlock[], container: HTMLElement, evidence: AnnotationDocument,
  matches: (item: TrackedBlock, text: string) => boolean): PassageRefresh[] {
  const whole = collectText(container);
  if (whole.text !== evidence.text) return [];
  const globalSpans = new Map(whole.spans.map(s => [s.node, s]));
  const index = new Map<string, HTMLElement[]>();
  for (const block of container.querySelectorAll<HTMLElement>(SOURCE_BLOCKS)) {
    const point = readSourcePoint(block);
    if (!point) continue;
    const key = `${point.line}:${point.column}`;
    const candidates = index.get(key) ?? [];
    candidates.push(block); index.set(key, candidates);
  }
  const blockText = new Map<HTMLElement, ReturnType<typeof collectText>>();
  const updates: PassageRefresh[] = [];
  for (const item of items) {
    // Byte-identical replacement/Undo already belongs to the snapshot path.
    if (exactSnapshotPosition(item.basis, evidence, whole.text)) continue;
    const point = item.point;
    const candidates = new Map<string, TextAnchor>();
    for (const block of index.get(`${point.line}:${point.column}`) ?? []) {
      let content = blockText.get(block);
      if (!content) { content = collectText(block); blockText.set(block, content); }
      if (!matches(item, content.text) || content.text.slice(item.start, item.end) !== item.basis.exact) continue;
      const range = rangeForOffsets(content.spans, item.start, item.end);
      if (!range) continue;
      const first = globalSpans.get(range.startContainer as Text), last = globalSpans.get(range.endContainer as Text);
      if (!first || !last) continue;
      const start = first.start + range.startOffset, end = last.start + range.endOffset;
      const anchor = anchorFromVerifiedOffsets(evidence, start, end);
      if (anchor?.exact === item.basis.exact) candidates.set(`${start}:${end}`, anchor);
    }
    if (candidates.size === 1) updates.push({ id: item.id, basis: item.basis, anchor: [...candidates.values()][0] });
  }
  return updates;
}

/** Rapid Read→Edit can carry an unapplied boundary only across exact documents. */
export function joinObservedChanges(first: ObservedEditorChanges, second: ObservedEditorChanges): ObservedEditorChanges | null {
  if (first.finalDocument !== second.initialDocument) return null;
  return { initialDocument: first.initialDocument, finalDocument: second.finalDocument,
    mapTextPoint(point) { const middle = first.mapTextPoint(point); return middle && second.mapTextPoint(middle); } };
}

/** Hash-only continuation, inert until exactly the saved source is shown again. */
export interface DepartureClaim {
  format: 1;
  sourceHash: string;
  line: number;
  column: number;
  blockHash: string;
  start: number;
  end: number;
  basis: Pick<NonNullable<TextAnchor["position"]>, "sourceHash" | "textHash" | "start" | "end">;
}
export interface PassageClaim { id: string; basis: TextAnchor; claim: DepartureClaim }

export function validDepartureClaim(value: unknown): value is DepartureClaim {
  if (!value || typeof value !== "object") return false;
  const c = value as DepartureClaim;
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const integer = (v: unknown, min: number) => Number.isSafeInteger(v) && (v as number) >= min;
  return c.format === 1 && hash(c.sourceHash) && hash(c.blockHash)
    && integer(c.line, 1) && integer(c.column, 1) && integer(c.start, 0) && integer(c.end, 1) && c.end > c.start
    && !!c.basis && hash(c.basis.sourceHash) && hash(c.basis.textHash)
    && integer(c.basis.start, 0) && integer(c.basis.end, 1) && c.basis.end > c.basis.start;
}

function claimHasBasis(claim: DepartureClaim, anchor: TextAnchor): boolean {
  const p = anchor.position, b = claim.basis;
  return !!p && p.format === 1 && p.sourceHash === b.sourceHash && p.textHash === b.textHash
    && p.start === b.start && p.end === b.end;
}

export async function departureClaims(capture: HighlightCapture, changes: ObservedEditorChanges): Promise<PassageClaim[]> {
  if (!capture.blocks.length || capture.source !== changes.initialDocument) return [];
  const mapped = capture.blocks.flatMap(item => {
    const point = changes.mapTextPoint(item.point);
    return point && item.basis.position ? [{ item, point }] : [];
  });
  if (!mapped.length) return [];
  const sourceHash = await digest(changes.finalDocument);
  const hashes = new Map<string, Promise<string>>();
  return Promise.all(mapped.map(async ({ item, point }) => {
    if (!hashes.has(item.text)) hashes.set(item.text, digest(item.text));
    const p = item.basis.position!;
    return { id: item.id, basis: item.basis, claim: { format: 1 as const, sourceHash,
      ...point, blockHash: await hashes.get(item.text)!, start: item.start, end: item.end,
      basis: { sourceHash: p.sourceHash, textHash: p.textHash, start: p.start, end: p.end } } };
  }));
}

export async function refreshDepartureClaims(highlights: readonly (TextAnchor & { id: string; continuity?: unknown })[],
  container: HTMLElement, evidence: AnnotationDocument): Promise<PassageRefresh[]> {
  const eligible = highlights.filter(h => validDepartureClaim(h.continuity)
    && h.continuity.sourceHash === evidence.sourceHash && claimHasBasis(h.continuity, h)
    && !exactSnapshotPosition(h, evidence));
  if (!eligible.length) return [];
  // Hash only blocks at claimed points, so a retained unmatched claim stays cheap.
  const claimed = new Set(eligible.map(h => `${(h.continuity as DepartureClaim).line}:${(h.continuity as DepartureClaim).column}`));
  const hashes = new Map<string, string>();
  await Promise.all(Array.from(container.querySelectorAll<HTMLElement>(SOURCE_BLOCKS), async block => {
    const point = readSourcePoint(block);
    if (!point || !claimed.has(`${point.line}:${point.column}`)) return;
    const text = collectText(block).text;
    if (!hashes.has(text)) hashes.set(text, await digest(text));
  }));
  const items = eligible.map(h => {
    const c = h.continuity as DepartureClaim;
    return { id: h.id, basis: h, point: { line: c.line, column: c.column }, text: c.blockHash, start: c.start, end: c.end };
  });
  return matchBlocks(items, container, evidence, (item, text) => hashes.get(text) === item.text);
}
