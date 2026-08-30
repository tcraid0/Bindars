import { memo } from "react";
import type { RecentFile } from "../types";
import { formatShortcutLabel } from "../lib/shortcut-labels";

interface EmptyStateProps {
  onNewFile: () => void;
  onOpenFile: () => void;
  recentFiles: RecentFile[];
  onOpenRecent: (path: string) => void;
  onRestoreDrafts: () => void;
}

function EmptyStateComponent({
  onNewFile,
  onOpenFile,
  recentFiles,
  onOpenRecent,
  onRestoreDrafts,
}: EmptyStateProps) {
  const hasRecent = recentFiles.length > 0;
  const topRecent = hasRecent ? recentFiles[0] : null;
  const recentList = recentFiles.slice(0, 5);

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 select-none">
      {/* Typographic welcome */}
      <h1
        className="font-reading text-[2.5rem] font-normal text-text-primary leading-tight tracking-tight empty-state-title"
      >
        Bindars
      </h1>
      <div className="w-12 h-px bg-border mt-3 mb-3 empty-state-subtitle" aria-hidden="true" />
      <p
        className="font-reading italic text-text-muted text-lg mb-8 empty-state-subtitle"
      >
        Read markdown beautifully
      </p>

      <div className="empty-state-content">
        {hasRecent && (
          <>
            <button
              type="button"
              onClick={() => onOpenRecent(topRecent!.path)}
              className="px-5 py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:bg-accent-hover transition-colors duration-120 shadow-sm mb-5 max-w-[320px] truncate"
            >
              Resume: {topRecent!.name}
            </button>

            {recentList.length > 1 && (
              <ul className="mb-4 space-y-1 max-w-[320px] w-full">
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

        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onNewFile}
            className="px-5 py-3 rounded-lg bg-accent text-white font-medium text-sm hover:bg-accent-hover transition-colors duration-120 shadow-sm"
          >
            New File
          </button>
          <button
            type="button"
            onClick={onOpenFile}
            className="px-5 py-3 rounded-lg border border-border text-text-secondary font-medium text-sm hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
          >
            Open File
          </button>
        </div>
        <p className="text-xs text-text-muted mt-2">
          {formatShortcutLabel("newFile")} · {formatShortcutLabel("openFile")}
        </p>
        <button
          type="button"
          onClick={onRestoreDrafts}
          className="mt-4 text-xs text-text-muted hover:text-text-primary transition-colors duration-120"
        >
          Restore an unsaved draft…
        </button>
      </div>

      <div className="text-xs text-text-muted mt-8 space-y-1.5 empty-state-content">
        <p>Drag .md, .markdown, or .fountain files here to open</p>
        <p>Press <kbd className="inline-block px-1.5 py-0.5 rounded border border-border bg-bg-tertiary font-mono text-[11px] leading-none">{formatShortcutLabel("showShortcuts")}</kbd> for keyboard shortcuts</p>
      </div>
    </div>
  );
}

export const EmptyState = memo(EmptyStateComponent);
