import { invoke } from "@tauri-apps/api/core";

export type UpdateCheck =
  | { kind: "skipped" }
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; current: string; version: string; installable: boolean };

export type UpdateError =
  | { kind: "busy" }
  | { kind: "failed"; detail: string }
  | { kind: "previous-app-kept"; path: string };

export const AUTO_CHECK_KEY = "updates:auto-check";
export const ASKED_KEY = "updates:asked";
export const ASKED_LOCAL_KEY = "bindars-updates-asked";
export const LAUNCH_COUNT_KEY = "updates:launch-count";
export const RELEASES_URL = "https://github.com/tcraid0/Bindars/releases/latest";
export const UPDATE_PROGRESS_EVENT = "bindars://update-progress";
export const UPDATE_PRIVACY_NOTE = "Checking contacts GitHub, which sees your internet address. Your documents are never sent.";

export function checkForUpdate(manual: boolean): Promise<UpdateCheck> {
  return invoke<UpdateCheck>("check_for_update", { manual });
}
export function downloadUpdate(): Promise<void> {
  return invoke("download_update");
}
export function installUpdateAndRestart(): Promise<void> {
  return invoke("install_update_and_restart");
}

/** The question is asked from the second launch on, and only once. */
export function shouldAskAboutUpdates(previousLaunchCount: number | null, autoCheck: boolean): boolean {
  return (previousLaunchCount ?? 0) >= 1 && !autoCheck;
}

/** Whole-number percent, or null when the total size is unknown. */
export function downloadPercent(downloaded: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

/** The message shown when installing fails. */
export function installFailureMessage(error: unknown): string {
  const known = error as Partial<UpdateError> | null;
  if (known && known.kind === "previous-app-kept" && typeof known.path === "string") {
    return `The update could not be installed, and the previous Bindars was moved. You can find it here: ${known.path}`;
  }
  // The installer can replace the app and still report a late failure, so
  // this says only what is certain.
  return "The update could not be completed. Bindars has not restarted.";
}
