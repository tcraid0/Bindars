import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { RecentFile } from "../types";
import { RecentFiles, type RecentDetails } from "./RecentFiles";
import { welcomeRecoveryMessage, type WelcomeRecovery } from "../lib/welcome-recovery";
import { toPathIdentityKey } from "../lib/paths";
import { detectShortcutPlatform, formatShortcutLabel } from "../lib/shortcut-labels";

const buttonBase = "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg font-medium text-sm transition-colors duration-120";
const outline = " border border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary";
const primaryButton = buttonBase + " bg-accent-fill text-on-accent hover:bg-accent-fill-hover shadow-sm";
const secondaryButton = buttonBase + outline;
// Home's actions stay quiet: the documents are what you came for.
const quietButton = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg font-medium text-[13px] transition-colors duration-120" + outline;
const listLabel = "text-xs font-medium text-text-muted mb-2 px-3";

const OPEN_ICON = "M3 9V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1M3 21h15l4-12H7L3 21Zm0 0L2 9h5";
const EXAMPLE_ICON = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h6";
const NEW_ICON = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M12 18v-6M9 15h6";
const icon = (path: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
);

interface EmptyStateProps {
  onOpenFile: () => void;
  onNewFile: () => void;
  onTrySample: () => void;
  onShowShortcuts: () => void;
  canTrySample?: boolean;
  canFocus?: boolean;
  /** Home was chosen in the app or restored from the saved session. */
  preferHome?: boolean;
  recentFiles: RecentFile[];
  recentDetails?: RecentDetails;
  recentHistoryUnavailable?: boolean;
  /** The recent file to mark "Continue at", if its section is known. */
  continuePath?: string | null;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  openingPath: string | null;
  recovery?: WelcomeRecovery | null;
  onRetry: () => void;
  onDismiss: () => void;
}

