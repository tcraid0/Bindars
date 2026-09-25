import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { isImeCompositionKey } from "../lib/keyboard";

interface DismissiblePopoverOptions {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  initialFocusRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

// The two nonmodal toolbar surfaces share dismissal, but choose their own
// focus entry and explicitly restore focus before handing off to another UI.
export function useDismissiblePopover({
  open, triggerRef, panelRef, initialFocusRef, onClose,
}: DismissiblePopoverOptions) {
  const closeRef = useRef(onClose);
  const closingRef = useRef(false);

  useLayoutEffect(() => { closeRef.current = onClose; });

  const dismiss = useCallback((restoreFocus: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (restoreFocus && triggerRef.current?.isConnected) triggerRef.current.focus();
    closeRef.current();
  }, [triggerRef]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    closingRef.current = false;
    let pointerId: number | null = null;
    let outsideGesture = false;
    let pointerCompleted = false;
    let focusWasInside = false;

    const isInside = (target: EventTarget | null) => target instanceof Node
      && (panel.contains(target) || triggerRef.current?.contains(target));
    const modalIsOpen = () => document.querySelector('[aria-modal="true"]') !== null;
    const resetPointer = () => { pointerId = null; outsideGesture = false; pointerCompleted = false; };

    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeCompositionKey(event) || event.key !== "Escape") return;
      if (modalIsOpen() || (!isInside(event.target)
        && !(event.target === document.body && focusWasInside))) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    const handleFocus = (event: FocusEvent) => {
      focusWasInside = Boolean(isInside(event.target));
      // DialogFrame retains its opener inside a covered popover. Keep that
      // element mounted until the dialog restores it on dismissal.
      if (!focusWasInside && pointerId === null && !modalIsOpen()) dismiss(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      pointerId = event.pointerId;
      pointerCompleted = false;
      outsideGesture = event.button === 0 && !isInside(event.target) && !modalIsOpen();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || event.button !== 0 || isInside(event.target)) resetPointer();
      else pointerCompleted = true;
    };
    const handleClick = (event: MouseEvent) => {
      const shouldDismiss = outsideGesture && pointerCompleted && event.button === 0
        && !isInside(event.target) && !modalIsOpen();
      resetPointer();
      if (shouldDismiss) {
        // A nonfocusable outside target can leave focus in the closing panel.
        dismiss(panel.contains(document.activeElement));
      }
    };

    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", handleFocus);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", resetPointer, true);
    document.addEventListener("click", handleClick, true);
    window.addEventListener("blur", resetPointer);
    initialFocusRef?.current?.focus();
    focusWasInside = Boolean(isInside(document.activeElement));

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", handleFocus);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", resetPointer, true);
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("blur", resetPointer);
      if (!closingRef.current && focusWasInside && !modalIsOpen()
        && (panel.contains(document.activeElement) || document.activeElement === document.body)) {
        triggerRef.current?.focus();
      }
    };
  }, [open, triggerRef, panelRef, initialFocusRef, dismiss]);

  return dismiss;
}
