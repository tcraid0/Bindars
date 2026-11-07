import type { RecentFile } from "../types";

export interface RecentRemovalRecovery {
  file: RecentFile;
  restore: () => void;
  dismiss: () => void;
}

/** Both Recent surfaces share one pending record owned by the history hook. */
export function RecentRemovalNotice({ recovery, onLeave, announce = true }: {
  recovery?: RecentRemovalRecovery | null;
  onLeave: () => void;
  announce?: boolean;
}) {
  if (!recovery) return null;
  return (
    <div className="navigation-help recent-removal-notice" role="status" aria-live={announce ? "polite" : "off"}>
      <p title={recovery.file.path}>Removed {recovery.file.name} from Recent.</p>
      <div className="flex gap-3">
        <button type="button" onClick={() => { onLeave(); recovery.restore(); }}>Add Back</button>
        <button type="button" onClick={() => { onLeave(); recovery.dismiss(); }}>Dismiss</button>
      </div>
    </div>
  );
}
