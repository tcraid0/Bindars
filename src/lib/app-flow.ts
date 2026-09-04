import type { FileType } from "../types";
import type { ShortcutPlatform } from "./shortcut-labels";

export type PendingAction =
  | { kind: "close-window" }
  | { kind: "quit-app" }
  | { kind: "new-file" }
  | { kind: "open-file-dialog" }
  | { kind: "open-file-path"; path: string }
  | { kind: "open-recent"; path: string }
  | { kind: "go-back" }
  | { kind: "go-forward" }
  | { kind: "navigate"; path: string; anchor: string | null }
  | { kind: "open-workspace-hit"; path: string; headingId: string | null }
  | { kind: "restore-session"; path: string; headingId: string | null };

export type RetryablePendingAction = Extract<
  PendingAction,
  { kind:
    | "open-file-path"
    | "open-recent"
    | "go-back"
    | "go-forward"
    | "navigate"
    | "open-workspace-hit"
    | "restore-session" }
>;

export type WindowClosePolicy = "hide" | "native";

export type NativeCloseRequestOutcome =
  | "complete-programmatic-close"
  | "allow-native-close"
  | "prevent-and-guard"
  | "prevent-silently";

interface NativeCloseRequestState {
  closePolicy: WindowClosePolicy;
  programmaticCloseInFlight: boolean;
  closeDrainPending: boolean;
  actionAdmissionInFlight: boolean;
}

// The macOS close guard hides the last window instead of destroying it so the
// process stays available for Dock reopen. Other platforms keep destroying it
// and letting the last close exit the process.
export function windowClosePolicy(platform: ShortcutPlatform): WindowClosePolicy {
  return platform === "macos" ? "hide" : "native";
}

// Classifies a native close request (red button or Command-W) from the guard's
// in-flight state. Ordering is load-bearing: a programmatic close completes
// its own handshake, an in-flight close or admission swallows repeat requests,
// the hide policy never lets the window be destroyed, and the native policy
// lets a clean document close while a dirty one is guarded by the caller.
export function decideNativeCloseRequest(state: NativeCloseRequestState): NativeCloseRequestOutcome {
  if (state.programmaticCloseInFlight) return "complete-programmatic-close";
  if (state.closeDrainPending || state.actionAdmissionInFlight) return "prevent-silently";
  if (state.closePolicy === "hide") return "prevent-and-guard";
  return "allow-native-close";
}

interface EditEntryState {
  documentOpen: boolean;
  editing: boolean;
  loading: boolean;
  documentTransitionInFlight: boolean;
}

interface PresentationEntryState {
  documentOpen: boolean;
  editing: boolean;
  loading: boolean;
  actionAdmissionInFlight: boolean;
  focusMode: boolean;
  fileType: FileType;
}

export function canEnterEditMode({
  documentOpen,
  editing,
  loading,
  documentTransitionInFlight,
}: EditEntryState): boolean {
  return documentOpen && !editing && !loading && !documentTransitionInFlight;
}

export function canToggleEditMode(state: EditEntryState): boolean {
  if (state.documentTransitionInFlight) return false;
  return state.editing || canEnterEditMode(state);
}

export function canEnterPresentationMode({
  documentOpen,
  editing,
  loading,
  actionAdmissionInFlight,
  focusMode,
  fileType,
}: PresentationEntryState): boolean {
  return documentOpen
    && !editing
    && !loading
    && !actionAdmissionInFlight
    && !focusMode
    && fileType !== "fountain";
}
