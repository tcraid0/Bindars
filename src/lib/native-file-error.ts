import type {
  AppError,
  ErrorCategory,
  NativeFileError,
  NativeFileErrorCategory,
} from "../types";

const NATIVE_CATEGORIES = new Set<NativeFileErrorCategory>([
  "notFound",
  "alreadyExists",
  "permissionDenied",
  "readOnly",
  "resourceUnavailable",
  "invalidInput",
  "incompleteWrite",
  "unknown",
]);

export interface NormalizedFileError {
  native: NativeFileError | null;
  message: string;
}

export function normalizeFileError(error: unknown, fallbackMessage: string): NormalizedFileError {
  if (isNativeFileError(error)) {
    return { native: error, message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { native: null, message: error.message };
  }
  if (typeof error === "string" && error) {
    return { native: null, message: error };
  }
  return { native: null, message: fallbackMessage };
}

export function appErrorFromNative(error: unknown, fallbackMessage: string): AppError {
  const normalized = normalizeFileError(error, fallbackMessage);
  return {
    message: normalized.message,
    category: appErrorCategory(normalized),
  };
}

function isNativeFileError(value: unknown): value is NativeFileError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NativeFileError>;
  return typeof candidate.category === "string"
    && NATIVE_CATEGORIES.has(candidate.category as NativeFileErrorCategory)
    && typeof candidate.operation === "string"
    && typeof candidate.message === "string"
    && typeof candidate.detail === "string";
}

function appErrorCategory(error: NormalizedFileError): ErrorCategory {
  if (error.native) {
    switch (error.native.category) {
      case "notFound": return "not-found";
      case "permissionDenied": return "permission-denied";
      case "readOnly": return "read-only";
      case "resourceUnavailable": return "resource-unavailable";
      case "invalidInput": return "generic";
      case "alreadyExists":
      case "incompleteWrite":
      case "unknown": return "generic";
    }
  }

  return "generic";
}
