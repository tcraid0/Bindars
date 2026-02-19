import { useState, useCallback, useEffect } from "react";
import { storeGet, storeSet } from "../lib/store";
import type { RecentFile } from "../types";

const STORE_KEY = "recent-files";
const MAX_RECENT = 10;

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load from Tauri store on mount
  useEffect(() => {
    storeGet<RecentFile[]>(STORE_KEY).then((stored) => {
      if (stored && Array.isArray(stored)) {
        setRecentFiles(stored);
      }
      setLoaded(true);
    });
  }, []);

  const persist = useCallback((files: RecentFile[]) => {
    storeSet(STORE_KEY, files);
  }, []);

  const addRecent = useCallback(
    (path: string, name: string) => {
      setRecentFiles((prev) => {
        const existing = prev.find((f) => f.path === path);
        const filtered = prev.filter((f) => f.path !== path);
        const entry: RecentFile = {
          path,
          name,
          openedAt: Date.now(),
          lastHeadingId: existing?.lastHeadingId ?? null,
        };
        const next = [entry, ...filtered].slice(0, MAX_RECENT);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const removeRecent = useCallback(
    (path: string) => {
      setRecentFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const updateScrollPosition = useCallback(
    (path: string, headingId: string | null) => {
      setRecentFiles((prev) => {
        const idx = prev.findIndex((f) => f.path === path);
        if (idx === -1) return prev;
        if (prev[idx].lastHeadingId === headingId) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], lastHeadingId: headingId };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const getScrollPosition = useCallback(
    (path: string): string | null => {
      const file = recentFiles.find((f) => f.path === path);
      return file?.lastHeadingId ?? null;
    },
    [recentFiles],
  );

  return { recentFiles, loaded, addRecent, removeRecent, updateScrollPosition, getScrollPosition };
}