function EmptyStateComponent({
  onOpenFile, onNewFile, onTrySample, onShowShortcuts, canTrySample = true, canFocus = false, preferHome = false,
  recentFiles, recentDetails, recentHistoryUnavailable = false, continuePath = null, onOpenRecent, onRemoveRecent,
  openingPath, recovery, onRetry, onDismiss,
}: EmptyStateProps) {
  const recentList = recentFiles.slice(0, 5);
  // Until Home lists three documents, ways to start fill the page below them.
  const blank = recentList.length === 0 && !recentHistoryUnavailable;
  const few = recentList.length < 3 && !recentHistoryUnavailable;
  const message = recovery ? welcomeRecoveryMessage(recovery) : null;
  const openRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const preserveHeaderFocus = useCallback((actions: HTMLDivElement | null) => {
    // Three to two recents removes these actions; hand off their focus first.
    return () => {
      if (actions?.contains(document.activeElement)) {
        headingRef.current?.focus({ preventScroll: true });
      }
    };
  }, []);
  const focusSettledRef = useRef(false);
  // main.tsx supplies the entrance at launch by gliding the startup mark here.
  const [atLaunch] = useState(() => document.getElementById("loading-screen") !== null);
  // Only the launch screen of someone with no history is the first-run welcome.
  // Decided at mount, so removing the last recent file never swaps the page.
  const [firstRun] = useState(() => !preferHome && recentFiles.length === 0 && !recentHistoryUnavailable);

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

  const openFile = (className: string) => (
    <button ref={openRef} type="button" onClick={onOpenFile} className={className}>
      {icon(OPEN_ICON)}
      Open File…
    </button>
  );
  const recoveryMessage = message && (
    <div className={`empty-state-recovery-message ${firstRun ? "empty-state-subtitle max-w-sm my-5" : "my-5 px-3"}`} role="status">
      <p className="text-sm text-text-primary">{message.title}</p>
      <p className="text-xs text-text-muted mt-1">{message.detail}</p>
      <div className={`flex gap-4 mt-2 ${firstRun ? "justify-center" : ""}`}>
        {!recentList.some(file => toPathIdentityKey(file.path) === toPathIdentityKey(recovery?.path ?? "")) && (
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
    <div className={`empty-state-recents ${firstRun ? "max-w-[440px] mx-auto mt-6" : ""} text-left`}>
      {firstRun && <h2 className={listLabel}>Recent files</h2>}
      <RecentFiles files={recentList} unavailable={recentHistoryUnavailable}
        currentFilePath={null} openingPath={openingPath} onOpen={onOpenRecent}
        onRemove={path => {
          // The last row hands keyboard focus to Open, which stays in place.
          if (recentFiles.length === 1 && document.activeElement?.closest(".empty-state-recents")) {
            openRef.current?.focus({ preventScroll: true });
          }
          onRemoveRecent(path);
        }} recovery={recovery} onRetry={onRetry} continuePath={continuePath}
        details={recentDetails} welcome />
    </div>
  );
  const startRows = (
    <div className="mt-6">
      {blank ? (
        <>
          <h2 className="font-reading text-[1.6rem] leading-tight font-medium text-text-primary px-3">Start with a document</h2>
          <p className="text-sm text-text-secondary mt-1.5 mb-3 px-3">Documents you open will be listed here, with where you left off in each.</p>
        </>
      ) : <h2 className={listLabel}>More ways to start</h2>}
      {[
        {
          title: "Open a file…",
          primary: true,
          path: OPEN_ICON,
          onClick: onOpenFile,
          disabled: false,
          hint: formatShortcutLabel("openFile"),
          detail: `Markdown or Fountain, from anywhere on your ${detectShortcutPlatform() === "macos" ? "Mac" : "computer"}`,
        },
        ...(blank ? [{
          title: "Try an example…",
          primary: false,
          path: EXAMPLE_ICON,
          onClick: onTrySample,
          disabled: !canTrySample,
          hint: null,
          detail: "Save a short guide to reading, highlights and notes",
        }] : []),
        {
          title: "New document",
          primary: false,
          path: NEW_ICON,
          onClick: onNewFile,
          disabled: false,
          hint: formatShortcutLabel("newFile"),
          detail: "Kept in Bindars Drafts until you save it somewhere",
        },
      ].map(row => (
        <button key={row.title} ref={row.primary ? openRef : undefined} type="button" onClick={row.onClick} disabled={row.disabled}
          aria-label={`${row.title}, ${row.detail}`}
          className="home-row flex items-center gap-3.5 w-full px-3 text-left hover:bg-bg-tertiary disabled:opacity-50 disabled:pointer-events-none transition-colors duration-120">
          <span className={`grid place-items-center size-9 shrink-0 rounded-[9px] ${row.primary ? "bg-accent/15 text-accent-text" : "bg-bg-tertiary text-text-secondary"}`}>
            {icon(row.path)}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-medium text-text-primary">{row.title}</span>
            <span className="block text-xs text-text-muted break-words mt-0.5">{row.detail}</span>
          </span>
          {row.hint && (
            <kbd aria-hidden="true" className="shrink-0 font-ui text-[11px] text-text-muted border border-border border-b-2 rounded-[5px] px-1.5 py-0.5">
              {row.hint}
            </kbd>
          )}
        </button>
      ))}
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
      <div className={["empty-state empty-state-home px-8 select-none",
        recovery ? "empty-state-recovery" : ""].join(" ")}>
        <div className="empty-state-content home-column">
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 mb-4">
            <h1 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold text-text-primary">Home</h1>
            {!few && (
              <div ref={preserveHeaderFocus} className="flex gap-2">
                {openFile(quietButton)}
                <button type="button" onClick={onNewFile} className={quietButton}>{icon(NEW_ICON)}New</button>
              </div>
            )}
          </div>
          {recoveryMessage}
          {!blank && recents}
          {few && startRows}
          <p className="text-xs text-text-muted mt-5 px-3">
            {blank ? "You can also drop a Markdown or Fountain file anywhere in this window." : "Drop a Markdown or Fountain file anywhere to open it."}
          </p>
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
          {openFile(primaryButton)}
          <div className="flex flex-col items-center">
            <button type="button" onClick={onTrySample} disabled={!canTrySample}
              className={secondaryButton + " disabled:opacity-50 disabled:pointer-events-none"}>
              {icon(EXAMPLE_ICON)}
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
