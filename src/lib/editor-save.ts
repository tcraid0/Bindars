import type { FileRevision } from "../types";
import { isDeletedDocumentError, normalizeFileError } from "./native-file-error";

export type EditorSaveResult =
  | "saved"
  | "saved-with-newer-edits"
  | "conflict"
  | "cancelled"
  | "error"
  | "noop"
  | "stale";

export type SuccessfulEditorSaveResult = "saved" | "saved-with-newer-edits";

export interface SavedFileSnapshot {
  canonicalPath: string;
  name: string;
  content: string;
  revision: FileRevision;
}

export type EditorSaveOutcome =
  | { status: SuccessfulEditorSaveResult; file: SavedFileSnapshot }
  | { status: Exclude<EditorSaveResult, SuccessfulEditorSaveResult> };

export function successfulSaveOutcome(
  status: SuccessfulEditorSaveResult,
  content: string,
  result: {
    canonicalPath: string;
    name: string;
    currentRevision: FileRevision;
  },
): EditorSaveOutcome {
  return {
    status,
    file: {
      canonicalPath: result.canonicalPath,
      name: result.name,
      content,
      revision: result.currentRevision,
    },
  };
}

export type SaveContinuationDecision = "continue" | "reconfirm" | "stop";

export function decideSaveContinuation(result: EditorSaveResult): SaveContinuationDecision {
  if (result === "saved") return "continue";
  if (result === "saved-with-newer-edits") return "reconfirm";
  return "stop";
}

export function isSuccessfulSave(result: EditorSaveResult): result is SuccessfulEditorSaveResult {
  return result === "saved" || result === "saved-with-newer-edits";
}

export type MarkdownSavePathResult =
  | { status: "valid"; path: string }
  | { status: "error"; message: string };

export function normalizeMarkdownSavePath(selectedPath: string): MarkdownSavePathResult {
  const lastSeparatorIndex = Math.max(
    selectedPath.lastIndexOf("/"),
    selectedPath.lastIndexOf("\\"),
  );
  const fileName = selectedPath.slice(lastSeparatorIndex + 1);
  if (!fileName.trim() || fileName === "." || fileName === "..") {
    return { status: "error", message: "Choose a file name, not a directory." };
  }

  const extensionSeparatorIndex = fileName.lastIndexOf(".");
  if (extensionSeparatorIndex <= 0) {
    return {
      status: "error",
      message: "File name must end in .md or .markdown.",
    };
  }

  const extension = fileName.slice(extensionSeparatorIndex + 1).toLowerCase();
  if (extension === "md" || extension === "markdown") {
    return { status: "valid", path: selectedPath };
  }

  return {
    status: "error",
    message: "File name must end in .md or .markdown.",
  };
}

export function isRecoverableDeletedFileSaveError(error: unknown): boolean {
  return isDeletedDocumentError(error);
}

export type SaveErrorRecovery = "save-as" | null;

export interface SaveErrorDescription {
  message: string;
  recovery: SaveErrorRecovery;
}

export function actionableSaveError(error: unknown): SaveErrorDescription {
  const normalized = normalizeFileError(error, "Bindars could not save this file.");
  switch (normalized.native?.category) {
    case "readOnly":
      return {
        message: "This file is read-only and was not changed.",
        recovery: "save-as",
      };
    case "permissionDenied":
      return {
        message: "Bindars could not save this file because access was denied.",
        recovery: "save-as",
      };
    case "resourceUnavailable":
      return {
        message: "The file resource is temporarily unavailable. Check its volume or provider and try again.",
        recovery: null,
      };
    case "notFound":
      return {
        message: normalized.native.operation === "resolveWriteParent"
          || normalized.native.operation === "inspectWriteParent"
          || normalized.native.operation === "createTemporaryFile"
          ? "The destination folder is no longer available."
          : "This file is no longer available.",
        recovery: "save-as",
      };
    case "invalidInput":
      return normalized.native.operation === "inspectWriteTarget"
        ? { message: normalized.message, recovery: "save-as" }
        : { message: normalized.message, recovery: null };
    default:
      return { message: normalized.message, recovery: null };
  }
}
