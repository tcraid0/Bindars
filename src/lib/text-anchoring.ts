import { clearMarks, isAnnotationMark } from "./dom-marks";
import { collectText, isMarkableText, rangeForOffsets } from "./dom-text";

const CONTEXT_CHARS = 32;
export interface AnchorPosition {
  format: 1;
  start: number;
  end: number;
  sourceHash: string;
  textHash: string;
  contextUnique: boolean;
}
export interface TextAnchor {
  prefix: string;
  exact: string;
  suffix: string;
  position?: AnchorPosition;
}
export interface AnnotationDocument {
  text: string;
  sourceHash: string;
  textHash: string;
}
export type AnchorStatus = "located" | "uncertain" | "missing";

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}

export async function prepareAnnotationDocument(container: HTMLElement, source: string): Promise<AnnotationDocument> {
  const { text } = collectText(container);
  const [sourceHash, textHash] = await Promise.all([digest(source), digest(text)]);
  return { text, sourceHash, textHash };
}

function selectionOffsets(range: Range, container: HTMLElement) {
  if (!container.contains(range.commonAncestorContainer) || !range.toString().trim()) return null;
  const index = collectText(container);
  const selected = index.spans.filter(({ node }) => range.intersectsNode(node));
  const first = selected.find(({ node }) => node !== range.startContainer || range.startOffset < node.length);
  const ending = selected.filter(({ node }) => node !== range.endContainer || range.endOffset > 0);
  const last = ending[ending.length - 1];
  if (!first || !last) return null;
  const start = first.start + (first.node === range.startContainer ? range.startOffset : 0);
  const end = last.start + (last.node === range.endContainer ? range.endOffset : last.node.length);
  const exact = index.text.slice(start, end);
  // A mixed selection must not be silently clipped around math/SVG/controls.
  if (exact.includes("\0") || exact !== range.toString()) return null;
  return { ...index, start, end, exact };
}

export function createAnchor(range: Range, container: HTMLElement): TextAnchor | null {
  const selection = selectionOffsets(range, container);
  if (!selection) return null;
  const { text, start, end, exact } = selection;
  return { prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start), exact, suffix: text.slice(end, end + CONTEXT_CHARS) };
}

export async function createPositionedAnchor(range: Range, container: HTMLElement, source: string): Promise<TextAnchor | null> {
  const selection = selectionOffsets(range, container);
  if (!selection) return null;
  const { text, start, end, exact } = selection;
  const [sourceHash, textHash] = await Promise.all([digest(source), digest(text)]);
  const prefix = text.slice(Math.max(0, start - CONTEXT_CHARS), start);
  const suffix = text.slice(end, end + CONTEXT_CHARS);
  let contextMatches = 0;
  for (let from = 0; from <= text.length;) {
    const index = text.indexOf(exact, from);
    if (index < 0) break;
    if (matchesContext(text, index, exact, prefix, suffix)) contextMatches++;
    from = index + 1;
  }
  return { prefix, exact, suffix, position: { format: 1, start, end, sourceHash, textHash, contextUnique: contextMatches === 1 } };
}

function matchesContext(text: string, index: number, exact: string, prefix: string, suffix: string): boolean {
  if (!prefix && !suffix) return text === exact;
  return text.slice(Math.max(0, index - prefix.length), index) === prefix
    && text.slice(index + exact.length, index + exact.length + suffix.length) === suffix;
}

export function resolveAnchor(anchor: TextAnchor, container: HTMLElement, evidence?: AnnotationDocument): { status: AnchorStatus; range: Range | null } {
  const { exact, prefix, suffix } = anchor;
  if (typeof exact !== "string" || !exact.trim() || exact.includes("\0")) return { status: "missing", range: null };
  const { text, spans } = collectText(container);
  const position = anchor.position;
  if (position?.format === 1 && evidence && evidence.text === text
    && position.sourceHash === evidence.sourceHash && position.textHash === evidence.textHash
    && Number.isInteger(position.start) && Number.isInteger(position.end)
    && position.start >= 0 && position.end <= text.length && text.slice(position.start, position.end) === exact) {
    const range = rangeForOffsets(spans, position.start, position.end);
    if (range) return { status: "located", range };
  }
  const matches: number[] = [];
  let foundExact = false;
  for (let from = 0; from <= text.length;) {
    const index = text.indexOf(exact, from);
    if (index < 0) break;
    foundExact = true;
    if (typeof prefix === "string" && typeof suffix === "string"
      && matchesContext(text, index, exact, prefix, suffix)) matches.push(index);
    from = index + 1;
  }
  // If the original context was duplicated, a now-unique survivor may be the
  // other passage after deletion. Position evidence cannot authorize that move.
  if (matches.length === 1 && (!position || position.contextUnique === true)) {
    const range = rangeForOffsets(spans, matches[0], matches[0] + exact.length);
    if (range) return { status: "located", range };
  }
  return { status: foundExact ? "uncertain" : "missing", range: null };
}

export function findAnchor(anchor: TextAnchor, container: HTMLElement, evidence?: AnnotationDocument): Range | null {
  return resolveAnchor(anchor, container, evidence).range;
}

/**
 * Walk text nodes within a Range and wrap each in a <mark> element.
 */
export function wrapRange(range: Range, className: string, highlightId?: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const textNodes = getTextNodesInRange(range);

  // Process in reverse to avoid DOM mutation invalidating later nodes
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const textNode = textNodes[i];
    const mark = document.createElement("mark");
    mark.className = className;
    if (highlightId) mark.dataset.highlightId = highlightId;

    const start = textNode === range.startContainer ? range.startOffset : 0;
    const end = textNode === range.endContainer ? range.endOffset : textNode.length;

    if (end <= start || !isMarkableText(textNode)) continue;
    marks.unshift(mark);
    const parent = textNode.parentNode;
    if (!parent) {
      continue;
    }

    if (start === 0 && end === textNode.length) {
      parent.insertBefore(mark, textNode);
      mark.appendChild(textNode);
    } else {
      // Split off the part AFTER the selection first (to preserve offsets)
      if (end < textNode.length) {
        textNode.splitText(end);
      }
      // Then split off the part BEFORE the selection
      const selected = start > 0 ? textNode.splitText(start) : textNode;
      const selectedParent = selected.parentNode;
      if (!selectedParent) {
        continue;
      }
      selectedParent.insertBefore(mark, selected);
      mark.appendChild(selected);
    }
  }
  return marks;
}

/**
 * Remove all annotation highlight marks from a container.
 */
export function clearAnnotationHighlights(container: HTMLElement): void {
  clearMarks(container, isAnnotationMark);
}

function getTextNodesInRange(range: Range): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement!
      : range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  );

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (range.intersectsNode(node)) {
      nodes.push(node);
    }
  }

  return nodes;
}
