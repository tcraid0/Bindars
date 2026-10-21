import { memo, useId, useRef } from "react";
import { DialogFrame } from "./DialogFrame";

interface ConfirmDialogProps {
  busy?: boolean;
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  initialFocus?: "confirm" | "cancel";
  secondaryLabel?: string;
  secondaryTone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  onSecondary?: () => void;
  onDismiss: () => void;
}

function ConfirmDialogComponent({
  busy = false,
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  initialFocus = "confirm",
  secondaryLabel,
  secondaryTone = "default",
  onConfirm,
  onCancel,
  onSecondary,
  onDismiss,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const messageId = useId();
  const initialFocusRef = initialFocus === "cancel" ? cancelRef : confirmRef;

  return (
    <DialogFrame
      visible={visible}
      title={title}
      descriptionId={messageId}
      initialFocusRef={initialFocusRef}
      onDismiss={onDismiss}
      dismissible={!busy}
    >
      <p id={messageId} className="text-sm text-text-secondary mb-5">{message}</p>
      {busy && <p role="status" className="text-sm text-text-secondary mb-3">Overwriting…</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary transition-colors duration-120 disabled:opacity-50 disabled:cursor-wait"
        >
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-sm font-medium text-accent-text hover:bg-bg-tertiary transition-colors duration-120 disabled:opacity-50 disabled:cursor-wait"
        >
          {confirmLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button
            type="button"
            onClick={onSecondary}
            disabled={busy}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors duration-120 disabled:opacity-50 disabled:cursor-wait ${
              secondaryTone === "danger"
                ? "text-danger hover:bg-danger/10"
                : "text-text-secondary hover:bg-bg-tertiary"
            }`}
          >
            {secondaryLabel}
          </button>
        )}
      </div>
    </DialogFrame>
  );
}

export const ConfirmDialog = memo(ConfirmDialogComponent);
