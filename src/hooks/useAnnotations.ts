import { useState, useCallback, useEffect, useRef } from "react";
import { loadAnnotations, saveAnnotations } from "../lib/annotation-storage";
import { readAnnotationRecord, storedAnnotationRecord, type AnnotationRecord } from "../lib/annotation-record";
import { EMPTY_ANNOTATIONS, type AnnotationLoadStatus } from "../lib/annotation-state";
import type { FileAnnotations, Highlight, HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";

interface Entry extends AnnotationRecord {
  status: AnnotationLoadStatus;
  loadError: string | null;
  revision: number;
  savedRevision: number;
  writing: boolean;
  saveError: string | null;
}

function fileLabel(path: string) { return path.split(/[\\/]/).pop() || path; }

export function useAnnotations(filePath: string | null) {
  const entries = useRef(new Map<string, Entry>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const locked = useRef(false);
  // Close consent must detect new work across paths, including entries whose
  // per-document revision counters were reset by a clean reload.
  const mutationVersion = useRef(0);
  const [, refresh] = useState(0);
  const errorVersion = useRef(0);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
  const notify = useCallback(() => { if (mounted.current) refresh((v) => v + 1); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const persist = useCallback((path: string, entry: Entry) => {
    if (entry.writing || entry.revision === entry.savedRevision) return;
    entry.writing = true;
    entry.saveError = null;
    const operation = queue.current.then(async () => {
      // Capture the newest snapshot only when this document's turn arrives.
      // A retry never queues a previously failed snapshot behind a newer edit.
      while (entry.revision !== entry.savedRevision) {
        const revision = entry.revision;
        try {
          const record = storedAnnotationRecord(entry);
          await saveAnnotations(path, record);
          entry.savedRevision = revision;
          entry.saveError = null;
        } catch {
          errorVersion.current++;
          entry.saveError = `Couldn't save annotations for ${fileLabel(path)}. Your changes are still available in this session.`;
          if (entry.revision === revision) break;
        }
      }
      entry.writing = false;
      notify();
    });
    // Unexpected callback failures must not prevent later documents from saving.
    queue.current = operation.catch((error) => {
      console.error("[annotations] Save queue callback failed:", error);
    });
    notify();
  }, [notify]);

  useEffect(() => {
    if (!filePath) return;
    const previous = entries.current.get(filePath);
    // Disk cannot recover unacknowledged work. Keep this path's latest record.
    if (previous && previous.revision !== previous.savedRevision) return;
    const entry: Entry = { ...readAnnotationRecord(null), status: "loading", loadError: null,
      revision: 0, savedRevision: 0, writing: false, saveError: null };
    entries.current.set(filePath, entry);
    notify();
    let cancelled = false;
    void loadAnnotations(filePath).then((value) => {
      if (cancelled) return;
      Object.assign(entry, readAnnotationRecord(value), { status: "ready" });
      notify();
    }).catch((error) => {
      if (cancelled) return;
      entry.status = "error";
      entry.loadError = error instanceof Error ? error.message : "Couldn't load annotations. Existing data was preserved.";
      notify();
    });
    return () => { cancelled = true; };
  }, [filePath, loadRetryNonce, notify]);

  const mutate = useCallback((change: (annotations: FileAnnotations) => FileAnnotations) => {
    if (!filePath || locked.current) return;
    const entry = entries.current.get(filePath);
    if (!entry || entry.status !== "ready") return;
    const next = change(entry.annotations);
    if (next === entry.annotations) return;
    entry.annotations = next;
    entry.revision++;
    mutationVersion.current++;
    notify();
    persist(filePath, entry);
  }, [filePath, notify, persist]);

  const addHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, nearestHeadingId: string | null) => {
    if (!anchor.exact.trim()) return;
    const highlight: Highlight = { ...anchor, id: crypto.randomUUID(), color, nearestHeadingId, createdAt: Date.now() };
    mutate((prev) => ({ ...prev, highlights: [...prev.highlights, highlight] }));
  }, [mutate]);
  const removeHighlight = useCallback((id: string) => {
    mutate((prev) => prev.highlights.some((h) => h.id === id)
      ? { ...prev, highlights: prev.highlights.filter((h) => h.id !== id) } : prev);
  }, [mutate]);
  const updateHighlight = useCallback((id: string, updates: Partial<Pick<Highlight, "color" | "note">>) => {
    mutate((prev) => prev.highlights.some((h) => h.id === id)
      ? { ...prev, highlights: prev.highlights.map((h) => h.id === id ? { ...h, ...updates } : h) } : prev);
  }, [mutate]);
  const toggleBookmark = useCallback((headingId: string, headingText: string) => {
    const bookmark = { id: crypto.randomUUID(), headingId, headingText, createdAt: Date.now() };
    mutate((prev) => ({ ...prev, bookmarks: prev.bookmarks.some((b) => b.headingId === headingId)
      ? prev.bookmarks.filter((b) => b.headingId !== headingId) : [...prev.bookmarks, bookmark] }));
  }, [mutate]);
  const removeBookmark = useCallback((id: string) => {
    mutate((prev) => prev.bookmarks.some((b) => b.id === id)
      ? { ...prev, bookmarks: prev.bookmarks.filter((b) => b.id !== id) } : prev);
  }, [mutate]);

  const restoreRecord = useCallback((value: unknown) => {
    if (!filePath || locked.current) return;
    const entry = entries.current.get(filePath);
    if (!entry || entry.status !== "ready") return;
    Object.assign(entry, readAnnotationRecord(value));
    entry.revision++;
    mutationVersion.current++;
    notify();
    persist(filePath, entry);
  }, [filePath, notify, persist]);

  const retrySave = useCallback(() => {
    for (const [path, entry] of entries.current) persist(path, entry);
  }, [persist]);
  const waitForSaves = useCallback(async () => { await queue.current; }, []);
  const pendingRecords = useCallback(() => Object.fromEntries([...entries.current]
    .filter(([, entry]) => entry.revision !== entry.savedRevision)
    .map(([path, entry]) => [path, storedAnnotationRecord(entry)])), []);
  const setLocked = useCallback((value: boolean) => { locked.current = value; }, []);
  const getMutationVersion = useCallback(() => mutationVersion.current, []);
  const retryLoad = useCallback(() => setLoadRetryNonce((v) => v + 1), []);
  const current = filePath ? entries.current.get(filePath) : undefined;
  const annotations = current?.annotations ?? EMPTY_ANNOTATIONS;
  const isBookmarked = useCallback((id: string) => annotations.bookmarks.some((b) => b.headingId === id), [annotations.bookmarks]);
  const allEntries = [...entries.current.values()];
  const saveError = allEntries.map((entry) => entry.saveError).filter(Boolean).join("\n") || null;
  return {
    status: current?.status ?? (filePath ? "loading" : "idle"), ready: current?.status === "ready",
    loadError: current?.loadError ?? null, saveError, saveErrorVersion: errorVersion.current,
    saving: allEntries.some((entry) => entry.writing),
    canRetrySave: allEntries.some((entry) => entry.revision !== entry.savedRevision && !entry.writing),
    dataWarning: current && (current.retainedHighlights.length || current.retainedBookmarks.length)
      ? "Some annotation records could not be displayed. Their original data has been preserved." : null,
    highlights: annotations.highlights, bookmarks: annotations.bookmarks,
    addHighlight, removeHighlight, updateHighlight, toggleBookmark, removeBookmark, isBookmarked,
    restoreRecord, retryLoad, retrySave, waitForSaves, pendingRecords, setLocked, getMutationVersion,
  };
}
