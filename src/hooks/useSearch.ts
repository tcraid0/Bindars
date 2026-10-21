import { phraseMatches, searchText } from "../lib/search-text";
import type { SearchPassage } from "../types";
import type { TextSpan } from "../lib/dom-text";
import { collectSearchRuns, type SearchRun } from "../lib/search-runs";
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
  limited: boolean;
}

interface UseSearchResult {
  query: string;
  matchCount: number;
  currentIndex: number;
  limited: boolean;
  setQuery: (q: string) => void;
  next: () => void;
  previous: () => void;
  clear: () => void;
  openPassage: (passage: SearchPassage) => boolean;
}

const DEBOUNCE_MS = 150;
// Bound live DOM work on both paint and clear, including multi-node matches.
export const MAX_SEARCH_MATCHES = 1000;
export const MAX_SEARCH_FRAGMENTS = 2000;

export function clearSearchHighlights(container: HTMLElement) {
  clearMarks(container, isSearchMark);
}

export function highlightSearchMatches(container: HTMLElement, query: string): HTMLElement[][] {
  return paintSearchRuns(collectSearchRuns(container), query).matches;
}
function paintSearchRuns(runs: SearchRun[], query: string, skipFirstMatches = 0) {
  const matches: HTMLElement[][] = [];
  const byRun = new Map<SearchRun, HTMLElement[][]>();
  let fragmentCount = 0;
  let limited = false;
  if (!query.trim()) return { matches, byRun, limited };

  // Original offsets remain UTF-16 DOM offsets when case folding expands text.
  for (const run of runs) {
    const runMatches: HTMLElement[][] = [];
    byRun.set(run, runMatches);
    // One extra result distinguishes an exact count from a truncated prefix.
    const skip = run === runs[0] ? skipFirstMatches : 0;
    const found = phraseMatches(run.text, query, !run.code, skip + MAX_SEARCH_MATCHES - matches.length + 1).slice(skip);
    const byNode = new Map<TextSpan, { start: number; end: number; fragments: HTMLElement[] }[]>();
    let spanIndex = 0;
    for (const match of found) {
      const { start, end } = match;
      while (run.spans[spanIndex].end <= start) spanIndex++;
      let spanEnd = spanIndex;
      while (spanEnd < run.spans.length && run.spans[spanEnd].start < end
        && fragmentCount + spanEnd - spanIndex <= MAX_SEARCH_FRAGMENTS) spanEnd++;
      if (matches.length === MAX_SEARCH_MATCHES || fragmentCount + spanEnd - spanIndex > MAX_SEARCH_FRAGMENTS) {
        limited = true;
        break; // Never paint or count a partial logical match.
      }
      fragmentCount += spanEnd - spanIndex;
      // One logical match can span several formatting or annotation nodes.
      const fragments: HTMLElement[] = [];
      matches.push(fragments);
      runMatches.push(fragments);
      for (let i = spanIndex; i < spanEnd; i++) {
        const span = run.spans[i];
        const ranges = byNode.get(span) ?? [];
        ranges.push({
          start: Math.max(start, span.start) - span.start,
          end: Math.min(end, span.end) - span.start,
          fragments,
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
      for (const { start, end, fragments } of ranges) {
        if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
        const mark = document.createElement("mark");
        mark.className = SEARCH_HIGHLIGHT_CLASS;
        mark.textContent = text.slice(start, end);
        fragment.append(mark);
        fragments.push(mark);
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
    if (limited) break;
  }
  return { matches, byRun, limited };
}

function findPassageRun(runs: SearchRun[], passage: SearchPassage) {
  return runs.filter(run => run.passageEligible
    && (passage.blockPrefix ? searchText(run.text).startsWith(passage.block) : searchText(run.text) === passage.block))[passage.blockOccurrence];
}

function setActiveMatch(matches: HTMLElement[][], index: number, prevIndex: number, reducedMotion: boolean, scroll = true) {
  // Class updates must stick on detached marks. A diagram refresh reads the
  // active class, and Next/Previous can run after a redraw removes that mark.
  if (prevIndex >= 0 && prevIndex < matches.length && prevIndex !== index) {
    for (const mark of matches[prevIndex]) mark.className = SEARCH_HIGHLIGHT_CLASS;
  }

  if (index >= 0 && index < matches.length) {
    for (const mark of matches[index]) mark.className = SEARCH_ACTIVE_CLASS;
    const first = matches[index][0];
    if (scroll && first.isConnected) {
      first.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    }
  }
}

export function useSearch(contentRef: React.RefObject<HTMLElement | null>, reducedMotion = false): UseSearchResult {
  const [state, setState] = useState<SearchState>({
    query: "",
    matchCount: 0,
    currentIndex: -1,
    limited: false,
  });

  const matchesRef = useRef<HTMLElement[][]>([]);
  const passageWindowRef = useRef<SearchPassage | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFrameRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const cancelPendingWork = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (refreshFrameRef.current !== null) cancelAnimationFrame(refreshFrameRef.current);
    debounceRef.current = null;
    refreshFrameRef.current = null;
  }, []);

  const performSearch = useCallback(
    (query: string, refresh = false) => {
      if (!refresh) passageWindowRef.current = null;
      const container = contentRef.current;
      if (!container) {
        matchesRef.current = [];
        setState({ query, matchCount: 0, currentIndex: -1, limited: false });
        return;
      }

      const oldMatches = matchesRef.current;
      const oldIndex = refresh ? oldMatches.findIndex(([first]) => first.classList.contains(SEARCH_ACTIVE_CLASS)) : 0;
      const oldActive = oldMatches[oldIndex];
      // Keep a surviving result in its parent when a late diagram adds earlier
      // matches. Replaced labels have no surviving identity: retain their ordinal.
      const parent = refresh && oldActive?.[0].isConnected ? oldActive[0].parentElement : null;
      const localIndex = parent ? oldMatches.filter(([first]) => parent.contains(first)).indexOf(oldActive) : -1;

      clearSearchHighlights(container);
      const runs = query.trim() ? collectSearchRuns(container) : [];
      const passageWindow = passageWindowRef.current;
      const start = passageWindow && findPassageRun(runs, passageWindow);
      const result = paintSearchRuns(start ? runs.slice(runs.indexOf(start)) : runs, query, start ? passageWindow.matchOccurrence : 0);
      const { matches } = result;
      const limited = result.limited || !!start;
      matchesRef.current = matches;
      const surviving = parent ? matches.filter(([first]) => parent.contains(first))[localIndex] : undefined;
      const currentIndex = surviving ? matches.indexOf(surviving)
        : matches.length ? Math.min(Math.max(oldIndex, 0), matches.length - 1) : -1;
      if (currentIndex >= 0) {
        setActiveMatch(matches, currentIndex, -1, reducedMotionRef.current, !refresh);
      }
      setState({ query, matchCount: matches.length, currentIndex, limited });
    },
    [contentRef],
  );

  const setQuery = useCallback(
    (q: string) => {
      cancelPendingWork();
      setState((prev) => ({ ...prev, query: q }));

      const container = contentRef.current;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (contentRef.current === container) performSearch(q);
      }, DEBOUNCE_MS);
    },
    [cancelPendingWork, contentRef, performSearch],
  );

  const openPassage = useCallback((passage: SearchPassage): boolean => {
    cancelPendingWork();
    passageWindowRef.current = null;
    const container = contentRef.current;
    if (!container) return false;
    clearSearchHighlights(container);
    // Resolve the whole normalized block and its ordinal before painting any
    // match. Identical passages are distinct; an unresolved target paints none.
    const runs = collectSearchRuns(container);
    const block = findPassageRun(runs, passage);
    if (!block) { matchesRef.current = []; setState({ query: "", matchCount: 0, currentIndex: -1, limited: false }); return false; }
    let result = paintSearchRuns(runs, passage.phrase);
    let target = result.byRun.get(block)?.[passage.matchOccurrence];
    if (!target && result.limited) {
      // A workspace passage can lie beyond the painted prefix. Start a bounded
      // window there so the cap does not make a valid passage unnavigable.
      clearSearchHighlights(container);
      const targetRuns = collectSearchRuns(container).slice(runs.indexOf(block));
      result = paintSearchRuns(targetRuns, passage.phrase, passage.matchOccurrence);
      target = result.byRun.get(targetRuns[0])?.[0];
      result.limited = true;
      if (target) passageWindowRef.current = passage;
    }
    const { matches, limited } = result;
    if (!target) {
      clearSearchHighlights(container);
      matchesRef.current = [];
      passageWindowRef.current = null;
      setState({ query: "", matchCount: 0, currentIndex: -1, limited: false });
      return false;
    }
    const index = matches.indexOf(target);
    matchesRef.current = matches;
    setActiveMatch(matches, index, -1, reducedMotionRef.current);
    setState({ query: passage.phrase, matchCount: matches.length, currentIndex: index, limited });
    return true;
  }, [cancelPendingWork, contentRef]);

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
    cancelPendingWork();
    performSearch("");
  }, [cancelPendingWork, performSearch]);

  useEffect(() => {
    if (!state.query.trim()) return;
    const repaint = (event: Event) => {
      const container = contentRef.current;
      if (debounceRef.current !== null || !container || !(event.target instanceof Node)
        || !container.contains(event.target) || refreshFrameRef.current !== null) return;
      refreshFrameRef.current = requestAnimationFrame(() => {
        refreshFrameRef.current = null;
        if (debounceRef.current === null && contentRef.current === container && container.isConnected) {
          performSearch(state.query, true);
        }
      });
    };
    // The reader may not exist yet and can remount without changing the ref object.
    document.addEventListener("bindars:diagram-rendered", repaint);
    return () => {
      document.removeEventListener("bindars:diagram-rendered", repaint);
      if (refreshFrameRef.current !== null) cancelAnimationFrame(refreshFrameRef.current);
      refreshFrameRef.current = null;
    };
  }, [contentRef, performSearch, state.query]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingWork();
      const container = contentRef.current;
      if (container) {
        clearSearchHighlights(container);
      }
      matchesRef.current = [];
    };
  }, [cancelPendingWork, contentRef]);

  return {
    query: state.query,
    matchCount: state.matchCount,
    currentIndex: state.currentIndex,
    limited: state.limited,
    setQuery,
    next,
    previous,
    clear,
    openPassage,
  };
}
