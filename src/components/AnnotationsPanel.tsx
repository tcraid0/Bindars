import { memo, useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { Highlight, Bookmark, HeadingItem } from "../types";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useToast } from "./ToastProvider";
import { buildAnnotationMarkdown } from "../lib/annotation-export";

interface AnnotationsPanelProps {
  visible: boolean;
  highlights: Highlight[];
  bookmarks: Bookmark[];
  onRemoveHighlight: (id: string) => void;
  onUpdateHighlight: (id: string, updates: Partial<Pick<Highlight, "color" | "note">>) => void;
  onClickHighlight: (id: string) => void;
  onClickBookmark: (headingId: string) => void;
  onClose: () => void;
  fileName: string | null;
  headings: HeadingItem[];
}

const COLOR_DOTS: Record<string, string> = {
  yellow: "var(--highlight-yellow)",
  green: "var(--highlight-green)",
  blue: "var(--highlight-blue)",
  pink: "var(--highlight-pink)",
};

export const AnnotationsPanel = memo(function AnnotationsPanel({
  visible,
  highlights,
  bookmarks,
  onRemoveHighlight,
  onUpdateHighlight,
  onClickHighlight,
  onClickBookmark,
  onClose,
  fileName,
  headings,
}: AnnotationsPanelProps) {
  const reducedMotion = useReducedMotion();
  const { toast } = useToast();
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteBuffer, setNoteBuffer] = useState("");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelledRef = useRef(false);

  // Auto-focus textarea when editing starts
  useEffect(() => {
    if (editingNoteId && noteRef.current) {
      noteRef.current.focus();
    }
  }, [editingNoteId]);

  const startEditNote = useCallback((hl: Highlight) => {
    cancelledRef.current = false;
    setEditingNoteId(hl.id);
    setNoteBuffer(hl.note || "");
  }, []);

  const saveNote = useCallback(() => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (!editingNoteId) return;
    const trimmed = noteBuffer.trim();
    onUpdateHighlight(editingNoteId, { note: trimmed || undefined });
    setEditingNoteId(null);
    setNoteBuffer("");
  }, [editingNoteId, noteBuffer, onUpdateHighlight]);

  const cancelEditNote = useCallback(() => {
    cancelledRef.current = true;
    setEditingNoteId(null);
    setNoteBuffer("");
  }, []);

  const handleNoteKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveNote();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditNote();
      }
    },
    [saveNote, cancelEditNote],
  );

  const handleExport = useCallback(async () => {
    if (!fileName) return;
    const markdown = buildAnnotationMarkdown(fileName, highlights, bookmarks, headings);
    const baseName = fileName.replace(/\.[^.]+$/, "");
    try {
      const savePath = await save({
        defaultPath: `${baseName}-annotations.md`,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!savePath) return;
      await invoke("export_markdown_file", { path: savePath, content: markdown });
      toast("Annotations exported");
    } catch {
      toast("Export failed", "error");
    }
  }, [fileName, highlights, bookmarks, headings, toast]);

  if (!visible) return null;

  const hasContent = highlights.length > 0 || bookmarks.length > 0;

  return (
    <aside
      className="print-hide w-[280px] shrink-0 border-l border-border overflow-y-auto bg-bg-primary"
      style={reducedMotion ? undefined : { animation: "tocIn 250ms cubic-bezier(0.2, 0, 0, 1)" }}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="ui-section-label">
          Annotations
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleExport}
            disabled={!hasContent}
            aria-label="Export annotations as Markdown"
            className="p-1 rounded hover:bg-bg-tertiary text-text-muted disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close annotations"
            className="p-1 rounded hover:bg-bg-tertiary text-text-muted"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {!hasContent && (
        <p className="px-4 text-sm text-text-muted">
          No annotations yet. Select text to highlight or click the bookmark icon in the table of contents.
        </p>
      )}

      {bookmarks.length > 0 && (
        <div className="px-4 mb-4">
          <h3 className="ui-subsection-label mb-2">
            Bookmarks
          </h3>
          <ul className="space-y-1">
            {bookmarks.map((bm) => (
              <li key={bm.id}>
                <button
                  type="button"
                  onClick={() => onClickBookmark(bm.headingId)}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent shrink-0">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="truncate">{bm.headingText}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {highlights.length > 0 && (
        <div className="px-4 mb-4">
          <h3 className="ui-subsection-label mb-2">
            Highlights
          </h3>
          <ul className="space-y-1">
            {highlights.map((hl) => (
              <li key={hl.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onClickHighlight(hl.id)}
                  className="w-full text-left flex items-start gap-2 px-2 py-1.5 pr-8 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0 mt-1"
                    style={{ backgroundColor: COLOR_DOTS[hl.color] }}
                  />
                  <span className="line-clamp-2 flex-1">&ldquo;{hl.exact}&rdquo;</span>
                </button>
                <button
                  type="button"
                  aria-label="Remove highlight"
                  className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 text-text-muted hover:text-text-primary shrink-0 p-0.5 rounded transition-opacity duration-100"
                  onClick={() => onRemoveHighlight(hl.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>

                {/* Note display / edit */}
                {editingNoteId === hl.id ? (
                  <div className="px-2 pb-1.5">
                    <textarea
                      ref={noteRef}
                      value={noteBuffer}
                      onChange={(e) => setNoteBuffer(e.target.value)}
                      onBlur={saveNote}
                      onKeyDown={handleNoteKeyDown}
                      aria-label="Highlight note"
                      rows={3}
                      className="w-full text-xs bg-bg-tertiary text-text-primary border border-border rounded px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-accent"
                      placeholder="Add a note..."
                    />
                  </div>
                ) : hl.note ? (
                  <div className="px-2 pb-1.5 flex items-start gap-1">
                    <p className="text-xs text-text-muted italic line-clamp-3 flex-1 pl-4.5">{hl.note}</p>
                    <button
                      type="button"
                      aria-label="Edit note"
                      onClick={() => startEditNote(hl)}
                      className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text-primary p-0.5 rounded transition-opacity duration-100 shrink-0"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <div className="px-2 pb-1 pl-6.5">
                    <button
                      type="button"
                      onClick={() => startEditNote(hl)}
                      className="opacity-0 group-hover:opacity-100 text-xs text-accent hover:underline transition-opacity duration-100"
                    >
                      Add note
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
});
