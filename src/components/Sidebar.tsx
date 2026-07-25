import { memo } from "react";
import type { BacklinkItem, MentionItem, RecentFile, WorkspaceState } from "../types";
import { RecentFiles } from "./RecentFiles";
import { WorkspacePanel } from "./WorkspacePanel";

interface SidebarProps {
  visible: boolean;
  recentFiles: RecentFile[];
  currentFilePath: string | null;
  openingPath: string | null;
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
  currentFilePath,
  openingPath,
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
      className="print-hide w-[260px] shrink-0 bg-bg-secondary border-r border-border overflow-y-auto flex flex-col"
      style={{ animation: "sidebarIn 250ms cubic-bezier(0.2, 0, 0, 1)" }}
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
        currentFilePath={currentFilePath}
        openingPath={openingPath}
        onOpen={onOpenRecent}
        onRemove={onRemoveRecent}
      />
    </aside>
  );
}

export const Sidebar = memo(SidebarComponent);
