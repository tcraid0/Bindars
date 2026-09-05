import { useEffect, useId, useRef } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

interface DialogFrameProps {
  visible: boolean;
  title: string;
  descriptionId?: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  dismissible?: boolean;
  children: ReactNode;
  maxWidthClassName?: string;
  className?: string;
  backdropClassName?: string;
  backdropStyle?: CSSProperties;
  titleClassName?: string;
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
  const titleId = useId();

  useEffect(() => {
    if (!visible) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    initialFocusRef.current?.focus();

    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [initialFocusRef, visible]);

  useEffect(() => {
    if (!visible) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (dismissible) onDismiss();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
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
      onClick={(event) => {
        if (dismissible && event.target === backdropRef.current) onDismiss();
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
