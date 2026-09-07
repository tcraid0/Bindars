import { collectText, rangeForOffsets, type TextSpan } from "../lib/dom-text";
import { wrapRange } from "../lib/text-anchoring";
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
  for (const run of runs.reverse()) {
    const found = [...run.text.matchAll(new RegExp(escaped, "giu"))];
    for (const match of found.reverse()) {
      const range = rangeForOffsets(run.spans, match.index!, match.index! + match[0].length);
      if (!range) continue;
      const marks = wrapRange(range, SEARCH_HIGHLIGHT_CLASS);
      if (marks[0]) matches.unshift(marks[0]);
    }
  }
  return matches;
}

function setActiveMatch(matches: HTMLElement[], index: number, prevIndex: number) {
  if (prevIndex >= 0 && prevIndex < matches.length && matches[prevIndex].isConnected) {
    matches[prevIndex].className = SEARCH_HIGHLIGHT_CLASS;
  }

  if (index >= 0 && index < matches.length && matches[index].isConnected) {
    matches[index].className = SEARCH_ACTIVE_CLASS;
    matches[index].scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

export function useSearch(contentRef: React.RefObject<HTMLElement | null>): UseSearchResult {
  const [state, setState] = useState<SearchState>({
    query: "",
    matchCount: 0,
    currentIndex: -1,
  });

  const matchesRef = useRef<HTMLElement[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setActiveMatch(matches, currentIndex, -1);
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
      setActiveMatch(matches, nextIndex, prev.currentIndex);
      return { ...prev, currentIndex: nextIndex };
    });
  }, []);

  const previous = useCallback(() => {
    const matches = matchesRef.current;
    if (matches.length === 0) return;
    setState((prev) => {
      const prevIndex = (prev.currentIndex - 1 + matches.length) % matches.length;
      setActiveMatch(matches, prevIndex, prev.currentIndex);
      return { ...prev, currentIndex: prevIndex };
    });
  }, []);

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
