import type { FileRevision } from "../types";
import { normalizeFileError } from "./native-file-error";
import {
  isOpenableDocumentExtension,
  OPENABLE_FILE_TYPES_DESCRIPTION,
} from "./openable-files";

export type EditorSaveResult =
  | "saved"
  | "saved-with-newer-edits"
  | "saved-with-recovery"
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
  | {
      status: "saved-with-recovery";
      file: SavedFileSnapshot;
      recoveryPath: string;
    }
  | {
      status: Exclude<EditorSaveResult, SuccessfulEditorSaveResult | "saved-with-recovery">;
    };

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

export function adoptsWrittenDestination(
  result: EditorSaveOutcome,
): result is Extract<EditorSaveOutcome, { file: SavedFileSnapshot }> {
  return result.status === "saved"
    || result.status === "saved-with-newer-edits"
    || result.status === "saved-with-recovery";
}

export function retainedVersionNotice(recoveryPath: string): string {
  return `Bindars exchanged this document and kept another version at ${recoveryPath}. Your current text is still in the editor. Autosave is paused.`;
}

export function saveErrorBlocksCurrentPath(error: unknown): boolean {
  const normalized = normalizeFileError(error, "");
  return normalized.native?.detail === "destination-changed";
}

export function isSuccessfulSave(result: EditorSaveResult): result is SuccessfulEditorSaveResult {
  return result === "saved" || result === "saved-with-newer-edits";
}

export type DocumentSavePathResult =
  | { status: "valid"; path: string; appendedExtension: boolean }
  | { status: "error"; message: string };

export function normalizeDocumentSavePath(selectedPath: string): DocumentSavePathResult {
  const lastSeparatorIndex = Math.max(
    selectedPath.lastIndexOf("/"),
    selectedPath.lastIndexOf("\\"),
  );
  const fileName = selectedPath.slice(lastSeparatorIndex + 1);
  if (!fileName.trim() || fileName === "." || fileName === "..") {
    return { status: "error", message: "Choose a file name, not a directory." };
  }

  const extensionSeparatorIndex = fileName.lastIndexOf(".");
  // A bare name has no extension. Linux save dialogs do not add one, so use .md.
  // The caller must refuse when that file already exists: the dialog's replace
  // check covered the typed name, not the name with .md added.
  if (extensionSeparatorIndex <= 0) {
    return {
      status: "valid",
      path: `${selectedPath}.md`,
      appendedExtension: true,
    };
  }

  const extension = fileName.slice(extensionSeparatorIndex + 1).toLowerCase();
  if (isOpenableDocumentExtension(extension)) {
    return { status: "valid", path: selectedPath, appendedExtension: false };
  }

  return {
    status: "error",
    message: `File name must end in ${OPENABLE_FILE_TYPES_DESCRIPTION}.`,
  };
}

export type SaveErrorRecovery = "save-as" | null;

export interface SaveErrorDescription {
  message: string;
  recovery: SaveErrorRecovery;
}

export function actionableSaveError(error: unknown): SaveErrorDescription {
  const normalized = normalizeFileError(error, "Bindars could not save this file.");
  switch (normalized.native?.category) {
    case "alreadyExists":
    case "incompleteWrite":
      return { message: normalized.message, recovery: "save-as" };
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
