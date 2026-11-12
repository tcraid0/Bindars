import { fileName } from "../lib/paths";
import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useEffect, useRef } from "react";
import { loadAnnotations, saveAnnotations } from "../lib/annotation-storage";
import { readAnnotationRecord, storedAnnotationRecord, type AnnotationRecord } from "../lib/annotation-record";
import { EMPTY_ANNOTATIONS, type AnnotationLoadStatus } from "../lib/annotation-state";
import type { FileAnnotations, Highlight, HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";
import { hasPassageBasis, type PassageRefresh, type PassageClaim } from "../lib/highlight-continuity";

interface Entry extends AnnotationRecord {
  passageChoices: Map<string, object>;
  status: AnnotationLoadStatus;
  loadError: string | null;
  revision: number;
  savedRevision: number;
  writing: boolean;
  saveError: string | null;
}

/** An ephemeral intent; note/color edits do not invalidate its attachment. */
export interface PassageChoice {
  id: string;
  excerpt: string;
  isCurrent: () => boolean;
  usePassage: (anchor: TextAnchor, headingId: string | null) => boolean;
  cancel: () => void;
}

export function useAnnotations(filePath: string | null) {
  const session = useRef({ filePath });
  if (session.current.filePath !== filePath) session.current = { filePath };
  const entries = useRef(new Map<string, Entry>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const locked = useRef(false);
  const reconnecting = useRef(false);
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
          entry.saveError = `Couldn't save annotations for ${fileName(path)}. Your changes are still available in this session.`;
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
    const entry: Entry = { ...readAnnotationRecord(null), passageChoices: new Map(), status: "loading", loadError: null,
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
    if (!filePath || locked.current || reconnecting.current) return;
    const entry = entries.current.get(filePath);
    if (!entry || entry.status !== "ready") return;
    const next = change(entry.annotations);
    if (next === entry.annotations) return;
    entry.annotations = next;
    entry.revision++;
    mutationVersion.current++;
    notify();
    persist(filePath, entry);
    return true;
  }, [filePath, notify, persist]);

  const addHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, nearestHeadingId: string | null) => {
    if (!anchor.exact.trim()) return;
    const highlight: Highlight = { ...anchor, id: crypto.randomUUID(), color, nearestHeadingId, createdAt: Date.now() };
    return mutate((prev) => ({ ...prev, highlights: [...prev.highlights, highlight] })) ? highlight.id : undefined;
  }, [mutate]);
  const removeHighlight = useCallback((id: string) => {
    if (filePath) entries.current.get(filePath)?.passageChoices.delete(id);
    mutate((prev) => prev.highlights.some((h) => h.id === id)
      ? { ...prev, highlights: prev.highlights.filter((h) => h.id !== id) } : prev);
  }, [filePath, mutate]);
  const updateHighlight = useCallback((id: string, updates: Partial<Pick<Highlight, "color" | "note">>) => {
    mutate((prev) => {
      const highlight = prev.highlights.find((h) => h.id === id);
      if (!highlight) return prev;
      if ((!Object.prototype.hasOwnProperty.call(updates, "note") || updates.note === highlight.note)
        && (!Object.prototype.hasOwnProperty.call(updates, "color") || updates.color === highlight.color)) return prev;
      return { ...prev, highlights: prev.highlights.map((h) => h.id === id ? { ...h, ...updates } : h) };
    });
  }, [mutate]);
  const annotationSession = session.current;
  // Continuity results apply only to highlights still attached to the passage
  // they were computed from, and never while a passage choice is in progress.
  const updateTrackedPassages = useCallback(<T extends { id: string; basis: TextAnchor }>(
    items: T[], apply: (highlight: Highlight, item: T) => Highlight) => {
    if (!items.length || !mounted.current || session.current !== annotationSession || !filePath) return;
    const entry = entries.current.get(filePath);
    const byId = new Map(items.map(item => [item.id, item]));
    mutate(prev => {
      let changed = false;
      const highlights = prev.highlights.map(highlight => {
        const item = byId.get(highlight.id);
        if (!item || entry?.passageChoices.has(highlight.id) || !hasPassageBasis(highlight, item.basis)) return highlight;
        const next = apply(highlight, item);
        if (next !== highlight) changed = true;
        return next;
      });
      return changed ? { ...prev, highlights } : prev;
    });
  }, [annotationSession, filePath, mutate]);
  const refreshPassages = useCallback((updates: PassageRefresh[]) => {
    const accepted = new Map<string, TextAnchor>();
    updateTrackedPassages(updates, (highlight, { anchor }) => {
      if (!anchor.position || highlight.exact !== anchor.exact) return highlight;
      accepted.set(highlight.id, anchor);
      // Attachment fields only: retain concurrent notes/colors and future fields.
      const { continuity: _claim, ...retained } = highlight;
      return { ...retained, prefix: anchor.prefix, suffix: anchor.suffix, position: anchor.position };
    });
    return accepted;
  }, [updateTrackedPassages]);
  const recordDepartureClaims = useCallback((claims: PassageClaim[]) => {
    updateTrackedPassages(claims, (highlight, { claim }) => ({ ...highlight, continuity: claim }));
  }, [updateTrackedPassages]);
  const beginPassageChoice = useCallback((id: string): PassageChoice | null => {
    if (!filePath || locked.current || reconnecting.current) return null;
    const entry = entries.current.get(filePath);
    const highlight = entry?.annotations.highlights.find((h) => h.id === id);
    if (!entry || entry.status !== "ready" || !highlight) return null;
    const owner = session.current;
    const token = {};
    entry.passageChoices.set(id, token);
    const isCurrent = () => mounted.current && session.current === owner && !locked.current && !reconnecting.current
      && entries.current.get(filePath) === entry && entry.passageChoices.get(id) === token
      && entry.annotations.highlights.some((h) => h.id === id);
    const cancel = () => { if (entry.passageChoices.get(id) === token) entry.passageChoices.delete(id); };
    return { id, excerpt: highlight.exact, isCurrent, cancel,
      usePassage(anchor, headingId) {
        if (!isCurrent() || !anchor.exact.trim() || !anchor.position) return false;
        const accepted = mutate((prev) => ({ ...prev, highlights: prev.highlights.map((h) => {
          if (h.id !== id) return h;
          const { continuity: _claim, ...retained } = h;
          return { ...retained, ...anchor, nearestHeadingId: headingId,
          // Preserve the earliest excerpt, as well as unrecognized future fields.
          ...(!Object.prototype.hasOwnProperty.call(h, "originalExcerpt") && h.exact !== anchor.exact
            ? { originalExcerpt: h.exact } : {}),
        }; }) }));
        if (accepted) cancel();
        return !!accepted;
      },
    };
  }, [filePath, mutate]);
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
    if (!filePath || locked.current || reconnecting.current) return;
    const entry = entries.current.get(filePath);
    if (!entry || entry.status !== "ready") return;
    Object.assign(entry, readAnnotationRecord(value));
    entry.passageChoices.clear();
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
  // A document may be deleted only when its record is known to be saved and
  // empty. Loading, failed loads and unsaved removals cannot prove that.
  const recordState = useCallback((path: string): "empty" | "annotated" | "unknown" => {
    const entry = entries.current.get(path);
    if (!entry || entry.status !== "ready") return "unknown";
    if (entry.annotations.highlights.length || entry.annotations.bookmarks.length
      || entry.retainedHighlights.length || entry.retainedBookmarks.length) return "annotated";
    return entry.revision === entry.savedRevision ? "empty" : "unknown";
  }, []);
  const setLocked = useCallback((value: boolean) => { locked.current = value; }, []);
  const getMutationVersion = useCallback(() => mutationVersion.current, []);
  const retryLoad = useCallback(() => setLoadRetryNonce((v) => v + 1), []);
  const reconnect = useCallback(async (source: string, destination: string, expected: unknown, revision: import("../types").FileRevision) => {
    if (locked.current || reconnecting.current) throw new Error("Another annotation operation is in progress.");
    reconnecting.current = true;
    const operation = queue.current.then(async () => {
      if ([...entries.current.values()].some(entry => entry.revision !== entry.savedRevision)) {
        throw new Error("Save pending annotation changes, then preview again.");
      }
      await invoke("reconnect_annotations", { source, destination, expected, revision });
      // Invalidate both cached identities before unlocking mutations.
      entries.current.delete(source); entries.current.delete(destination);
      mutationVersion.current++;
      setLoadRetryNonce(n => n + 1); notify();
    });
    queue.current = operation.catch(() => {});
    try { await operation; } finally { reconnecting.current = false; }
  }, [notify]);
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
    addHighlight, removeHighlight, updateHighlight, refreshPassages, recordDepartureClaims, beginPassageChoice, toggleBookmark, removeBookmark, isBookmarked,
    reconnect, restoreRecord, retryLoad, retrySave, waitForSaves, pendingRecords, recordState, setLocked, getMutationVersion,
  };
}
