import { memo, useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { HighlightColor } from "../types";
import type { TextAnchor } from "../lib/text-anchoring";
import { createPositionedAnchor } from "../lib/text-anchoring";
import { isImeCompositionKey } from "../lib/keyboard";

import { useToast } from "./ToastProvider";

interface HighlightToolbarProps {
  source: string;
  contentRef: React.RefObject<HTMLElement | null>;
  isEditing: boolean;
  getActiveHeadingId: () => string | null;
  onHighlight: (anchor: TextAnchor, color: HighlightColor, headingId: string | null) => void;
  onNote: (anchor: TextAnchor, headingId: string | null) => void;
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

interface ToolbarSelection {
  range: Range;
  container: HTMLElement;
  source: string;
  text: string;
  headingId: string | null;
  position: ToolbarPosition;
}

function sameRange(left: Range, right: Range) {
  return left.startContainer === right.startContainer && left.startOffset === right.startOffset
    && left.endContainer === right.endContainer && left.endOffset === right.endOffset;
}

function HighlightToolbarComponent({ source, contentRef, isEditing, getActiveHeadingId, onHighlight, onNote }: HighlightToolbarProps) {
  const [selection, setSelection] = useState<ToolbarSelection | null>(null);
  const selectionRef = useRef<ToolbarSelection | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const requestedFocus = useRef<"first" | "last" | null>(null);
  const documentRef = useRef({ source, isEditing });
  documentRef.current = { source, isEditing };
  const { toast } = useToast();
  const alive = useRef(true);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const updateSelection = useCallback((next: ToolbarSelection | null) => {
    selectionRef.current = next;
    if (!next) requestedFocus.current = null;
    setSelection(next);
  }, []);

  const ownsSelection = useCallback((value: ToolbarSelection) => {
    const { range, container, text } = value;
    return !documentRef.current.isEditing && documentRef.current.source === value.source
      && contentRef.current === container && container.isConnected
      && container.contains(range.startContainer) && container.contains(range.endContainer)
      && !range.collapsed && range.toString() === text;
  }, [contentRef]);

  useLayoutEffect(() => {
    const current = selectionRef.current;
    if (current && !ownsSelection(current)) updateSelection(null);
  }, [isEditing, ownsSelection, source, updateSelection]);

  const readSelection = useCallback((): ToolbarSelection | null => {
    const native = window.getSelection();
    const container = contentRef.current;
    if (isEditing || !container || !native || native.isCollapsed || native.rangeCount === 0) return null;
    const range = native.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer) || !range.toString().trim()) return null;
    const current = selectionRef.current;
    if (current && ownsSelection(current) && sameRange(current.range, range)) return current;
    const rect = range.getBoundingClientRect();
    const above = rect.top > 80;
    return {
      range: range.cloneRange(), container, source, text: range.toString(),
      headingId: getActiveHeadingId(),
      position: { x: rect.left + rect.width / 2, y: above ? rect.top - 8 : rect.bottom + 8, above },
    };
  }, [contentRef, getActiveHeadingId, isEditing, ownsSelection, source]);

  const focusReader = useCallback((value: ToolbarSelection) => {
    // The reading surface is programmatically focusable without adding a tab stop.
    value.container.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });
  }, []);

  const clearOwnedSelection = useCallback((value: ToolbarSelection) => {
    const native = window.getSelection();
    if (native?.rangeCount && sameRange(native.getRangeAt(0), value.range)) native.removeAllRanges();
    updateSelection(null);
  }, [updateSelection]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!selection || !toolbar) return;
    const placeToolbar = () => {
      const { width, height } = toolbar.getBoundingClientRect();
      const { x, y, above } = selection.position;
      const inset = 8;
      // Measure the actual controls so short selections at either viewport
      // edge cannot hide a color, Note, or their focus outlines.
      toolbar.style.left = `${Math.max(inset, Math.min(x - width / 2, window.innerWidth - width - inset))}px`;
      toolbar.style.top = `${Math.max(inset, Math.min(above ? y - height : y, window.innerHeight - height - inset))}px`;
    };
    placeToolbar();
    window.addEventListener("resize", placeToolbar);
    return () => window.removeEventListener("resize", placeToolbar);
  }, [selection]);

  const focusRequestedButton = useCallback(() => {
    if (!requestedFocus.current || !toolbarRef.current) return;
    const buttons = toolbarRef.current.querySelectorAll<HTMLButtonElement>("button");
    const button = requestedFocus.current === "first" ? buttons[0] : buttons[buttons.length - 1];
    requestedFocus.current = null;
    button?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(focusRequestedButton, [focusRequestedButton, selection]);

  const handleSelectionChange = useCallback(() => {
    const next = readSelection();
    if (next) { updateSelection(next); return; }
    const current = selectionRef.current;
    const native = window.getSelection();
    // WebKit can collapse the visible selection when a button takes focus. Keep
    // the cloned range only for the active toolbar interaction, never globally.
    if ((!native || native.isCollapsed || native.rangeCount === 0) && current && ownsSelection(current)
      && (toolbarRef.current?.contains(document.activeElement) || pending.current)) return;
    updateSelection(null);
  }, [ownsSelection, readSelection, updateSelection]);

  useEffect(() => {
    const handleMouseUp = () => { requestAnimationFrame(handleSelectionChange); };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || isImeCompositionKey(event)) return;
      const toolbar = toolbarRef.current;
      const inToolbar = !!toolbar?.contains(event.target as Node);
      const container = contentRef.current;
      const target = event.target;
      const inReader = target === document.body || target === document.documentElement
        || target === container?.closest("[tabindex]")
        || (target instanceof HTMLElement && !!container?.contains(target)
          && !target.closest("input, textarea, select, button, [contenteditable='true']"));
      if (event.key === "Escape") {
        const current = selectionRef.current;
        if (current && (inToolbar || inReader)) {
          event.preventDefault();
          event.stopPropagation();
          clearOwnedSelection(current);
          if (inToolbar) focusReader(current);
        }
        return;
      }
      if (event.key !== "Tab") return;
      if (inToolbar && toolbar) {
        const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[index + (event.shiftKey ? -1 : 1)];
        // Within the group, include buttons even when macOS skips controls in
        // its native tab order. At either end, let Tab leave normally.
        if (index >= 0 && next) { event.preventDefault(); next.focus({ preventScroll: true }); }
      } else if (inReader && !pending.current) {
        const next = readSelection();
        if (!next) return;
        event.preventDefault();
        requestedFocus.current = event.shiftKey ? "last" : "first";
        updateSelection(next);
        focusRequestedButton();
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [clearOwnedSelection, contentRef, focusReader, focusRequestedButton, handleSelectionChange, readSelection, updateSelection]);

  const handleSelectionAction = useCallback(
    async (action: HighlightColor | "note") => {
      const current = selectionRef.current;
      if (!current || !ownsSelection(current) || pending.current) return;
      const keyboardAction = !!toolbarRef.current?.contains(document.activeElement);
      pending.current = true;
      setSaving(true);
      try {
        const anchor = await createPositionedAnchor(current.range, current.container, current.source);
        if (!alive.current || selectionRef.current !== current || !ownsSelection(current)) return;
        clearOwnedSelection(current);
        // Note's panel owns its textarea focus. Highlights and failed actions
        // return keyboard users to the document after the buttons disappear.
        if (keyboardAction && (action !== "note" || !anchor)) focusReader(current);
        if (anchor) {
          if (action === "note") onNote(anchor, current.headingId);
          else onHighlight(anchor, action, current.headingId);
        } else toast("This selection includes text that cannot be highlighted. Select prose, code, or a visible HTML label.", "error");
      } catch {
        if (alive.current && selectionRef.current === current && ownsSelection(current)) {
          clearOwnedSelection(current);
          if (keyboardAction) focusReader(current);
          toast("Couldn't create this highlight. Please select the text again.", "error");
        }
      } finally {
        pending.current = false;
        if (alive.current) setSaving(false);
      }
    },
    [clearOwnedSelection, focusReader, onHighlight, onNote, ownsSelection, toast],
  );

  if (!selection || isEditing || selection.source !== source) return null;
  const { position } = selection;

  return (
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selected text actions"
      onBlur={(event) => {
        const current = selectionRef.current;
        if (current && !event.currentTarget.contains(event.relatedTarget as Node | null)
          && !(pending.current && !event.relatedTarget)) clearOwnedSelection(current);
      }}
      className="print-hide fixed z-50 flex w-max items-center gap-1.5 px-2 py-1.5 rounded-lg bg-bg-secondary border border-border shadow-lg"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {COLORS.map(({ color, bg, label }) => (
        <button
          key={color}
          type="button"
          disabled={saving}
          aria-label={`Highlight ${label}`}
          title={label}
          className="w-6 h-6 rounded-full border-2 border-transparent hover:border-text-muted focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent transition-colors duration-100 cursor-pointer"
          style={{ backgroundColor: bg }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleSelectionAction(color)}
        />
      ))}
      <button
        type="button"
        disabled={saving}
        className="ml-1 border-l border-border px-2 py-0.5 text-xs font-medium text-text-primary hover:text-accent focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent disabled:opacity-50"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => handleSelectionAction("note")}
      >
        Note
      </button>
    </div>
  );
}

export const HighlightToolbar = memo(HighlightToolbarComponent);
