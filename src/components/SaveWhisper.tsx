import { useEffect, useState } from "react";

interface SaveWhisperProps {
  isDraft?: boolean;
  saving?: boolean;
  dirty: boolean;
  saved: boolean;
  warning: string | null;
}

export function SaveWhisper({ isDraft = false, dirty, saved, warning, saving = false }: SaveWhisperProps) {
  const [saveProgress, setSaveProgress] = useState<"quiet" | "saving" | "slow">("quiet");
  useEffect(() => {
    setSaveProgress("quiet");
    if (!saving) return;
    // Fast autosaves stay quiet; these timers only describe the pending write.
    const savingTimer = setTimeout(() => setSaveProgress("saving"), 2_000);
    const slowTimer = setTimeout(() => setSaveProgress("slow"), 30_000);
    return () => { clearTimeout(savingTimer); clearTimeout(slowTimer); };
  }, [saving]);

  if (saving && saveProgress === "slow") {
    warning = "Still saving. Your text is safe in this window.";
  }
  if (warning) {
    return (
      <span
        role="status"
        aria-label={`Save warning: ${warning}`}
        title={warning}
        className="text-warning text-xs font-medium truncate shrink-0 max-w-[180px]"
      >{warning}</span>
    );
  }

  if (saving && saveProgress === "saving") {
    return <span role="status" aria-label="Saving…" className="text-accent-text text-xs whitespace-nowrap shrink-0">Saving…</span>;
  }

  if (isDraft) {
    return (
      <span
        aria-label="Not saved yet"
        title="Save to choose a filename and location."
        className="text-text-muted text-xs whitespace-nowrap shrink-0"
      >Not saved yet</span>
    );
  }

  if (dirty) {
    return (
      <span className="text-accent-text text-xs whitespace-nowrap shrink-0" aria-label="Unsaved changes">
        Unsaved changes
      </span>
    );
  }

  if (saved) {
    return (
      <span
        role="status"
        aria-label="Saved"
        className="save-whisper-saved text-accent-text text-xs whitespace-nowrap shrink-0"
      >Saved</span>
    );
  }

  return null;
}
