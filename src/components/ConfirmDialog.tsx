import { memo, useRef, useEffect } from "react";

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
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
  secondaryLabel,
  secondaryTone = "default",
  onConfirm,
  onCancel,
  onSecondary,
  onDismiss,
}: ConfirmDialogProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (visible) {
      confirmRef.current?.focus();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key === "Tab") {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKey, { capture: true });
    return () => window.removeEventListener("keydown", handleKey, { capture: true });
  }, [visible, onDismiss]);

  if (!visible) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) {
      onDismiss();
    }
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="print-hide fixed inset-0 z-[60] flex items-center justify-center"
      style={{
        background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
        backdropFilter: "blur(4px)",
        animation: "fadeIn 150ms ease",
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" className="w-full max-w-[360px] mx-4 bg-bg-secondary border border-border rounded-xl shadow-lg p-6">
        <h2 id="confirm-dialog-title" className="font-reading italic text-lg text-text-primary mb-2">{title}</h2>
        <p id="confirm-dialog-message" className="text-sm text-text-secondary mb-5">{message}</p>
        <div className="flex items-center justify-end gap-2">
          <button
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
      </div>
    </div>
  );
}

export const ConfirmDialog = memo(ConfirmDialogComponent);
