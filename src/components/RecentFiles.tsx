import { locationLabel, toPathIdentityKey } from "../lib/paths";
import type { RecentFile } from "../types";
import { useRef } from "react";
import { focusAfterRemoval } from "../lib/focus-after-removal";
import type { WelcomeRecovery } from "../lib/welcome-recovery";

/** What the search index knows about a recent file, keyed by path identity. */
export type RecentDetails = ReadonlyMap<string, { title: string | null; section: string | null }>;

interface RecentFilesProps {
  files: RecentFile[];
  unavailable?: boolean;
  currentFilePath: string | null;
  openingPath: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  recovery?: WelcomeRecovery | null;
  onRetry?: () => void;
  /** Home marks the file you were last reading. */
  continuePath?: string | null;
  welcome?: boolean;
  /** Home names each document by its title and the section it was left at. */
  details?: RecentDetails;
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

export function RecentFiles({
  files,
  unavailable = false,
  currentFilePath,
  openingPath,
  onOpen,
  onRemove,
  recovery,
  onRetry,
  continuePath = null,
  welcome = false,
  details,
}: RecentFilesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="group"
      aria-label="Recent files"
      className="flex-1 focus-visible:outline-2 focus-visible:outline-accent-indicator focus-visible:-outline-offset-2"
    >
      {files.length === 0 && (unavailable ? (
        <div className="px-4 py-8 text-center text-text-muted text-sm">Recent history is unavailable.</div>
      ) : <p className="navigation-help">Documents you open will appear here.</p>)}
      {files.map((file) => {
        const isActive = file.path === currentFilePath;
        const isOpening = file.path === openingPath;
        const key = toPathIdentityKey(file.path);
        const isUnavailable = recovery && key === toPathIdentityKey(recovery.path);
        const { title = null, section = null } = details?.get(key) ?? {};
        // Home's cue says where to continue, so it needs a known section.
        const isContinue = file.path === continuePath && !isUnavailable && section !== null;
        const location = locationLabel(file.path);
        const status = isOpening ? "Opening…" : isUnavailable ? "Unavailable" : null;
        return (
          <div
            key={file.path}
            data-path={file.path}
            data-current={isActive || undefined}
            className={`document-row flex items-center gap-2 group ${welcome ? "home-row" : ""}`}
          >
            <div className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => { if (!isOpening && !isUnavailable) onOpen(file.path); }}
                className="block w-full min-w-0 text-left"
                aria-label={`Open ${title ?? file.name}${title ? `, ${file.name}` : ""}, ${location}${isContinue ? ", Continue reading" : ""}`}
                title={file.path}
                aria-current={isActive ? "page" : undefined}
                aria-busy={isOpening}
                aria-disabled={isOpening || isUnavailable || undefined}
                // Keep focus on failure; Tab advances to the explicit Retry action.
                tabIndex={isUnavailable ? -1 : undefined}
              >
                {welcome ? (
                  <>
                    <span className="flex items-baseline justify-between gap-4">
                      <span className="font-reading text-[1.3rem] leading-[1.3] font-medium text-text-primary break-words min-w-0">
                        {title ?? file.name}
                      </span>
                      {/* Remove takes the time's place on an available row. */}
                      <span className={`shrink-0 text-xs text-text-muted tabular-nums ${isUnavailable ? "" : "group-hover:invisible group-focus-within:invisible"}`}>
                        {timeAgo(file.openedAt)}
                      </span>
                    </span>
                    <span className="block text-[0.8125rem] text-text-muted break-words mt-1">
                      {section && (
                        <span className={isContinue ? "text-accent-text" : "text-text-secondary"}>
                          {isContinue ? `Continue at ${section}` : section}
                        </span>
                      )}
                      {section && " · "}
                      {title ? `${file.name} in ${location}` : location}
                      {status && ` · ${status}`}
                    </span>
                  </>
                ) : (
                  <>
                    <div
                      className="text-sm font-medium text-text-primary break-words"
                      title={file.name}
                    >
                      {file.name}
                    </div>
                    <div className="text-xs text-text-muted break-words mt-0.5">
                      {location} · {status ?? timeAgo(file.openedAt)}
                    </div>
                  </>
                )}
              </button>
            </div>
            {isUnavailable && onRetry && (
              <button
                type="button"
                onClick={(event) => {
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
                  onRetry();
                }}
                disabled={isOpening || recovery.retryDisabled}
                className="text-xs text-accent-text hover:underline disabled:opacity-50 disabled:pointer-events-none"
                aria-label={`Retry opening ${file.name}`}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                focusAfterRemoval(
                  e.currentTarget.parentElement,
                  containerRef.current,
                );
                onRemove(file.path);
              }}
              aria-label={`Remove ${file.name} from recent files`}
              disabled={isOpening}
              className={`shrink-0 p-1.5 rounded ${isUnavailable ? "" : `opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ${
                welcome ? "absolute top-3 right-1.5 group-focus-within:opacity-100" : ""}`} hover:bg-bg-primary text-text-muted hover:text-text-primary transition-all duration-120`}
              title="Remove from recent"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
