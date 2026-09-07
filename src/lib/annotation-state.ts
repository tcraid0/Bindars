import type { FileAnnotations } from "../types";

export type AnnotationLoadStatus = "idle" | "loading" | "ready" | "error";
export const EMPTY_ANNOTATIONS: FileAnnotations = { highlights: [], bookmarks: [] };
