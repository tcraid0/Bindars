import { resolveActiveHeadingId } from "./active-heading";
import {
  ACTIVE_HEADING_BOTTOM_THRESHOLD_PX,
  ACTIVE_HEADING_HYSTERESIS_PX,
  ACTIVE_HEADING_TOP_PX,
} from "./scroll-constants";
import { offsetAtSourcePoint, sourcePointAtOffset } from "./source-lines";
import type { SourcePoint } from "./source-lines";

export type { SourcePoint } from "./source-lines";

export interface ReaderAnchor {
  source: SourcePoint;
  viewportOffsetPx: number;
}

const SOURCE_SELECTOR = "[data-bindars-source-line][data-bindars-source-column]";
const HEADING_SELECTOR = "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]";

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function readSourcePoint(element: HTMLElement): SourcePoint | null {
  const line = positiveInteger(element.dataset.bindarsSourceLine);
  const column = positiveInteger(element.dataset.bindarsSourceColumn);
  return line && column ? { line, column } : null;
}

function compareSourcePoints(left: SourcePoint, right: SourcePoint): number {
  return left.line - right.line || left.column - right.column;
}

function findElementById(
  root: HTMLElement,
  selector: string,
  id: string | null,
): HTMLElement | null {
  if (!id) return null;
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (element.id === id) return element;
  }
  return null;
}

export function findHeadingElement(root: HTMLElement, id: string | null): HTMLElement | null {
  return findElementById(root, HEADING_SELECTOR, id);
}

export function findFragmentElement(root: HTMLElement, id: string | null): HTMLElement | null {
  return findElementById(root, "[id]", id);
}

function currentHeadingElement(
  root: HTMLElement,
  scrollRoot: HTMLElement,
  currentId: string | null,
): HTMLElement | null {
  const rootTop = scrollRoot.getBoundingClientRect().top;
  const headings = Array.from(
    root.querySelectorAll<HTMLElement>(HEADING_SELECTOR),
  ).filter((heading) => readSourcePoint(heading) !== null);
  const headingOffsets = headings.map((heading) => ({
    id: heading.id,
    offsetTop: heading.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop,
  }));
  const activeId = resolveActiveHeadingId({
    headingOffsets,
    scrollTop: scrollRoot.scrollTop,
    clientHeight: scrollRoot.clientHeight,
    scrollHeight: scrollRoot.scrollHeight,
    topOffsetPx: ACTIVE_HEADING_TOP_PX,
    hysteresisPx: ACTIVE_HEADING_HYSTERESIS_PX,
    currentId,
  });
  const activeOffset = headingOffsets.find((heading) => heading.id === activeId)?.offsetTop;
  const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
  const atBottom = maxScrollTop > 0
    && scrollRoot.scrollTop >= maxScrollTop - ACTIVE_HEADING_BOTTOM_THRESHOLD_PX;
  if (!atBottom && activeOffset !== undefined && activeOffset > scrollRoot.scrollTop + ACTIVE_HEADING_TOP_PX) {
    return null;
  }
  return findHeadingElement(root, activeId);
}

function firstVisibleSourceElement(root: HTMLElement, scrollRoot: HTMLElement): HTMLElement | null {
  const viewport = scrollRoot.getBoundingClientRect();
  for (const element of root.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 && rect.width <= 0) continue;
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) return element;
  }
  return null;
}

interface VisibleTextCandidate {
  element: HTMLElement;
  text: string;
}

const TEXT_BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, pre, blockquote, li, td, th";
const WORD_CHARACTER_RE = /[\p{L}\p{N}_]/u;

function usefulTextCandidates(root: HTMLElement): VisibleTextCandidate[] {
  const candidates: VisibleTextCandidate[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR)) {
    if (element.closest('[aria-hidden="true"]')) continue;
    if (element.querySelector(TEXT_BLOCK_SELECTOR)) continue;
    const text = element.textContent?.trim() ?? "";
    if (text) candidates.push({ element, text });
  }
  return candidates;
}

function sourceBoundsForElement(
  root: HTMLElement,
  target: HTMLElement,
  content: string,
  candidates: VisibleTextCandidate[],
): { from: number; to: number; firstCandidateIndex: number } {
  const sourceElements = Array.from(root.querySelectorAll<HTMLElement>(SOURCE_SELECTOR));
  let preceding: HTMLElement | null = null;
  let following: HTMLElement | null = null;

  for (const element of sourceElements) {
    const relation = element.compareDocumentPosition(target);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) preceding = element;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
      following = element;
      break;
    }
  }

  const precedingPoint = preceding ? readSourcePoint(preceding) : null;
  const followingPoint = following ? readSourcePoint(following) : null;
  const firstCandidateAfterSource = preceding
    ? candidates.findIndex((candidate) => {
        const relation = preceding.compareDocumentPosition(candidate.element);
        return preceding.contains(candidate.element) || Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
      })
    : 0;
  const firstCandidateIndex = firstCandidateAfterSource < 0
    ? candidates.length
    : firstCandidateAfterSource;
  return {
    from: precedingPoint ? offsetAtSourcePoint(content, precedingPoint) : 0,
    to: followingPoint ? offsetAtSourcePoint(content, followingPoint) : content.length,
    firstCandidateIndex,
  };
}

