import { memo, useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { readAnnotationRecord } from "../lib/annotation-record";
import type { Highlight, Bookmark, HeadingItem } from "../types";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useToast } from "./ToastProvider";
import { buildAnnotationMarkdown } from "../lib/annotation-export";
import type { AnnotationLoadStatus } from "../lib/annotation-state";
import { focusAfterRemoval } from "../lib/focus-after-removal";
import { isImeCompositionKey } from "../lib/keyboard";

interface AnnotationsPanelProps {
  visible: boolean;
  filePath?: string | null;
  onRestoreRecord?: (record: unknown) => void;
  saving?: boolean;
  mutationsDisabled?: boolean;
  dataWarning?: string | null;
  locations?: Record<string, string>;
  onRemoveBookmark?: (id: string) => void;
  flushNoteRef?: React.RefObject<(() => void) | null>;
  annotationStatus: AnnotationLoadStatus;
  annotationsReady: boolean;
  loadError: string | null;
  saveError: string | null;
  canRetrySave: boolean;
  highlights: Highlight[];
  bookmarks: Bookmark[];
  onRetryLoad: () => void;
  onRetrySave: () => void;
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
  saving, mutationsDisabled, dataWarning, locations, onRemoveBookmark, flushNoteRef, filePath, onRestoreRecord,
  annotationStatus,
  annotationsReady,
  loadError,
  saveError,
  canRetrySave,
  highlights,
  bookmarks,
  onRetryLoad,
  onRetrySave,
  onRemoveHighlight,
  onUpdateHighlight,
  onClickHighlight,
  onClickBookmark,
  onClose,
  fileName,
  headings,
}: AnnotationsPanelProps) {
  const [recoveryRecord, setRecoveryRecord] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reducedMotion = useReducedMotion();
  const { toast } = useToast();
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteBuffer, setNoteBuffer] = useState("");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const draft = useRef<{ id: string; text: string; commit: AnnotationsPanelProps["onUpdateHighlight"] } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreNoteFocusRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const id = restoreNoteFocusRef.current;
    if (editingNoteId || !id) return;
    restoreNoteFocusRef.current = null;
    const action = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-note-action]") ?? [])
      .find((button) => button.dataset.noteAction === id);
    (action ?? closeRef.current)?.focus();
  }, [editingNoteId]);

  // Auto-focus textarea when editing starts
  useEffect(() => {
    if (editingNoteId && noteRef.current) {
      noteRef.current.focus();
    }
  }, [editingNoteId]);

  const startEditNote = useCallback((hl: Highlight) => {
    draft.current = { id: hl.id, text: hl.note || "", commit: onUpdateHighlight };
    setEditingNoteId(hl.id);
    setNoteBuffer(hl.note || "");
  }, [onUpdateHighlight]);

  const saveNote = useCallback(() => {
    const current = draft.current;
    draft.current = null;
    if (!current) return;
    current.commit(current.id, { note: current.text.trim() || undefined });
    setEditingNoteId(null);
    setNoteBuffer("");
  }, []);

  const cancelEditNote = useCallback(() => {
    draft.current = null;
    setEditingNoteId(null);
    setNoteBuffer("");
  }, []);

  useLayoutEffect(() => {
    if (flushNoteRef) flushNoteRef.current = saveNote;
    return () => { if (flushNoteRef?.current === saveNote) flushNoteRef.current = null; };
  }, [flushNoteRef, saveNote]);
  useEffect(() => { if (!visible) saveNote(); }, [visible, saveNote]);
  useEffect(() => () => {
    // The captured callback belongs to the document where editing began.
    const current = draft.current;
    draft.current = null;
    if (current) current.commit(current.id, { note: current.text.trim() || undefined });
  }, []);

  const handleNoteKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeCompositionKey(e.nativeEvent)) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        restoreNoteFocusRef.current = editingNoteId;
        saveNote();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        restoreNoteFocusRef.current = editingNoteId;
        cancelEditNote();
      }
    },
    [saveNote, cancelEditNote, editingNoteId],
  );

  const restoreRecovery = async () => {
    if (!filePath || !onRestoreRecord) return;
    try {
      const path = await open({ multiple: false, filters: [{ name: "Annotation recovery", extensions: ["json"] }] });
      if (!path || typeof path !== "string") return;
      const recovery = await invoke<{ documents: Record<string, unknown> }>("read_annotation_recovery", { path });
      if (!alive.current) return;
      const record = recovery.documents[filePath];
      if (!record) { toast("This recovery copy has no annotations for this document path.", "error"); return; }
      readAnnotationRecord(record);
      saveNote();
      setRecoveryRecord(record);
    } catch { if (alive.current) toast("Couldn't read annotation recovery data. Existing annotations were not changed.", "error"); }
  };

  const handleExport = useCallback(async () => {
    if (!fileName || exportBusy.current) return;
    exportBusy.current = true;
    setExporting(true);
    const currentDraft = draft.current;
    const exportHighlights = currentDraft ? highlights.map((hl) => hl.id === currentDraft.id
      ? { ...hl, note: currentDraft.text.trim() || undefined } : hl) : highlights;
    saveNote();
    const markdown = buildAnnotationMarkdown(fileName, exportHighlights, bookmarks, headings);
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
    } finally {
      exportBusy.current = false;
      if (alive.current) setExporting(false);
    }
  }, [fileName, highlights, bookmarks, headings, toast, saveNote]);

  if (!visible) return null;

  const hasContent = highlights.length > 0 || bookmarks.length > 0;

  return (
    <aside
      ref={panelRef}
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
            disabled={!hasContent || exporting}
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
            ref={closeRef}
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

      {filePath && onRestoreRecord && <button type="button" disabled={!annotationsReady || mutationsDisabled}
        className="mx-4 mb-3 text-xs text-accent underline" onClick={() => void restoreRecovery()}>Restore recovery copy</button>}
      <ConfirmDialog visible={recoveryRecord !== null} title="Restore annotations?"
        message="Replace this document's current annotations with the recovery copy? The copy itself will be kept."
        confirmLabel="Restore annotations" cancelLabel="Cancel" initialFocus="cancel"
        onConfirm={() => { if (recoveryRecord) onRestoreRecord?.(recoveryRecord); setRecoveryRecord(null); }}
        onCancel={() => setRecoveryRecord(null)} onDismiss={() => setRecoveryRecord(null)} />
      {saving && <p className="px-4 pb-2 text-xs text-text-muted" role="status">Saving annotations...</p>}
      {dataWarning && <p className="px-4 pb-2 text-xs text-text-muted" role="alert">{dataWarning}</p>}
      {loadError && (
        <div className="mx-4 mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={onRetryLoad}
            className="mt-2 text-xs font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {saveError && (
        <div className="mx-4 mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
          <p>{saveError}</p>
          <button
            type="button"
            onClick={onRetrySave}
            disabled={!canRetrySave}
            className="mt-2 text-xs font-medium underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {annotationStatus === "idle" && (
        <p className="px-4 text-sm text-text-muted">
          Open a file to use annotations.
        </p>
      )}

      {annotationStatus === "loading" && !loadError && (
        <p className="px-4 text-sm text-text-muted">
          Loading annotations...
        </p>
      )}

      {annotationsReady && !hasContent && (
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
              <li key={bm.id} className="group relative pr-6">
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
                {!headings.some((heading) => heading.id === bm.headingId) && <p className="px-2 text-xs text-text-muted">Location unavailable</p>}
                {onRemoveBookmark && <button type="button" aria-label="Remove bookmark" disabled={mutationsDisabled}
                  className="absolute right-0 top-2 text-text-muted hover:text-text-primary"
                  onClick={(event) => {
                    focusAfterRemoval(event.currentTarget.parentElement, closeRef.current);
                    onRemoveBookmark(bm.id);
                  }}>×</button>}
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
                  disabled={mutationsDisabled}
                  aria-label="Remove highlight"
                  className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-text-muted hover:text-text-primary shrink-0 p-0.5 rounded transition-opacity duration-100"
                  onClick={(event) => {
                    focusAfterRemoval(event.currentTarget.parentElement, closeRef.current);
                    onRemoveHighlight(hl.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>

                {locations && locations[hl.id] !== "located" && <p className="px-2 text-xs text-text-muted">
                  {locations[hl.id] === "missing" ? "Location unavailable" : locations[hl.id] === "uncertain" ? "Location uncertain" : "Locating highlight..."}
                </p>}
                {/* Note display / edit */}
                {editingNoteId === hl.id ? (
                  <div className="px-2 pb-1.5">
                    <textarea
                      ref={noteRef}
                      disabled={mutationsDisabled}
                      value={noteBuffer}
                      onChange={(e) => {
                        if (draft.current) draft.current.text = e.target.value;
                        setNoteBuffer(e.target.value);
                      }}
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
                      disabled={mutationsDisabled}
                      aria-label="Edit note"
                      data-note-action={hl.id}
                      onClick={() => startEditNote(hl)}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-text-muted hover:text-text-primary p-0.5 rounded transition-opacity duration-100 shrink-0"
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
                      disabled={mutationsDisabled}
                      onClick={() => startEditNote(hl)}
                      data-note-action={hl.id}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-xs text-accent hover:underline transition-opacity duration-100"
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
