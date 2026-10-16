import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RecentFile,
  WorkspaceDocIndex,
  WorkspaceSearchHit,
} from "../types";
import {
  compareSearchHits,
  createRecentBoostMap,
  searchWorkspaceDocs,
} from "../lib/workspace-search";

const SEARCH_DEBOUNCE_MS = 100;

interface UseWorkspaceSearchArgs {
  docs: WorkspaceDocIndex[];
  recentFiles: RecentFile[];
  maxResults?: number;
}

export function useWorkspaceSearch({
  docs,
  recentFiles,
  maxResults = 50,
}: UseWorkspaceSearchArgs) {
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

  const recentPaths = JSON.stringify(recentFiles.map((file) => file.path));
  const recentBoostByPath = useMemo(
    () => createRecentBoostMap(JSON.parse(recentPaths) as string[]),
    [recentPaths],
  );

  const scope = useMemo(
    () => JSON.stringify(docs.map((doc) => doc.path)),
    [docs],
  );
  const searchKey = JSON.stringify([debouncedQuery, recentPaths, scope]);
  const latest = useRef({ docs, searchKey });
  latest.current = { docs, searchKey };
  const generation = useRef(0);
  const runningKey = useRef<string | null>(null);
  const [settled, setSettled] = useState<{
    key: string;
    hits: WorkspaceSearchHit[];
  } | null>(null);
  useEffect(() => {
    // Content preparation must not starve a running search. Finish its current
    // snapshot, then catch up. A different query or scope cancels immediately.
    if (runningKey.current === searchKey) return;
    const id = ++generation.current;
    runningKey.current = searchKey;
    const run = async () => {
      while (
        id === generation.current &&
        latest.current.searchKey === searchKey
      ) {
        const snapshot = latest.current.docs;
        const hits: WorkspaceSearchHit[] = [];
        for (let start = 0; start < snapshot.length; start += 8) {
          if (
            id !== generation.current ||
            latest.current.searchKey !== searchKey
          )
            return;
          hits.push(
            ...searchWorkspaceDocs(
              snapshot.slice(start, start + 8),
              debouncedQuery,
              recentBoostByPath,
              8,
            ),
          );
          if (start + 8 < snapshot.length)
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (id !== generation.current) return;
        setSettled({ key: searchKey, hits: hits.sort(compareSearchHits) });
        if (snapshot === latest.current.docs) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (id === generation.current) runningKey.current = null;
    };
    void run();
  }, [docs, searchKey, debouncedQuery, recentBoostByPath]);
  useEffect(
    () => () => {
      generation.current++;
      runningKey.current = null;
    },
    [],
  );
  // Never let Enter or a result button act on a different query than the input.
  const pending = query !== debouncedQuery || settled?.key !== searchKey;
  const results = pending ? [] : settled!.hits.slice(0, maxResults);

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
    results.length > 0
      ? results[Math.min(selectedIndex, results.length - 1)]
      : null;

  const reset = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQueryState("");
    setDebouncedQuery("");
    setSelectedIndex(0);
  }, []);

  return {
    query,
    pending,
    setQuery,
    results,
    totalDocuments: pending ? 0 : settled!.hits.length,
    selectedIndex,
    setSelectedIndex,
    selectedHit,
    moveNext,
    movePrevious,
    reset,
  };
}
