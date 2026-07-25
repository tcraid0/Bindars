import { useState, useCallback, useEffect, useRef } from "react";
import { storeSet, storeTryGet } from "../lib/store";
import {
  EMPTY_ANNOTATIONS,
  applyAnnotationMutation,
  areAnnotationsReady,
  beginAnnotationLoad,
  completeAnnotationLoad,
  createAnnotationLoadState,
  failAnnotationLoad,
  type AnnotationLoadState,
} from "../lib/annotation-state";
import { queueAnnotationPersist } from "../lib/annotation-persistence";
import type { FileAnnotations, Highlight, Bookmark, HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";

function storeKey(filePath: string): string {
  return `annotations:${filePath}`;
}

function fileLabel(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const VALID_HIGHLIGHT_COLORS = new Set<HighlightColor>(["yellow", "green", "blue", "pink"]);

interface FailedPersist {
  path: string;
  annotations: FileAnnotations;
}

function normalizeAnnotations(stored: unknown): FileAnnotations {
  if (!stored || typeof stored !== "object") {
    return EMPTY_ANNOTATIONS;
  }

  const raw = stored as Partial<FileAnnotations>;
  const highlights = Array.isArray(raw.highlights)
    ? raw.highlights
        .map((item) => normalizeHighlight(item))
        .filter((item): item is Highlight => item !== null)
    : [];
  const bookmarks = Array.isArray(raw.bookmarks)
    ? raw.bookmarks
        .map((item) => normalizeBookmark(item))
        .filter((item): item is Bookmark => item !== null)
    : [];

  return { highlights, bookmarks };
}

function normalizeHighlight(value: unknown): Highlight | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const item = value as Partial<Highlight>;
  if (
    typeof item.id !== "string" ||
    typeof item.prefix !== "string" ||
    typeof item.exact !== "string" ||
    typeof item.suffix !== "string"
  ) {
    return null;
  }

  const color = VALID_HIGHLIGHT_COLORS.has(item.color as HighlightColor)
    ? (item.color as HighlightColor)
    : "yellow";

  return {
    id: item.id,
    prefix: item.prefix,
    exact: item.exact,
    suffix: item.suffix,
    color,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
    nearestHeadingId:
      typeof item.nearestHeadingId === "string" || item.nearestHeadingId === null
        ? item.nearestHeadingId
        : null,
    note: typeof item.note === "string" ? item.note : undefined,
  };
}

function normalizeBookmark(value: unknown): Bookmark | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const item = value as Partial<Bookmark>;
  if (
    typeof item.id !== "string" ||
    typeof item.headingId !== "string" ||
    typeof item.headingText !== "string"
  ) {
    return null;
  }

  return {
    id: item.id,
    headingId: item.headingId,
    headingText: item.headingText,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
}

export function useAnnotations(filePath: string | null) {
  const [loadState, setLoadState] = useState<AnnotationLoadState>(() =>
    createAnnotationLoadState(filePath)
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrorVersion, setSaveErrorVersion] = useState(0);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const failedPersistRef = useRef<FailedPersist | null>(null);

  const updateLoadState = useCallback((updater: (state: AnnotationLoadState) => AnnotationLoadState) => {
    setLoadState(updater);
  }, []);

  // Load annotations when file changes
  useEffect(() => {
    updateLoadState((prev) => beginAnnotationLoad(prev, filePath));
    if (!filePath) {
      return;
    }

    const requestedPath = filePath;
    storeTryGet<unknown>(storeKey(filePath))
      .then((result) => {
        if (!result.ok) {
          console.warn("[useAnnotations] Failed to load:", result.error);
          updateLoadState((prev) =>
            failAnnotationLoad(
              prev,
              requestedPath,
              "Couldn't load annotations. Existing annotations were not changed.",
            )
          );
          return;
        }

        updateLoadState((prev) =>
          completeAnnotationLoad(prev, requestedPath, normalizeAnnotations(result.value))
        );
      })
      .catch((err) => {
        console.warn("[useAnnotations] Failed to load:", err);
        updateLoadState((prev) =>
          failAnnotationLoad(
            prev,
            requestedPath,
            "Couldn't load annotations. Existing annotations were not changed.",
          )
        );
      });
  }, [filePath, loadRetryNonce, updateLoadState]);

  const persist = useCallback((path: string, next: FileAnnotations) => {
    const key = storeKey(path);
    const data = { ...next, version: 2 };
    const failedPayload = { path, annotations: next };
    const queued = queueAnnotationPersist(
      persistQueueRef.current,
      () => storeSet(key, data),
      (err) => {
        failedPersistRef.current = failedPayload;
        console.warn("[useAnnotations] Failed to save:", err);
        setSaveError(`Couldn't save annotations for ${fileLabel(path)}. Changes may not persist.`);
        setSaveErrorVersion((version) => version + 1);
      },
      () => {
        if (failedPersistRef.current?.path === path) {
          failedPersistRef.current = null;
          setSaveError(null);
        }
      },
    );
    persistQueueRef.current = queued.then(() => undefined);
  }, []);

  const mutateLoadedAnnotations = useCallback(
    (mutate: (annotations: FileAnnotations) => FileAnnotations) => {
      updateLoadState((prev) => {
        const result = applyAnnotationMutation(prev, mutate);
        if (result.mutated && result.state.filePath) {
          persist(result.state.filePath, result.state.annotations);
        }
        return result.state;
      });
    },
    [persist, updateLoadState],
  );

  const addHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, nearestHeadingId: string | null) => {
    mutateLoadedAnnotations((prev) => {
      const highlight: Highlight = {
        id: generateId(),
        prefix: anchor.prefix,
        exact: anchor.exact,
        suffix: anchor.suffix,
        color,
        createdAt: Date.now(),
        nearestHeadingId,
      };
      return { ...prev, highlights: [...prev.highlights, highlight] };
    });
  }, [mutateLoadedAnnotations]);

  const removeHighlight = useCallback((id: string) => {
    mutateLoadedAnnotations((prev) => ({
      ...prev,
      highlights: prev.highlights.filter((h) => h.id !== id),
    }));
  }, [mutateLoadedAnnotations]);

  const updateHighlight = useCallback(
    (id: string, updates: Partial<Pick<Highlight, "color" | "note">>) => {
      mutateLoadedAnnotations((prev) => ({
        ...prev,
        highlights: prev.highlights.map((h) =>
          h.id === id ? { ...h, ...updates } : h
        ),
      }));
    },
    [mutateLoadedAnnotations],
  );

  const toggleBookmark = useCallback((headingId: string, headingText: string) => {
    mutateLoadedAnnotations((prev) => {
      const exists = prev.bookmarks.some((b) => b.headingId === headingId);
      if (exists) {
        return {
          ...prev,
          bookmarks: prev.bookmarks.filter((b) => b.headingId !== headingId),
        };
      }

      const bookmark: Bookmark = {
        id: generateId(),
        headingId,
        headingText,
        createdAt: Date.now(),
      };
      return { ...prev, bookmarks: [...prev.bookmarks, bookmark] };
    });
  }, [mutateLoadedAnnotations]);

  const isBookmarked = useCallback((headingId: string) => {
    return loadState.annotations.bookmarks.some((b) => b.headingId === headingId);
  }, [loadState.annotations.bookmarks]);

  const dismissSaveError = useCallback(() => {
    setSaveError(null);
  }, []);

  const retryLoad = useCallback(() => {
    if (!loadState.filePath) return;
    setLoadRetryNonce((nonce) => nonce + 1);
  }, [loadState.filePath]);

  const retrySave = useCallback(() => {
    const failed = failedPersistRef.current;
    if (!failed) return;
    persist(failed.path, failed.annotations);
  }, [persist]);

  return {
    status: loadState.status,
    ready: areAnnotationsReady(loadState),
    loadError: loadState.error,
    saveError,
    saveErrorVersion,
    canRetrySave: failedPersistRef.current !== null,
    highlights: loadState.annotations.highlights,
    bookmarks: loadState.annotations.bookmarks,
    addHighlight,
    removeHighlight,
    updateHighlight,
    toggleBookmark,
    isBookmarked,
    dismissSaveError,
    retryLoad,
    retrySave,
  };
}