function hasSourceTextBoundaries(content: string, offset: number, text: string): boolean {
  const first = text[0];
  const last = text[text.length - 1];
  const before = offset > 0 ? content[offset - 1] : "";
  const after = offset + text.length < content.length ? content[offset + text.length] : "";
  if (WORD_CHARACTER_RE.test(first) && before && WORD_CHARACTER_RE.test(before)) return false;
  if (WORD_CHARACTER_RE.test(last) && after && WORD_CHARACTER_RE.test(after)) return false;
  return true;
}

function findOccurrenceWithin(
  content: string,
  text: string,
  occurrence: number,
  from: number,
  to: number,
): number {
  let offset = from;
  let matchedOccurrence = 0;
  while (offset < to) {
    offset = content.indexOf(text, offset);
    if (offset < 0 || offset + text.length > to) return -1;
    if (hasSourceTextBoundaries(content, offset, text)) {
      if (matchedOccurrence === occurrence) return offset;
      matchedOccurrence += 1;
    }
    offset += text.length;
  }
  return -1;
}

function firstVisibleTextAnchor(
  root: HTMLElement,
  scrollRoot: HTMLElement,
  content: string,
): ReaderAnchor | null {
  const viewport = scrollRoot.getBoundingClientRect();
  const candidates = usefulTextCandidates(root);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const rect = candidate.element.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
      const bounds = sourceBoundsForElement(root, candidate.element, content, candidates);
      let occurrence = 0;
      for (let index = bounds.firstCandidateIndex; index < candidateIndex; index += 1) {
        if (candidates[index].text === candidate.text) occurrence += 1;
      }
      const offset = findOccurrenceWithin(
        content,
        candidate.text,
        occurrence,
        bounds.from,
        bounds.to,
      );
      if (offset >= 0) {
        return {
          source: sourcePointAtOffset(content, offset),
          viewportOffsetPx: rect.top - viewport.top,
        };
      }
    }
  }
  return null;
}

export function captureReaderAnchor(
  root: HTMLElement,
  scrollRoot: HTMLElement,
  activeHeadingId: string | null,
  content: string,
): ReaderAnchor | null {
  const activeHeading = currentHeadingElement(root, scrollRoot, activeHeadingId);
  const element = activeHeading ?? (
    root.classList.contains("fountain-body") ? null : firstVisibleSourceElement(root, scrollRoot)
  );
  if (element) {
    const source = readSourcePoint(element);
    if (!source) return null;

    return {
      source,
      viewportOffsetPx: element.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top,
    };
  }

  const textAnchor = firstVisibleTextAnchor(root, scrollRoot, content);
  if (textAnchor) return textAnchor;

  const fallback = firstVisibleSourceElement(root, scrollRoot);
  const fallbackSource = fallback ? readSourcePoint(fallback) : null;
  return fallback && fallbackSource ? {
    source: fallbackSource,
    viewportOffsetPx: fallback.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top,
  } : null;
}

export function findSourceElement(root: HTMLElement, target: SourcePoint): HTMLElement | null {
  let sameLinePreceding: { element: HTMLElement; point: SourcePoint } | null = null;
  let sameLineFollowing: { element: HTMLElement; point: SourcePoint } | null = null;
  let earlierLinePreceding: { element: HTMLElement; point: SourcePoint } | null = null;

  for (const element of root.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
    const point = readSourcePoint(element);
    if (!point) continue;
    const comparison = compareSourcePoints(point, target);
    if (comparison === 0) return element;
    if (point.line === target.line) {
      if (
        point.column < target.column
        && (!sameLinePreceding || point.column > sameLinePreceding.point.column)
      ) {
        sameLinePreceding = { element, point };
      } else if (
        point.column > target.column
        && (!sameLineFollowing || point.column < sameLineFollowing.point.column)
      ) {
        sameLineFollowing = { element, point };
      }
    } else if (
      point.line < target.line
      && (!earlierLinePreceding || compareSourcePoints(point, earlierLinePreceding.point) > 0)
    ) {
      earlierLinePreceding = { element, point };
    }
  }

  return sameLinePreceding?.element
    ?? sameLineFollowing?.element
    ?? earlierLinePreceding?.element
    ?? root.querySelector<HTMLElement>(SOURCE_SELECTOR);
}

export function restoreReaderAnchor(
  root: HTMLElement,
  scrollRoot: HTMLElement,
  source: SourcePoint,
  viewportOffsetPx: number | null,
): boolean {
  const target = findSourceElement(root, source);
  if (!target) return false;

  const viewportTop = scrollRoot.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top - viewportTop + scrollRoot.scrollTop;
  const requestedOffset = viewportOffsetPx !== null && Number.isFinite(viewportOffsetPx)
    ? viewportOffsetPx
    : 0;
  const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
  scrollRoot.scrollTop = Math.max(0, Math.min(targetTop - requestedOffset, maxScrollTop));
  return true;
}
