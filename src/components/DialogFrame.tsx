import { useEffect, useId, useRef } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

interface OpenDialog {
  element: HTMLDivElement;
  previousFocus: HTMLElement | null;
}

// Opening order determines keyboard ownership, independently of callback renders.
const openDialogs: OpenDialog[] = [];

function isTopDialog(element: HTMLDivElement | null) {
  return openDialogs[openDialogs.length - 1]?.element === element;
}

function focusableElements(dialog: HTMLDivElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled"));
}

function focusInside(dialog: HTMLDivElement) {
  focusableElements(dialog)[0]?.focus();
  if (!dialog.contains(document.activeElement)) dialog.focus();
}

interface DialogFrameProps {
  visible: boolean;
  title: string;
  descriptionId?: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  dismissible?: boolean;
  children: ReactNode;
  maxWidthClassName?: string;
  // Replaces the default card classes, including maxWidthClassName.
  className?: string;
  backdropClassName?: string;
  backdropStyle?: CSSProperties;
  titleClassName?: string;
  // The returned header must include the supplied labelled heading.
  renderHeader?: (title: ReactNode) => ReactNode;
}

export function DialogFrame({
  visible,
  title,
  descriptionId,
  initialFocusRef,
  onDismiss,
  dismissible = true,
  children,
  maxWidthClassName = "max-w-[360px]",
  className = `w-full ${maxWidthClassName} mx-4 bg-bg-secondary border border-border rounded-xl shadow-lg p-6`,
  backdropClassName = "print-hide fixed inset-0 z-[60] flex items-center justify-center",
  backdropStyle,
  titleClassName = "font-reading italic text-lg text-text-primary mb-2",
  renderHeader,
}: DialogFrameProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const backdropPointerRef = useRef<number | null>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialogRef.current;
    if (!visible || !element) return;

    const entry: OpenDialog = {
      element,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    openDialogs.push(entry);
    initialFocusRef.current?.focus();

    return () => {
      const wasTop = isTopDialog(element);
      openDialogs.splice(openDialogs.indexOf(entry), 1);
      // If an underlying dialog unmounts first, preserve the remaining opener chain.
      for (const remaining of openDialogs) {
        if (remaining.previousFocus && element.contains(remaining.previousFocus)) {
          remaining.previousFocus = entry.previousFocus;
        }
      }
      backdropPointerRef.current = null;
      if (wasTop) {
        const remainingDialog = openDialogs[openDialogs.length - 1]?.element;
        if (remainingDialog) {
          if (entry.previousFocus?.isConnected && remainingDialog.contains(entry.previousFocus)) {
            entry.previousFocus.focus();
          } else {
            focusInside(remainingDialog);
          }
        } else if (entry.previousFocus?.isConnected) {
          entry.previousFocus.focus();
        }
      }
    };
  }, [initialFocusRef, visible]);

  useEffect(() => {
    if (!visible) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isTopDialog(dialogRef.current)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (dismissible) onDismiss();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!focusable.some((element) => element === document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKey, { capture: true });
    return () => window.removeEventListener("keydown", handleKey, { capture: true });
  }, [dismissible, onDismiss, visible]);

  if (!visible) return null;

  const heading = <h2 id={titleId} className={titleClassName}>{title}</h2>;

  return (
    <div
      ref={backdropRef}
      onPointerDown={(event) => {
        backdropPointerRef.current = dismissible && isTopDialog(dialogRef.current)
          && event.button === 0 && event.target === backdropRef.current
          ? event.pointerId
          : null;
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== backdropPointerRef.current || event.target !== backdropRef.current) {
          backdropPointerRef.current = null;
        }
      }}
      onPointerCancel={() => { backdropPointerRef.current = null; }}
      onClick={(event) => {
        const startedOnBackdrop = backdropPointerRef.current !== null;
        backdropPointerRef.current = null;
        if (startedOnBackdrop && dismissible && isTopDialog(dialogRef.current)
          && event.target === backdropRef.current) onDismiss();
      }}
      className={backdropClassName}
      style={{
        background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
        backdropFilter: "blur(4px)",
        animation: "fadeIn 150ms ease",
        ...backdropStyle,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={className}
      >
        {renderHeader ? renderHeader(heading) : heading}
        {children}
      </div>
    </div>
  );
}
