import { useEffect, useRef } from "react";
import type { ReaderSettings } from "../types";

interface MarkdownEditorProps {
  buffer: string;
  settings: ReaderSettings;
  saving: boolean;
  saveError: string | null;
  onBufferChange: (content: string) => void;
  onDismissSaveError: () => void;
}

export function MarkdownEditor({
  buffer,
  settings,
  saving,
  saveError,
  onBufferChange,
  onDismissSaveError,
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        maxWidth: `${settings.contentWidth}ch`,
        margin: "0 auto",
        padding: "48px 24px 80px",
      }}
    >
      {saveError && (
        <div
          role="alert"
          className="mb-4 px-4 py-3 rounded-lg border border-red-400/30 bg-red-500/10 text-red-400 text-sm flex items-start gap-3"
        >
          <span className="flex-1 min-w-0">{saveError}</span>
          <button
            type="button"
            onClick={onDismissSaveError}
            className="shrink-0 p-0.5 rounded hover:bg-red-500/10 transition-colors duration-120"
            aria-label="Dismiss error"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={buffer}
        onChange={(e) => onBufferChange(e.target.value)}
        disabled={saving}
        spellCheck={false}
        aria-label="Edit markdown"
        className="w-full min-h-[calc(100vh-200px)] bg-transparent border-none outline-none resize-none text-text-primary disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: `${settings.fontSize}px`,
          lineHeight: settings.lineHeight,
          caretColor: "var(--accent)",
        }}
      />
    </div>
  );
}
