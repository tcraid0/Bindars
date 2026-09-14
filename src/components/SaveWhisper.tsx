interface SaveWhisperProps {
  isDraft?: boolean;
  dirty: boolean;
  saved: boolean;
  warning: string | null;
}

export function SaveWhisper({ isDraft = false, dirty, saved, warning }: SaveWhisperProps) {
  if (warning) {
    return (
      <span
        role="status"
        aria-label={`Save warning: ${warning}`}
        title={warning}
        className="text-amber-500 text-xs font-medium truncate shrink-0 max-w-[180px]"
      >{warning}</span>
    );
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
      <span className="text-accent text-xs whitespace-nowrap shrink-0" aria-label="Unsaved changes">
        Unsaved changes
      </span>
    );
  }

  if (saved) {
    return (
      <span
        role="status"
        aria-label="Saved"
        className="save-whisper-saved text-accent text-xs whitespace-nowrap shrink-0"
      >Saved</span>
    );
  }

  return null;
}
