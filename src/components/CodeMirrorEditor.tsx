import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  Text,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { SourcePoint } from "../lib/editor-position";
import { isImeCompositionKey } from "../lib/keyboard";
import type { FileType } from "../types";
import {
  markdownFormattingEnabled as markdownFormattingEnabledField,
  markdownFormattingExtensions,
  setMarkdownFormatting,
} from "./markdown-decorations";

const BUFFER_PUBLICATION_DELAY_MS = 200;

// App owns an unhandled Escape so it can guard mode exit without CodeMirror
// collapsing the current selection first. Search keeps its own Escape binding
// so an open panel closes before App considers exiting the edit session.
const editorDefaultKeymap = defaultKeymap.filter((binding) => binding.key !== "Escape");

export interface CodeMirrorEditorHandle {
  flushPendingChanges: () => boolean | null;
  capturePosition: () => EditorSurfacePosition | null;
  adoptExternalDocument: (capturedDocument: string, externalDocument: string) => boolean;
}

export interface EditorSurfacePosition {
  cursor: SourcePoint;
  viewport: SourcePoint | null;
  viewportMoved: boolean;
}

interface CodeMirrorEditorProps {
  /** Initialization-only. Change the React key to start a different document session. */
  initialDocument: string;
  initialPosition?: SourcePoint | null;
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** Initialization-only. File-type transitions require a keyed remount. */
  fileType: FileType;
  markdownFormattingEnabled: boolean;
  onBufferChange: (content: string) => boolean;
}

type LineSeparator = "\n" | "\r\n" | "\r";

interface PreparedDocument {
  content: string;
  lineSeparator: LineSeparator;
}

interface LineSeparatorCounts {
  crlf: number;
  lf: number;
  cr: number;
}

const editorTheme = EditorView.theme({
  "&": {
    width: "100%",
    minHeight: "calc(100vh - 200px)",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  },
  ".cm-content": {
    minHeight: "calc(100vh - 200px)",
    padding: "0",
    caretColor: "var(--accent)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  ".cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-ui)",
    fontSize: "14px",
    lineHeight: "1.4",
  },
  ".cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": {
    padding: "8px 12px",
  },
  ".cm-panel.cm-search .cm-textfield": {
    border: "1px solid var(--border)",
    borderRadius: "6px",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    padding: "4px 7px",
    outline: "none",
  },
  ".cm-panel.cm-search .cm-textfield:focus": {
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent)",
  },
  ".cm-panel.cm-search .cm-textfield::placeholder": {
    color: "var(--text-muted)",
  },
  ".cm-panel.cm-search .cm-button": {
    border: "1px solid var(--border)",
    borderRadius: "6px",
    // The base theme paints buttons with a light gradient backgroundImage,
    // which would override backgroundColor and hide light text on light.
    backgroundImage: "none",
    backgroundColor: "var(--bg-tertiary)",
    color: "var(--text-primary)",
    padding: "4px 8px",
  },
  ".cm-panel.cm-search .cm-button:hover": {
    borderColor: "var(--accent)",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    accentColor: "var(--accent)",
  },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--text-secondary)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 52%, transparent)",
    outline: "1px solid var(--accent)",
  },
  ".cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6": {
    fontFamily: "var(--font-ui)",
    lineHeight: "1.35",
  },
  // This compact, relative scale belongs to the editor. It intentionally does
  // not mirror the reader's rem-based display scale or decorative borders.
  ".cm-md-h1": {
    fontSize: "1.6em",
    fontWeight: "700",
    letterSpacing: "-0.025em",
  },
  ".cm-md-h2": {
    fontSize: "1.4em",
    fontWeight: "700",
    letterSpacing: "-0.02em",
  },
  ".cm-md-h3": {
    fontSize: "1.25em",
    fontWeight: "650",
    letterSpacing: "-0.012em",
  },
  ".cm-md-h4": {
    fontSize: "1.12em",
    fontWeight: "650",
  },
  ".cm-md-h5, .cm-md-h6": {
    fontSize: "1em",
    fontWeight: "650",
  },
  ".cm-md-marker": {
    color: "var(--text-muted)",
  },
});

function countLineSeparators(content: string): LineSeparatorCounts {
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (content[index] === "\n") {
      lf += 1;
    }
  }

  return { crlf, lf, cr };
}

function selectUniformLineSeparator(counts: LineSeparatorCounts): LineSeparator {
  if (counts.crlf > 0) return "\r\n";
  if (counts.cr > 0) return "\r";
  return "\n";
}

function prepareDocument(content: string): PreparedDocument {
  const counts = countLineSeparators(content);
  const presentSeparators = [counts.crlf, counts.lf, counts.cr].filter((count) => count > 0);

  if (presentSeparators.length <= 1) {
    return { content, lineSeparator: selectUniformLineSeparator(counts) };
  }

  // CodeMirror stores one separator per state. Mixed files normalize to their
  // dominant convention, using the first encountered separator to break ties.
  const firstSeparator = (content.match(/\r\n|\r|\n/)?.[0] ?? "\n") as LineSeparator;
  const candidates: Array<{ separator: LineSeparator; count: number }> = [
    { separator: "\r\n", count: counts.crlf },
    { separator: "\n", count: counts.lf },
    { separator: "\r", count: counts.cr },
  ];
  const lineSeparator = candidates.reduce((selected, candidate) => {
    if (candidate.count > selected.count) return candidate;
    if (candidate.count === selected.count && candidate.separator === firstSeparator) return candidate;
    return selected;
  }).separator;

  return {
    content: content.replace(/\r\n|\r|\n/g, lineSeparator),
    lineSeparator,
  };
}

