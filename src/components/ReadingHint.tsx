import type { RefObject } from "react";
import type { ReaderSettings } from "../types";
import { CONTENT_WIDTH_EM_PER_UNIT } from "../lib/reader-settings";

interface ReadingHintProps {
  onDismiss: () => void;
  readerRef: RefObject<HTMLElement | null>;
  settings: ReaderSettings;
}

export function ReadingHint({ onDismiss, readerRef, settings }: ReadingHintProps) {
  return (
    <div className="reading-hint print-hide w-full shrink-0 flex items-center gap-3 text-xs text-text-muted border-b border-border"
      style={{ maxWidth: settings.contentWidth * CONTENT_WIDTH_EM_PER_UNIT * settings.fontSize }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 11 8-8 4 4-8 8-4-4Z" /><path d="m9 11-4 4 4 4 4-4M5 19l-2 2h6" />
      </svg>
      <span className="flex-1">Select text to highlight it or add a note.</span>
      <button type="button" aria-label="Dismiss reading hint"
        className="p-1.5 rounded hover:bg-bg-tertiary hover:text-text-primary"
        onClick={() => {
          readerRef.current?.focus({ preventScroll: true });
          onDismiss();
        }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12M6 18 18 6" />
        </svg>
      </button>
    </div>
  );
}
