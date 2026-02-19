const CONTEXT_CHARS = 32;

export interface TextAnchor {
  prefix: string;
  exact: string;
  suffix: string;
}

/**
 * Create a text anchor from a DOM Range within a container.
 * Uses W3C-style prefix/exact/suffix for resilient re-anchoring.
 */
export function createAnchor(range: Range, container: HTMLElement): TextAnchor | null {
  const exact = range.toString();
  if (!exact.trim()) return null;

  const fullText = container.textContent || "";
  // Find the offset of the selection in the container's text
  const preRange = document.createRange();
  preRange.setStart(container, 0);
  preRange.setEnd(range.startContainer, range.startOffset);
  const offset = preRange.toString().length;

  const prefix = fullText.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
  const suffix = fullText.slice(offset + exact.length, offset + exact.length + CONTEXT_CHARS);

  return { prefix, exact, suffix };
}

/**
 * Find a text anchor in a container's DOM and return a Range.
 * Tries exact context match first, then falls back to best fuzzy match.
 */
export function findAnchor(anchor: TextAnchor, container: HTMLElement): Range | null {
  const fullText = container.textContent || "";
  const { prefix, exact, suffix } = anchor;

  // Find all occurrences of the exact text
  const occurrences: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = fullText.indexOf(exact, searchFrom);
    if (idx === -1) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }

  if (occurrences.length === 0) return null;

  // Score each occurrence by context similarity
  let bestIdx = occurrences[0];
  let bestScore = -1;

  for (const idx of occurrences) {
    let score = 0;
    const actualPrefix = fullText.slice(Math.max(0, idx - CONTEXT_CHARS), idx);
    const actualSuffix = fullText.slice(idx + exact.length, idx + exact.length + CONTEXT_CHARS);

    // Count matching characters from the end of prefix
    for (let i = 0; i < Math.min(prefix.length, actualPrefix.length); i++) {
      if (prefix[prefix.length - 1 - i] === actualPrefix[actualPrefix.length - 1 - i]) {
        score++;
      } else {
        break;
      }
    }

    // Count matching characters from the start of suffix
    for (let i = 0; i < Math.min(suffix.length, actualSuffix.length); i++) {
      if (suffix[i] === actualSuffix[i]) {
        score++;
      } else {
        break;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }

  // Convert text offset to DOM Range
  return textOffsetToRange(container, bestIdx, bestIdx + exact.length);
}

/**
 * Walk text nodes within a Range and wrap each in a <mark> element.
 */
export function wrapRange(range: Range, className: string, highlightId: string): void {
  const textNodes = getTextNodesInRange(range);

  // Process in reverse to avoid DOM mutation invalidating later nodes
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const textNode = textNodes[i];
    const mark = document.createElement("mark");
    mark.className = className;
    mark.dataset.highlightId = highlightId;

    const start = textNode === range.startContainer ? range.startOffset : 0;
    const end = textNode === range.endContainer ? range.endOffset : textNode.length;

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
}

/**
 * Remove all annotation highlight marks from a container.
 */
export function clearAnnotationHighlights(container: HTMLElement): void {
  const marks = container.querySelectorAll("mark[data-highlight-id]");
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (parent && parent.contains(mark)) {
      parents.add(parent);
      try {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      } catch {
        // DOM can change between query and replace during file transitions.
      }
    }
  }
  for (const parent of parents) {
    if (typeof parent.normalize === "function") {
      parent.normalize();
    }
  }
}

function textOffsetToRange(container: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.length;

    if (!startNode && offset + len > start) {
      startNode = node;
      startOffset = start - offset;
    }

    if (offset + len >= end) {
      endNode = node;
      endOffset = end - offset;
      break;
    }

    offset += len;
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
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
