import { commonmarkLanguage, markdown, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { keymap, Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { isolateHistory } from "@codemirror/commands";
import { applyListCommand, listAwareIndent, listItemAtCursor, linkCommandTarget, listMarkerSpacing, type EmphasisCommandResult } from "./markdown-formatting-commands";

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

// Keep upstream continuation and numbering. Empty task outdent uses the same
// item/indent path as explicit commands, preserving its kind and checked state.
export function continueMarkdownList(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const item = listItemAtCursor(state);
  const empty = item && range.head === line.to && item.prefixEnd === line.to;
  if (empty && item.task && item.list.parent?.name === "ListItem") {
    return applyListCommand(view, "outdent").handled;
  }
  const exiting = empty && item.list.parent?.name === "Document";
  // Typing replaces the caret's empty line. Keep a separate blank line on each
  // occupied side, or following numbered items can become paragraph text.
  const before = exiting && line.number > 1 && /\S/.test(state.doc.line(line.number - 1).text) ? 1 : 0;
  const after = exiting && line.number < state.doc.lines && /\S/.test(state.doc.line(line.number + 1).text) ? 1 : 0;
  // Upstream handles bullet tasks, but treats ordered checkboxes as content.
  // For an empty top-level ordered task, remove just its checkbox in the
  // temporary state, then compose that edit and upstream exit in one dispatch.
  const task = item?.number != null && item.task;
  const emptyTask = task && empty;
  const preparation = state.changes(emptyTask ? { from: line.from + item.contentColumn, to: line.to } : []);
  const prepared = emptyTask ? state.update({ changes: preparation }).state : state;
  if (emptyTask && !ensureSyntaxTree(prepared, prepared.selection.main.head, 50)) return false;
  return continueMarkup({
    state: prepared,
    dispatch(transaction) {
      const pos = transaction.newSelection.main.head;
      const nextLine = transaction.state.doc.lineAt(pos);
      const continueTask = task && !emptyTask
        && /^ *\d+[.)] +$/.test(transaction.state.sliceDoc(nextLine.from, pos));
      const insert = continueTask ? "[ ] " : "";
      if (!exiting && !insert && preparation.empty) return view.dispatch(transaction);
      // Put the trailing boundary after the existing newline so history maps
      // the original caret to the typing line when this action is redone.
      const extra = transaction.state.changes(exiting ? [
        ...(before ? [{ from: pos, insert: state.lineBreak }] : []),
        ...(after ? [{ from: nextLine.to + 1, insert: state.lineBreak }] : []),
      ] : { from: pos, insert });
      view.dispatch({
        changes: preparation.compose(transaction.changes).compose(extra),
        selection: EditorSelection.cursor(pos + (exiting ? before : insert.length)),
        annotations: exiting ? isolateHistory.of("full") : [],
        scrollIntoView: true,
        userEvent: "input",
      });
    },
  });
}

interface StableSyntaxNodeLike {
  name: string;
  from: number;
  to: number;
}

interface SyntaxNodeLike extends StableSyntaxNodeLike {
  node: {
    firstChild: StableSyntaxNodeLike | null;
    lastChild: StableSyntaxNodeLike | null;
  };
}

interface SyntaxTreeLike {
  iterate(spec: {
    from?: number;
    to?: number;
    enter(node: SyntaxNodeLike): boolean | void;
  }): void;
}

export interface MarkdownMarkerRange {
  from: number;
  to: number;
}

export interface MarkdownHeadingDecoration {
  level: number;
  lineFrom: number;
  markerRanges: MarkdownMarkerRange[];
}

const ATX_HEADING_NAME = /^ATXHeading([1-6])$/;
const ATX_HEADING_LEAF_BLOCKS = new Set([
  "CodeBlock",
  "FencedCode",
  "HTMLBlock",
  "Paragraph",
  "SetextHeading1",
  "SetextHeading2",
  "Table",
]);

const markdownLanguageSupport = markdown({
  base: commonmarkLanguage,
  extensions: GFM,
  addKeymap: false,
  completeHTMLTags: false,
  pasteURLAsLink: false,
});

// Tests parse with the exact parser installed in editor sessions. This matters
// as later slices add inline and nested-language decorations.
export const markdownGfmParser = markdownLanguageSupport.language.parser;

function markerRange(node: StableSyntaxNodeLike, doc: Text, includeSeparator: boolean): MarkdownMarkerRange {
  let to = node.to;
  if (includeSeparator && doc.sliceString(to, to + 1) === " ") to += 1;
  return { from: node.from, to };
}

/**
 * Classify visible ATX headings without reading or copying the whole document.
 * Setext headings deliberately remain plain in the Stage 2 opening slice.
 */
export function headingDecorations(
  tree: SyntaxTreeLike,
  doc: Text,
  from: number,
  to: number,
): MarkdownHeadingDecoration[] {
  if (from >= to) return [];

  const headings: MarkdownHeadingDecoration[] = [];
  // A visible range can begin in the middle of a wrapped heading line. Scan
  // complete physical lines so its opening marker and line decoration remain
  // available even when those positions sit just outside the visible range.
  const scanFrom = doc.lineAt(Math.max(0, Math.min(from, doc.length))).from;
  const scanTo = doc.lineAt(Math.max(scanFrom, Math.min(to - 1, doc.length))).to;

  tree.iterate({
    from: scanFrom,
    to: scanTo,
    enter(node) {
      const headingMatch = ATX_HEADING_NAME.exec(node.name);
      if (!headingMatch) {
        if (ATX_HEADING_LEAF_BLOCKS.has(node.name)) return false;
        return;
      }

      const opening = node.node.firstChild;
      if (!opening || opening.name !== "HeaderMark") return false;
      const closing = node.node.lastChild;
      const markerRanges = [markerRange(opening, doc, true)];
      if (closing?.name === "HeaderMark" && closing.from !== opening.from) {
        markerRanges.push(markerRange(closing, doc, false));
      }
      headings.push({
        level: Number(headingMatch[1]),
        lineFrom: doc.lineAt(node.from).from,
        markerRanges,
      });
      // HeaderMark nodes are always the direct edges of an ATX heading. Do not
      // traverse arbitrarily many inline descendants on a wrapped long line.
      return false;
    },
  });

  return headings;
}

export const setMarkdownFormatting = StateEffect.define<boolean>();

export const markdownFormattingEnabled = StateField.define<boolean>({
  create: () => true,
  update(enabled, transaction) {
    let next = enabled;
    for (const effect of transaction.effects) {
      if (effect.is(setMarkdownFormatting)) next = effect.value;
    }
    return next;
  },
});

function buildHeadingDecorationSet(view: EditorView): DecorationSet {
  if (!view.state.field(markdownFormattingEnabled)) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  const decoratedLines = new Set<number>();
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    for (const heading of headingDecorations(tree, view.state.doc, from, to)) {
      if (decoratedLines.has(heading.lineFrom)) continue;
      decoratedLines.add(heading.lineFrom);
      ranges.push(Decoration.line({ class: `cm-md-h${heading.level}` }).range(heading.lineFrom));
      for (const marker of heading.markerRanges) {
        ranges.push(Decoration.mark({ class: "cm-md-marker" }).range(marker.from, marker.to));
      }
    }
  }

  // Iterate only visible source. Inline marks never replace characters or
  // introduce atomic ranges; selection, search and caret movement stay native.
  const decoratedListLines = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    const decoratedTo = Math.min(to, from + 12000);
    tree.iterate({ from, to: decoratedTo, enter(node) {
      if (/^(?:FencedCode|CodeBlock|HTMLBlock|Table)$/.test(node.name)) return false;
      if (node.name === "StrongEmphasis" || node.name === "Emphasis") {
        const start = Math.max(from, node.from), end = Math.min(decoratedTo, node.to);
        if (start < end) ranges.push(Decoration.mark({ class: node.name === "StrongEmphasis" ? "cm-md-strong" : "cm-md-emphasis" }).range(start, end));
      } else if (node.name === "EmphasisMark" || node.name === "ListMark" || node.name === "TaskMarker") {
        const start = Math.max(from, node.from), end = Math.min(decoratedTo, node.to);
        if (start < end) ranges.push(Decoration.mark({ class: "cm-md-marker" }).range(start, end));
      } else if (node.name === "HorizontalRule") {
        const line = view.state.doc.lineAt(node.from);
        ranges.push(Decoration.line({ class: "cm-md-divider" }).range(line.from));
      }
    } });
    // Wrapped list lines hang at the item's content column. Existing spaces
    // and all Markdown markers remain visible, including on continuation lines.
    const first = view.state.doc.lineAt(from).number;
    const last = view.state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let number = first; number <= last; number++) {
      const line = view.state.doc.line(number);
      if (decoratedListLines.has(line.from)) continue;
      decoratedListLines.add(line.from);
      let item = tree.resolveInner(line.from + line.text.search(/\S|$/), 1);
      while (item.parent && item.name !== "ListItem") item = item.parent;
      if (item.name !== "ListItem") continue;
      const marker = item.getChild("Task")?.getChild("TaskMarker") ?? item.getChild("ListMark");
      if (!marker) continue;
      const itemLine = view.state.doc.lineAt(item.from);
      const column = marker.to - itemLine.from + Math.max(1, listMarkerSpacing(view.state.doc.sliceString(marker.to, itemLine.to)).length);
      ranges.push(Decoration.line({ class: "cm-md-list-line", attributes: {
        style: `padding-left: ${column}ch; text-indent: -${column}ch`,
      } }).range(line.from));
    }
  }
  return Decoration.set(ranges, true);
}

export const markdownHeadingViewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildHeadingDecorationSet(view);
  }

  update(update: ViewUpdate) {
    const formattingChanged = update.startState.field(markdownFormattingEnabled)
      !== update.state.field(markdownFormattingEnabled);
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (update.docChanged || update.viewportChanged || formattingChanged || treeChanged) {
      this.decorations = buildHeadingDecorationSet(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

export function markdownFormattingExtensions(initiallyEnabled: boolean, report?: (result: EmphasisCommandResult) => void): Extension {
  return [
    markdownLanguageSupport,
    linkCommandTarget,
    Prec.high(keymap.of([
      { key: "Enter", run: continueMarkdownList },
      { key: "Backspace", run: deleteMarkupBackward },
      { key: "Mod-]", run: (view) => listAwareIndent(view, "indent", report) },
      { key: "Mod-[", run: (view) => listAwareIndent(view, "outdent", report) },
    ])),
    markdownFormattingEnabled.init(() => initiallyEnabled),
    markdownHeadingViewPlugin,
  ];
}
