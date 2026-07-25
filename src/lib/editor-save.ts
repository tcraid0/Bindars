import type { FileRevision } from "../types";

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

export function isRecoverableDeletedFileSaveError(message: string): boolean {
  return /^File not found:/i.test(message.trim()) || /No such file or directory/i.test(message);
}
