import { forwardRef } from "react";
import type { RefObject } from "react";
import type { FileType, ReaderSettings } from "../types";
import { resolveReaderSurfaceStyle } from "../lib/reader-settings";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import type { CodeMirrorEditorHandle, EditorSurfacePosition } from "./CodeMirrorEditor";
import type { SourcePoint } from "../lib/editor-position";

export type MarkdownEditorHandle = CodeMirrorEditorHandle;
export type { EditorSurfacePosition };

interface MarkdownEditorProps {
  buffer: string;
  initialPosition?: SourcePoint | null;
  scrollRootRef: RefObject<HTMLElement | null>;
  fileType: FileType;
  markdownFormattingEnabled: boolean;
  settings: ReaderSettings;
  saveError: string | null;
  canSaveAsAfterError: boolean;
  onBufferChange: (content: string) => boolean;
  onSaveAsAfterError: () => void;
  onDismissSaveError: () => void;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({
    buffer,
    initialPosition,
    scrollRootRef,
    fileType,
    markdownFormattingEnabled,
    settings,
    saveError,
    canSaveAsAfterError,
    onBufferChange,
    onSaveAsAfterError,
    onDismissSaveError,
  }, ref) {
    return (
      <div
        style={resolveReaderSurfaceStyle(settings)}
      >
        {saveError && (
          <div
            role="alert"
            className="font-ui mb-4 px-4 py-3 rounded-lg border border-red-400/30 bg-red-500/10 text-red-400 text-sm flex items-start gap-3"
          >
            <span className="flex-1 min-w-0">{saveError}</span>
            {canSaveAsAfterError && (
              <button
                type="button"
                onClick={onSaveAsAfterError}
                className="shrink-0 rounded px-2 py-0.5 font-medium text-red-300 hover:bg-red-500/10"
              >
                Save As…
              </button>
            )}
            <button
              type="button"
              onClick={onDismissSaveError}
              className="shrink-0 p-0.5 rounded hover:bg-red-500/10 transition-colors duration-120"
              aria-label="Dismiss error"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
        <CodeMirrorEditor
          ref={ref}
          initialDocument={buffer}
          initialPosition={initialPosition}
          scrollRootRef={scrollRootRef}
          fileType={fileType}
          markdownFormattingEnabled={markdownFormattingEnabled}
          onBufferChange={onBufferChange}
        />
      </div>
    );
  },
);
