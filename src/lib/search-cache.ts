import { MAX_WORKSPACE_BODY_CHARS } from "./workspace-limits";
import type { WorkspaceDocIndex } from "../types";

// Bump when the cache schema or extracted text changes, even if files do not.
// Version 2 excludes Markdown footnote backlinks from passage text.
const SEARCH_CACHE_VERSION = 2;
/** Bounds for derived text, on disk and in the session's retained entries. */
export const CACHE_MAX_DOCS = 10_025;
export const CACHE_MAX_CHARS = 2_000_000;

// Serialized entry characters, not heap bytes. Include metadata as well as prose.
function cacheEntryChars(doc: WorkspaceDocIndex): number {
  return JSON.stringify(doc).length;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function cachedDocuments(value: unknown): WorkspaceDocIndex[] {
  if (
    !object(value) ||
    value.version !== SEARCH_CACHE_VERSION ||
    !Array.isArray(value.docs) ||
    value.docs.length > CACHE_MAX_DOCS
  )
    return [];
  return value.docs.filter(
    (doc): doc is WorkspaceDocIndex =>
      object(doc) &&
      typeof doc.path === "string" &&
      !!doc.path &&
      typeof doc.name === "string" &&
      typeof doc.relPath === "string" &&
      count(doc.size) &&
      count(doc.mtimeMs) &&
      ["ready", "partial", "complexity"].includes(String(doc.coverage)) &&
      (doc.title === null || typeof doc.title === "string") &&
      typeof doc.bodyText === "string" &&
      doc.bodyText.length <= MAX_WORKSPACE_BODY_CHARS &&
      (doc.problem === undefined || typeof doc.problem === "string") &&
      (doc.draftLabel === undefined || typeof doc.draftLabel === "string") &&
      Array.isArray(doc.headings) &&
      doc.headings.every(
        (h) =>
          object(h) && typeof h.id === "string" && typeof h.text === "string",
      ) &&
      Array.isArray(doc.links) &&
      doc.links.every((link) => typeof link === "string") &&
      Array.isArray(doc.scenes) &&
      doc.scenes.every(
        (scene) =>
          object(scene) &&
          typeof scene.id === "string" &&
          typeof scene.label === "string" &&
          count(scene.line) &&
          (scene.headingId === null || typeof scene.headingId === "string"),
      ),
  );
}
/** Keep `docs` as the newest entries and evict the oldest beyond the cache bounds. */
export function retainCachedDocuments(
  known: Map<string, WorkspaceDocIndex>,
  docs: Iterable<WorkspaceDocIndex>,
): void {
  for (const doc of docs) {
    known.delete(doc.path);
    if (cacheEntryChars(doc) <= CACHE_MAX_CHARS) known.set(doc.path, doc);
  }
  let chars = 0;
  for (const doc of known.values()) chars += cacheEntryChars(doc);
  for (const [path, doc] of known) {
    if (known.size <= CACHE_MAX_DOCS && chars <= CACHE_MAX_CHARS) break;
    known.delete(path);
    chars -= cacheEntryChars(doc);
  }
}
export function buildSearchCache(docs: WorkspaceDocIndex[]) {
  let chars = 0;
  const cached: WorkspaceDocIndex[] = [];
  for (const doc of docs) {
    const cost = cacheEntryChars(doc);
    if (cost > CACHE_MAX_CHARS) continue;
    if (cached.length >= CACHE_MAX_DOCS || chars + cost > CACHE_MAX_CHARS) break;
    chars += cost;
    cached.push(doc);
  }
  return { version: SEARCH_CACHE_VERSION, docs: cached };
}
