import type { BacklinkItem, MentionItem, WorkspaceState } from "../types";
import { DOCUMENT_COMPLEXITY_REASON } from "../lib/document-complexity";
import { formatShortcutLabel } from "../lib/shortcut-labels";

interface WorkspacePanelProps {
  rootPath: string | null;
  state: WorkspaceState;
  backlinks: BacklinkItem[];
  mentions: MentionItem[];
  onChooseRoot: () => void;
  onClearRoot: () => void;
  onReindex: () => void;
  onOpenPath: (path: string) => void;
  onOpenPalette: () => void;
}

export function WorkspacePanel({
  rootPath,
  state,
  backlinks,
  mentions,
  onChooseRoot,
  onClearRoot,
  onReindex,
  onOpenPath,
  onOpenPalette,
}: WorkspacePanelProps) {
  const hasWorkspace = Boolean(rootPath);
  const showingInsights = backlinks.length > 0 || mentions.length > 0;
  const showingLastKnownIndex = state.status === "error" && state.indexedAt !== null;

  return (
    <section className="workspace-panel px-4 py-3 border-b border-border bg-bg-secondary/70">
      <div className="flex items-center justify-between gap-2">
        <h2 className="ui-section-label">Workspace</h2>
        <button
          type="button"
          onClick={onOpenPalette}
          className="workspace-link-btn text-xs text-text-muted hover:text-text-primary px-1.5 py-1 rounded hover:bg-bg-tertiary transition-colors"
          title={`Quick switcher (${formatShortcutLabel("workspaceSwitcher")})`}
        >
          Search
        </button>
      </div>

      <div className="mt-2 text-xs text-text-secondary">
        {hasWorkspace && rootPath ? (
          <p className="workspace-path truncate" title={rootPath}>{rootPath}</p>
        ) : (
          <p>Choose a folder to index markdown files for quick navigation and links.</p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onChooseRoot}
          className="workspace-pill-btn"
        >
          {hasWorkspace ? "Change folder" : "Choose folder"}
        </button>
        {hasWorkspace && (
          <>
            <button
              type="button"
              onClick={onReindex}
              disabled={state.status === "indexing"}
              className="workspace-pill-btn disabled:cursor-default disabled:opacity-50"
            >
              {state.status === "indexing" ? "Indexing…" : "Reindex"}
            </button>
            <button
              type="button"
              onClick={onClearRoot}
              className="workspace-pill-btn"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {hasWorkspace && (
        <p className="mt-2 workspace-status text-[11px] text-text-muted">
          {formatStatus(state)}
        </p>
      )}

      {hasWorkspace && hasDiagnostics(state) && (
        <p className="mt-1 text-[11px] text-text-muted">
          {formatDiagnostics(state)}
        </p>
      )}

      {state.error && (
        <p className="mt-1 text-[11px] text-red-500 line-clamp-2" title={state.error}>
          {state.error}
        </p>
      )}

      {showingLastKnownIndex && (
        <p className="mt-1 text-[11px] text-text-muted">
          Showing last-known workspace insights.
        </p>
      )}

      {showingInsights && (
        <div className="mt-3 space-y-2">
          {backlinks.length > 0 && (
            <div>
              <h3 className="ui-subsection-label">Referenced by ({backlinks.length})</h3>
              <ul className="mt-1 space-y-1">
                {backlinks.slice(0, 5).map((item) => (
                  <li key={item.fromPath}>
                    <button
                      type="button"
                      onClick={() => onOpenPath(item.fromPath)}
                      className="w-full text-left px-2 py-1 rounded text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                      title={item.relPath}
                    >
                      <span className="block truncate">{item.relPath}</span>
                      <span className="block text-[11px] text-text-muted truncate">{item.context}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mentions.length > 0 && (
            <div>
              <h3 className="ui-subsection-label">Unlinked mentions ({mentions.length})</h3>
              <ul className="mt-1 space-y-1">
                {mentions.slice(0, 5).map((item) => (
                  <li key={item.path}>
                    <button
                      type="button"
                      onClick={() => onOpenPath(item.path)}
                      className="w-full text-left px-2 py-1 rounded text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                      title={item.relPath}
                    >
                      <span className="block truncate">{item.relPath}</span>
                      <span className="block text-[11px] text-text-muted truncate">{item.context}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function formatStatus(state: WorkspaceState): string {
  switch (state.status) {
    case "idle":
      return "Idle";
    case "indexing":
      return `Indexing ${state.processedCount}/${state.fileCount} files...`;
    case "ready":
      if (state.limitHit) {
        return `${state.fileCount} files indexed (limit reached)`;
      }
      if (state.indexedCount !== state.fileCount) {
        return `${state.indexedCount}/${state.fileCount} files indexed`;
      }
      return `${state.fileCount} files indexed`;
    case "error":
      if (state.indexedAt !== null) {
        return "Indexing failed; last successful index is still shown";
      }
      return "Indexing failed";
    default:
      return "Idle";
  }
}

function hasDiagnostics(state: WorkspaceState): boolean {
  return state.listSkippedCount > 0
    || state.readFailedCount > 0
    || state.complexitySkippedCount > 0;
}

function formatDiagnostics(state: WorkspaceState): string {
  const parts: string[] = [];
  if (state.listSkippedCount > 0) {
    parts.push(`${state.listSkippedCount} entries skipped`);
  }
  if (state.readFailedCount > 0) {
    parts.push(`${state.readFailedCount} files failed to read`);
  }
  if (state.complexitySkippedCount > 0) {
    const fileLabel = state.complexitySkippedCount === 1 ? "file was" : "files were";
    parts.push(
      `${state.complexitySkippedCount} ${fileLabel} ${DOCUMENT_COMPLEXITY_REASON} to index safely`,
    );
  }
  return parts.join(" | ");
}
