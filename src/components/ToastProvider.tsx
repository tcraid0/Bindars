import { createPortal } from "react-dom";
import { getActiveDialog, useActiveDialog } from "./DialogFrame";
import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

type ToastVariant = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  context: HTMLDivElement | null;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 3000;

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const activeDialog = useActiveDialog();
  const idRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timerId = timersRef.current.get(id);
    if (timerId) {
      clearTimeout(timerId);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = "success") => {
      const id = ++idRef.current;
      const context = getActiveDialog();
      setToasts((prev) => {
        if (variant === "error" && prev.some(t => t.context === context && t.variant === variant && t.message === message)) return prev;
        const next = [...prev, { id, message, variant, context }];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
    },
    [],
  );

  useEffect(() => {
    setToasts(prev => {
      if (!prev.some(t => t.context && !t.context.isConnected)) return prev;
      const visible = prev.filter(t => t.context === activeDialog);
      return prev.flatMap(t => {
        if (!t.context || t.context.isConnected) return [t];
        if (visible.some(other => other.variant === t.variant && other.message === t.message)) return [];
        const moved = { ...t, context: activeDialog };
        visible.push(moved);
        return [moved];
      });
    });
    for (const [id, timer] of timersRef.current) {
      if (!toasts.some(t => t.id === id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
    for (const t of toasts) {
      if (t.variant !== "error" && !timersRef.current.has(t.id)) {
        timersRef.current.set(t.id, setTimeout(() => dismiss(t.id), AUTO_DISMISS_MS));
      }
    }
  }, [activeDialog, toasts, dismiss]);

  // Clear all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const contextValue = useMemo(() => ({ toast }), [toast]);

  const notifications = (context: HTMLDivElement | null) => (
      <div
        className={context ? "print-hide mt-4 flex flex-col gap-2" : "print-hide fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] flex flex-col-reverse items-center gap-2 pointer-events-none"}
        style={{ visibility: !context && activeDialog ? "hidden" : undefined }}
        role="status"
        aria-live="polite"
      >
        {toasts.filter(t => t.context === context).map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : undefined}
            aria-live={t.variant === "error" ? "assertive" : undefined}
            className="pointer-events-auto flex items-center gap-2 bg-bg-secondary border border-border rounded-lg shadow-lg px-4 py-2.5 border-l-4"
            style={{
              borderLeftColor:
                t.variant === "error"
                  ? "var(--danger)"
                  : t.variant === "success"
                    ? "var(--accent-text)"
                    : "var(--color-border)",
              animation: "toastIn 250ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            {t.variant === "success" ? (
              <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            ) : t.variant === "error" ? (
              <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            ) : (
              <svg className="shrink-0 text-text-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
            <span className="text-sm text-text-primary">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="text-text-muted hover:text-text-primary p-0.5 rounded transition-colors duration-120"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
  );
  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {notifications(null)}
      {activeDialog && createPortal(notifications(activeDialog), activeDialog)}
    </ToastContext.Provider>
  );
}
