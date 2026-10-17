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
  /** Reached inside the app (not the screen shown at launch): always Home. */
  inApp?: boolean;
  recentFiles: RecentFile[];
  recentHistoryUnavailable?: boolean;
  /** The recent file to mark "Continue reading", if any. */
  continuePath?: string | null;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  openingPath: string | null;
  recovery?: WelcomeRecovery | null;
  onRetry: () => void;
  onDismiss: () => void;
}

function EmptyStateComponent({
  onOpenFile, onTrySample, onShowShortcuts, canTrySample = true, canFocus = false, inApp = false,
  recentFiles, recentHistoryUnavailable = false, continuePath = null, onOpenRecent, onRemoveRecent,
  openingPath, recovery, onRetry, onDismiss,
}: EmptyStateProps) {
  const recentList = recentFiles.slice(0, 5);
  const message = recovery ? welcomeRecoveryMessage(recovery) : null;
  const openRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusSettledRef = useRef(false);
  // main.tsx supplies the entrance at launch by gliding the startup mark here.
  const [atLaunch] = useState(() => document.getElementById("loading-screen") !== null);
  // Only the launch screen of someone with no history is the first-run welcome.
  // Decided at mount, so removing the last recent file never swaps the page.
  const [firstRun] = useState(() => !inApp && recentFiles.length === 0 && !recentHistoryUnavailable);

  useEffect(() => {
    if (!canFocus || focusSettledRef.current) return;
    const focusOpen = () => {
      focusSettledRef.current = true;
      // A user who already chose a toolbar control keeps their focus. First run
      // starts at Open File…; a launch onto Home announces where you are.
      if (!document.activeElement || document.activeElement === document.body) {
        (firstRun ? openRef : headingRef).current?.focus({ preventScroll: true });
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

  const openFile = (
    <button ref={openRef} type="button" onClick={onOpenFile} className={primaryButton}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 9V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1M3 21h15l4-12H7L3 21Zm0 0L2 9h5" />
      </svg>
      Open File…
    </button>
  );
  const recoveryMessage = message && (
    <div className={`empty-state-recovery-message ${firstRun ? "empty-state-subtitle max-w-sm my-5" : "my-5 px-3"}`} role="status">
      <p className="text-sm text-text-primary">{message.title}</p>
      <p className="text-xs text-text-muted mt-1">{message.detail}</p>
      <div className={`flex gap-4 mt-2 ${firstRun ? "justify-center" : ""}`}>
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
  );
  const recents = (
    <div className={`empty-state-recents ${firstRun ? "max-w-[440px] mx-auto mt-6" : "mt-5"} text-left`}>
      <h2 className="text-xs font-medium text-text-muted mb-2 px-3">Recent files</h2>
      <RecentFiles files={recentList} unavailable={recentHistoryUnavailable}
        currentFilePath={null} openingPath={openingPath} onOpen={onOpenRecent}
        onRemove={onRemoveRecent} recovery={recovery} onRetry={onRetry} continuePath={continuePath} welcome />
    </div>
  );
  const shortcuts = (
    <button type="button" onClick={onShowShortcuts}
      className="text-xs text-accent-text hover:underline rounded px-2 py-1.5 mt-5">
      Keyboard Shortcuts
    </button>
  );

  if (!firstRun) {
    return (
      <div className={["empty-state empty-state-home flex flex-col items-center px-8 select-none",
        recovery ? "empty-state-recovery" : ""].join(" ")}>
        <div className="empty-state-content w-full max-w-[440px]">
          <div className="flex flex-wrap items-center justify-between gap-3 px-3">
            <h1 ref={headingRef} tabIndex={-1} className="flex items-center gap-2.5 text-2xl font-semibold text-text-primary">
              <svg className="size-7 overflow-visible" aria-hidden="true"><use href="#bindars-symbol" /></svg>
              Home
            </h1>
            {openFile}
          </div>
          {recoveryMessage}
          {recents}
          {shortcuts}
        </div>
      </div>
    );
  }

  return (
    <div className={["empty-state flex flex-col items-center text-center px-8 select-none",
      atLaunch ? "empty-state-at-launch" : "", recovery ? "empty-state-recovery" : ""].join(" ")}>
      <h1 tabIndex={-1} className="empty-state-brand empty-state-title">
        <svg className="empty-state-symbol" data-startup-mark-target aria-hidden="true"><use href="#bindars-symbol" /></svg>
        <svg className="empty-state-wordmark" data-startup-mark-passes aria-hidden="true"><use href="#bindars-wordmark" /></svg>
        <span className="sr-only">Bindars</span>
      </h1>
      {recoveryMessage ?? (
        <p className="font-reading italic text-text-muted text-lg empty-state-tagline empty-state-subtitle">
          Read, highlight, and add your thoughts
        </p>
      )}
      <div className="empty-state-content w-full">
        <div className="flex flex-wrap items-start justify-center gap-2.5">
          {openFile}
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
        {(recentList.length > 0 || recentHistoryUnavailable) && recents}
        {shortcuts}
      </div>
    </div>
  );
}

export const EmptyState = memo(EmptyStateComponent);
