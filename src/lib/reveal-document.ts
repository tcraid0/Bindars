import { invoke } from "@tauri-apps/api/core";
import { normalizeFileError } from "./native-file-error";
import { detectShortcutPlatform } from "./shortcut-labels";

export function revealDocumentLabel(): string {
  return detectShortcutPlatform() === "macos" ? "Show in Finder" : "Show in folder";
}

/** Shows the document in the system file manager. A failure rejects with the
 * native message when there is one, otherwise with `fallback`. */
export async function revealDocument(path: string, fallback: string): Promise<void> {
  try {
    await invoke("reveal_markdown_file_in_folder", { path });
  } catch (error) {
    console.warn("[reveal-file] Failed to show document location:", error);
    throw new Error(normalizeFileError(error, fallback).native?.message ?? fallback);
  }
}
