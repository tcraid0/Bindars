import { collectText, rangeForOffsets } from "./dom-text";
import { readSourcePoint, type SourcePoint } from "./editor-position";
import { anchorFromVerifiedOffsets, exactSnapshotPosition, type AnnotationDocument, type TextAnchor } from "./text-anchoring";

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
  for (const item of capture.blocks) {
    // Byte-identical replacement/Undo already belongs to the snapshot path.
    if (exactSnapshotPosition(item.basis, evidence, whole.text)) continue;
    const point = changes.mapTextPoint(item.point);
    if (!point) continue;
    const candidates = new Map<string, TextAnchor>();
    for (const block of index.get(`${point.line}:${point.column}`) ?? []) {
      let content = blockText.get(block);
      if (!content) { content = collectText(block); blockText.set(block, content); }
      if (content.text !== item.text || content.text.slice(item.start, item.end) !== item.basis.exact) continue;
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
