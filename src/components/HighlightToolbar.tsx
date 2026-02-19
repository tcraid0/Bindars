import { memo, useState, useEffect, useCallback, useRef } from "react";
import type { HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";
import { createAnchor } from "../lib/text-anchoring";

interface HighlightToolbarProps {
  contentRef: React.RefObject<HTMLElement | null>;
  isEditing: boolean;
  activeHeadingId: string | null;
  onHighlight: (anchor: TextAnchor, color: HighlightColor, headingId: string | null) => void;
}

const COLORS: { color: HighlightColor; bg: string; label: string }[] = [
  { color: "yellow", bg: "var(--highlight-yellow)", label: "Yellow" },
  { color: "green", bg: "var(--highlight-green)", label: "Green" },
  { color: "blue", bg: "var(--highlight-blue)", label: "Blue" },
  { color: "pink", bg: "var(--highlight-pink)", label: "Pink" },
];

interface ToolbarPosition {
  x: number;
  y: number;
  above: boolean;
}

function HighlightToolbarComponent({ contentRef, isEditing, activeHeadingId, onHighlight }: HighlightToolbarProps) {
  const [position, setPosition] = useState<ToolbarPosition | null>(null);
  const [selection, setSelection] = useState<Range | null>(null);
  const [selectionHeadingId, setSelectionHeadingId] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const activeHeadingIdRef = useRef(activeHeadingId);

  useEffect(() => {
    activeHeadingIdRef.current = activeHeadingId;
  }, [activeHeadingId]);

  const handleSelectionChange = useCallback(() => {
    if (isEditing) {
      setPosition(null);
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPosition(null);
      return;
    }

    const range = sel.getRangeAt(0);
    const container = contentRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) {
      setPosition(null);
      return;
    }

    const text = range.toString().trim();
    if (!text) {
      setPosition(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    const above = rect.top > 80;
    setPosition({
      x: rect.left + rect.width / 2,
      y: above ? rect.top - 8 : rect.bottom + 8,
      above,
    });
    setSelection(range.cloneRange());
    setSelectionHeadingId(activeHeadingIdRef.current);
  }, [contentRef, isEditing]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    const handleMouseUp = () => {
      requestAnimationFrame(handleSelectionChange);
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleSelectionChange]);

  const handleColorClick = useCallback(
    (color: HighlightColor) => {
      if (!selection || !contentRef.current) return;

      const anchor = createAnchor(selection, contentRef.current);
      if (anchor) {
        onHighlight(anchor, color, selectionHeadingId);
      }

      // Clear selection
      window.getSelection()?.removeAllRanges();
      setPosition(null);
      setSelection(null);
    },
    [selection, contentRef, onHighlight, selectionHeadingId],
  );

  if (!position) return null;

  return (
    <div
      ref={toolbarRef}
      className="print-hide fixed z-50 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-bg-secondary border border-border shadow-lg"
      style={{
        left: position.x,
        top: position.y,
        transform: position.above
          ? "translate(-50%, -100%)"
          : "translate(-50%, 0)",
      }}
    >
      {COLORS.map(({ color, bg, label }) => (
        <button
          key={color}
          type="button"
          aria-label={`Highlight ${label}`}
          title={label}
          className="w-6 h-6 rounded-full border-2 border-transparent hover:border-text-muted transition-colors duration-100 cursor-pointer"
          style={{ backgroundColor: bg }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleColorClick(color)}
        />
      ))}
    </div>
  );
}

export const HighlightToolbar = memo(HighlightToolbarComponent);
