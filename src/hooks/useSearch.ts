import { collectText, type TextSpan } from "../lib/dom-text";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  clearMarks,
  isSearchMark,
  SEARCH_ACTIVE_CLASS,
  SEARCH_HIGHLIGHT_CLASS,
} from "../lib/dom-marks";

interface SearchState {
  query: string;
  matchCount: number;
  currentIndex: number;
}

interface UseSearchResult {
  query: string;
  matchCount: number;
  currentIndex: number;
  setQuery: (q: string) => void;
  next: () => void;
  previous: () => void;
  clear: () => void;
}

const DEBOUNCE_MS = 150;

export function clearSearchHighlights(container: HTMLElement) {
  clearMarks(container, isSearchMark);
}

export function highlightSearchMatches(container: HTMLElement, query: string): HTMLElement[] {
  if (!query.trim()) return [];
  const { spans } = collectText(container);
  // Search across inline formatting and marks, but not across block boundaries
  // or hidden/unsupported renderer text.
  const runs: { text: string; spans: TextSpan[] }[] = [];
  let previous: TextSpan | undefined;
  let previousBlock: Element | null = null;
  for (const span of spans) {
    const block = span.node.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, pre, li, td, th, .mermaid-diagram") ?? container;
    if (!previous || previous.end !== span.start || block !== previousBlock) runs.push({ text: "", spans: [] });
    const run = runs[runs.length - 1];
    run.spans.push({ node: span.node, start: run.text.length, end: run.text.length + span.node.length });
    run.text += span.node.data;
    previous = span;
    previousBlock = block;
  }
  const matches: HTMLElement[] = [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Regex indices remain UTF-16 DOM offsets even when case folding expands a
  // character; indexing a lowercased copy did not provide that guarantee.
  for (const run of runs) {
    const found = [...run.text.matchAll(new RegExp(escaped, "giu"))];
    const byNode = new Map<TextSpan, { start: number; end: number; first: boolean }[]>();
    let spanIndex = 0;
    for (const match of found) {
      const start = match.index!;
      const end = start + match[0].length;
      while (run.spans[spanIndex].end <= start) spanIndex++;
      // A match can span several formatting nodes. Paint each fragment, but
      // keep only its first mark for match counting and navigation.
      for (let i = spanIndex; i < run.spans.length && run.spans[i].start < end; i++) {
        const span = run.spans[i];
        const ranges = byNode.get(span) ?? [];
        ranges.push({
          start: Math.max(start, span.start) - span.start,
          end: Math.min(end, span.end) - span.start,
          first: i === spanIndex,
        });
        byNode.set(span, ranges);
      }
    }

    // Splitting a live text node for every match stalls on dense paragraphs.
    // Build its text and marks off-DOM, then insert them once.
    for (const [span, ranges] of byNode) {
      const node = span.node;
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const { start, end, first } of ranges) {
        if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
        const mark = document.createElement("mark");
        mark.className = SEARCH_HIGHLIGHT_CLASS;
        mark.textContent = text.slice(start, end);
        fragment.append(mark);
        if (first) matches.push(mark);
        cursor = end;
      }
      if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
      // React still owns this node. Keep it as the first piece, as splitText
      // did, so clearing search puts the same node back with its full text.
      const first = fragment.firstChild!;
      node.after(fragment);
      node.data = first.textContent!;
      if (first.nodeType === Node.TEXT_NODE) first.remove();
      else (first as Element).replaceChildren(node);
    }
  }
  return matches;
}

function setActiveMatch(matches: HTMLElement[], index: number, prevIndex: number, reducedMotion: boolean) {
  if (prevIndex >= 0 && prevIndex < matches.length && matches[prevIndex].isConnected) {
    matches[prevIndex].className = SEARCH_HIGHLIGHT_CLASS;
  }

  if (index >= 0 && index < matches.length && matches[index].isConnected) {
    matches[index].className = SEARCH_ACTIVE_CLASS;
    matches[index].scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }
}

export function useSearch(contentRef: React.RefObject<HTMLElement | null>, reducedMotion = false): UseSearchResult {
  const [state, setState] = useState<SearchState>({
    query: "",
    matchCount: 0,
    currentIndex: -1,
  });

  const matchesRef = useRef<HTMLElement[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const performSearch = useCallback(
    (query: string) => {
      const container = contentRef.current;
      if (!container) {
        matchesRef.current = [];
        setState({ query, matchCount: 0, currentIndex: -1 });
        return;
      }

      clearSearchHighlights(container);

      if (!query.trim()) {
        matchesRef.current = [];
        setState({ query, matchCount: 0, currentIndex: -1 });
        return;
      }

      const matches = highlightSearchMatches(container, query);
      matchesRef.current = matches;
      const currentIndex = matches.length > 0 ? 0 : -1;
      if (currentIndex >= 0) {
        setActiveMatch(matches, currentIndex, -1, reducedMotionRef.current);
      }
      setState({ query, matchCount: matches.length, currentIndex });
    },
    [contentRef],
  );

  const setQuery = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setState((prev) => ({ ...prev, query: q }));

      debounceRef.current = setTimeout(() => {
        performSearch(q);
      }, DEBOUNCE_MS);
    },
    [performSearch],
  );

  const next = useCallback(() => {
    const matches = matchesRef.current;
    if (matches.length === 0) return;
    setState((prev) => {
      const nextIndex = (prev.currentIndex + 1) % matches.length;
      setActiveMatch(matches, nextIndex, prev.currentIndex, reducedMotion);
      return { ...prev, currentIndex: nextIndex };
    });
  }, [reducedMotion]);

  const previous = useCallback(() => {
    const matches = matchesRef.current;
    if (matches.length === 0) return;
    setState((prev) => {
      const prevIndex = (prev.currentIndex - 1 + matches.length) % matches.length;
      setActiveMatch(matches, prevIndex, prev.currentIndex, reducedMotion);
      return { ...prev, currentIndex: prevIndex };
    });
  }, [reducedMotion]);

  const clear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const container = contentRef.current;
    if (container) {
      clearSearchHighlights(container);
    }
    matchesRef.current = [];
    setState({ query: "", matchCount: 0, currentIndex: -1 });
  }, [contentRef]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const container = contentRef.current;
      if (container) {
        clearSearchHighlights(container);
      }
    };
  }, [contentRef]);

  return {
    query: state.query,
    matchCount: state.matchCount,
    currentIndex: state.currentIndex,
    setQuery,
    next,
    previous,
    clear,
  };
}
