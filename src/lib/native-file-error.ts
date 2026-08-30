import type {
  AppError,
  ErrorCategory,
  NativeFileError,
  NativeFileErrorCategory,
  NativeFileOperation,
} from "../types";

const NATIVE_CATEGORIES = new Set<NativeFileErrorCategory>([
  "notFound",
  "permissionDenied",
  "readOnly",
  "resourceUnavailable",
  "invalidInput",
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

export function isDeletedDocumentError(error: unknown): boolean {
  const normalized = normalizeFileError(error, "Failed to save file.");
  if (normalized.native) {
    return normalized.native.category === "notFound"
      && isDocumentIdentityOperation(normalized.native.operation);
  }
  return /^File not found:/i.test(normalized.message.trim())
    || /No such file or directory/i.test(normalized.message);
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

function isDocumentIdentityOperation(operation: NativeFileOperation): boolean {
  return operation === "resolveDocument"
    || operation === "inspectDocument"
    || operation === "openDocument"
    || operation === "readDocument"
    || operation === "checkRevision"
    || operation === "inspectSavedDocument";
}

function appErrorCategory(error: NormalizedFileError): ErrorCategory {
  if (error.native) {
    switch (error.native.category) {
      case "notFound": return "not-found";
      case "permissionDenied": return "permission-denied";
      case "readOnly": return "read-only";
      case "resourceUnavailable": return "resource-unavailable";
      case "invalidInput": break;
      case "unknown": return "generic";
    }
  }

  if (error.message.includes("File not found")) return "not-found";
  if (error.message.includes("too large")) return "too-large";
  if (error.message.includes("Not a supported file type")) return "not-markdown";
  if (error.message.includes("UTF-8")) return "utf8";
  return "generic";
}
