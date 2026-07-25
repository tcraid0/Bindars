import { memo, useState, useEffect, useRef } from "react";

interface PresentationBarProps {
  currentSlide: number;
  totalSlides: number;
  onExit: () => void;
}

const PROXIMITY_PX = 60;
const TOUCH_SHOW_MS = 3000;

function PresentationBarComponent({ currentSlide, totalSlides, onExit }: PresentationBarProps) {
  const [nearBottom, setNearBottom] = useState(false);
  const [isCoarsePointer] = useState(() => matchMedia("(pointer: coarse)").matches);
  const rafRef = useRef<number | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isCoarsePointer) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setNearBottom(e.clientY >= window.innerHeight - PROXIMITY_PX);
      });
    };

    const handleMouseLeave = () => {
      setNearBottom(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isCoarsePointer]);

  // Touch: show bar temporarily on any touch
  useEffect(() => {
    if (isCoarsePointer) return; // already always visible

    const handleTouch = () => {
      setNearBottom(true);
      if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
      touchTimerRef.current = setTimeout(() => setNearBottom(false), TOUCH_SHOW_MS);
    };

    window.addEventListener("touchstart", handleTouch, { passive: true });
    return () => {
      window.removeEventListener("touchstart", handleTouch);
      if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    };
  }, [isCoarsePointer]);

  const visible = isCoarsePointer || nearBottom;
  const progress = totalSlides > 1 ? (currentSlide + 1) / totalSlides : 1;

  return (
    <div
      className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-3 px-4 py-2 rounded-full bg-bg-secondary border border-border shadow-lg select-none"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity 200ms ease",
      }}
    >
      <span className="text-sm text-text-muted tabular-nums" aria-live="polite">
        {currentSlide + 1} / {totalSlides}
      </span>
      <div className="w-24 h-1 bg-bg-tertiary rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full"
          style={{
            width: `${progress * 100}%`,
            transition: "width 150ms ease",
          }}
        />
      </div>
      <button
        type="button"
        onClick={onExit}
        className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-120"
        title="Exit presentation (Esc)"
      >
        Exit
      </button>
    </div>
  );
}

export const PresentationBar = memo(PresentationBarComponent);
