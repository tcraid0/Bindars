import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { GFM } from "@lezer/markdown";

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

export function markdownFormattingExtensions(initiallyEnabled: boolean): Extension {
  return [
    markdownLanguageSupport,
    markdownFormattingEnabled.init(() => initiallyEnabled),
    markdownHeadingViewPlugin,
  ];
}
