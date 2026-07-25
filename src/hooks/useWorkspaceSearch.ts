import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecentFile, WorkspaceDocIndex, WorkspaceSearchHit } from "../types";
import { createRecentBoostMap, searchWorkspaceDocs } from "../lib/workspace-search";

const SEARCH_DEBOUNCE_MS = 100;

interface UseWorkspaceSearchArgs {
  docs: WorkspaceDocIndex[];
  recentFiles: RecentFile[];
  maxResults?: number;
}

export function useWorkspaceSearch({ docs, recentFiles, maxResults = 50 }: UseWorkspaceSearchArgs) {
  const [query, setQueryState] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(q);
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const recentBoostByPath = useMemo(
    () => createRecentBoostMap(recentFiles.map((f) => f.path)),
    [recentFiles],
  );

  const results = useMemo(
    () => searchWorkspaceDocs(docs, debouncedQuery, recentBoostByPath, maxResults),
    [docs, debouncedQuery, recentBoostByPath, maxResults],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQuery, results.length]);

  const moveNext = useCallback(() => {
    setSelectedIndex((prev) => {
      if (results.length === 0) return 0;
      return (prev + 1) % results.length;
    });
  }, [results.length]);

  const movePrevious = useCallback(() => {
    setSelectedIndex((prev) => {
      if (results.length === 0) return 0;
      return prev === 0 ? results.length - 1 : prev - 1;
    });
  }, [results.length]);

  const selectedHit: WorkspaceSearchHit | null =
    results.length > 0 ? results[Math.min(selectedIndex, results.length - 1)] : null;

  const reset = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQueryState("");
    setDebouncedQuery("");
    setSelectedIndex(0);
  }, []);

  return {
    query,
    setQuery,
    results,
    selectedIndex,
    setSelectedIndex,
    selectedHit,
    moveNext,
    movePrevious,
    reset,
  };
}
