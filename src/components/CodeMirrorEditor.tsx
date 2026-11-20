import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap, searchPanelOpen, openSearchPanel, findNext, findPrevious } from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  ChangeSet,
  Text,
  Prec,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";
import { editorEntryOffset } from "../lib/editor-position";
import type { SourcePoint } from "../lib/editor-position";
import type { ObservedEditorChanges } from "../lib/highlight-continuity";
import { isImeCompositionKey } from "../lib/keyboard";
import { detectShortcutPlatform } from "../lib/shortcut-labels";
import type { FileType } from "../types";
import {
  markdownFormattingEnabled as markdownFormattingEnabledField,
  markdownFormattingExtensions,
  setMarkdownFormatting,
} from "./markdown-decorations";

import {
  FORMATTING_SHORTCUTS, LINK_STALE_REASON, refusalResult, COMPOSITION_REASON, executeFormattingCommand, formattingToolbarState, beginLinkCommand, applyLinkCommand, cancelLinkCommand, linkCommandIsCurrent,
  type FormattingCommand, type FormattingToolbarState, type EmphasisCommandResult,
  type LinkCommandIntent, type LinkCommandInput,
} from "./markdown-formatting-commands";

export interface EditorLinkForm { id: number; label: string }

const BUFFER_PUBLICATION_DELAY_MS = 200;

// App owns an unhandled Escape so it can guard mode exit without CodeMirror
// collapsing the current selection first. Search keeps its own Escape binding
// so an open panel closes before App considers exiting the edit session.
const editorDefaultKeymap = defaultKeymap.filter((binding) => binding.key !== "Escape");

export interface CodeMirrorEditorHandle {
  focus: () => void;
  executeFormatting: (command: FormattingCommand) => EmphasisCommandResult | null;
  beginLink: () => void;
  applyLink: (id: number, input: LinkCommandInput, composing?: boolean) => EmphasisCommandResult | null;
  cancelLink: (id?: number, restoreFocus?: boolean) => void;
  find: () => void;
  findNext: () => void;
  findPrevious: () => void;
  flushPendingChanges: () => boolean | null;
  capturePosition: () => EditorSurfacePosition | null;
  captureChanges: () => ObservedEditorChanges | null;
  adoptExternalDocument: (capturedDocument: string, externalDocument: string) => boolean;
}

export interface EditorSurfacePosition {
  cursor: SourcePoint;
  viewport: SourcePoint | null;
  viewportMoved: boolean;
  /** Screen tops of the cursor's and the viewport's lines; null when the line does not start on screen. */
  cursorTopPx: number | null;
  viewportTopPx: number | null;
}

interface CodeMirrorEditorProps {
  /** Initialization-only. Change the React key to start a different document session. */
  initialDocument: string;
  initialPosition?: SourcePoint | null;
  /** Initialization-only. Where Read showed `initialPosition` on screen; without it (or without
   *  a formatting bar) the editor centres the initial position. */
  initialScreenTopPx?: number | null;
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** Initialization-only. File-type transitions require a keyed remount. */
  fileType: FileType;
  markdownFormattingEnabled: boolean;
  onBufferChange: (content: string) => boolean;
  filePath?: string | null;
  formattingControlsRef?: RefObject<HTMLElement | null>;
  onFormattingState?: (state: FormattingToolbarState) => void;
  onFormattingRefusal?: (reason: string) => void;
  onLinkFormChange?: (form: EditorLinkForm | null) => void;
  onFocusToolbar?: () => void;
  onExternalDocumentAdopted?: () => void;
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
    caretColor: "var(--accent-indicator)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent-indicator)",
  },
  ".cm-content ::selection": {
    color: "var(--text-primary)",
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
    borderColor: "var(--accent-indicator)",
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
    accentColor: "var(--accent-fill)",
  },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--text-secondary)",
  },
  ".cm-searchMatch, .cm-searchMatch .cm-md-marker, .cm-md-marker .cm-searchMatch": {
    color: "var(--text-primary)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    outline: "1px solid var(--accent-indicator)",
  },
  ".cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6": {
    fontFamily: "var(--font-ui)",
    lineHeight: "1.35",
  },
  // The editor uses its own compact heading scale and keeps headings borderless.
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
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-emphasis": { fontStyle: "italic" },
  ".cm-md-divider": {
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
    paddingBlock: ".35em",
  },
  ".cm-md-task": { cursor: "pointer" },
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

