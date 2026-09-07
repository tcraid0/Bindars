import { memo, useState, useEffect, useCallback, useRef } from "react";
import type { HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";
import { createPositionedAnchor } from "../lib/text-anchoring";

import { useToast } from "./ToastProvider";

interface HighlightToolbarProps {
  source: string;
  contentRef: React.RefObject<HTMLElement | null>;
  isEditing: boolean;
  getActiveHeadingId: () => string | null;
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

function HighlightToolbarComponent({ source, contentRef, isEditing, getActiveHeadingId, onHighlight }: HighlightToolbarProps) {
  const [position, setPosition] = useState<ToolbarPosition | null>(null);
  const [selection, setSelection] = useState<Range | null>(null);
  const [selectionHeadingId, setSelectionHeadingId] = useState<string | null>(null);
  const { toast } = useToast();
  const alive = useRef(true);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
    setSelectionHeadingId(getActiveHeadingId());
  }, [contentRef, getActiveHeadingId, isEditing]);

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
    async (color: HighlightColor) => {
      if (!selection || !contentRef.current || pending.current) return;
      pending.current = true;
      setSaving(true);

      try {
        const anchor = await createPositionedAnchor(selection, contentRef.current, source);
        if (!alive.current) return;
        if (anchor) onHighlight(anchor, color, selectionHeadingId);
        else toast("This selection includes text that cannot be highlighted. Select prose, code, or a visible HTML label.", "error");
      } catch {
        if (alive.current) toast("Couldn't create this highlight. Please select the text again.", "error");
      } finally {
        pending.current = false;
        if (alive.current) setSaving(false);
      }
      if (!alive.current) return;

      // Clear selection
      window.getSelection()?.removeAllRanges();
      setPosition(null);
      setSelection(null);
    },
    [selection, contentRef, onHighlight, selectionHeadingId, source, toast],
  );

  if (!position) return null;

  return (
    <div
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
          disabled={saving}
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
