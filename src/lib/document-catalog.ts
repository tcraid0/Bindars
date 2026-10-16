import { documentFileType, replaceOpenableDocumentExtension } from "./openable-files";
import { MAX_WORKSPACE_BODY_CHARS } from "./workspace-limits";
import type { WorkspaceDocIndex, WorkspaceFileMeta } from "../types";
import { tryBuildWorkspaceDoc } from "./workspace-index";
import { normalizeFileError } from "./native-file-error";

export function discoveredDocument(meta: WorkspaceFileMeta): WorkspaceDocIndex {
  return {
    ...meta,
    title: null,
    headings: [],
    bodyText: "",
    links: [],
    scenes: [],
    coverage: "pending",
  };
}
export function prepareCatalogDocument(
  meta: WorkspaceFileMeta,
  content: string,
): WorkspaceDocIndex {
  try {
    const result = tryBuildWorkspaceDoc(meta, content);
    if (result.status === "too-complex")
      return {
        ...discoveredDocument(meta),
        coverage: "complexity",
        problem: "Too complex to display. Open to edit the source.",
      };
    return {
      ...meta,
      ...result.doc,
      coverage:
        result.doc.bodyText.length >= MAX_WORKSPACE_BODY_CHARS
          ? "partial"
          : "ready",
      draftLabel:
        (result.doc.title !== replaceOpenableDocumentExtension(meta.name, "")
          ? result.doc.title
          : result.doc.bodyText.split("\n").find((line) => line.trim())
        )?.slice(0, 100) || meta.name,
    };
  } catch {
    return {
      ...discoveredDocument(meta),
      coverage: "parse-error",
      problem: documentFileType(meta.name) === "fountain"
        ? "Screenplay parsing failed. Open to inspect the source, or retry."
        : "Text preparation failed. Open to inspect the source, or retry.",
    };
  }
}
export function failedCatalogDocument(
  meta: WorkspaceFileMeta,
  error: unknown,
): WorkspaceDocIndex {
  const failure = normalizeFileError(
    error,
    "Couldn't read this file. Retry or check its location and permissions.",
  );
  const coverage =
    failure.native?.category === "notFound"
      ? "missing"
      : failure.native?.operation === "decodeDocument"
        ? "encoding"
        : failure.native?.operation === "validateDocument"
          ? "too-large"
          : "unreadable";
  return { ...discoveredDocument(meta), coverage, problem: failure.message };
}
/** Extracted text that may be reused while the file's size and mtime are unchanged. */
export function isReusable(doc: WorkspaceDocIndex): boolean {
  return (
    doc.coverage === "ready" ||
    doc.coverage === "partial" ||
    doc.coverage === "complexity"
  );
}
export function sameFileVersion(
  a: WorkspaceDocIndex,
  b: WorkspaceFileMeta,
): boolean {
  return (
    a.size !== undefined &&
    a.mtimeMs !== undefined &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    isReusable(a)
  );
}
