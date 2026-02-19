import { memo, useEffect, useRef } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PresentationBar } from "./PresentationBar";
import type { Slide } from "../lib/slide-parser";
import type { ReaderSettings } from "../types";

interface PresentationViewProps {
  slides: Slide[];
  currentSlide: number;
  settings: ReaderSettings;
  filePath: string;
  onNavigateToFile?: (path: string, anchor: string | null) => void;
  onExit: () => void;
  onNext: () => void;
  onPrev: () => void;
}

function PresentationViewComponent({
  slides,
  currentSlide,
  settings,
  filePath,
  onNavigateToFile,
  onExit,
  onNext,
  onPrev,
}: PresentationViewProps) {
  const contentRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const slide = slides[currentSlide];

  useEffect(() => {
    overlayRef.current?.scrollTo(0, 0);
  }, [currentSlide]);

  if (!slide) return null;

  const handleClick = (e: React.MouseEvent) => {
    // Don't navigate on interactive element clicks
    const target = e.target as HTMLElement;
    if (target.closest("a, button, code, pre, input, textarea, select, label, [contenteditable]")) return;

    // Don't advance when user is selecting text
    if (window.getSelection()?.toString()) return;

    // Click on left third goes back, rest goes forward
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width / 3) {
      onPrev();
    } else {
      onNext();
    }
  };

  return (
    <>
      <div
        ref={overlayRef}
        className="presentation-overlay"
        onClick={handleClick}
      >
        <div className="presentation-slide">
          <MarkdownRenderer
            content={slide.content}
            filePath={filePath}
            settings={settings}
            contentRef={contentRef}
            onNavigateToFile={onNavigateToFile}
          />
        </div>
      </div>
      <PresentationBar
        currentSlide={currentSlide}
        totalSlides={slides.length}
        onExit={onExit}
      />
    </>
  );
}

export const PresentationView = memo(PresentationViewComponent);
