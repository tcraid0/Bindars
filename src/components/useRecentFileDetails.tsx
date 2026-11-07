import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RecentFile } from "../types";
import { isImeCompositionKey } from "../lib/keyboard";

/** Supplementary details for Recent's existing open buttons; never takes focus. */
export function useRecentFileDetails(files: RecentFile[], formatTime: (time: number) => string) {
  const prefix = useId();
  const [active, setActive] = useState<{ path: string; button: HTMLButtonElement } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focused = useRef<HTMLButtonElement | null>(null);
  const hovered = useRef<HTMLButtonElement | null>(null);
  const dismissed = useRef<HTMLButtonElement | null>(null);
  const overDetails = useRef(false);
  const activeButton = useRef<HTMLButtonElement | null>(null);
  const pointerPressed = useRef(false);
  const clearTimer = () => clearTimeout(timer.current);
  const hide = () => {
    clearTimer();
    overDetails.current = false;
    activeButton.current = null;
    setActive(null);
    setPosition(null);
  };
  const show = (path: string, button: HTMLButtonElement) => {
    clearTimer();
    if (!button.isConnected || dismissed.current === button || pointerPressed.current) return;
    if (activeButton.current === button) return;
    activeButton.current = button;
    setPosition(null);
    setActive({ path, button });
  };
  const leave = () => {
    clearTimer();
    // A brief grace period also lets the pointer cross to the tooltip.
    timer.current = setTimeout(() => {
      if (!overDetails.current && focused.current !== activeButton.current
        && hovered.current !== activeButton.current) hide();
    }, 150);
  };
  const dismiss = () => {
    dismissed.current = activeButton.current ?? hovered.current ?? focused.current;
    hide();
  };
  const getFocusedDetails = () => {
    const tooltip = tooltipRef.current;
    return document.activeElement === activeButton.current && tooltip?.style.visibility === "visible"
      ? tooltip : null;
  };

  const hasFiles = files.length > 0;
  useEffect(() => {
    if (!hasFiles) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || isImeCompositionKey(event)) return;
      // A modal owns its keyboard, including Escape during a hover grace period.
      if (document.querySelector('[aria-modal="true"]')) { hide(); return; }
      if (!activeButton.current && !hovered.current) return;
      const ownsEscape = getFocusedDetails() !== null;
      dismiss();
      // Hover details must not steal Escape from Find, editing or other app UI.
      if (ownsEscape) { event.preventDefault(); event.stopPropagation(); }
    };
    const endPointer = () => { pointerPressed.current = false; };
    const onWindowBlur = () => { endPointer(); dismiss(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      clearTimer();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [hasFiles]);

  const activeFile = files.find(file => file.path === active?.path);
  useLayoutEffect(() => {
    if (tooltipRef.current) tooltipRef.current.scrollTop = 0;
  }, [active]);
  useLayoutEffect(() => {
    if (active && !activeFile) { hide(); return; }
    const tooltip = tooltipRef.current;
    if (!active || !activeFile || !tooltip) return;
    const place = () => {
      const rect = active.button.getBoundingClientRect();
      const scroller = active.button.closest(".navigation-scroll")?.getBoundingClientRect();
      // Focus can precede the browser's automatic scroll into view.
      if (document.activeElement !== active.button && rect.height > 0
        && (rect.bottom <= Math.max(0, scroller?.top ?? 0)
        || rect.top >= Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight))) {
        hide();
        return;
      }
      const sidebar = active.button.closest(".document-sidebar")?.getBoundingClientRect();
      const { width, height } = tooltip.getBoundingClientRect();
      const edge = sidebar?.right ?? rect.right;
      const beside = edge + width <= window.innerWidth - 8;
      const left = beside ? edge
        : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      let maxHeight = window.innerHeight - 16;
      let top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
      if (!beside) {
        // At constrained widths prefer above/below the whole row, keeping its
        // open, retry and remove targets clear whenever there is room.
        const row = active.button.closest("[data-path]")?.getBoundingClientRect() ?? rect;
        const rowTop = Math.max(0, sidebar?.top ?? 0, row.top);
        const rowBottom = Math.min(window.innerHeight, sidebar?.bottom ?? window.innerHeight, row.bottom);
        const above = rowTop - 8;
        const below = window.innerHeight - rowBottom - 8;
        const room = Math.max(above, below);
        if (room >= 40) {
          maxHeight = Math.min(room, maxHeight);
          top = above >= below ? rowTop - Math.min(height, room) : rowBottom;
        }
      }
      top = Math.max(8, Math.min(top, window.innerHeight - Math.min(height, maxHeight) - 8));
      setPosition({ left, top, maxHeight });
    };
    place();
    const observer = new window.ResizeObserver(place);
    observer.observe(tooltip);
    observer.observe(active.button);
    const group = active.button.closest('[aria-label="Recent files"]');
    if (group) observer.observe(group);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, activeFile]);

  return {
    triggerProps: (file: RecentFile, index: number) => ({
      "aria-describedby": `${prefix}-${index}`,
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const direction = event.key === "PageDown" ? 1 : event.key === "PageUp" ? -1 : 0;
        if (!direction || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || isImeCompositionKey(event.nativeEvent)) return;
        const tooltip = getFocusedDetails();
        if (!tooltip || tooltip.scrollHeight <= tooltip.clientHeight) return;
        event.preventDefault();
        event.stopPropagation();
        tooltip.scrollTop = Math.max(0, Math.min(tooltip.scrollHeight - tooltip.clientHeight,
          tooltip.scrollTop + direction * tooltip.clientHeight * 0.8));
      },
      onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
        focused.current = event.currentTarget;
        if (pointerPressed.current) return;
        dismissed.current = null;
        show(file.path, event.currentTarget);
      },
      onBlur: () => {
        focused.current = null;
        if (overDetails.current) leave(); else hide();
      },
      onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === "touch") return;
        const button = event.currentTarget;
        hovered.current = button;
        if (activeButton.current && activeButton.current !== button) hide();
        clearTimer();
        timer.current = setTimeout(() => show(file.path, button), 450);
      },
      onPointerDown: () => { pointerPressed.current = true; dismiss(); },
      onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => {
        hovered.current = null;
        if (dismissed.current === event.currentTarget) dismissed.current = null;
        leave();
      },
      onClickCapture: dismiss,
    }),
    details: createPortal(files.map((file, index) => {
      const visible = active?.path === file.path;
      return <div key={file.path} id={`${prefix}-${index}`} role="tooltip" hidden={!visible}
        ref={visible ? tooltipRef : undefined}
        className="recent-file-details"
        style={visible ? { ...position, visibility: position ? "visible" : "hidden" } : undefined}
        onPointerEnter={() => { overDetails.current = true; clearTimer(); }}
        onPointerLeave={() => { overDetails.current = false; leave(); }}>
        <div>
          <p><strong>Location: </strong>{file.path}</p>
          <p><strong>Last opened: </strong>{formatTime(file.openedAt)}</p>
        </div>
      </div>;
    }), document.body),
  };
}
