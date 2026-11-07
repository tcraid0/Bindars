import { useState, useCallback, useEffect, useRef } from "react";
import { loadRecentFiles, saveRecentFiles } from "../lib/recent-files";
import type { RecentFile } from "../types";
import { toPathIdentityKey } from "../lib/paths";

const MAX_RECENT = 25;

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  // Mutations use the latest list even within one React batch, without doing
  // persistence inside a state updater that StrictMode can replay.
  const filesRef = useRef(recentFiles);
  const [removedRecent, setRemovedRecent] = useState<RecentFile | null>(null);
  const removedRef = useRef<RecentFile | null>(null);
  const dismissRecentRemoval = useCallback(() => {
    removedRef.current = null;
    setRemovedRecent(null);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const files = await loadRecentFiles();
        if (!active) return;
        filesRef.current = files;
        setRecentFiles(files);
        setStatus("ready");
      } catch (error) {
        if (!active) return;
        console.warn("[recents] History is unavailable:", error);
        setStatus("unavailable");
      }
    })();
    return () => { active = false; };
  }, []);

  const persist = useCallback((files: RecentFile[]) => {
    if (status !== "ready") return;
    filesRef.current = files;
    setRecentFiles(files);
    void saveRecentFiles(files);
  }, [status]);

  const addRecent = useCallback(
    (path: string, name: string) => {
      if (removedRef.current && toPathIdentityKey(removedRef.current.path) === toPathIdentityKey(path)) dismissRecentRemoval();
      const prev = filesRef.current;
      const existing = prev.find((f) => f.path === path);
      const filtered = prev.filter((f) => f.path !== path);
      const entry: RecentFile = {
        ...existing,
        path,
        name,
        openedAt: Date.now(),
        lastHeadingId: existing?.lastHeadingId ?? null,
      };
      persist([entry, ...filtered].slice(0, MAX_RECENT));
    },
    [persist, dismissRecentRemoval],
  );

  const removeRecent = useCallback(
    (path: string, { recoverable = false } = {}) => {
      if (status !== "ready") return;
      const removed = filesRef.current.find(file => file.path === path);
      if (recoverable && removed) {
        removedRef.current = removed;
        setRemovedRecent(removed);
      } else if (removedRef.current?.path === path) {
        dismissRecentRemoval();
      }
      persist(filesRef.current.filter((f) => f.path !== path));
    },
    [persist, status, dismissRecentRemoval],
  );

  const restoreRemovedRecent = useCallback(() => {
    const removed = removedRef.current;
    if (!removed || status !== "ready") return;
    const current = filesRef.current;
    // A reopened document's live reading state wins, including within one batch.
    if (!current.some(file => toPathIdentityKey(file.path) === toPathIdentityKey(removed.path))) {
      // Reserve one place for the restored record, even if it is the oldest.
      const kept = [...current].sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENT - 1);
      persist([...kept, removed].sort((a, b) => b.openedAt - a.openedAt));
    }
    dismissRecentRemoval();
    return removed;
  }, [persist, status, dismissRecentRemoval]);

  const updateScrollPosition = useCallback(
    (path: string, headingId: string | null) => {
      const prev = filesRef.current;
      const idx = prev.findIndex((f) => f.path === path);
      if (idx === -1) {
        const removed = removedRef.current;
        if (removed?.path === path && removed.lastHeadingId !== headingId) {
          const updated = { ...removed, lastHeadingId: headingId };
          removedRef.current = updated;
          setRemovedRecent(updated);
        }
        return;
      }
      if (prev[idx].lastHeadingId === headingId) return;
      const next = [...prev];
      next[idx] = { ...next[idx], lastHeadingId: headingId };
      persist(next);
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

  return { recentFiles, status, addRecent, removeRecent, updateScrollPosition, getScrollPosition,
    removedRecent, restoreRemovedRecent, dismissRecentRemoval };
}
