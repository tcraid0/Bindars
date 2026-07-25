interface MarkdownFormattingToggleProps {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}

export function MarkdownFormattingToggle({
  enabled,
  onToggle,
  className = "",
}: MarkdownFormattingToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Toggle markup formatting"
      aria-pressed={enabled}
      className={`px-2 py-1 rounded-md border font-ui text-[11px] leading-none transition-colors duration-120 shrink-0 ${
        enabled
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border text-text-muted hover:bg-bg-tertiary hover:text-text-secondary"
      } ${className}`.trim()}
      title={`Use ${enabled ? "plain" : "formatted"} Markdown (Ctrl/Cmd+Alt+M)`}
    >
      {enabled ? "Styled" : "Plain"}
    </button>
  );
}
