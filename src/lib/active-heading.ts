/** Sorted heading position; callers must break equal offsets by DOM order. */
export interface ActiveHeadingOffset {
  id: string;
  offsetTop: number;
}

interface ResolveActiveHeadingIdArgs {
  headingOffsets: ActiveHeadingOffset[];
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  topOffsetPx: number;
  hysteresisPx: number;
  currentId: string | null;
  bottomThresholdPx?: number;
}

function findHeadingAtOrBefore(
  headingOffsets: ActiveHeadingOffset[],
  referenceOffset: number,
): ActiveHeadingOffset | null {
  let left = 0;
  let right = headingOffsets.length - 1;
  let bestIndex = 0;

  while (left <= right) {
    const mid = (left + right) >> 1;
    if (headingOffsets[mid].offsetTop <= referenceOffset) {
      bestIndex = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return headingOffsets[bestIndex] ?? null;
}

export function resolveActiveHeadingId({
  headingOffsets,
  scrollTop,
  clientHeight,
  scrollHeight,
  topOffsetPx,
  hysteresisPx,
  currentId,
  bottomThresholdPx = ACTIVE_HEADING_BOTTOM_THRESHOLD_PX,
}: ResolveActiveHeadingIdArgs): string | null {
  if (headingOffsets.length === 0) return null;

  const viewportHeight = Math.max(0, clientHeight);
  const documentHeight = Math.max(0, scrollHeight);
  const maxScrollTop = Math.max(0, documentHeight - viewportHeight);
  const boundedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const isScrollable = documentHeight > viewportHeight;
  const isAtBottom =
    isScrollable && boundedScrollTop >= maxScrollTop - Math.max(0, bottomThresholdPx);
  const referenceOffset = isAtBottom
    ? boundedScrollTop + viewportHeight
    : boundedScrollTop + Math.max(0, topOffsetPx);
  const next = findHeadingAtOrBefore(headingOffsets, referenceOffset);

  if (!next) return null;
  if (!currentId || currentId === next.id || hysteresisPx <= 0) return next.id;

  const current = headingOffsets.find((heading) => heading.id === currentId);
  if (!current) return next.id;

  // In bottom mode the reference is viewport bottom, so the bottom-most
  // visible heading intentionally wins unless another heading is very close.
  const currentDistance = Math.abs(current.offsetTop - referenceOffset);
  const nextDistance = Math.abs(next.offsetTop - referenceOffset);

  return nextDistance + hysteresisPx < currentDistance ? next.id : currentId;
}
import { ACTIVE_HEADING_BOTTOM_THRESHOLD_PX } from "./scroll-constants";
