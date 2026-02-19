import { memo, useState, useEffect, useRef } from "react";
import type { ReadingStats } from "../lib/reading-stats";
import { formatWordCount } from "../lib/reading-stats";

interface FocusBarProps {
  fileName: string | null;
  onExit: () => void;
  readingStats: ReadingStats | null;
  progressTextRef: React.RefObject<HTMLSpanElement | null>;
}

const PROXIMITY_PX = 60;

function FocusBarComponent({ fileName, onExit, readingStats, progressTextRef }: FocusBarProps) {
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
    <div
      data-tauri-drag-region
      className="print-hide fixed top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-full bg-bg-secondary border border-border shadow-lg select-none"
      style={{
        opacity: nearTop ? 1 : 0,
        pointerEvents: nearTop ? "auto" : "none",
        transition: "opacity 200ms ease",
      }}
    >
      {fileName && (
        <span className="text-sm text-text-muted truncate max-w-[280px]">{fileName}</span>
      )}
      {readingStats && (
        <span className="text-[11px] text-text-muted">
          <span ref={progressTextRef}>0%</span>
          {" · "}{readingStats.pageCount != null
            ? `~${readingStats.pageCount} pg · ${formatWordCount(readingStats.wordCount)} words`
            : `${formatWordCount(readingStats.wordCount)} words · ${readingStats.readingTimeMinutes} min`}
        </span>
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
  );
}

export const FocusBar = memo(FocusBarComponent);
