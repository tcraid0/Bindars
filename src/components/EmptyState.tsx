import { memo, useEffect, useRef, useState } from "react";
import type { RecentFile } from "../types";
import { RecentFiles } from "./RecentFiles";
import { welcomeRecoveryMessage, type WelcomeRecovery } from "../lib/welcome-recovery";

const buttonBase = "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg font-medium text-sm transition-colors duration-120";
const primaryButton = buttonBase + " bg-accent-fill text-on-accent hover:bg-accent-fill-hover shadow-sm";
const secondaryButton = buttonBase + " border border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary";

interface EmptyStateProps {
  onOpenFile: () => void;
  onTrySample: () => void;
  onShowShortcuts: () => void;
  canTrySample?: boolean;
  canFocus?: boolean;
  recentFiles: RecentFile[];
  recentHistoryUnavailable?: boolean;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  openingPath: string | null;
  recovery?: WelcomeRecovery | null;
  onRetry: () => void;
  onDismiss: () => void;
}

function EmptyStateComponent({
  onOpenFile, onTrySample, onShowShortcuts, canTrySample = true, canFocus = false,
  recentFiles, recentHistoryUnavailable = false, onOpenRecent, onRemoveRecent,
  openingPath, recovery, onRetry, onDismiss,
}: EmptyStateProps) {
  const recentList = recentFiles.slice(0, 5);
  const message = recovery ? welcomeRecoveryMessage(recovery) : null;
  const openRef = useRef<HTMLButtonElement | null>(null);
  const focusSettledRef = useRef(false);
  // main.tsx supplies the entrance at launch by gliding the startup mark here.
  const [atLaunch] = useState(() => document.getElementById("loading-screen") !== null);

  useEffect(() => {
    if (!canFocus || focusSettledRef.current) return;
    const focusOpen = () => {
      focusSettledRef.current = true;
      // A user who already chose a toolbar control keeps their focus.
      if (!document.activeElement || document.activeElement === document.body) {
        openRef.current?.focus({ preventScroll: true });
      }
    };
    const loadingScreen = document.getElementById("loading-screen");
    if (!loadingScreen) {
      focusOpen();
      return;
    }
    // App readiness precedes the splash's font wait and exit animation.
    const observer = new MutationObserver(() => {
      if (loadingScreen.isConnected) return;
      cleanup();
      if (!focusSettledRef.current) focusOpen();
    });
    const onFocus = () => {
      focusSettledRef.current = true;
      cleanup();
    };
    const cleanup = () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus);
    };
    if (document.activeElement && document.activeElement !== document.body) {
      focusSettledRef.current = true;
      return;
    }
    observer.observe(document.body, { childList: true });
    document.addEventListener("focusin", onFocus);
    return cleanup;
  }, [canFocus]);

  return (
    <div className={["empty-state flex flex-col items-center text-center px-8 select-none",
      atLaunch ? "empty-state-at-launch" : "", recovery ? "empty-state-recovery" : ""].join(" ")}>
      <h1 className="empty-state-brand empty-state-title">
        <svg className="empty-state-symbol" data-startup-mark-target aria-hidden="true"><use href="#bindars-symbol" /></svg>
        <svg className="empty-state-wordmark" data-startup-mark-passes aria-hidden="true"><use href="#bindars-wordmark" /></svg>
        <span className="sr-only">Bindars</span>
      </h1>
      {message ? (
        <div className="empty-state-recovery-message empty-state-subtitle max-w-sm my-5" role="status">
          <p className="text-sm text-text-primary">{message.title}</p>
          <p className="text-xs text-text-muted mt-1">{message.detail}</p>
          <div className="flex justify-center gap-4 mt-2">
            {!recentList.some(file => file.path === recovery?.path) && (
              <button type="button" onClick={onRetry} disabled={recovery?.retryDisabled}
                className="text-xs text-accent-text hover:underline disabled:opacity-50 disabled:pointer-events-none">
                Retry
              </button>
            )}
            <button type="button" className="text-xs text-accent-text hover:underline"
              onClick={() => {
                // The message unmounts with its button; hand focus to the primary action.
                openRef.current?.focus({ preventScroll: true });
                onDismiss();
              }}>
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <p className="font-reading italic text-text-muted text-lg empty-state-tagline empty-state-subtitle">
          Read, highlight, and add your thoughts
        </p>
      )}
      <div className="empty-state-content w-full">
        <div className="flex flex-wrap items-start justify-center gap-2.5">
          <button ref={openRef} type="button" onClick={onOpenFile} className={primaryButton}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 9V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1M3 21h15l4-12H7L3 21Zm0 0L2 9h5" />
            </svg>
            Open File…
          </button>
          <div className="flex flex-col items-center">
            <button type="button" onClick={onTrySample} disabled={!canTrySample}
              className={secondaryButton + " disabled:opacity-50 disabled:pointer-events-none"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h6" />
              </svg>
              Try an Example…
            </button>
            <p className="text-xs text-text-muted mt-2">Choose where to save it.</p>
          </div>
        </div>
        {!recovery && <p className="text-xs text-text-muted mt-6">Or drop a Markdown or Fountain file here</p>}
        {(recentList.length > 0 || recentHistoryUnavailable) && (
          <div className="empty-state-recents max-w-[440px] mx-auto mt-6 text-left">
            <h2 className="text-xs font-medium text-text-muted mb-2 px-3">Recent files</h2>
            <RecentFiles files={recentList} unavailable={recentHistoryUnavailable}
              currentFilePath={null} openingPath={openingPath} onOpen={onOpenRecent}
              onRemove={onRemoveRecent} recovery={recovery} onRetry={onRetry} welcome />
          </div>
        )}
        <button type="button" onClick={onShowShortcuts}
          className="text-xs text-accent-text hover:underline rounded px-2 py-1.5 mt-5">
          Keyboard Shortcuts
        </button>
      </div>
    </div>
  );
}

export const EmptyState = memo(EmptyStateComponent);
