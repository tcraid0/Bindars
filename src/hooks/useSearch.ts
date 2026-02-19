import { useState, useCallback, useRef, useEffect } from "react";

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

const HIGHLIGHT_CLASS = "search-highlight";
const ACTIVE_CLASS = "search-highlight-active";
const DEBOUNCE_MS = 150;

function clearHighlights(container: HTMLElement) {
  const marks = container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}, mark.${ACTIVE_CLASS}`);
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (parent && parent.contains(mark)) {
      parents.add(parent);
      try {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      } catch {
        // DOM can change between query and replace while switching documents.
      }
    }
  }
  for (const parent of parents) {
    if (typeof parent.normalize === "function") {
      parent.normalize();
    }
  }
}

function highlightMatches(container: HTMLElement, query: string): HTMLElement[] {
  if (!query.trim()) return [];

  const matches: HTMLElement[] = [];
  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.toLowerCase().includes(lowerQuery)) {
      textNodes.push(node);
    }
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || "";
    const lowerText = text.toLowerCase();
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let searchIndex = lowerText.indexOf(lowerQuery, lastIndex);

    while (searchIndex !== -1) {
      if (searchIndex > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, searchIndex)));
      }

      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.textContent = text.slice(searchIndex, searchIndex + query.length);
      fragment.appendChild(mark);
      matches.push(mark);

      lastIndex = searchIndex + query.length;
      searchIndex = lowerText.indexOf(lowerQuery, lastIndex);
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    if (textNode.parentNode) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  return matches;
}

function setActiveMatch(matches: HTMLElement[], index: number, prevIndex: number) {
  if (prevIndex >= 0 && prevIndex < matches.length && matches[prevIndex].isConnected) {
    matches[prevIndex].className = HIGHLIGHT_CLASS;
  }

  if (index >= 0 && index < matches.length && matches[index].isConnected) {
    matches[index].className = ACTIVE_CLASS;
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

      clearHighlights(container);

      if (!query.trim()) {
        matchesRef.current = [];
        setState({ query, matchCount: 0, currentIndex: -1 });
        return;
      }

      const matches = highlightMatches(container, query);
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
      clearHighlights(container);
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
        clearHighlights(container);
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
