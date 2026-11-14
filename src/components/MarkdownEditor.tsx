import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FileType, ReaderSettings } from "../types";
import { retainedVersionNotice } from "../lib/editor-save";
import { resolveReaderSurfaceStyle } from "../lib/reader-settings";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import type { CodeMirrorEditorHandle, EditorSurfacePosition } from "./CodeMirrorEditor";
import { MarkdownFormattingToolbar } from "./MarkdownFormattingToolbar";
import type { FormattingToolbarState } from "./markdown-formatting-commands";
import type { EditorLinkForm } from "./CodeMirrorEditor";
import type { SourcePoint } from "../lib/editor-position";

export type MarkdownEditorHandle = CodeMirrorEditorHandle;
export type { EditorSurfacePosition };

interface MarkdownEditorProps {
  buffer: string;
  initialPosition?: SourcePoint | null;
  initialScreenTopPx?: number | null;
  scrollRootRef: RefObject<HTMLElement | null>;
  fileType: FileType;
  markdownFormattingEnabled: boolean;
  settings: ReaderSettings;
  saveError: string | null;
  canSaveAsAfterError: boolean;
  canDismissSaveError?: boolean;
  recoveryPath?: string | null;
  filePath?: string | null;
  onToggleMarkdownFormatting?: () => void;
  onFormattingRefusal?: (reason: string) => void;
  onBufferChange: (content: string) => boolean;
  onSaveAsAfterError: () => void;
  onDismissSaveError: () => void;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({
    buffer,
    initialPosition,
    initialScreenTopPx,
    scrollRootRef,
    fileType,
    markdownFormattingEnabled,
    settings,
    saveError,
    canSaveAsAfterError,
    canDismissSaveError = true,
    recoveryPath = null,
    filePath, onToggleMarkdownFormatting, onFormattingRefusal,
    onBufferChange,
    onSaveAsAfterError,
    onDismissSaveError,
  }, ref) {
    const editorRef = useRef<CodeMirrorEditorHandle | null>(null);
    const toolbarRef = useRef<HTMLDivElement | null>(null);
    const [adoption, setAdoption] = useState(0);
    const [state, setState] = useState<FormattingToolbarState | null>(null);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const [linkForm, setLinkForm] = useState<EditorLinkForm | null>(null);
    useLayoutEffect(() => {
      const bar = toolbarRef.current?.parentElement;
      const surface = surfaceRef.current;
      if (!bar || !surface) return;
      // CSS owns wrapping/stickiness. Only the resulting height is shared with
      // CodeMirror's separately sticky Find panel; no React layout state.
      const syncHeight = () => surface.style.setProperty("--markdown-toolbar-height", `${bar.offsetHeight}px`);
      syncHeight();
      const observer = new window.ResizeObserver(syncHeight);
      observer.observe(bar);
      return () => observer.disconnect();
    }, []);
    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      find: () => editorRef.current?.find(),
      findNext: () => editorRef.current?.findNext(),
      findPrevious: () => editorRef.current?.findPrevious(),
      flushPendingChanges: () => editorRef.current?.flushPendingChanges() ?? null,
      capturePosition: () => editorRef.current?.capturePosition() ?? null,
      captureChanges: () => editorRef.current?.captureChanges() ?? null,
      adoptExternalDocument: (captured, external) => editorRef.current?.adoptExternalDocument(captured, external) ?? false,
      executeFormatting: command => editorRef.current?.executeFormatting(command) ?? null,
      beginLink: () => editorRef.current?.beginLink(),
      applyLink: (id, input, composing) => editorRef.current?.applyLink(id, input, composing) ?? null,
      cancelLink: (id, restoreFocus) => editorRef.current?.cancelLink(id, restoreFocus),
    }), []);
    return (
      <div
        ref={surfaceRef}
        className="markdown-editor-surface"
        style={resolveReaderSurfaceStyle(settings)}
      >
        {recoveryPath && (
          <div
            role="status"
            className="font-ui mb-4 px-4 py-3 rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm flex items-start gap-3"
          >
            <span className="flex-1 min-w-0">{retainedVersionNotice(recoveryPath)}</span>
            <button
              type="button"
              onClick={onSaveAsAfterError}
              className="shrink-0 rounded px-2 py-0.5 font-medium text-danger hover:bg-danger/10"
            >
              Save As…
            </button>
          </div>
        )}
        {saveError && (
          <div
            role="alert"
            className="font-ui mb-4 px-4 py-3 rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm flex items-start gap-3"
          >
            <span className="flex-1 min-w-0">{saveError}</span>
            {canSaveAsAfterError && (
              <button
                type="button"
                onClick={onSaveAsAfterError}
                className="shrink-0 rounded px-2 py-0.5 font-medium text-danger hover:bg-danger/10"
              >
                Save As…
              </button>
            )}
            {canDismissSaveError && (
              <button
                type="button"
                onClick={onDismissSaveError}
                className="shrink-0 p-0.5 rounded hover:bg-danger/10 transition-colors duration-120"
                aria-label="Dismiss error"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}
        {fileType === "markdown" && <MarkdownFormattingToolbar editorRef={editorRef} toolbarRef={toolbarRef}
          adoption={adoption} state={state} linkForm={linkForm} styled={markdownFormattingEnabled} onToggleStyled={() => {
            onToggleMarkdownFormatting?.();
          }} />}
        <CodeMirrorEditor
          ref={editorRef}
          filePath={filePath}
          formattingControlsRef={toolbarRef}
          onFormattingState={setState}
          onFormattingRefusal={onFormattingRefusal}
          onLinkFormChange={setLinkForm}
          onExternalDocumentAdopted={() => setAdoption(value => value + 1)}
          onFocusToolbar={() => toolbarRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus()}
          initialDocument={buffer}
          initialPosition={initialPosition}
          initialScreenTopPx={initialScreenTopPx}
          scrollRootRef={scrollRootRef}
          fileType={fileType}
          markdownFormattingEnabled={markdownFormattingEnabled}
          onBufferChange={onBufferChange}
        />
      </div>
    );
  },
);