function clampSourcePoint(doc: Text, point: SourcePoint): number {
  const lineNumber = Math.max(1, Math.min(Math.trunc(point.line), doc.lines));
  const line = doc.line(lineNumber);
  const columnOffset = Math.max(0, Math.trunc(point.column) - 1);
  return line.from + Math.min(columnOffset, line.length);
}

function sourcePointAt(doc: Text, position: number): SourcePoint {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  return { line: line.number, column: position - line.from + 1 };
}

function firstVisibleSourcePoint(view: EditorView, scrollRoot: HTMLElement): SourcePoint | null {
  const viewport = scrollRoot.getBoundingClientRect();
  for (const lineElement of view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")) {
    const lineRect = lineElement.getBoundingClientRect();
    if (lineRect.bottom <= viewport.top || lineRect.top >= viewport.bottom) continue;

    try {
      const coordinatePosition = view.posAtCoords({
        x: Math.max(lineRect.left, viewport.left) + 1,
        y: Math.max(lineRect.top, viewport.top) + 1,
      });
      const position = coordinatePosition ?? view.posAtDOM(lineElement, 0);
      return sourcePointAt(view.state.doc, position);
    } catch {
      // A line can disappear between the DOM query and position lookup when
      // CodeMirror refreshes its measured viewport. Try the next live line.
    }
  }
  return null;
}

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor({
    initialDocument,
    initialPosition,
    scrollRootRef,
    fileType,
    markdownFormattingEnabled,
    onBufferChange,
  }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const publishRef = useRef<(() => boolean | null) | null>(null);
    const adoptExternalDocumentRef = useRef<(
      capturedDocument: string,
      externalDocument: string,
    ) => boolean>(() => false);
    const onBufferChangeRef = useRef(onBufferChange);
    const initialScrollTopRef = useRef<number | null>(null);
    const viewportMovedByUserRef = useRef(false);

    useLayoutEffect(() => {
      onBufferChangeRef.current = onBufferChange;
    }, [onBufferChange]);

    useImperativeHandle(ref, () => ({
      flushPendingChanges: () => publishRef.current?.() ?? null,
      adoptExternalDocument: (capturedDocument, externalDocument) => (
        adoptExternalDocumentRef.current(capturedDocument, externalDocument)
      ),
      capturePosition: () => {
        const view = viewRef.current;
        if (!view) return null;
        const cursor = sourcePointAt(view.state.doc, view.state.selection.main.head);
        const scrollRoot = scrollRootRef?.current ?? null;
        const currentScrollTop = scrollRoot?.scrollTop ?? null;
        if (initialScrollTopRef.current === null && currentScrollTop !== null) {
          // A zero-layout test surface (or an exit before the first measured
          // frame) may never run the post-centering callback. Treat the first
          // read as settled instead of guessing that initialization moved.
          initialScrollTopRef.current = currentScrollTop;
        }
        const initialScrollTop = initialScrollTopRef.current;
        return {
          cursor,
          viewport: scrollRoot ? firstVisibleSourcePoint(view, scrollRoot) : null,
          viewportMoved: viewportMovedByUserRef.current || (
            currentScrollTop !== null
            && initialScrollTop !== null
            && Math.abs(currentScrollTop - initialScrollTop) > 1
          ),
        };
      },
    }), []);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      let view: EditorView | null = null;
      let pendingPublication = false;
      let publicationTimer: ReturnType<typeof setTimeout> | null = null;
      let baselineFrame: number | null = null;
      let applyingExternalDocument = false;
      initialScrollTopRef.current = null;
      viewportMovedByUserRef.current = false;
      const scrollRoot = scrollRootRef?.current ?? null;
      const recordUserViewportMovement = () => {
        viewportMovedByUserRef.current = true;
      };
      scrollRoot?.addEventListener("wheel", recordUserViewportMovement, { passive: true });
      scrollRoot?.addEventListener("touchmove", recordUserViewportMovement, { passive: true });

      const publishPendingChanges = (): boolean | null => {
        if (!pendingPublication || !view || viewRef.current !== view) return null;

        if (publicationTimer) {
          clearTimeout(publicationTimer);
          publicationTimer = null;
        }
        pendingPublication = false;
        return onBufferChangeRef.current(view.state.sliceDoc());
      };

      const schedulePublication = (): void => {
        pendingPublication = true;
        if (publicationTimer) clearTimeout(publicationTimer);
        publicationTimer = setTimeout(() => {
          publicationTimer = null;
          publishPendingChanges();
        }, BUFFER_PUBLICATION_DELAY_MS);
      };

      const createEditorState = (
        preparedDocument: PreparedDocument,
        selection: EditorSelection | undefined,
        formattingEnabled: boolean,
      ): EditorState => {
        const preparedText = Text.of(
          preparedDocument.content.split(preparedDocument.lineSeparator),
        );
        return EditorState.create({
          doc: preparedText,
          selection,
          extensions: [
            EditorState.lineSeparator.of(preparedDocument.lineSeparator),
            EditorState.allowMultipleSelections.of(true),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
              "aria-label": "Edit markdown",
              "aria-multiline": "true",
              spellcheck: "false",
            }),
            history(),
            search({ top: true }),
            keymap.of([...editorDefaultKeymap, ...historyKeymap, ...searchKeymap]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !applyingExternalDocument) schedulePublication();
            }),
            fileType === "markdown" ? markdownFormattingExtensions(formattingEnabled) : [],
            editorTheme,
          ],
        });
      };

      const preparedDocument = prepareDocument(initialDocument);
      const preparedText = Text.of(preparedDocument.content.split(preparedDocument.lineSeparator));
      const initialOffset = initialPosition
        ? clampSourcePoint(preparedText, initialPosition)
        : null;
      const state = createEditorState(
        preparedDocument,
        initialOffset === null ? undefined : EditorSelection.single(initialOffset),
        markdownFormattingEnabled,
      );

      const createdView = new EditorView({
        state,
        parent: host,
        scrollTo: initialOffset === null
          ? undefined
          : EditorView.scrollIntoView(initialOffset, { y: "center" }),
      });
      view = createdView;
      viewRef.current = createdView;
      publishRef.current = publishPendingChanges;
      adoptExternalDocumentRef.current = (capturedDocument, externalDocument) => {
        publishPendingChanges();
        if (viewRef.current !== createdView) return false;

        const captured = prepareDocument(capturedDocument);
        if (
          createdView.state.sliceDoc() !== captured.content
          || createdView.state.lineBreak !== captured.lineSeparator
        ) return false;

        const external = prepareDocument(externalDocument);
        const currentDocument = createdView.state.doc;
        const externalText = Text.of(external.content.split(external.lineSeparator));
        const selection = EditorSelection.create(
          createdView.state.selection.ranges.map((range) => EditorSelection.range(
            clampSourcePoint(externalText, sourcePointAt(currentDocument, range.anchor)),
            clampSourcePoint(externalText, sourcePointAt(currentDocument, range.head)),
          )),
          createdView.state.selection.mainIndex,
        );
        const formattingEnabled = createdView.state.field(
          markdownFormattingEnabledField,
          false,
        ) ?? markdownFormattingEnabled;
        const scrollTop = scrollRoot?.scrollTop ?? null;
        const hadFocus = createdView.hasFocus;
        applyingExternalDocument = true;
        try {
          createdView.setState(createEditorState(external, selection, formattingEnabled));
        } finally {
          applyingExternalDocument = false;
        }
        if (scrollRoot && scrollTop !== null) scrollRoot.scrollTop = scrollTop;
        if (hadFocus && !createdView.hasFocus) createdView.focus();
        return true;
      };
      createdView.focus();
      if (initialOffset === null) {
        initialScrollTopRef.current = scrollRootRef?.current?.scrollTop ?? null;
      } else {
        createdView.requestMeasure({
          read: () => scrollRootRef?.current,
          write: (scrollRoot) => {
            if (!scrollRoot || viewRef.current !== createdView) return;
            // CodeMirror applies its constructor scroll target after measure
            // request writes. The next frame observes the settled centered
            // position, so initialization is not mistaken for user scrolling.
            baselineFrame = window.requestAnimationFrame(() => {
              baselineFrame = null;
              if (viewRef.current === createdView) {
                initialScrollTopRef.current = scrollRoot.scrollTop;
              }
            });
          },
        });
      }

      return () => {
        if (publicationTimer) clearTimeout(publicationTimer);
        if (baselineFrame !== null) window.cancelAnimationFrame(baselineFrame);
        publicationTimer = null;
        baselineFrame = null;
        pendingPublication = false;
        publishRef.current = null;
        adoptExternalDocumentRef.current = () => false;
        initialScrollTopRef.current = null;
        viewportMovedByUserRef.current = false;
        scrollRoot?.removeEventListener("wheel", recordUserViewportMovement);
        scrollRoot?.removeEventListener("touchmove", recordUserViewportMovement);
        if (viewRef.current === view) viewRef.current = null;
        createdView.destroy();
        view = null;
      };
    }, []);

    useLayoutEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.field(markdownFormattingEnabledField, false);
      if (current === undefined || current === markdownFormattingEnabled) return;
      view.dispatch({ effects: setMarkdownFormatting.of(markdownFormattingEnabled) });
    }, [markdownFormattingEnabled]);

    return (
      <div
        ref={hostRef}
        onKeyDownCapture={(event) => {
          // Search-panel handlers run before App's window listener. Keep an
          // IME-owned key from closing the panel or triggering editor keymaps.
          if (isImeCompositionKey(event.nativeEvent)) event.stopPropagation();
        }}
      />
    );
  },
);
