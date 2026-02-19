import type { RecentFile } from "../types";

interface RecentFilesProps {
  files: RecentFile[];
  currentFilePath: string | null;
  openingPath: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
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
  const parts = path.split("/");
  parts.pop();
  const dir = parts.join("/");
  const home = dir.replace(/^\/home\/[^/]+/, "~");
  return home;
}

export function RecentFiles({
  files,
  currentFilePath,
  openingPath,
  onOpen,
  onRemove,
}: RecentFilesProps) {
  if (files.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-text-muted text-sm">
        No recent files
      </div>
    );
  }

  return (
    <div className="flex-1">
      {files.map((file) => {
        const isActive = file.path === currentFilePath;
        const isOpening = file.path === openingPath;
        return (
          <div
            key={file.path}
            className={`w-full text-left px-4 py-2.5 hover:bg-bg-tertiary transition-colors duration-120 group relative ${
              isActive ? "border-l-[3px] border-l-accent sidebar-active-item" : "border-l-[3px] border-l-transparent"
            }`}
          >
            <button
              type="button"
              onClick={() => onOpen(file.path)}
              className="w-full text-left"
              aria-label={`Open ${file.name}`}
              aria-busy={isOpening}
              disabled={isOpening}
            >
              <div className="text-sm font-medium text-text-primary truncate pr-6">
                {file.name}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-text-muted truncate">{dirName(file.path)}</span>
                <span className="text-xs text-text-muted shrink-0">
                  {isOpening ? "opening..." : timeAgo(file.openedAt)}
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(file.path);
              }}
              aria-label={`Remove ${file.name} from recent files`}
              disabled={isOpening}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-primary text-text-muted hover:text-text-primary transition-all duration-120"
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
