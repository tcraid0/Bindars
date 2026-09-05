import { memo, useRef } from "react";
import { DialogFrame } from "./DialogFrame";
import { formatShortcutLabel, SHORTCUT_SECTIONS } from "../lib/shortcut-labels";

interface ShortcutOverlayProps {
  visible: boolean;
  onClose: () => void;
}

function ShortcutOverlayComponent({ visible, onClose }: ShortcutOverlayProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DialogFrame
      visible={visible}
      title="Keyboard Shortcuts"
      initialFocusRef={closeRef}
      onDismiss={onClose}
      backdropClassName="print-hide fixed inset-0 z-50 flex items-center justify-center"
      className="shortcut-card w-full max-w-[420px] max-h-[calc(100vh-2rem)] overflow-y-auto mx-4 bg-bg-secondary border border-border rounded-xl shadow-lg p-6"
      titleClassName="font-reading italic text-lg text-text-primary"
      renderHeader={(title) => (
        <div className="flex items-center justify-between mb-5">
          {title}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-bg-tertiary text-text-muted"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
    >
      {SHORTCUT_SECTIONS.map((section) => (
        <div key={section.title} className="mb-3.5 last:mb-0">
          <h3 className="font-reading italic text-sm text-text-muted mb-1.5">
            {section.title}
          </h3>
          <div className="space-y-1">
            {section.shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="flex items-center justify-between py-0.5">
                <span className="text-sm text-text-secondary">{shortcut.label}</span>
                <kbd className="shortcut-kbd px-2 py-0.5 rounded bg-bg-tertiary text-xs font-mono text-text-primary border-b-2 border-border">
                  {formatShortcutLabel(shortcut.id)}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </DialogFrame>
  );
}

export const ShortcutOverlay = memo(ShortcutOverlayComponent);
