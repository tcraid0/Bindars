import { memo, useRef } from "react";

interface ShortcutOverlayProps {
  visible: boolean;
  onClose: () => void;
}

interface ShortcutEntry {
  keys: string;
  label: string;
}

const sections: { title: string; shortcuts: ShortcutEntry[] }[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: "Ctrl+O", label: "Open file" },
      { keys: "Ctrl+K", label: "Workspace quick switcher" },
      { keys: "Alt+\u2190", label: "Go back" },
      { keys: "Alt+\u2192", label: "Go forward" },
      { keys: "Alt+\u2191", label: "Previous scene" },
      { keys: "Alt+\u2193", label: "Next scene" },
    ],
  },
  {
    title: "View",
    shortcuts: [
      { keys: "Ctrl+B", label: "Toggle sidebar" },
      { keys: "Ctrl+J", label: "Toggle table of contents" },
      { keys: "Ctrl+\\", label: "Toggle both panels" },
      { keys: "Ctrl+Shift+F", label: "Focus mode" },
      { keys: "Ctrl+Shift+T", label: "Cycle theme" },
    ],
  },
  {
    title: "Reading",
    shortcuts: [
      { keys: "Ctrl+F", label: "Search in document" },
      { keys: "Ctrl+D", label: "Bookmark current heading" },
      { keys: "Ctrl+M", label: "Toggle annotations panel" },
      { keys: "Ctrl+P", label: "Print / export PDF" },
      { keys: "Ctrl++", label: "Increase font size" },
      { keys: "Ctrl+\u2212", label: "Decrease font size" },
      { keys: "Ctrl+0", label: "Reset settings" },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { keys: "Ctrl+E", label: "Toggle edit mode" },
      { keys: "Ctrl+S", label: "Save file" },
      { keys: "Esc", label: "Exit edit mode" },
    ],
  },
  {
    title: "General",
    shortcuts: [
      { keys: "?", label: "Show keyboard shortcuts" },
      { keys: "Esc", label: "Close overlay / exit focus" },
    ],
  },
];

function ShortcutOverlayComponent({ visible, onClose }: ShortcutOverlayProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);

  if (!visible) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) {
      onClose();
    }
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="print-hide fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
        backdropFilter: "blur(4px)",
        animation: "fadeIn 150ms ease",
      }}
    >
      <div className="shortcut-card w-full max-w-[420px] mx-4 bg-bg-secondary border border-border rounded-xl shadow-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-reading italic text-lg text-text-primary">Keyboard Shortcuts</h2>
          <button
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

        {sections.map((section) => (
          <div key={section.title} className="mb-3.5 last:mb-0">
            <h3 className="font-reading italic text-sm text-text-muted mb-1.5">
              {section.title}
            </h3>
            <div className="space-y-1">
              {section.shortcuts.map((s) => (
                <div key={s.keys} className="flex items-center justify-between py-0.5">
                  <span className="text-sm text-text-secondary">{s.label}</span>
                  <kbd className="shortcut-kbd px-2 py-0.5 rounded bg-bg-tertiary text-xs font-mono text-text-primary border-b-2 border-border">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const ShortcutOverlay = memo(ShortcutOverlayComponent);
