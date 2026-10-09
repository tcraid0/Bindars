import type { RecentFile } from "../types";
import { useRef } from "react";
import { focusAfterRemoval } from "../lib/focus-after-removal";
import type { WelcomeRecovery } from "../lib/welcome-recovery";

interface RecentFilesProps {
  files: RecentFile[];
  unavailable?: boolean;
  currentFilePath: string | null;
  openingPath: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  recovery?: WelcomeRecovery | null;
  onRetry?: () => void;
  welcome?: boolean;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function dirName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) return "";
  // Keep the separator for filesystem roots, including Windows drive roots.
  const isRoot = separator === 0 || (separator === 2 && path[1] === ":");
  return path.slice(0, separator + (isRoot ? 1 : 0));
}

export function RecentFiles({
  files,
  unavailable = false,
  currentFilePath,
  openingPath,
  onOpen,
  onRemove,
  recovery,
  onRetry,
  welcome = false,
}: RecentFilesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={containerRef} tabIndex={-1} role="group" aria-label="Recent files" className="flex-1 focus-visible:outline-2 focus-visible:outline-accent-indicator focus-visible:-outline-offset-2">
      {files.length === 0 && (
        <div className="px-4 py-8 text-center text-text-muted text-sm">{unavailable ? "Recent history is unavailable." : "No recent files"}</div>
      )}
      {files.map((file) => {
        const isActive = file.path === currentFilePath;
        const isOpening = file.path === openingPath;
        const isUnavailable = file.path === recovery?.path;
        return (
          <div
            key={file.path}
            className={`w-full flex items-center gap-2 text-left px-3 py-2.5 hover:bg-bg-tertiary transition-colors duration-120 group relative ${welcome ? "border-t border-border" : ""} ${
              isActive ? "border-l-[3px] border-l-accent-indicator sidebar-active-item" : "border-l-[3px] border-l-transparent"
            }`}
          >
            <button
              type="button"
              onClick={() => onOpen(file.path)}
              className="flex-1 min-w-0 text-left"
              aria-label={`Open ${file.name}`}
              aria-busy={isOpening}
              // The explicit Retry control is the one action for an unavailable file.
              disabled={isOpening || isUnavailable}
            >
              <div className="text-sm font-medium text-text-primary truncate" title={file.name}>
                {file.name}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-text-muted truncate" title={file.path}>{dirName(file.path)}</span>
                <span className="text-xs text-text-muted shrink-0">
                  {isOpening ? "Opening…" : isUnavailable ? "Unavailable" : welcome ? null : timeAgo(file.openedAt)}
                </span>
              </div>
            </button>
            {isUnavailable && onRetry && (
              <button type="button" onClick={onRetry} disabled={isOpening || recovery.retryDisabled}
                className="text-xs text-accent-text hover:underline disabled:opacity-50 disabled:pointer-events-none"
                aria-label={`Retry opening ${file.name}`}>Retry</button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                focusAfterRemoval(e.currentTarget.parentElement, containerRef.current);
                onRemove(file.path);
              }}
              aria-label={`Remove ${file.name} from recent files`}
              disabled={isOpening}
              className={`shrink-0 p-1.5 rounded ${welcome || isUnavailable ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"} hover:bg-bg-primary text-text-muted hover:text-text-primary transition-all duration-120`}
              title="Remove from recent"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
