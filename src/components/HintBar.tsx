import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ReaderSettings } from "../types";
import { CONTENT_WIDTH_EM_PER_UNIT } from "../lib/reader-settings";

interface HintBarProps {
  icon: ReactNode;
  text: string;
  dismissLabel: string;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
  readerRef: RefObject<HTMLElement | null>;
  settings: ReaderSettings;
  hiddenForSearch?: boolean;
}

export function HintBar({ icon, text, dismissLabel, action, onDismiss, readerRef, settings, hiddenForSearch }: HintBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => {
    // A sidebar/menu action can retire the hint while one of its controls has focus.
    if (barRef.current?.contains(document.activeElement)) readerRef.current?.focus({ preventScroll: true });
  }, [readerRef]);
  const finish = (callback: () => void) => {
    readerRef.current?.focus({ preventScroll: true });
    callback();
  };
  return (
    <div ref={barRef} className={`hint-bar print-hide w-full shrink-0 flex flex-wrap items-center gap-3 text-xs text-text-muted border-b border-border${hiddenForSearch ? " invisible" : ""}`}
      style={{ maxWidth: settings.contentWidth * CONTENT_WIDTH_EM_PER_UNIT * settings.fontSize }}>
      <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon}
      </svg>
      <span className="flex-1">{text}</span>
      {action && <button type="button" className="text-accent-text hover:underline" onClick={() => finish(action.onClick)}>{action.label}</button>}
      <button type="button" aria-label={dismissLabel}
        className="p-1.5 rounded hover:bg-bg-tertiary hover:text-text-primary"
        onClick={() => finish(onDismiss)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12M6 18 18 6" />
        </svg>
      </button>
    </div>
  );
}
