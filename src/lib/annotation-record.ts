import type { Bookmark, FileAnnotations, Highlight } from "../types";

export interface AnnotationRecord {
  annotations: FileAnnotations;
  retainedHighlights: unknown[];
  retainedBookmarks: unknown[];
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readAnnotationRecord(value: unknown): AnnotationRecord {
  if (value == null) value = { highlights: [], bookmarks: [] };
  if (!object(value) || !Array.isArray(value.highlights) || !Array.isArray(value.bookmarks)
    || (value.version !== undefined && ![1, 2, 3].includes(value.version as number))) {
    throw new Error("Annotations have a damaged or unsupported format. The original records were preserved.");
  }
  const highlights: Highlight[] = [];
  const bookmarks: Bookmark[] = [];
  const retainedHighlights: unknown[] = [];
  const retainedBookmarks: unknown[] = [];
  const ids = new Set<string>();
  for (const item of value.highlights) {
    if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.exact !== "string" || typeof item.prefix !== "string" || typeof item.suffix !== "string"
      || (item.note !== undefined && typeof item.note !== "string")) {
      retainedHighlights.push(item); continue;
    }
    ids.add(item.id);
    highlights.push({ ...item,
      color: ["yellow", "green", "blue", "pink"].includes(item.color as string) ? item.color : "yellow",
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
      nearestHeadingId: typeof item.nearestHeadingId === "string" ? item.nearestHeadingId : null,
    } as unknown as Highlight);
  }
  ids.clear();
  for (const item of value.bookmarks) {
    if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.headingId !== "string" || typeof item.headingText !== "string") {
      retainedBookmarks.push(item); continue;
    }
    ids.add(item.id);
    bookmarks.push({ ...item, createdAt: typeof item.createdAt === "number" ? item.createdAt : 0 } as unknown as Bookmark);
  }
  return { annotations: { ...value, highlights, bookmarks }, retainedHighlights, retainedBookmarks };
}

export function storedAnnotationRecord(record: AnnotationRecord): FileAnnotations {
  return {
    ...record.annotations, version: 3,
    highlights: [...record.annotations.highlights, ...record.retainedHighlights] as Highlight[],
    bookmarks: [...record.annotations.bookmarks, ...record.retainedBookmarks] as Bookmark[],
  };
}
