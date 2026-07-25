interface SaveWhisperProps {
  dirty: boolean;
  saved: boolean;
  warning: string | null;
}

export function SaveWhisper({ dirty, saved, warning }: SaveWhisperProps) {
  if (warning) {
    return (
      <span
        role="status"
        aria-label={`Save warning: ${warning}`}
        title={warning}
        className="text-amber-500 text-sm font-semibold shrink-0"
      >!</span>
    );
  }

  if (dirty) {
    return (
      <span className="text-accent text-sm shrink-0" aria-label="Unsaved changes">
        ●
      </span>
    );
  }

  if (saved) {
    return (
      <span
        role="status"
        aria-label="Saved"
        className="save-whisper-saved text-accent text-sm shrink-0"
      >✓</span>
    );
  }

  return null;
}
