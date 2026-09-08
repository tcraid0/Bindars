import { useState, useCallback, useEffect, useRef } from "react";
import { storeTryGet, storeSet } from "../lib/store";
import { runMigrations } from "../lib/migrations";
import { decodeRecentFiles } from "../lib/recent-files";
import type { RecentFile } from "../types";

const STORE_KEY = "recent-files";
const MAX_RECENT = 10;

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  // Mutations use the latest list even within one React batch, without doing
  // persistence inside a state updater that StrictMode can replay.
  const filesRef = useRef(recentFiles);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await runMigrations();
        if (!active) return;
        const result = await storeTryGet<unknown>(STORE_KEY);
        if (!active) return;
        if (!result.ok) throw new Error("Could not read recent history");
        const files = decodeRecentFiles(result.value);
        if (files === null) throw new Error("Unsupported recent history format");
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
    void storeSet(STORE_KEY, files);
  }, [status]);

  const addRecent = useCallback(
    (path: string, name: string) => {
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
    [persist],
  );

  const removeRecent = useCallback(
    (path: string) => {
      persist(filesRef.current.filter((f) => f.path !== path));
    },
    [persist],
  );

  const updateScrollPosition = useCallback(
    (path: string, headingId: string | null) => {
      const prev = filesRef.current;
      const idx = prev.findIndex((f) => f.path === path);
      if (idx === -1 || prev[idx].lastHeadingId === headingId) return;
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

  return { recentFiles, status, addRecent, removeRecent, updateScrollPosition, getScrollPosition };
}
