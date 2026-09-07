import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DialogFrame } from "./DialogFrame";
import type { FileAnnotations } from "../types";

interface Props {
  paths: string[] | null;
  waiting: boolean;
  onKeepOpen: () => void;
  onRetry: () => void;
  onQuit: () => void;
  pendingRecords: () => Record<string, FileAnnotations>;
}
export function AnnotationExitDialog({ paths, waiting, onKeepOpen, onRetry, onQuit, pendingRecords }: Props) {
  const keepOpen = useRef<HTMLButtonElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function recover() {
    if (exporting) return;
    setExporting(true);
    setMessage(null);
    const documents = pendingRecords();
    try {
      const path = await save({ defaultPath: "annotation-recovery.json", filters: [{ name: "Annotation recovery", extensions: ["json"] }] });
      if (path) {
        await invoke("export_annotation_recovery", { path, documents });
        setMessage("Recovery copy saved and verified. To restore, open each original document and choose Restore recovery copy in Annotations.");
      }
    } catch {
      setMessage("Couldn't save the recovery copy. Your changes remain available while Bindars stays open.");
    } finally { setExporting(false); }
  }
  return <DialogFrame visible={paths !== null} title="Annotations haven't been saved"
    initialFocusRef={keepOpen} onDismiss={onKeepOpen} dismissible={!exporting}>
    <p className="text-sm text-text-secondary">Keep Bindars open to retain these changes, retry saving, or save a recovery copy. Quitting without a saved copy can lose changes.</p>
    <ul className="my-3 text-xs break-all">{paths?.map((path) => <li key={path}>{path}</li>)}</ul>
    {message && <p role="status" className="my-3 text-sm">{message}</p>}
    <div className="flex flex-wrap gap-3 text-sm">
      <button ref={keepOpen} disabled={exporting} onClick={onKeepOpen}>Keep open</button>
      <button disabled={waiting || exporting} onClick={onRetry}>{waiting ? "Waiting for save..." : "Retry saving"}</button>
      <button disabled={exporting || waiting} onClick={() => void recover()}>Save recovery copy</button>
      <button disabled={exporting} onClick={onQuit} className="text-red-500">Quit without saving</button>
    </div>
  </DialogFrame>;
}
