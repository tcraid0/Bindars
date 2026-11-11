import type { ButtonHTMLAttributes } from "react";
import { formatShortcutLabel } from "../lib/shortcut-labels";

interface MarkdownFormattingToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}

export function MarkdownFormattingToggle({
  enabled,
  onToggle,
  className = "",
  ...buttonProps
}: MarkdownFormattingToggleProps) {
  return (
    <button
      {...buttonProps}
      type="button"
      onClick={onToggle}
      aria-label="Toggle markup formatting"
      aria-pressed={enabled}
      className={`px-2 py-1 rounded-md border font-ui text-[11px] leading-none transition-colors duration-120 shrink-0 ${
        enabled
          ? "border-accent/40 bg-accent/10 text-accent-text"
          : "border-border text-text-muted hover:bg-bg-tertiary hover:text-text-secondary"
      } ${className}`.trim()}
      title={`Use ${enabled ? "plain" : "formatted"} Markdown (${formatShortcutLabel("toggleMarkdownFormatting")})`}
    >
      {enabled ? "Styled" : "Plain"}
    </button>
  );
}
