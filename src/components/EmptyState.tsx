import { memo, useState } from "react";
import type { RecentFile } from "../types";
import { OPENABLE_FILE_TYPES_DESCRIPTION } from "../lib/openable-files";
import { formatShortcutLabel } from "../lib/shortcut-labels";

const buttonBase = "px-5 py-3 rounded-lg font-medium text-sm transition-colors duration-120";
const primaryButton = `${buttonBase} bg-accent-fill text-on-accent hover:bg-accent-fill-hover shadow-sm`;
const secondaryButton = `${buttonBase} border border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary`;

interface EmptyStateProps {
  onNewFile: () => void;
  onOpenFile: () => void;
  onTrySample: () => void;
  canTrySample?: boolean;
  recentFiles: RecentFile[];
  recentHistoryUnavailable?: boolean;
  onOpenRecent: (path: string) => void;
}

function EmptyStateComponent({
  onNewFile,
  onOpenFile,
  onTrySample,
  canTrySample = true,
  recentFiles,
  recentHistoryUnavailable = false,
  onOpenRecent,
}: EmptyStateProps) {
  const hasRecent = recentFiles.length > 0;
  const topRecent = hasRecent ? recentFiles[0] : null;
  const recentList = recentFiles.slice(0, 5);
  // At launch the startup screen reveals this screen and its mark glides into the
  // symbol (main.tsx), so the entrance only plays when the screen appears later.
  const [atLaunch] = useState(() => document.getElementById("loading-screen") !== null);

  return (
    <div className={`empty-state flex flex-col items-center text-center px-8 select-none${atLaunch ? " empty-state-at-launch" : ""}`}>
      {/* The brand artwork is inlined in index.html. */}
      <h1 className="empty-state-brand empty-state-title">
        <svg className="empty-state-symbol" data-startup-mark-target aria-hidden="true">
          <use href="#bindars-symbol" />
        </svg>
        <svg className="empty-state-wordmark" data-startup-mark-passes aria-hidden="true">
          <use href="#bindars-wordmark" />
        </svg>
        <span className="sr-only">Bindars</span>
      </h1>
      <p
        className="font-reading italic text-text-muted text-lg empty-state-tagline empty-state-subtitle"
      >
        Read, highlight, and add your thoughts
      </p>

      <div className="empty-state-content">
        {recentHistoryUnavailable && (
          <p className="text-sm text-text-muted mb-4">Recent history is unavailable.</p>
        )}
        {hasRecent && (
          <>
            <button
              type="button"
              onClick={() => onOpenRecent(topRecent!.path)}
              className={`${primaryButton} mb-5 max-w-[320px] truncate`}
            >
              Resume: {topRecent!.name}
            </button>

            {recentList.length > 1 && (
              <ul className="mb-4 space-y-1 max-w-[320px] w-full mx-auto">
                {recentList.slice(1).map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => onOpenRecent(file.path)}
                      className="w-full text-left px-3 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120 truncate"
                    >
                      {file.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

          </>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* Resume is the main action once there is something to resume. */}
          <button
            type="button"
            onClick={onTrySample}
            disabled={!canTrySample}
            className={`${hasRecent ? secondaryButton : primaryButton} disabled:opacity-50 disabled:pointer-events-none`}
          >
            Try an example
          </button>
          <button
            type="button"
            onClick={onNewFile}
            className={secondaryButton}
          >
            New File
          </button>
          <button
            type="button"
            onClick={onOpenFile}
            className={secondaryButton}
          >
            Open File
          </button>
        </div>
        {!hasRecent && (
          <p className="text-xs text-text-muted mt-3 max-w-sm mx-auto">
            Save your own copy, then try highlighting and adding notes. Reopen your saved copy from Recent files or Open File.
          </p>
        )}
        <p className="text-xs text-text-muted mt-2">
          {formatShortcutLabel("newFile")} · {formatShortcutLabel("openFile")}
        </p>
      </div>

      <div className="text-xs text-text-muted mt-8 space-y-1.5 empty-state-content">
        <p>Drag {OPENABLE_FILE_TYPES_DESCRIPTION} files here to open</p>
        <p>Press <kbd className="inline-block px-1.5 py-0.5 rounded border border-border bg-bg-tertiary font-mono text-[11px] leading-none">{formatShortcutLabel("showShortcuts")}</kbd> for keyboard shortcuts</p>
      </div>
    </div>
  );
}

export const EmptyState = memo(EmptyStateComponent);
