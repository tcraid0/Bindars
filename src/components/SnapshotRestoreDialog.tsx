import { memo, useCallback, useRef } from "react";
import type { KeyboardEvent } from "react";
import { DialogFrame } from "./DialogFrame";

export interface SnapshotRestoreChoice {
  id: string;
  title: string;
  detail: string;
}

interface SnapshotRestoreDialogProps {
  visible: boolean;
  title: string;
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  choices: SnapshotRestoreChoice[];
  restoringId: string | null;
  onRestore: (id: string) => void;
  onDismiss: () => void;
}

function SnapshotRestoreDialogComponent({
  visible,
  title,
  loading,
  error,
  emptyMessage,
  choices,
  restoringId,
  onRestore,
  onDismiss,
}: SnapshotRestoreDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // A native button fires its click on Enter *keydown*, so restoring — which
  // mounts and focuses the editor — would happen while Enter is still held. If
  // the key auto-repeats, those repeats leak into the freshly focused editor as
  // leading blank lines that then autosave. Suppress the keydown activation and
  // restore on keyup instead, matching Space, so the key is released before the
  // editor mounts. (Space already activates on keyup and is left untouched.)
  const handleRestoreKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter") event.preventDefault();
  }, []);

  const handleRestoreKeyUp = useCallback(
    (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (restoringId === null) onRestore(id);
    },
    [onRestore, restoringId],
  );

  return (
    <DialogFrame
      visible={visible}
      title={title}
      initialFocusRef={closeRef}
      onDismiss={onDismiss}
      dismissible={restoringId === null}
      maxWidthClassName="max-w-[480px]"
    >
      <p className="text-sm text-text-secondary mb-4">
        Restoring replaces the editor buffer and cannot be undone there. Bindars snapshots the current state first.
      </p>

      {loading ? (
        <p role="status" className="text-sm text-text-muted py-4">Loading snapshots…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-400 py-4">{error}</p>
      ) : choices.length === 0 ? (
        <p className="text-sm text-text-muted py-4">{emptyMessage}</p>
      ) : (
        <ul className="max-h-[320px] overflow-y-auto space-y-1 mb-4">
          {choices.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                disabled={restoringId !== null}
                onClick={() => onRestore(choice.id)}
                onKeyDown={handleRestoreKeyDown}
                onKeyUp={handleRestoreKeyUp(choice.id)}
                className="w-full text-left px-3 py-2 rounded-md hover:bg-bg-tertiary transition-colors duration-120 disabled:opacity-50"
              >
                <span className="block text-sm text-text-primary">{choice.title}</span>
                <span className="block text-xs text-text-muted mt-0.5">
                  {restoringId === choice.id ? "Restoring…" : choice.detail}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button
          ref={closeRef}
          type="button"
          disabled={restoringId !== null}
          onClick={onDismiss}
          className="px-3 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary transition-colors duration-120 disabled:opacity-50"
        >
          Close
        </button>
      </div>
    </DialogFrame>
  );
}

export const SnapshotRestoreDialog = memo(SnapshotRestoreDialogComponent);
