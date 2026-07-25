import { memo, useEffect, useRef } from "react";
import type { WorkspaceSearchHit, WorkspaceStatus } from "../types";

interface CommandPaletteProps {
  visible: boolean;
  query: string;
  results: WorkspaceSearchHit[];
  selectedIndex: number;
  status: WorkspaceStatus;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onOpenHit: (hit: WorkspaceSearchHit) => void;
  onHoverIndex: (index: number) => void;
}

function CommandPaletteComponent({
  visible,
  query,
  results,
  selectedIndex,
  status,
  onQueryChange,
  onClose,
  onOpenHit,
  onHoverIndex,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={backdropRef}
      className="command-palette-backdrop print-hide fixed inset-0 z-50 flex items-start justify-center"
      style={{
        background: "color-mix(in srgb, var(--bg-primary) 84%, transparent)",
        backdropFilter: "blur(5px)",
      }}
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="command-palette-shell mt-[12vh] w-full max-w-[720px] mx-4 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <span className="ui-chip-label">Quick switcher</span>
            <span className="ui-subsection-label text-[11px]">
              {status === "indexing"
                ? "Indexing in progress"
                : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="command-palette-input-wrap">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search files, headings, and content..."
              className="w-full bg-transparent text-text-primary text-sm outline-none placeholder:text-text-muted"
              aria-label="Workspace quick switcher"
            />
          </div>
          <div className="mt-2 text-[11px] text-text-muted flex items-center justify-between gap-3">
            <span>
              {status === "indexing"
                ? "Results improve as indexing progresses."
                : "Arrow keys to navigate."}
            </span>
            <span className="hidden sm:inline">Enter opens. Esc closes.</span>
          </div>
        </div>

        <ul className="max-h-[50vh] overflow-y-auto">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-sm text-text-muted">
              {query.trim() ? "No matches for this query." : "Type to search your workspace."}
            </li>
          ) : (
            results.map((hit, idx) => {
              const selected = idx === selectedIndex;
              return (
                <li key={`${hit.path}:${hit.kind}:${hit.headingId ?? "none"}:${idx}`}>
                  <button
                    type="button"
                    onMouseEnter={() => onHoverIndex(idx)}
                    onClick={() => onOpenHit(hit)}
                    className={`w-full text-left px-4 py-2.5 border-b border-border/50 transition-colors ${
                      selected
                        ? "bg-bg-tertiary border-l-2 border-l-accent pl-[14px]"
                        : "hover:bg-bg-tertiary/60 border-l-2 border-l-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="ui-chip-label">{kindLabel(hit.kind)}</span>
                      <span className="text-sm text-text-primary truncate">{hit.relPath}</span>
                    </div>
                    {hit.snippet && (
                      <p className="mt-1 text-xs text-text-secondary line-clamp-2">
                        {hit.snippet}
                      </p>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}

export const CommandPalette = memo(CommandPaletteComponent);

function kindLabel(kind: WorkspaceSearchHit["kind"]): string {
  if (kind === "title") return "File";
  if (kind === "heading") return "Heading";
  return "Content";
}
