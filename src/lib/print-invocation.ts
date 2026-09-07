import { invoke, isTauri } from "@tauri-apps/api/core";
import { detectShortcutPlatform } from "./shortcut-labels";

export function hasNativePrintCompletion(): boolean {
  return isTauri() && detectShortcutPlatform() === "macos";
}

/** Only the custom macOS command waits for operation termination. */
export async function invokePrint(nativeCompletion: boolean): Promise<void> {
  if (nativeCompletion) {
    await invoke<"completed" | "cancelled-or-failed">("print_current_webview");
  } else {
    await window.print();
  }
}
