import { memo, useEffect, useId, useRef } from "react";
import { DialogFrame } from "./DialogFrame";
import type { UpdatePhase } from "../hooks/useUpdates";
import { UPDATE_PRIVACY_NOTE } from "../lib/updates";

interface UpdateDialogProps {
  visible: boolean;
  phase: UpdatePhase;
  problem: string | null;
  autoCheck: boolean;
  onClose: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onDownloadPage: () => void;
  onAutoCheckChange: (value: boolean) => void;
}

const BUTTON = "px-3 py-1.5 rounded-md text-sm hover:bg-bg-tertiary transition-colors duration-120";
const QUIET_BUTTON = `${BUTTON} text-text-secondary`;
const MAIN_BUTTON = `${BUTTON} font-medium text-accent-text`;

function updateMessage(phase: UpdatePhase): string {
  switch (phase.kind) {
    case "idle":
      return "Check for a newer version of Bindars.";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return `Bindars ${phase.current} is the newest version.`;
    case "available":
      return phase.installable
        ? `Bindars ${phase.version} is available. You have ${phase.current}.`
        : `Bindars ${phase.version} is available. You have ${phase.current}. Move Bindars to Applications to update from inside the app.`;
    case "downloading":
      return phase.percent === null
        ? `Downloading Bindars ${phase.version}…`
        : `Downloading Bindars ${phase.version}… ${phase.percent}%`;
  }
}

function dismissLabel(phase: UpdatePhase): string {
  if (phase.kind === "available") return "Later";
  return phase.kind === "downloading" ? "Hide" : "Close";
}

function UpdateDialogComponent({
  visible,
  phase,
  problem,
  autoCheck,
  onClose,
  onCheck,
  onInstall,
  onDownloadPage,
  onAutoCheckChange,
}: UpdateDialogProps) {
  const messageId = useId();
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const downloading = phase.kind === "downloading";

  // The action buttons change with the phase. When the focused one goes away,
  // focus returns to the button that is always here, not to the page behind.
  useEffect(() => {
    const dismiss = dismissRef.current;
    if (!visible || !dismiss) return;
    if (!dismiss.closest('[role="dialog"]')?.contains(document.activeElement)) dismiss.focus();
  }, [visible, phase.kind]);

  return (
    <DialogFrame
      visible={visible}
      title="Updates"
      descriptionId={messageId}
      initialFocusRef={dismissRef}
      onDismiss={onClose}
    >
      <p id={messageId} role="status" className="text-sm text-text-secondary mb-4">{updateMessage(phase)}</p>
      {problem && <p role="alert" className="text-sm text-danger mb-4">{problem}</p>}
      {!downloading && (
        <>
          <label className="flex items-center gap-2 mb-2 text-sm text-text-primary select-none">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(event) => onAutoCheckChange(event.target.checked)}
              className="accent-accent-text size-4"
            />
            Check automatically, about once a day
          </label>
          <p className="text-xs text-text-muted mb-5">{UPDATE_PRIVACY_NOTE}</p>
        </>
      )}
      <div className="flex items-center justify-end gap-2">
        <button ref={dismissRef} type="button" onClick={onClose} className={QUIET_BUTTON}>
          {dismissLabel(phase)}
        </button>
        {phase.kind === "idle" && (
          <button type="button" onClick={onCheck} className={MAIN_BUTTON}>Check Again</button>
        )}
        {phase.kind === "available" && phase.installable && (
          <>
            <button type="button" onClick={onDownloadPage} className={QUIET_BUTTON}>What&apos;s New</button>
            <button type="button" onClick={onInstall} className={MAIN_BUTTON}>Install and Restart</button>
          </>
        )}
        {phase.kind === "available" && !phase.installable && (
          <button type="button" onClick={onDownloadPage} className={MAIN_BUTTON}>Get the Update</button>
        )}
      </div>
    </DialogFrame>
  );
}

export const UpdateDialog = memo(UpdateDialogComponent);
