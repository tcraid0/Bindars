import { memo, useState, useEffect, useRef } from "react";
import { MarkdownFormattingToggle } from "./MarkdownFormattingToggle";
import { SaveWhisper } from "./SaveWhisper";

interface FocusBarProps {
  fileName: string | null;
  isDirty: boolean;
  isSavedFlash: boolean;
  saveWarning: string | null;
  onExit: () => void;
  statsSummary: string | null;
  progressTextRef: React.RefObject<HTMLSpanElement | null>;
  reducedEffects: boolean;
  showMarkdownFormatting: boolean;
  markdownFormattingEnabled: boolean;
  onToggleMarkdownFormatting: () => void;
}

const PROXIMITY_PX = 60;

function FocusBarComponent({
  fileName,
  isDirty,
  isSavedFlash,
  saveWarning,
  onExit,
  statsSummary,
  progressTextRef,
  reducedEffects,
  showMarkdownFormatting,
  markdownFormattingEnabled,
  onToggleMarkdownFormatting,
}: FocusBarProps) {
  const [nearTop, setNearTop] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setNearTop(e.clientY <= PROXIMITY_PX);
      });
    };

    const handleMouseLeave = () => {
      setNearTop(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <>
      <div
        className="print-hide fixed top-0 left-0 right-0 z-[39] pointer-events-none"
        aria-hidden="true"
        style={{
          height: nearTop ? 0 : 3,
          opacity: nearTop ? 0 : 0.5,
          background: "var(--accent)",
          transition: reducedEffects ? "none" : "opacity 200ms ease, height 200ms ease",
        }}
      />
      <div
        data-tauri-drag-region
        className="print-hide fixed top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-full bg-bg-secondary border border-border shadow-lg select-none"
        style={{
          opacity: nearTop ? 1 : 0,
          pointerEvents: nearTop ? "auto" : "none",
          transition: reducedEffects ? "none" : "opacity 200ms ease",
        }}
      >
        <SaveWhisper
          dirty={isDirty}
          saved={isSavedFlash}
          warning={saveWarning}
        />
        {fileName && (
          <span className="text-sm text-text-muted truncate max-w-[280px]">{fileName}</span>
        )}
        {statsSummary && (
          <span className="text-[11px] text-text-muted">
            <span ref={progressTextRef}>0%</span>
            {" · "}{statsSummary}
          </span>
        )}
        {showMarkdownFormatting && (
          <MarkdownFormattingToggle
            enabled={markdownFormattingEnabled}
            onToggle={onToggleMarkdownFormatting}
          />
        )}
        <button
          type="button"
          onClick={onExit}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-120"
          title="Exit focus mode (Esc)"
        >
          Exit
        </button>
      </div>
    </>
  );
}

export const FocusBar = memo(FocusBarComponent);
