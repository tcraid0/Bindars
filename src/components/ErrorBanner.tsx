import { memo } from "react";
import type { AppError, ErrorCategory } from "../types";

interface ErrorBannerProps {
  error: AppError;
  onDismiss: () => void;
}

const icons: Record<ErrorCategory, React.ReactNode> = {
  "not-found": (
    // file-x
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9.5" y1="12.5" x2="14.5" y2="17.5" />
      <line x1="14.5" y1="12.5" x2="9.5" y2="17.5" />
    </svg>
  ),
  "too-large": (
    // file-warning
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="16" />
      <line x1="12" y1="19" x2="12.01" y2="19" />
    </svg>
  ),
  "not-markdown": (
    // file-type
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15v-2h6v2" />
      <path d="M12 13v5" />
    </svg>
  ),
  utf8: (
    // file-code
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="m10 13-2 2 2 2" />
      <path d="m14 17 2-2-2-2" />
    </svg>
  ),
  generic: (
    // alert-circle
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
};

function ErrorBannerComponent({ error, onDismiss }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="max-w-[65ch] mx-auto mt-4 px-4 py-3 rounded-lg border border-red-400/30 bg-red-500/10 text-red-400 text-sm flex items-start gap-3"
    >
      <span className="shrink-0 mt-0.5">{icons[error.category]}</span>
      <span className="flex-1 min-w-0">{error.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-red-500/10 transition-colors duration-120"
        aria-label="Dismiss error"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export const ErrorBanner = memo(ErrorBannerComponent);
