import { READER_PANEL_WIDTHS } from "../lib/reader-panels";
import { memo } from "react";
import type { BacklinkItem, MentionItem, RecentFile, WorkspaceState } from "../types";
import { RecentFiles } from "./RecentFiles";
import { WorkspacePanel } from "./WorkspacePanel";
import type { WelcomeRecovery } from "../lib/welcome-recovery";

interface SidebarProps {
  visible: boolean;
  recentFiles: RecentFile[];
  recentHistoryUnavailable?: boolean;
  currentFilePath: string | null;
  openingPath: string | null;
  recovery?: WelcomeRecovery | null;
  onRetry?: () => void;
  workspaceRootPath: string | null;
  workspaceState: WorkspaceState;
  backlinks: BacklinkItem[];
  mentions: MentionItem[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onChooseWorkspaceRoot: () => void;
  onClearWorkspaceRoot: () => void;
  onReindexWorkspace: () => void;
  onOpenWorkspacePath: (path: string) => void;
  onOpenCommandPalette: () => void;
}

function SidebarComponent({
  visible,
  recentFiles,
  recentHistoryUnavailable = false,
  currentFilePath,
  openingPath,
  recovery,
  onRetry,
  workspaceRootPath,
  workspaceState,
  backlinks,
  mentions,
  onOpenRecent,
  onRemoveRecent,
  onChooseWorkspaceRoot,
  onClearWorkspaceRoot,
  onReindexWorkspace,
  onOpenWorkspacePath,
  onOpenCommandPalette,
}: SidebarProps) {
  if (!visible) return null;

  return (
    <aside
      className="print-hide shrink-0 bg-bg-secondary border-r border-border overflow-y-auto flex flex-col"
      data-reader-panel="sidebar"
      style={{ width: READER_PANEL_WIDTHS.sidebar, animation: "sidebarIn 250ms cubic-bezier(0.2, 0, 0, 1)" }}
    >
      <WorkspacePanel
        rootPath={workspaceRootPath}
        state={workspaceState}
        backlinks={backlinks}
        mentions={mentions}
        onChooseRoot={onChooseWorkspaceRoot}
        onClearRoot={onClearWorkspaceRoot}
        onReindex={onReindexWorkspace}
        onOpenPath={onOpenWorkspacePath}
        onOpenPalette={onOpenCommandPalette}
      />
      <div className="px-4 py-3 pb-2">
        <h2 className="ui-section-label">Recent files</h2>
      </div>
      <RecentFiles
        files={recentFiles}
        unavailable={recentHistoryUnavailable}
        currentFilePath={currentFilePath}
        openingPath={openingPath}
        onOpen={onOpenRecent}
        onRemove={onRemoveRecent}
        recovery={recovery}
        onRetry={onRetry}
      />
    </aside>
  );
}

export const Sidebar = memo(SidebarComponent);
