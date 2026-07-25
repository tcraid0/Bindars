import type { FileAnnotations } from "../types";

export type AnnotationLoadStatus = "idle" | "loading" | "ready" | "error";

export interface AnnotationLoadState {
  filePath: string | null;
  status: AnnotationLoadStatus;
  annotations: FileAnnotations;
  error: string | null;
}

export const EMPTY_ANNOTATIONS: FileAnnotations = { highlights: [], bookmarks: [] };

export function createAnnotationLoadState(filePath: string | null = null): AnnotationLoadState {
  return {
    filePath,
    status: filePath ? "loading" : "idle",
    annotations: EMPTY_ANNOTATIONS,
    error: null,
  };
}

export function beginAnnotationLoad(
  _state: AnnotationLoadState,
  filePath: string | null,
): AnnotationLoadState {
  return createAnnotationLoadState(filePath);
}

export function completeAnnotationLoad(
  state: AnnotationLoadState,
  filePath: string,
  annotations: FileAnnotations,
): AnnotationLoadState {
  if (state.filePath !== filePath || state.status !== "loading") {
    return state;
  }

  return {
    filePath,
    status: "ready",
    annotations,
    error: null,
  };
}

export function failAnnotationLoad(
  state: AnnotationLoadState,
  filePath: string,
  error: string,
): AnnotationLoadState {
  if (state.filePath !== filePath || state.status !== "loading") {
    return state;
  }

  return {
    filePath,
    status: "error",
    annotations: EMPTY_ANNOTATIONS,
    error,
  };
}

export function canMutateAnnotations(state: AnnotationLoadState): boolean {
  return state.filePath !== null && state.status === "ready";
}

export function areAnnotationsReady(state: AnnotationLoadState): boolean {
  return state.status === "ready";
}

export function applyAnnotationMutation(
  state: AnnotationLoadState,
  mutate: (annotations: FileAnnotations) => FileAnnotations,
): { state: AnnotationLoadState; mutated: boolean } {
  if (!canMutateAnnotations(state)) {
    return { state, mutated: false };
  }

  return {
    state: {
      ...state,
      annotations: mutate(state.annotations),
    },
    mutated: true,
  };
}
