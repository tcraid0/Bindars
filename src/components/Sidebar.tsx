import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  RecentFile,
  WorkspaceDocIndex,
  WorkspaceState,
} from "../types";
import { RecentFiles, type RecentDetails } from "./RecentFiles";
import { DocumentList } from "./DocumentList";
import { FolderContext } from "./FolderContext";
import { fileName, toPosixPath } from "../lib/paths";
import { PathDetails } from "./PathDetails";
import { READER_PANEL_WIDTHS } from "../lib/reader-panels";
import { detectShortcutPlatform } from "../lib/shortcut-labels";
import type { WelcomeRecovery } from "../lib/welcome-recovery";
import { RecentRemovalNotice, type RecentRemovalRecovery } from "./RecentRemovalNotice";

interface SidebarProps {
  visible: boolean;
  recentFiles: RecentFile[];
  recentDetails?: RecentDetails;
  recentRemoval?: RecentRemovalRecovery | null;
  announceRecentRemoval?: boolean;
  recentHistoryUnavailable?: boolean;
  currentFilePath: string | null;
  openingPath: string | null;
  recovery?: WelcomeRecovery | null;
  onRetry?: () => void;
  workspaceRootPath: string | null;
  workspaceState: WorkspaceState;
  docs?: WorkspaceDocIndex[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onChooseWorkspaceRoot: () => Promise<string | null>;
  onClearWorkspaceRoot: () => void;
  onRestoreFolder?: (path: string) => void;
  onReindexWorkspace: () => void;
  onShowDrafts: () => void;
  onOpenWorkspacePath: (path: string) => void;
  onOpenCommandPalette: () => void;
  onFindNotes?: (path: string) => void;
}
const views = ["Recent", "Drafts", "Folders"] as const;
function SidebarComponent(props: SidebarProps) {
  const {
    visible,
    workspaceRootPath: root,
    workspaceState: state,
    docs = [],
    onOpenWorkspacePath: onOpen,
  } = props;
  const [view, setView] = useState<(typeof views)[number]>("Recent");
  const [directory, setDirectory] = useState("");
  const [removed, setRemoved] = useState<string | null>(null);
  const [folderLimit, setFolderLimit] = useState(100);
  const panelRef = useRef<HTMLDivElement>(null);
  const foldersTabRef = useRef<HTMLButtonElement>(null);
  const directoryFocusPending = useRef(false);
  const isMac = detectShortcutPlatform() === "macos";
  useEffect(() => {
    setDirectory("");
    if (root) setRemoved(null);
  }, [root]);
  useEffect(() => {
    setFolderLimit(100);
  }, [directory]);
  useLayoutEffect(() => {
    if (!directoryFocusPending.current) return;
    directoryFocusPending.current = false;
    panelRef.current?.focus();
  }, [directory]);
  if (!visible) return null;
  const folderDocs = docs.filter((doc) => doc.sources?.includes("folder"));
  const drafts = docs.filter((doc) => doc.sources?.includes("draft"));
  const draftsLocation = state.draftsRootPath;
  const normalizedDir = toPosixPath(directory);
  const prefix = normalizedDir ? `${normalizedDir}/` : "";
  const subfolders = (state.directories ?? [])
    .map(toPosixPath)
    .filter(
      (path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
    );
  const files = folderDocs.filter((doc) => {
    const rel = toPosixPath(doc.relPath);
    return rel.startsWith(prefix) && !rel.slice(prefix.length).includes("/");
  });
  const moveDirectory = (path: string) => {
    directoryFocusPending.current = true;
    setDirectory(path);
  };
  const chooseFolder = async () => {
    const opener = document.activeElement;
    const selected = await props.onChooseWorkspaceRoot();
    const tab = foldersTabRef.current;
    // Add Folder and the keyed options trigger can disappear on success.
    // The selected tab survives; cancellation keeps focus on the opener.
    if (selected && tab?.isConnected && tab.getAttribute("aria-selected") === "true"
      && (document.activeElement === opener || document.activeElement === document.body)) {
      tab.focus();
    }
  };
  return (
    <aside
      className="document-sidebar print-hide"
      data-reader-panel="sidebar"
      aria-label="Document navigation"
      style={{ width: READER_PANEL_WIDTHS.sidebar }}
    >
      <div className="navigation-layout">
        <div className="navigation-header">
          <div
            role="tablist"
            aria-label="Document locations"
            className="navigation-tabs"
          >
            {views.map((name, index) => (
              <button
                key={name}
                ref={name === "Folders" ? foldersTabRef : undefined}
                id={`navigation-tab-${name}`}
                role="tab"
                aria-selected={view === name}
                aria-controls="navigation-view"
                tabIndex={view === name ? 0 : -1}
                onClick={() => setView(name)}
                onKeyDown={(event) => {
                  // Modified keys belong to app shortcuts such as Alt+Home and Alt+←.
                  if (event.altKey || event.ctrlKey || event.metaKey) return;
                  const target =
                    event.key === "ArrowRight"
                      ? (index + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (index + 2) % 3
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? 2
                            : -1;
                  if (target < 0) return;
                  event.preventDefault();
                  setView(views[target]);
                  document
                    .getElementById(`navigation-tab-${views[target]}`)
                    ?.focus();
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <button
            className="navigation-search"
            onClick={props.onOpenCommandPalette}
          >
            Search documents…
          </button>
          {view === "Folders" && root && (
            <FolderContext key={root} root={root} directory={directory}
              onNavigate={moveDirectory} onChoose={chooseFolder}
              onRemove={() => {
                // The options and their trigger disappear; the selected tab survives.
                foldersTabRef.current?.focus();
                setRemoved(root);
                props.onClearWorkspaceRoot();
              }} />
          )}
          {view === "Recent" && (
            <RecentRemovalNotice recovery={props.recentRemoval} announce={props.announceRecentRemoval}
              onLeave={() => panelRef.current?.focus({ preventScroll: true })} />
          )}
        </div>
        <div className="navigation-scroll">
          <div
            id="navigation-view"
            ref={panelRef}
            tabIndex={0}
            role="tabpanel"
            aria-labelledby={`navigation-tab-${view}`}
            aria-describedby={view === "Folders" && root
              ? directory ? "navigation-folder-breadcrumbs" : "navigation-folder-name"
              : undefined}
          >
            {view === "Recent" && (
              <>
                <RecentFiles
                  files={props.recentFiles}
                  details={props.recentDetails}
                  unavailable={props.recentHistoryUnavailable}
                  currentFilePath={props.currentFilePath}
                  openingPath={props.openingPath}
                  onOpen={props.onOpenRecent}
                  onRemove={props.onRemoveRecent}
                  recovery={props.recovery}
                  onRetry={props.onRetry}
                />
                {docs
                  .filter(
                    (doc) =>
                      doc.sources?.includes("recent") && doc.coverage === "missing",
                  )
                  .map((doc) => (
                    <div className="navigation-help" key={doc.path}>
                      <p>Can't find {doc.name}.</p>
                      <button onClick={() => props.onFindNotes?.(doc.path)}>
                        Reconnect notes…
                      </button>
                    </div>
                  ))}
              </>
            )}
            {view === "Drafts" && (
              <>
                <p className="navigation-help">
                  New documents are saved here until you save them somewhere else.
                </p>
                {draftsLocation && <div className="navigation-help">
                  <PathDetails path={draftsLocation} label="Bindars Drafts location" />
                </div>}
                {state.draftsError && (
                  <p role="status" className="navigation-help">
                    {state.draftsError}{" "}
                    {isMac &&
                      "Allow access in System Settings › Privacy & Security › Files and Folders. "}
                    <button onClick={props.onReindexWorkspace}>Retry</button>
                  </p>
                )}
                {!drafts.length && !state.draftsError && state.draftsSkipped && (
                  <div className="navigation-help">
                    <button onClick={props.onShowDrafts}>Show existing drafts</button>
                  </div>
                )}
                {!drafts.length && !state.draftsError && !state.draftsSkipped && (
                  <p className="navigation-help">
                    {state.status === "indexing"
                      ? "Looking for drafts…"
                      : "No drafts yet."}
                  </p>
                )}
                <DocumentList
                  docs={drafts}
                  drafts
                  currentPath={props.currentFilePath}
                  onOpen={onOpen}
                  onRetry={props.onReindexWorkspace}
                  onFindNotes={props.onFindNotes}
                />
              </>
            )}
            {view === "Folders" && (
              <>
                {!root && (
                  <p className="navigation-help">
                    Add a folder to browse the documents in it. Nothing is moved or copied.
                  </p>
                )}
                {!root && <button
                  className="navigation-action"
                  onClick={chooseFolder}
                >
                  Add Folder…
                </button>}
                {removed && (
                  <div role="status" className="navigation-help">
                    Removed ‘{fileName(removed)}’ from the sidebar. Its files and
                    your notes are unchanged.{" "}
                    <button
                      onClick={() => {
                        foldersTabRef.current?.focus();
                        props.onRestoreFolder?.(removed);
                        setRemoved(null);
                      }}
                    >
                      Add Back
                    </button>
                  </div>
                )}
                {root && (
                  <>
                    {state.error && (
                      <p role="status" className="navigation-help">
                        {state.error}{" "}
                        <button onClick={props.onReindexWorkspace}>Retry</button>
                      </p>
                    )}
                    <ul className="document-list">
                      {subfolders.slice(0, folderLimit).map((path) => (
                        <li key={path}>
                          <button
                            className="document-open document-row"
                            onClick={() => moveDirectory(path)}
                          >
                            ▸ {fileName(path)}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {subfolders.length > folderLimit && (
                      <button
                        className="navigation-action"
                        onClick={() => setFolderLimit((n) => n + 100)}
                      >
                        More folders
                      </button>
                    )}
                    <DocumentList
                      key={directory}
                      docs={files}
                      currentPath={props.currentFilePath}
                      onOpen={onOpen}
                      onRetry={props.onReindexWorkspace}
                      onFindNotes={props.onFindNotes}
                    />
                    {!files.length && !subfolders.length && !state.error && (
                      <p className="navigation-help">
                        {state.status === "indexing"
                          ? "Looking for documents…"
                          : "No supported documents in this folder."}
                      </p>
                    )}
                  </>
                )}
                <details className="navigation-help">
                  <summary>What appears here</summary>
                  <p>
                    Markdown (.md, .markdown) and Fountain files. Hidden folders,
                    node_modules, target, vendor, and symbolic links are skipped.
                    Discovery stops at 5,000 documents, 100,000 entries or 32
                    levels.
                  </p>
                </details>
              </>
            )}
          </div>
          {state.limitHit && (
            <p role="status" className="navigation-help">
              Only part of this folder is listed. Choose a smaller folder to reach
              documents beyond the discovery limits.
            </p>
          )}
          {!!state.issues?.length && (
            <details className="navigation-help">
              <summary>Some locations could not be checked</summary>
              {state.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </details>
          )}
          {/* Background rechecks run on every window focus; keep them out of live regions. */}
          <p className="navigation-help">
            {state.status === "indexing"
              ? "Checking documents…"
              : state.readFailedCount + state.complexitySkippedCount > 0
                ? "Some documents have limited search coverage. Their names remain searchable."
                : ""}
          </p>
        </div>
      </div>
    </aside>
  );
}
export const Sidebar = memo(SidebarComponent);
