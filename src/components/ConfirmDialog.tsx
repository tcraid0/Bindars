import { memo, useId, useRef } from "react";
import { DialogFrame } from "./DialogFrame";

interface ConfirmDialogProps {
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
    >
      <p id={messageId} className="text-sm text-text-secondary mb-5">{message}</p>
      <div className="flex items-center justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary transition-colors duration-120"
        >
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="px-3 py-1.5 rounded-md text-sm font-medium text-accent hover:bg-bg-tertiary transition-colors duration-120"
        >
          {confirmLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button
            type="button"
            onClick={onSecondary}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors duration-120 ${
              secondaryTone === "danger"
                ? "text-red-500 hover:bg-red-500/10"
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