/** Height of the sticky formatting controls covering the top of the shared scroll root. */
function stickyControlsInset(controls: HTMLElement | null | undefined, scrollRoot: HTMLElement | null | undefined): number {
  const bar = controls?.parentElement;
  if (!bar) return 0;
  return Math.max(0, bar.getBoundingClientRect().bottom - Math.max(0, scrollRoot?.getBoundingClientRect().top ?? 0));
}

/** Screen top of the drawn line holding `point`; null when it is not drawn or starts off screen. */
function lineScreenTop(view: EditorView, scrollRoot: HTMLElement | null, point: SourcePoint | null): number | null {
  if (!scrollRoot || !point) return null;
  const { node } = view.domAtPos(view.state.doc.line(point.line).from);
  const line = (node instanceof HTMLElement ? node : node.parentElement)?.closest(".cm-line");
  if (!line) return null;
  const top = line.getBoundingClientRect().top;
  const viewport = scrollRoot.getBoundingClientRect();
  return top >= viewport.top && top < viewport.bottom ? top : null;
}

function firstVisibleSourcePoint(view: EditorView, scrollRoot: HTMLElement, topInset: number): SourcePoint | null {
  const viewport = scrollRoot.getBoundingClientRect();
  const top = viewport.top + topInset;
  for (const lineElement of view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")) {
    const lineRect = lineElement.getBoundingClientRect();
    if (lineRect.bottom <= top || lineRect.top >= viewport.bottom) continue;

    try {
      const coordinatePosition = view.posAtCoords({
        x: Math.max(lineRect.left, viewport.left) + 1,
        y: Math.max(lineRect.top, top) + 1,
      });
      const position = coordinatePosition ?? view.posAtDOM(lineElement, 0);
      // A blank line has no reader block; the reader would fall back to the
      // block before it. The first visible text is the next non-blank line.
      if (!view.state.doc.lineAt(position).text.trim()) continue;
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
    initialScreenTopPx,
    scrollRootRef,
    fileType,
    markdownFormattingEnabled,
    onBufferChange,
    filePath = null, formattingControlsRef, onFormattingState, onFormattingRefusal, onLinkFormChange, onFocusToolbar, onExternalDocumentAdopted,
  }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const publishRef = useRef<(() => boolean | null) | null>(null);
    const captureChangesRef = useRef<() => ObservedEditorChanges | null>(() => null);
    const adoptExternalDocumentRef = useRef<(
      capturedDocument: string,
      externalDocument: string,
    ) => boolean>(() => false);
    const onBufferChangeRef = useRef(onBufferChange);
    const interactionRef = useRef({ filePath, onFormattingState, onFormattingRefusal, onLinkFormChange, onFocusToolbar, onExternalDocumentAdopted });
    const formattingBridgeRef = useRef<Pick<CodeMirrorEditorHandle, "executeFormatting" | "beginLink" | "applyLink" | "cancelLink"> | null>(null);
    const viewportMovedByUserRef = useRef(false);
    const stickyTopInset = () => stickyControlsInset(formattingControlsRef?.current, scrollRootRef?.current);

    useLayoutEffect(() => {
      onBufferChangeRef.current = onBufferChange;
    }, [onBufferChange]);

    useLayoutEffect(() => {
      if (interactionRef.current.filePath !== filePath) formattingBridgeRef.current?.cancelLink(undefined, false);
      interactionRef.current = { filePath, onFormattingState, onFormattingRefusal, onLinkFormChange, onFocusToolbar, onExternalDocumentAdopted };
    });

    useImperativeHandle(ref, () => ({
      executeFormatting: command => formattingBridgeRef.current?.executeFormatting(command) ?? null,
      beginLink: () => formattingBridgeRef.current?.beginLink(),
      applyLink: (id, input, composing) => formattingBridgeRef.current?.applyLink(id, input, composing) ?? null,
      cancelLink: (id, restoreFocus) => formattingBridgeRef.current?.cancelLink(id, restoreFocus),
      focus: () => viewRef.current?.focus(),
      find: () => {
        const view = viewRef.current;
        if (!view) return;
        formattingBridgeRef.current?.cancelLink(undefined, false);
        openSearchPanel(view);
        // Explicit navigation from a form/control owns focus, independently of
        // whether the browser focuses a newly mounted input through select().
        view.dom.querySelector<HTMLInputElement>('.cm-search [main-field]')?.focus();
      },
      findNext: () => { if (viewRef.current) findNext(viewRef.current); },
      findPrevious: () => { if (viewRef.current) findPrevious(viewRef.current); },
      flushPendingChanges: () => publishRef.current?.() ?? null,
      captureChanges: () => captureChangesRef.current(),
      adoptExternalDocument: (capturedDocument, externalDocument) => (
        adoptExternalDocumentRef.current(capturedDocument, externalDocument)
      ),
      capturePosition: () => {
        const view = viewRef.current;
        if (!view) return null;
        const cursor = sourcePointAt(view.state.doc, view.state.selection.main.head);
        const scrollRoot = scrollRootRef?.current ?? null;
        const viewport = scrollRoot ? firstVisibleSourcePoint(view, scrollRoot, stickyTopInset()) : null;
        return {
          cursor,
          viewport,
          viewportMoved: viewportMovedByUserRef.current,
          cursorTopPx: lineScreenTop(view, scrollRoot, cursor),
          viewportTopPx: lineScreenTop(view, scrollRoot, viewport),
        };
      },
    }), []);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      let view: EditorView | null = null;
      let pendingPublication = false;
      let publicationTimer: ReturnType<typeof setTimeout> | null = null;
      let applyingExternalDocument = false;
      let observedChanges: ChangeSet | null = null;
      let observedDocument: Text | null = null;
      let feedbackFrame: number | null = null;
      let lastFeedback = "";
      let compositionActive = false;
      let linkSequence = 0;
      let link: { id: number; intent: LinkCommandIntent } | null = null;
      const session = {};
      const context = () => ({ session, filePath: interactionRef.current.filePath });
      const reportReason = (reason: string | null) => {
        if (reason) interactionRef.current.onFormattingRefusal?.(reason);
      };
      const report = (result: EmphasisCommandResult) => {
        reportReason(result.reason);
        return result;
      };
      const cancelLink = (id?: number, restoreFocus = true) => {
        if (!link || (id !== undefined && id !== link.id) || !view) return;
        cancelLinkCommand(view, link.intent, context(), restoreFocus);
        link = null;
        interactionRef.current.onLinkFormChange?.(null);
      };
      const scheduleFeedback = () => {
        if (!view || viewRef.current !== view || fileType !== "markdown" || feedbackFrame !== null) return;
        feedbackFrame = window.requestAnimationFrame(() => {
          feedbackFrame = null;
          if (!view || viewRef.current !== view) return;
          const snapshot = formattingToolbarState(view.state, compositionActive || view.composing);
          const key = JSON.stringify(snapshot);
          if (key === lastFeedback) return;
          lastFeedback = key;
          interactionRef.current.onFormattingState?.(snapshot);
        });
      };
      const compositionChanged = (active: boolean) => {
        compositionActive = active;
        if (active) cancelLink(undefined, false);
        scheduleFeedback();
      };
      const compositionStart = () => compositionChanged(true);
      const compositionEnd = () => {
        compositionActive = false;
        // CodeMirror settles its own composition flag after this DOM event.
        scheduleFeedback();
        setTimeout(scheduleFeedback, 0);
      };
      const executeFormatting = (command: FormattingCommand, at?: number) => {
        if (!view || fileType !== "markdown") return null;
        cancelLink(undefined, false);
        const result = compositionActive
          ? refusalResult(COMPOSITION_REASON)
          : executeFormattingCommand(view, command, at);
        report(result);
        view.focus();
        scheduleFeedback();
        return result;
      };
      viewportMovedByUserRef.current = false;
      const scrollRoot = scrollRootRef?.current ?? null;
      // CodeMirror scrolls the shared root itself: the initial placement and
      // its scroll anchoring when measured heights change (late parsing,
      // fonts, wrapping). Remember where its measure cycles leave the root;
      // any other scroll (wheel, scrollbar, keyboard) is the user's.
      let editorScrollTop: number | null = null;
      // The opening line and where it belongs on screen, until CodeMirror has first measured.
      let entryPlacement: { offset: number; screenTop: number } | null = null;
      const recordViewportMovement = () => {
        if (scrollRoot && editorScrollTop !== null
          && Math.abs(scrollRoot.scrollTop - editorScrollTop) > 1) viewportMovedByUserRef.current = true;
      };
      scrollRoot?.addEventListener("scroll", recordViewportMovement, { passive: true });

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
        const isMac = detectShortcutPlatform() === "macos";
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
            // CodeMirror's nested-scroll algorithm does not read CSS
            // scroll-padding. Reserve the actual visible sticky controls.
            EditorView.scrollMargins.of(() => ({ top: stickyTopInset() })),
            EditorView.contentAttributes.of({
              "aria-label": "Edit document",
              "aria-multiline": "true",
              spellcheck: isMac ? "true" : "false",
              autocorrect: "off",
            }),
            history(),
            search({ top: true }),
            fileType === "markdown" ? Prec.highest(keymap.of([
              ...FORMATTING_SHORTCUTS.map(({ command, key }) => ({ key: `Mod-${key}`, run: () => { executeFormatting(command); return true; } })),
              { key: "Alt-F10", run: () => { interactionRef.current.onFocusToolbar?.(); return true; } },
            ])) : [],
            fileType === "markdown" ? EditorView.domEventHandlers({
              // Styled supplies task spans; Plain supplies none. A plain left
              // click ticks without moving the cursor or starting a selection.
              // Modified, composing and multi-cursor clicks stay CodeMirror's.
              mousedown(event, editorView) {
                const box = (event.target as Element | null)?.closest?.(".cm-md-task");
                if (!box || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey
                  || compositionActive || editorView.composing || editorView.state.selection.ranges.length > 1) return false;
                event.preventDefault();
                // Swallow later presses in a double/triple click without ticking again.
                if (event.detail <= 1) executeFormatting("toggleTask", editorView.posAtDOM(box));
                return true;
              },
              beforeinput(event) {
                const command = event.inputType === "formatBold" ? "bold" : event.inputType === "formatItalic" ? "italic"
                  : event.inputType === "insertOrderedList" ? "numbered" : event.inputType === "insertUnorderedList" ? "bullets"
                  : event.inputType === "formatIndent" ? "indent" : event.inputType === "formatOutdent" ? "outdent" : null;
                if (!command && !event.inputType.startsWith("format")) return false;
                event.preventDefault();
                if (command) executeFormatting(command);
                else reportReason("Use the formatting bar for supported Markdown formatting.");
                return true;
              },
            }) : [],
            keymap.of([...editorDefaultKeymap, ...historyKeymap, ...searchKeymap]),
            EditorView.updateListener.of((update) => {
              if (scrollRoot && update.transactions.length === 0) {
                // CodeMirror places the opening line using estimated heights for lines it has
                // not drawn, then swaps in measured ones without holding the line. Once it has
                // measured, move the line the rest of the way to its height in Read.
                if (entryPlacement && update.geometryChanged) {
                  const top = lineScreenTop(update.view, scrollRoot, sourcePointAt(update.state.doc, entryPlacement.offset));
                  if (top !== null) scrollRoot.scrollTop += top - entryPlacement.screenTop;
                  entryPlacement = null;
                }
                editorScrollTop = scrollRoot.scrollTop;
              }
              if (update.docChanged && observedChanges) {
                // setState/adoption and any unobserved replacement break ownership.
                if (applyingExternalDocument || update.startState.doc !== observedDocument) observedChanges = null;
                else {
                  observedChanges = observedChanges.compose(update.changes);
                  observedDocument = update.state.doc;
                }
              }
              if (update.docChanged && !applyingExternalDocument) schedulePublication();
              if (link && !linkCommandIsCurrent(update.view, link.intent, context())) cancelLink(undefined, false);
              if (update.docChanged || update.selectionSet
                || syntaxTree(update.startState) !== syntaxTree(update.state)
                || update.startState.readOnly !== update.state.readOnly) scheduleFeedback();
              if (isMac && searchPanelOpen(update.state) && !searchPanelOpen(update.startState)) {
                // CodeMirror mounts its search panel before notifying update listeners.
                for (const input of update.view.dom.querySelectorAll(".cm-search input.cm-textfield")) {
                  input.setAttribute("autocorrect", "off");
                  input.setAttribute("spellcheck", "false");
                }
              }
            }),
            fileType === "markdown" ? markdownFormattingExtensions(formattingEnabled, report) : [],
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

      const createdView = new EditorView({ state, parent: host });
      if (initialOffset !== null) {
        // Read the bar only now: before the editor has content, a Focus-mode bar cannot take its
        // sticky offset yet. The scroll margins (stickyTopInset) are added back by CodeMirror.
        const bar = formattingControlsRef?.current?.parentElement;
        if (initialScreenTopPx == null || !bar || !scrollRoot) {
          createdView.dispatch({ effects: EditorView.scrollIntoView(initialOffset, { y: "center" }) });
        } else {
          const stuckBarBottom = bar.offsetHeight + (Number.parseFloat(window.getComputedStyle(bar).top) || 0);
          const rootTop = scrollRoot.getBoundingClientRect().top;
          const wanted = editorEntryOffset(initialScreenTopPx, rootTop, stuckBarBottom);
          entryPlacement = { offset: initialOffset, screenTop: rootTop + wanted };
          createdView.dispatch({
            effects: EditorView.scrollIntoView(initialOffset, { y: "start", yMargin: wanted - stickyTopInset() }),
          });
        }
      }
      view = createdView;
      viewRef.current = createdView;
      observedChanges = fileType === "markdown" ? ChangeSet.empty(state.doc.length) : null;
      observedDocument = state.doc;
      captureChangesRef.current = () => {
        if (fileType !== "markdown" || !observedChanges || observedDocument !== createdView.state.doc) return null;
        const changes = observedChanges, final = createdView.state.doc;
        return {
          initialDocument: preparedDocument.content,
          finalDocument: createdView.state.sliceDoc(),
          mapTextPoint(point, length = 1) {
            if (!Number.isInteger(point.line) || point.line < 1 || point.line > state.doc.lines
              || !Number.isInteger(point.column) || point.column < 1 || !Number.isInteger(length) || length < 1) return null;
            const line = state.doc.line(point.line);
            // A run stays on its own line, where editor and string offsets agree.
            if (point.column + length - 1 > line.length) return null;
            const first = line.from + point.column - 1, last = first + length - 1;
            // Follow TEXT CHARACTERS, never a gap. touchesRange(first + 1, last) is
            // true exactly when a change deletes or replaces any character of the
            // run, or inserts between two of them. Typing at either edge is not a
            // touch, for a single character too.
            if (changes.touchesRange(first + 1, last)) return null;
            return sourcePointAt(final, changes.mapPos(first, 1));
          },
        };
      };
      publishRef.current = publishPendingChanges;
      formattingBridgeRef.current = {
        executeFormatting,
        cancelLink,
        beginLink() {
          if (fileType !== "markdown") return;
          cancelLink(undefined, false);
          if (compositionActive) {
            reportReason(COMPOSITION_REASON);
            return;
          }
          const begun = beginLinkCommand(createdView, context());
          reportReason(begun.reason);
          if (!begun.intent) return;
          link = { id: ++linkSequence, intent: begun.intent };
          interactionRef.current.onLinkFormChange?.({ id: link.id, label: begun.intent.label });
        },
        applyLink(id, input, composing = false) {
          if (!link || link.id !== id || !linkCommandIsCurrent(createdView, link.intent, context())) {
            cancelLink(id, false);
            return report(refusalResult(LINK_STALE_REASON));
          }
          // A live form owns its one inline validation surface. Stale/no-form
          // submissions above use the notice path because no form can show it.
          if (composing || compositionActive) return refusalResult(COMPOSITION_REASON);
          const result = applyLinkCommand(createdView, link.intent, input, context());
          if (result.applied) { cancelLink(undefined, false); createdView.focus(); }
          return result;
        },
      };
      host.addEventListener("compositionstart", compositionStart);
      host.addEventListener("compositionend", compositionEnd);
      scheduleFeedback();
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
        const hadFocus = createdView.hasFocus || link !== null;
        cancelLink(undefined, false);
        if (feedbackFrame !== null) window.cancelAnimationFrame(feedbackFrame);
        feedbackFrame = null;
        lastFeedback = "";
        applyingExternalDocument = true;
        observedChanges = null;
        try {
          createdView.setState(createEditorState(external, selection, formattingEnabled));
        } finally {
          applyingExternalDocument = false;
        }
        interactionRef.current.onExternalDocumentAdopted?.();
        scheduleFeedback();
        if (scrollRoot && scrollTop !== null) editorScrollTop = scrollRoot.scrollTop = scrollTop;
        if (hadFocus && !createdView.hasFocus) createdView.focus();
        return true;
      };
      createdView.focus();

      return () => {
        cancelLink(undefined, false);
        formattingBridgeRef.current = null;
        if (feedbackFrame !== null) window.cancelAnimationFrame(feedbackFrame);
        host.removeEventListener("compositionstart", compositionStart);
        host.removeEventListener("compositionend", compositionEnd);
        if (publicationTimer) clearTimeout(publicationTimer);
        publicationTimer = null;
        pendingPublication = false;
        publishRef.current = null;
        captureChangesRef.current = () => null;
        adoptExternalDocumentRef.current = () => false;
        viewportMovedByUserRef.current = false;
        scrollRoot?.removeEventListener("scroll", recordViewportMovement);
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
