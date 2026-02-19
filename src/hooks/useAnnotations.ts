import { useState, useCallback, useEffect, useRef } from "react";
import { storeGet, storeSet } from "../lib/store";
import type { FileAnnotations, Highlight, Bookmark, HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";

function storeKey(filePath: string): string {
  return `annotations:${filePath}`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY: FileAnnotations = { highlights: [], bookmarks: [] };
const VALID_HIGHLIGHT_COLORS = new Set<HighlightColor>(["yellow", "green", "blue", "pink"]);

function normalizeAnnotations(stored: unknown): FileAnnotations {
  if (!stored || typeof stored !== "object") {
    return EMPTY;
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
  const [annotations, setAnnotations] = useState<FileAnnotations>(EMPTY);
  const filePathRef = useRef(filePath);

  // Load annotations when file changes
  useEffect(() => {
    filePathRef.current = filePath;
    if (!filePath) {
      setAnnotations(EMPTY);
      return;
    }

    storeGet<unknown>(storeKey(filePath))
      .then((stored) => {
        if (filePathRef.current === filePath) {
          setAnnotations(normalizeAnnotations(stored));
        }
      })
      .catch((err) => {
        console.warn("[useAnnotations] Failed to load:", err);
        if (filePathRef.current === filePath) {
          setAnnotations(EMPTY);
        }
      });
  }, [filePath]);

  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persist = useCallback((next: FileAnnotations) => {
    if (!filePathRef.current) return;
    const key = storeKey(filePathRef.current);
    const data = { ...next, version: 2 };
    persistQueueRef.current = persistQueueRef.current.then(() => storeSet(key, data));
  }, []);

  const addHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, nearestHeadingId: string | null) => {
    setAnnotations((prev) => {
      const highlight: Highlight = {
        id: generateId(),
        prefix: anchor.prefix,
        exact: anchor.exact,
        suffix: anchor.suffix,
        color,
        createdAt: Date.now(),
        nearestHeadingId,
      };
      const next = { ...prev, highlights: [...prev.highlights, highlight] };
      persist(next);
      return next;
    });
  }, [persist]);

  const removeHighlight = useCallback((id: string) => {
    setAnnotations((prev) => {
      const next = { ...prev, highlights: prev.highlights.filter((h) => h.id !== id) };
      persist(next);
      return next;
    });
  }, [persist]);

  const updateHighlight = useCallback(
    (id: string, updates: Partial<Pick<Highlight, "color" | "note">>) => {
      setAnnotations((prev) => {
        const next = {
          ...prev,
          highlights: prev.highlights.map((h) =>
            h.id === id ? { ...h, ...updates } : h
          ),
        };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const toggleBookmark = useCallback((headingId: string, headingText: string) => {
    setAnnotations((prev) => {
      const exists = prev.bookmarks.some((b) => b.headingId === headingId);
      let next: FileAnnotations;
      if (exists) {
        next = { ...prev, bookmarks: prev.bookmarks.filter((b) => b.headingId !== headingId) };
      } else {
        const bookmark: Bookmark = {
          id: generateId(),
          headingId,
          headingText,
          createdAt: Date.now(),
        };
        next = { ...prev, bookmarks: [...prev.bookmarks, bookmark] };
      }
      persist(next);
      return next;
    });
  }, [persist]);

  const isBookmarked = useCallback((headingId: string) => {
    return annotations.bookmarks.some((b) => b.headingId === headingId);
  }, [annotations.bookmarks]);

  return {
    highlights: annotations.highlights,
    bookmarks: annotations.bookmarks,
    addHighlight,
    removeHighlight,
    updateHighlight,
    toggleBookmark,
    isBookmarked,
  };
}
