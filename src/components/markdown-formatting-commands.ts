import { indentLess, indentMore, isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection, EditorState, StateField, type ChangeSet, type ChangeSpec, type Text, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { Nodes, Root } from "mdast";
import { assertDocumentComplexity, checkDocumentComplexity, isDocumentComplexityError } from "../lib/document-complexity";
import { extractFrontmatter, withoutByteOrderMark } from "../lib/frontmatter";
import { markdownSyntax } from "../lib/markdown-syntax";
import { markdownLinkDestination } from "../lib/paths";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

export type EmphasisCommand = "bold" | "italic";

export interface EmphasisCommandStatus {
  available: boolean;
  /** True when the same-kind action removes existing formatting. */
  active: boolean;
  reason: string | null;
}

export interface EmphasisCommandResult extends EmphasisCommandStatus {
  /** An editor shortcut that reaches this command has been consumed. */
  handled: true;
  applied: boolean;
}

const LOADING_REASON = "Formatting context is still loading.";
const MULTI_SELECTION_REASON = "Use one selection to format text.";
const COMPOSITION_REASON = "Finish the current composition before formatting.";
const READ_ONLY_REASON = "This document cannot be edited.";
const METADATA_REASON = "Move out of the document details to format text.";
const MATH_REASON = "Move out of math to format text.";
const PARTIAL_SPAN_REASON = "Select the whole formatted span, or place the cursor inside it.";
const MIXED_SPAN_REASON = "Select one plain phrase or one formatted span.";
const CROSS_BLOCK_REASON = "Select text in a single paragraph.";
const MULTILINE_REASON = "Select text on one line.";
const HEADING_MARKER_REASON = "Select the heading text, not its marker.";
const TASK_MARKER_REASON = "Select the checklist text, not its checkbox.";
const COMPLEXITY_REASON = "This document is too large or complex to format safely. Edit the markers directly.";
const CHANGED_SYNTAX_REASON = "This would change other Markdown. Edit the markers directly.";

const STYLE = {
  bold: {
    marker: "**",
    node: "StrongEmphasis",
    empty: "Select text to make it bold.",
    literal: "This text would not appear bold. Select different text.",
  },
  italic: {
    marker: "*",
    node: "Emphasis",
    empty: "Select text to make it italic.",
    literal: "This text would not appear italic. Select different text.",
  },
} as const;

const TEXT_BLOCK = /^(?:Paragraph|Task|ATXHeading[1-6]|SetextHeading[12])$/;
const FRONTMATTER_FENCE = /^---[ \t]*$/;

const mathDocument = unified()
  .use(remarkParse)
  .use(markdownSyntax);

interface Range {
  from: number;
  to: number;
}

interface ReaderDocument {
  tree: Root;
  /** Reader body offset in CodeMirror's LF-normalized document. */
  offset: number;
}

type DocumentProtection = {
  ok: true;
  ranges: Range[];
  metadata: Range | null;
  reader: ReaderDocument | null;
} | { ok: false; reason: string };
// CodeMirror Text is immutable. Selection changes and the two toolbar buttons
// share this scan; editing or replacing the document gets a fresh entry.
const protectionCache = new WeakMap<Text, { lineBreak: string; protection: DocumentProtection }>();
// Reader trees are immutable too. Retain the validated candidate on the actual
// dispatched Text, so a subsequent command need not parse that baseline again.
// Serialization matters: the same Text can belong to states with LF/CRLF/CR.
const readerCache = new WeakMap<Text, { lineBreak: string; reader: ReaderDocument }>();

interface FormattingEdit {
  status: EmphasisCommandStatus;
  changes: ChangeSet | null;
  selection: EditorSelection | null;
}

interface EmphasisEdit extends FormattingEdit {
  coverage: Range[];
}

export function emphasisCommandStatus(
  state: EditorState,
  command: EmphasisCommand,
  composing = false,
): EmphasisCommandStatus {
  return planEmphasis(state, command, composing).status;
}

export function applyEmphasisCommand(
  view: EditorView,
  command: EmphasisCommand,
): EmphasisCommandResult {
  const plan = planEmphasis(view.state, command, view.composing);
  if (!plan.changes || !plan.selection || !plan.status.available) {
    return { ...plan.status, handled: true, applied: false };
  }

  const transaction = formattingTransaction(view.state, plan);
  const invalid = readerRefusal(view.state, plan, command, transaction);
  if (invalid) return { ...refused(invalid).status, handled: true, applied: false };

  return dispatchFormatting(view, plan, transaction);
}

function commandRefusal(state: EditorState, composing: boolean): string | null {
  if (composing) return COMPOSITION_REASON;
  if (state.readOnly) return READ_ONLY_REASON;
  if (state.selection.ranges.length !== 1) return MULTI_SELECTION_REASON;
  return null;
}

function planEmphasis(
  state: EditorState,
  command: EmphasisCommand,
  composing: boolean,
): EmphasisEdit {
  const unavailable = commandRefusal(state, composing);
  if (unavailable) return refused(unavailable);

  const range = state.selection.main;
  const tree = treeCovering(state, range.from, range.to);
  if (!tree) return refused(LOADING_REASON);

  const protection = documentProtection(state);
  if (!protection.ok) return refused(protection.reason);

  if (range.empty) {
    const refusal = rangeRefusal(tree, range.from, range.to, protection);
    if (refusal) return refused(refusal);
    return planCaret(state, tree, command, range.head, protection);
  }
  return planSelection(
    state,
    tree,
    command,
    range.from,
    range.to,
    range.anchor > range.head,
    null,
    protection,
  );
}

function planCaret(
  state: EditorState,
  tree: Tree,
  command: EmphasisCommand,
  pos: number,
  protection: Extract<DocumentProtection, { ok: true }>,
): EmphasisEdit {
  const active = innermost(tree, pos, STYLE[command].node);
  if (active) return toggleSpan(state, tree, active, pos, false, protection);

  const word = state.wordAt(pos);
  if (!word || word.empty) return refused(STYLE[command].empty);
  return planSelection(state, tree, command, word.from, word.to, false, pos, protection);
}

function planSelection(
  state: EditorState,
  tree: Tree,
  command: EmphasisCommand,
  from: number,
  to: number,
  reversed: boolean,
  caret: number | null,
  protection: Extract<DocumentProtection, { ok: true }>,
): EmphasisEdit {
  const refusal = rangeRefusal(tree, from, to, protection);
  if (refusal) return refused(refusal);

  const nodes = emphasisNodes(tree, from, to);
  const requestedName = STYLE[command].node;
  const exactRequested = smallest(nodes.filter((node) => node.name === requestedName && isExactSpan(node, from, to)));
  if (exactRequested) return toggleSpan(state, tree, exactRequested, caret, reversed, protection);

  if (nodes.some((node) => containsRange(node, from, to) && !isExactSpan(node, from, to))) {
    return refused(PARTIAL_SPAN_REASON);
  }

  const otherName = command === "bold" ? "Emphasis" : "StrongEmphasis";
  const exactOther = smallest(nodes.filter((node) => node.name === otherName && isExactSpan(node, from, to)));
  if (exactOther) {
    if (hasNestedEmphasis(exactOther)) return refused(MIXED_SPAN_REASON);
    const inner = innerContent(exactOther);
    if (!inner) return refused(PARTIAL_SPAN_REASON);
    return wrapSpan(state, tree, command, inner, reversed, caret);
  }

  if (nodes.length > 0) return refused(MIXED_SPAN_REASON);

  const trimmed = trimEdges(state, from, to);
  if (!trimmed) return refused(STYLE[command].empty);
  return wrapSpan(state, tree, command, trimmed, reversed, caret);
}

function toggleSpan(
  state: EditorState,
  tree: Tree,
  span: SyntaxNode,
  caret: number | null,
  reversed: boolean,
  protection: Extract<DocumentProtection, { ok: true }>,
): EmphasisEdit {
  // A caret toggles the entire span, which can contain protected text elsewhere.
  const refusal = rangeRefusal(tree, span.from, span.to, protection);
  if (refusal) return refused(refusal);
  const inner = innerContent(span);
  const marks = directMarks(span);
  if (!inner || marks.length < 2) return refused(PARTIAL_SPAN_REASON);

  const changes = state.changes(marks.map((mark) => ({ from: mark.from, to: mark.to })));
  const invalid = validateEdit(state, tree, changes, span);
  if (invalid) return refused(invalid);
  const selection = resultingSelection(changes, inner, caret, reversed);
  return {
    status: { available: true, active: true, reason: null },
    changes,
    selection,
    coverage: plainSegments(span),
  };
}

function wrapSpan(
  state: EditorState,
  tree: Tree,
  command: EmphasisCommand,
  target: Range,
  reversed: boolean,
  caret: number | null,
): EmphasisEdit {
  const style = STYLE[command];
  const content = state.doc.sliceString(target.from, target.to);
  if (!content) return refused(style.empty);

  const changes = state.changes([
    { from: target.from, insert: style.marker },
    { from: target.to, insert: style.marker },
  ]);
  const invalid = validateEdit(state, tree, changes, target, command);
  if (invalid) return refused(invalid);

  return {
    status: { available: true, active: false, reason: null },
    changes,
    selection: resultingSelection(changes, target, caret, reversed),
    coverage: [target],
  };
}

/** Preliminary Edit-mode coherence checks, shared by status and Apply.
 * The authoritative reader preservation check runs only on Apply.
 */
function validateEdit(
  state: EditorState,
  tree: Tree,
  changes: ChangeSet,
  target: Range,
  added?: EmphasisCommand,
): string | null {
  if (!singleTextBlock(tree, target.from, target.to)) return CROSS_BLOCK_REASON;
  if (state.doc.sliceString(target.from, target.to).includes("\n")) return MULTILINE_REASON;
  const before = textBlockAt(tree, target.from)!;
  const from = changes.mapPos(before.from, -1);
  const to = changes.mapPos(before.to, 1);
  // Preview only: no view dispatch, autosave, or history entry. Retain the
  // language's parse fragments instead of serializing and reparsing the file.
  const candidate = state.update({ changes, filter: false }).state;
  const parsed = treeCovering(candidate, from, to);
  if (!parsed) return LOADING_REASON;
  const after = textBlockAt(parsed, from);
  if (!after || after.name !== before.name || after.from !== from || after.to !== to) {
    return CHANGED_SYNTAX_REASON;
  }
  const wrapper = added
    ? coveringEmphasis(parsed, STYLE[added].node, changes.mapPos(target.from, 1), changes.mapPos(target.to, -1))
    : null;
  if (added && !wrapper) return STYLE[added].literal;
  return null;
}

/** Whole-document reader check, specific to one emphasis wrapper. Never mutate
 * either parser tree: the baseline is shared with the existing math scan.
 * Typography transforms are deliberately outside this raw-grammar comparison.
 */
function readerRefusal(state: EditorState, plan: EmphasisEdit, command: EmphasisCommand, transaction: Transaction): string | null {
  try {
    const protection = documentProtection(state);
    if (!protection.ok) return protection.reason;
    const before = protection.reader ??= parseReader(state.doc, state.lineBreak);
    const changes = transaction.changes;
    const after = parseReader(transaction.newDoc, state.lineBreak);
    const adding = !plan.status.active;
    const wrapped = adding ? after : before;
    const expected = plan.coverage.map(({ from, to }) => ({
      from: (adding ? changes.mapPos(from, 1) : from) - wrapped.offset,
      to: (adding ? changes.mapPos(to, -1) : to) - wrapped.offset,
    }));
    const matches: (Nodes & { children: Nodes[] })[] = [];
    visit(wrapped.tree, command === "bold" ? "strong" : "emphasis", (node) => {
      if (JSON.stringify(readerCoverage(node)) === JSON.stringify(expected)) matches.push(node);
    });
    if (matches.length !== 1) return CHANGED_SYNTAX_REASON;
    const authorized = matches[0];
    return JSON.stringify(readerSemantics(before.tree, adding ? null : authorized))
      === JSON.stringify(readerSemantics(after.tree, adding ? authorized : null))
      ? null : CHANGED_SYNTAX_REASON;
  } catch (error) {
    return isDocumentComplexityError(error) ? COMPLEXITY_REASON : CHANGED_SYNTAX_REASON;
  }
}

function parseReader(doc: Text, lineBreak: string): ReaderDocument {
  const cached = readerCache.get(doc);
  if (cached?.lineBreak === lineBreak) return cached.reader;
  const source = doc.sliceString(0, doc.length, lineBreak);
  assertDocumentComplexity(source, "markdown");
  // Extract exactly as MarkdownRenderer does, including invalid/scalar YAML
  // fallback and a second frontmatter block at the start of the extracted body.
  // Serialize for extraction (CR-only differs from LF), then normalize parser
  // offsets to CodeMirror units. No serialized editor content is rewritten.
  const { body } = extractFrontmatter(source);
  const normalized = lineBreak === "\n" ? body : body.split(lineBreak).join("\n");
  const text = withoutByteOrderMark(normalized);
  const reader = { tree: mathDocument.parse(text), offset: doc.length - text.length };
  readerCache.set(doc, { lineBreak, reader });
  return reader;
}

function readerCoverage(node: Nodes): Range[] {
  const marks: Range[] = [];
  function collect(current: Nodes): void {
    if (!("children" in current)) return;
    if (current.type === "strong" || current.type === "emphasis") {
      const start = current.position?.start.offset;
      const end = current.position?.end.offset;
      const from = current.children[0]?.position?.start.offset;
      const to = current.children[current.children.length - 1]?.position?.end.offset;
      if (start == null || end == null || from == null || to == null) throw new Error("Missing emphasis coverage");
      marks.push({ from: start, to: from }, { from: to, to: end });
    }
    for (const child of current.children) collect(child);
  }
  collect(node);
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from == null || to == null ? [] : segmentsWithoutMarks({ from, to }, marks);
}

interface ReaderSemantics {
  type: string;
  value?: string;
  children?: ReaderSemantics[];
}

function readerSemantics(node: Nodes, authorized: Nodes | null): ReaderSemantics {
  const { position: _position, ...properties } = node;
  const result: ReaderSemantics = { ...properties };
  if ("children" in node) {
    const children: ReaderSemantics[] = [];
    for (const child of node.children) {
      const unwrapped = child === authorized && "children" in child ? child.children : [child];
      for (const item of unwrapped) {
        const next = readerSemantics(item, authorized);
        const previous = children[children.length - 1];
        // Raw grammar text nodes have only type/value. Retain any future
        // metadata rather than merging it away along with node boundaries.
        if (previous?.type === "text" && next.type === "text"
          && Object.keys(previous).length === 2 && Object.keys(next).length === 2) {
          previous.value! += next.value!;
        } else children.push(next);
      }
    }
    result.children = children;
  }
  return result;
}

function resultingSelection(
  changes: ChangeSet,
  target: Range,
  caret: number | null,
  reversed: boolean,
): EditorSelection {
  if (caret != null) {
    const mapped = caret <= target.from
      ? changes.mapPos(target.from, 1)
      : caret >= target.to
        ? changes.mapPos(target.to, -1)
        : changes.mapPos(caret, 1);
    return EditorSelection.create([EditorSelection.cursor(mapped)]);
  }
  const from = changes.mapPos(target.from, 1);
  const to = changes.mapPos(target.to, -1);
  return EditorSelection.create([
    reversed ? EditorSelection.range(to, from) : EditorSelection.range(from, to),
  ]);
}

function rangeRefusal(
  tree: Tree,
  from: number,
  to: number,
  protection: Extract<DocumentProtection, { ok: true }>,
): string | null {
  return protectedRangeRefusal(protection, from, to, syntaxRefusal(tree, from, to));
}

function protectedRangeRefusal(
  protection: DocumentProtection,
  from: number,
  to: number,
  syntaxReason: string | null,
): string | null {
  if (!protection.ok) return protection.reason;
  if (protection.metadata && intersects(protection.metadata, from, to)) return METADATA_REASON;
  if (syntaxReason) return syntaxReason;
  if (protection.ranges.some((span) => intersects(span, from, to))) return MATH_REASON;
  return null;
}

function refused(reason: string): EmphasisEdit {
  return {
    status: { available: false, active: false, reason },
    changes: null,
    selection: null,
    coverage: [],
  };
}

function treeCovering(state: EditorState, from: number, to: number): Tree | null {
  const doc = state.doc;
  const probed = Math.max(from, to);
  const line = doc.lineAt(Math.max(0, Math.min(probed, doc.length)));
  const upto = line.number < doc.lines ? doc.line(line.number + 1).to : doc.length;
  // ensureSyntaxTree returns the current parse context, even when a previous
  // query advanced it beyond the tree snapshot stored on this EditorState.
  const parsed = ensureSyntaxTree(state, upto, 50);
  if (!parsed || parsed.length < upto) return null;
  return parsed;
}

/**
 * Document-leading `---` metadata, including a leading BOM and both fences.
 * An opening fence without a closing `---` protects the rest of the document.
 * `...` does not close the fence. One line of `---` without a following line
 * is not metadata.
 */
function leadingMetadataRange(state: EditorState): Range | null {
  const doc = state.doc;
  if (doc.lines < 2) return null;
  const opening = doc.line(1).text.replace(/^\uFEFF/, "");
  if (!FRONTMATTER_FENCE.test(opening)) return null;
  for (let number = 2; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (FRONTMATTER_FENCE.test(line.text)) return { from: 0, to: line.to };
  }
  return { from: 0, to: doc.length };
}

function documentProtection(state: EditorState): DocumentProtection {
  const cached = protectionCache.get(state.doc);
  if (cached?.lineBreak === state.lineBreak) return cached.protection;
  let protection: DocumentProtection;
  try {
    // Preserve the existing cold math scan on status. Apply reuses its tree;
    // non-math status never acquires a reader parse.
    const reader = state.doc.toString().includes("$$") ? parseReader(state.doc, state.lineBreak) : null;
    const ranges: Range[] = [];
    if (reader) visit(reader.tree, (node) => {
      if (node.type !== "math" && node.type !== "inlineMath") return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null) throw new Error("Missing math coverage");
      if (end > start) ranges.push({ from: start + reader.offset, to: end + reader.offset });
    });
    protection = { ok: true, ranges, metadata: leadingMetadataRange(state), reader };
  } catch (error) {
    protection = { ok: false, reason: isDocumentComplexityError(error) ? COMPLEXITY_REASON : LOADING_REASON };
  }
  protectionCache.set(state.doc, { lineBreak: state.lineBreak, protection });
  return protection;
}

function syntaxRefusal(tree: Tree, from: number, to: number): string | null {
  if (from === to) return protectedAncestor(tree, from);
  let reason: string | null = null;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (reason) return false;
      if (node.from < to && node.to > from) {
        const next = reasonForSyntax(node.name);
        if (next) {
          reason = next;
          return false;
        }
      }
    },
  });
  return reason;
}

function protectedAncestor(tree: Tree, pos: number): string | null {
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.from <= pos && pos < node.to) {
        const reason = reasonForSyntax(node.name);
        if (reason) return reason;
      }
    }
  }
  return null;
}

function reasonForSyntax(name: string): string | null {
  if (name === "HeaderMark") return HEADING_MARKER_REASON;
  if (name === "TaskMarker") return TASK_MARKER_REASON;
  if (
    name === "InlineCode"
    || name === "FencedCode"
    || name === "CodeBlock"
    || name === "CodeText"
    || name === "CodeMark"
  ) return "Move out of code to format text.";
  if (name === "HTMLBlock" || name === "HTMLTag") return "Move out of HTML to format text.";
  if (name.startsWith("Table")) return "Move out of the table to format text.";
  if (
    name === "Link"
    || name === "Image"
    || name === "Autolink"
    || name === "URL"
    || name === "LinkMark"
  ) return "Move out of the link to format text.";
  return null;
}

function singleTextBlock(tree: Tree, from: number, to: number): boolean {
  if (from >= to) return false;
  const start = textBlockAt(tree, from);
  const end = textBlockAt(tree, to - 1);
  return !!start
    && !!end
    && start.from === end.from
    && start.to === end.to
    && start.from <= from
    && to <= start.to;
}

function textBlockAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (TEXT_BLOCK.test(node.name) && node.from <= pos && pos < node.to) return node;
  }
  return null;
}

function emphasisNodes(tree: Tree, from: number, to: number): SyntaxNode[] {
  if (from === to) {
    const found: SyntaxNode[] = [];
    for (let node: SyntaxNode | null = tree.resolveInner(from, -1); node; node = node.parent) {
      if ((node.name === "Emphasis" || node.name === "StrongEmphasis") && node.from <= from && from < node.to) {
        found.push(node);
      }
    }
    return found;
  }
  const found: SyntaxNode[] = [];
  tree.iterate({
    from,
    to,
    enter(node) {
      if (
        (node.name === "Emphasis" || node.name === "StrongEmphasis")
        && node.from < to
        && node.to > from
      ) found.push(node.node);
    },
  });
  return found;
}

function innermost(tree: Tree, pos: number, name: string): SyntaxNode | null {
  let best: SyntaxNode | null = null;
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === name && node.from <= pos && pos < node.to) {
        if (!best || node.to - node.from < best.to - best.from) best = node;
        break;
      }
    }
  }
  return best;
}

function isExactSpan(node: SyntaxNode, from: number, to: number): boolean {
  if (node.from === from && node.to === to) return true;
  const inner = innerContent(node);
  return !!inner && inner.from === from && inner.to === to;
}

function containsRange(node: Range, from: number, to: number): boolean {
  return node.from <= from && node.to >= to;
}

function smallest(nodes: SyntaxNode[]): SyntaxNode | null {
  let best: SyntaxNode | null = null;
  for (const node of nodes) {
    if (!best || node.to - node.from < best.to - best.from) best = node;
  }
  return best;
}

function innerContent(node: SyntaxNode): Range | null {
  const marks = directMarks(node);
  if (marks.length < 2) return null;
  const opening = marks[0];
  const closing = marks[marks.length - 1];
  if (!opening || !closing || opening.to > closing.from) return null;
  return { from: opening.to, to: closing.from };
}

function directMarks(node: SyntaxNode): SyntaxNode[] {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "EmphasisMark") marks.push(child);
  }
  return marks;
}

function hasNestedEmphasis(node: SyntaxNode): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Emphasis" || child.name === "StrongEmphasis") return true;
    if (hasNestedEmphasis(child)) return true;
  }
  return false;
}

function coveringEmphasis(tree: Tree, name: string, from: number, to: number): SyntaxNode | null {
  let matched: SyntaxNode | null = null;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name !== name) return;
      const segments = plainSegments(node.node);
      if (segments.length === 1 && segments[0]?.from === from && segments[0]?.to === to) matched = node.node;
    },
  });
  return matched;
}

function plainSegments(node: SyntaxNode): Range[] {
  const inner = innerContent(node);
  if (!inner) return [];
  const marks: Range[] = [];
  collectMarks(node, inner.from, inner.to, marks);
  return segmentsWithoutMarks(inner, marks);
}

function segmentsWithoutMarks(range: Range, marks: Range[]): Range[] {
  marks.sort((left, right) => left.from - right.from || left.to - right.to);
  const segments: Range[] = [];
  let cursor = range.from;
  for (const mark of marks) {
    if (mark.from > cursor) segments.push({ from: cursor, to: mark.from });
    cursor = Math.max(cursor, mark.to);
  }
  if (cursor < range.to) segments.push({ from: cursor, to: range.to });
  return segments;
}

function collectMarks(node: SyntaxNode, from: number, to: number, marks: Range[]): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "EmphasisMark" && child.from >= from && child.to <= to) {
      marks.push({ from: child.from, to: child.to });
    }
    collectMarks(child, from, to, marks);
  }
}

function trimEdges(state: EditorState, from: number, to: number): Range | null {
  let start = from;
  let end = to;
  while (start < end && isEdgeWhitespace(state.doc.sliceString(start, start + 1))) start += 1;
  while (end > start && isEdgeWhitespace(state.doc.sliceString(end - 1, end))) end -= 1;
  if (start >= end) return null;
  return { from: start, to: end };
}

function isEdgeWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function intersects(span: Range, from: number, to: number): boolean {
  if (from === to) return span.from <= from && from < span.to;
  return span.from < to && from < span.to;
}

export type ListCommand = "bullets" | "numbered" | "checklist" | "indent" | "outdent";
export type ListCommandStatus = EmphasisCommandStatus;
export type ListCommandResult = EmphasisCommandResult;

const LIST_LEVEL_REASON = "Place the cursor in a list to change its level.";
const LIST_PARENT_REASON = "An item needs a preceding sibling to indent under.";
const LIST_TOP_REASON = "This item is already at the top level.";
const LIST_SELECTION_REASON = "Select ordinary lines or adjacent items in one list.";
const LIST_STRUCTURE_REASON = "Select a list with ordinary text and supported sub-items.";
const LIST_REMOVAL_REASON = "Outdent sub-items before removing this list.";
const LIST_INLINE_REASON = "This would change formatting, a link or a line break across these lines. Edit the Markdown directly.";
const INLINE_SPAN = /^(?:Emphasis|StrongEmphasis|Strikethrough|Link|Image)$/;

interface ListItemInfo {
  node: SyntaxNode;
  list: SyntaxNode;
  line: number;
  endLine: number;
  indent: number;
  contentColumn: number;
  prefixEnd: number;
  marker: string;
  spacing: string;
  number: number | null;
  task: string | null;
  taskSpacing: string;
}

interface ListContext {
  tree: Tree;
  fromLine: number;
  toLine: number;
  items: ListItemInfo[];
}

export function listCommandStatus(state: EditorState, command: ListCommand, composing = false): ListCommandStatus {
  return planList(state, command, composing).status;
}

export function applyListCommand(view: EditorView, command: ListCommand): ListCommandResult {
  return dispatchFormatting(view, planList(view.state, command, view.composing));
}

function formattingTransaction(state: EditorState, plan: FormattingEdit): Transaction {
  return state.update({ changes: plan.changes!, selection: plan.selection!,
    annotations: isolateHistory.of("full"), userEvent: "input" });
}

function dispatchFormatting(view: EditorView, plan: FormattingEdit, transaction?: Transaction): EmphasisCommandResult {
  if (!plan.changes || !plan.selection || !plan.status.available) {
    return { ...plan.status, handled: true, applied: false };
  }
  const before = view.state.doc;
  view.dispatch(transaction ?? formattingTransaction(view.state, plan));
  if (view.state.doc.eq(before)) {
    return { available: false, active: false, reason: READ_ONLY_REASON, handled: true, applied: false };
  }
  return { ...plan.status, handled: true, applied: true };
}

function sameNode(a: SyntaxNode | null, b: SyntaxNode | null): boolean {
  return !!a && !!b && a.from === b.from && a.to === b.to && a.name === b.name;
}

function ancestor(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (; node; node = node.parent) if (node.name === name) return node;
  return null;
}

export function listMarkerSpacing(afterMarker: string): string {
  return /^ */.exec(afterMarker)![0];
}

function listItem(state: EditorState, node: SyntaxNode): ListItemInfo | null {
  const line = state.doc.lineAt(node.from);
  const mark = node.getChild("ListMark");
  if (!mark || !node.parent) return null;
  const indent = node.from - line.from;
  if (!/^ *$/.test(line.text.slice(0, indent))) return null;
  const marker = state.doc.sliceString(mark.from, mark.to);
  const tail = state.doc.sliceString(mark.to, line.to);
  const spacing = listMarkerSpacing(tail);
  if (spacing.length > 4 || tail.startsWith("\t")) return null;
  const taskNode = node.getChild("Task")?.getChild("TaskMarker");
  const contentColumn = mark.to - line.from + (spacing.length || 1);
  let prefixEnd = Math.min(line.to, line.from + contentColumn);
  let task: string | null = null;
  let taskSpacing = " ";
  if (taskNode) {
    task = state.doc.sliceString(taskNode.from, taskNode.to);
    const after = listMarkerSpacing(state.doc.sliceString(taskNode.to, line.to));
    prefixEnd = taskNode.to + after.length;
    taskSpacing = after || " ";
  }
  return { node, list: node.parent, line: line.number, endLine: state.doc.lineAt(node.to).number,
    indent, contentColumn, prefixEnd, marker, spacing: spacing || " ",
    number: /^\d/.test(marker) ? Number(marker.slice(0, -1)) : null, task, taskSpacing };
}

/** Continuation needs this line's own item, never an ancestor's marker. */
export function listItemAtCursor(state: EditorState): ListItemInfo | null {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return null;
  const line = state.doc.lineAt(range.head);
  const node = ancestor(syntaxTree(state).resolveInner(range.head, -1), "ListItem");
  if (!node || state.doc.lineAt(node.from).number !== line.number) return null;
  return listItem(state, node);
}

// A block selection is half-open. A touched item expands to its complete
// continuation/subtree; a selected ancestor owns its descendants only once.
function selectedBlockLines(state: EditorState) {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1));
  let tree = treeCovering(state, first.from, last.to);
  if (!tree) return LOADING_REASON;
  // The containing list must be complete, not a truncated parser frontier.
  const atFrontier = [first, last].some((line) => {
    let node = tree!.resolveInner(line.from + line.text.search(/\S|$/), 1);
    while (node.parent && node.parent.name !== "Document") node = node.parent;
    return node.to >= tree!.length;
  });
  if (atFrontier && tree.length < state.doc.length) {
    tree = treeCovering(state, first.from, state.doc.length);
    if (!tree) return LOADING_REASON;
  }
  return { first, last, tree };
}

function listContext(state: EditorState): ListContext | string {
  const selected = selectedBlockLines(state);
  if (typeof selected === "string") return selected;
  const { first, last, tree } = selected;
  const range = state.selection.main;
  const touched: SyntaxNode[] = [];
  let plain = false;
  for (let number = first.number; number <= last.number; number++) {
    const line = state.doc.line(number);
    if (!line.text.trim() && !range.empty) continue;
    const pos = line.from + line.text.search(/\S|$/);
    const item = ancestor(tree.resolveInner(pos, 1), "ListItem");
    if (item && item.from <= line.to && item.to >= line.from) touched.push(item);
    else plain = true;
  }
  const roots: SyntaxNode[] = [];
  for (const item of touched) {
    const previous = roots[roots.length - 1];
    if (previous && previous.from <= item.from && previous.to >= item.to) continue;
    // A selection can start in a descendant and then touch its parent's later
    // continuation. Include that parent once, with its complete subtree.
    while (roots.length && item.from <= roots[roots.length - 1].from && item.to >= roots[roots.length - 1].to) roots.pop();
    roots.push(item);
  }
  if (plain && roots.length) return LIST_SELECTION_REASON;
  const items: ListItemInfo[] = [];
  for (const root of roots) {
    const item = listItem(state, root);
    if (!item) return LIST_STRUCTURE_REASON;
    if (items.length && !sameNode(items[0].list, item.list)) return LIST_SELECTION_REASON;
    items.push(item);
  }
  const fromLine = items[0]?.line ?? first.number;
  const toLine = items[items.length - 1]?.endLine ?? last.number;
  const from = state.doc.line(fromLine).from;
  const to = state.doc.line(toLine).to;
  const invalid = listRangeRefusal(state, tree, from, to);
  if (invalid) return invalid;
  if (from === 0 && state.doc.sliceString(0, 1) === "\uFEFF") return "Edit the first line's list markers directly when it has a byte-order mark.";
  return { tree, fromLine, toLine, items };
}

function listRangeRefusal(state: EditorState, tree: Tree, from: number, to: number): string | null {
  for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
    if (/^ *\t/.test(state.doc.line(number).text)) return LIST_STRUCTURE_REASON;
  }
  return protectedRangeRefusal(documentProtection(state), from, to, listSyntaxRefusal(state, tree, from, to));
}

function listSyntaxRefusal(state: EditorState, tree: Tree, from: number, to: number): string | null {
  let reason: string | null = null;
  tree.iterate({ from, to, enter(node) {
    if (node.to < from || node.from > to || (from !== to && (node.to === from || node.from === to))) return false;
    if (node.name === "OrderedList") {
      const first = node.node.firstChild;
      const previous = node.node.prevSibling;
      const item = first && listItem(state, first);
      if (item && item.number !== 1 && previous && /^(?:Paragraph|Task)$/.test(previous.name)
        && state.doc.lineAt(previous.to).number + 1 === item.line) {
        reason = "This numbered run needs a blank line before it.";
        return false;
      }
    }
    // Links/emphasis inside one block are content. Spans across changed block
    // boundaries are checked separately by inlineBoundaryRefusal.
    if (/^(?:Link|Image|Autolink|URL|LinkMark|TaskMarker)$/.test(node.name)) return;
    const protectedReason = reasonForSyntax(node.name);
    if (protectedReason) { reason = protectedReason; return false; }
    if (/^(?:Blockquote|ATXHeading[1-6]|SetextHeading[12]|HorizontalRule|LinkReference)$/.test(node.name)) {
      reason = LIST_STRUCTURE_REASON;
      return false;
    }
  } });
  return reason;
}

function itemKind(item: ListItemInfo): "bullets" | "numbered" | "checklist" {
  return item.task ? "checklist" : item.number === null ? "bullets" : "numbered";
}

function planList(state: EditorState, command: ListCommand, composing: boolean): FormattingEdit {
  const unavailable = commandRefusal(state, composing);
  if (unavailable) return refused(unavailable);
  const context = listContext(state);
  if (typeof context === "string") return refused(context);
  const { items, fromLine, toLine } = context;
  if (command === "indent" || command === "outdent") return planListIndent(state, context, command);
  const remove = items.length > 0 && items.every((item) => itemKind(item) === command);
  if (remove && items.some((item) => item.list.parent?.name !== "Document"
    || item.node.getChild("BulletList") || item.node.getChild("OrderedList"))) return refused(LIST_REMOVAL_REASON);
  const edits: ChangeSpec[] = [];
  let ordered = command === "numbered";
  let marker = ordered ? "." : "-";
  let nextNumber = 1;
  const first = items[0];
  if (first && command === "numbered" && first.number !== null) {
    marker = first.marker.slice(-1); nextNumber = first.number;
  } else if (first && command === "bullets" && first.number === null) marker = first.marker;
  // A new empty item following a list uses that list's authored style/start.
  let extending = false;
  if (!first && fromLine === toLine && !state.doc.line(fromLine).text.trim() && fromLine > 1) {
    const previousLine = state.doc.line(fromLine - 1);
    const previous = ancestor(context.tree.resolveInner(previousLine.to, -1), "ListItem");
    const previousItem = previous && listItem(state, previous);
    if (previousItem && previousItem.list.parent?.name === "Document"
      && (command === "checklist" || (command === "numbered") === (previousItem.number !== null))) {
      ordered = previousItem.number !== null;
      marker = ordered ? previousItem.marker.slice(-1) : previousItem.marker;
      nextNumber = (previousItem.number ?? 0) + 1; extending = true;
    }
  }
  if (items.length) {
    for (const item of items) {
      const prefix = remove ? "" : command === "checklist" ? item.marker + item.spacing
        : command === "numbered" ? item.number !== null ? item.marker + item.spacing : `${nextNumber++}${marker}${item.spacing}`
          : `${marker}${item.spacing}`;
      const task = !remove && command === "checklist" ? item.task ?? "[ ]" : null;
      changeItem(state, item, item.indent, prefix, edits, task);
    }
  } else {
    for (let number = fromLine; number <= toLine; number++) {
      const line = state.doc.line(number);
      if (!line.text.trim() && fromLine !== toLine) continue;
      const leading = /^ */.exec(line.text)![0].length;
      if (leading > 3 || /^ *\t/.test(line.text)) return refused(LIST_STRUCTURE_REASON);
      const glyph = command === "bullets" ? /^[•◦▪](?: +|$)/.exec(line.text.slice(leading))?.[0].length ?? 0 : 0;
      const prefix = (ordered ? `${nextNumber++}${marker} ` : `${marker} `)
        + (command === "checklist" ? "[ ] " : "");
      edits.push({ from: line.from, to: line.from + leading + glyph,
        insert: prefix + line.text.slice(0, leading) });
    }
  }
  const changingContainer = first && command !== "checklist"
    && (command === "numbered") !== (first.number !== null);
  if (!extending && (!first || remove || changingContainer)) {
    addListBoundaries(state, fromLine, toLine, edits, !first || first.list.parent?.name === "Document"
      ? undefined : { before: !!first.node.prevSibling, after: !!items[items.length - 1].node.nextSibling });
  }
  return finishListEdit(state, edits, remove, context, command);
}

// Replace only prefixes. Descendants and continuation content keep their
// relative columns; lazy continuations gain the required content indentation.
function changeItem(state: EditorState, item: ListItemInfo, indent: number, prefix: string, edits: ChangeSpec[], task: string | null = null): void {
  const line = state.doc.line(item.line);
  edits.push({ from: line.from, to: item.prefixEnd, insert: " ".repeat(indent) + prefix + (task ? task + (task === item.task ? item.taskSpacing : " ") : "") });
  const newContentColumn = indent + prefix.length;
  const delta = newContentColumn - item.contentColumn;
  for (let number = item.line + 1; number <= item.endLine; number++) {
    const continued = state.doc.line(number);
    if (!continued.text.trim()) continue;
    const spaces = /^ */.exec(continued.text)![0].length;
    const column = Math.max(item.contentColumn, spaces) + delta;
    if (column !== spaces) edits.push({ from: continued.from, to: continued.from + spaces, insert: " ".repeat(column) });
  }
}

function addListBoundaries(state: EditorState, fromLine: number, toLine: number, edits: ChangeSpec[], sides = { before: true, after: true }): void {
  if (sides.before && fromLine > 1 && state.doc.line(fromLine - 1).text.trim()) {
    edits.unshift({ from: state.doc.line(fromLine).from, insert: state.lineBreak });
  }
  if (sides.after && toLine < state.doc.lines && state.doc.line(toLine + 1).text.trim()) {
    edits.push({ from: state.doc.line(toLine).to, insert: state.lineBreak });
  }
}

function finishListEdit(state: EditorState, edits: ChangeSpec[], active: boolean, context: ListContext, command: ListCommand): FormattingEdit {
  if (!edits.length) return refused(LIST_SELECTION_REASON);
  const changes = state.changes(edits);
  const selection = mapBlockSelection(state, changes);
  // Structural edits deliberately aren't sent through the emphasis comparator.
  // Check newly exposed block syntax and inline continuity at changed lines;
  // reader outcomes are covered directly by list-specific renderer tests.
  const candidate = state.update({ changes, selection }).state;
  const from = changes.mapPos(state.doc.line(context.fromLine).from, -1);
  const to = changes.mapPos(state.doc.line(context.toLine).to, 1);
  const tree = treeCovering(candidate, from, to);
  if (!tree) return refused(LOADING_REASON);
  const invalid = listSyntaxRefusal(candidate, tree, from, to);
  if (invalid) return refused(invalid);
  // Prefix/indent edits cannot introduce dollar runs outside these items.
  // Recheck possible newly exposed math here, without reparsing an unchanged
  // remote math block for every status query on an ordinary list item.
  if (candidate.doc.sliceString(from, to).includes("$$")) {
    const math = protectedRangeRefusal(documentProtection(candidate), from, to, null);
    if (math) return refused(math);
  }
  const roots = context.items.length ? context.items.map((item) => ({ line: item.line, item }))
    : Array.from({ length: context.toLine - context.fromLine + 1 }, (_, index) => ({ line: context.fromLine + index, item: null }));
  const boundaries: number[] = [];
  const mappedBoundaries: number[] = [];
  if (context.toLine < state.doc.lines) {
    const next = state.doc.line(context.toLine + 1).from;
    boundaries.push(next);
    mappedBoundaries.push(changes.mapPos(next, 1));
  }
  for (const root of roots) {
    const oldLine = state.doc.line(root.line);
    if (!root.item && !oldLine.text.trim() && roots.length > 1) continue;
    const line = candidate.doc.lineAt(changes.mapPos(oldLine.from, 1));
    boundaries.push(oldLine.from);
    mappedBoundaries.push(line.from);
    const node = ancestor(tree.resolveInner(line.from + line.text.search(/\S|$/), 1), "ListItem");
    const item = node && listItem(candidate, node);
    const expected = command === "indent" || command === "outdent" ? itemKind(root.item!) : command;
    if (active ? !!item : !item || itemKind(item) !== expected) return refused(LIST_STRUCTURE_REASON);
    if (!root.item && item && (item.list.parent?.name !== "Document"
      || item.node.getChild("BulletList") || item.node.getChild("OrderedList"))) return refused(LIST_STRUCTURE_REASON);
  }
  const crossing = inlineBoundaryRefusal(state, context.tree, boundaries)
    ?? inlineBoundaryRefusal(candidate, tree, mappedBoundaries);
  if (crossing) return refused(crossing);
  return { status: { available: true, active, reason: null }, changes, selection };
}

/** Each root's first line and the line after the run change block membership.
 * Inline syntax across one of them before the edit would split; after it, join.
 * Two-space hard breaks are invisible either way. Single-tilde strike exists
 * only in the reader dialect, so a paragraph containing `~` is parsed with the
 * reader grammar, limited to that paragraph.
 */
function inlineBoundaryRefusal(state: EditorState, tree: Tree, boundaries: number[]): string | null {
  const paragraphs = new Map<number, { to: number; boundaries: number[] }>();
  for (const pos of boundaries) {
    let paragraph: SyntaxNode | null = null;
    for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node && !paragraph; node = node.parent) {
      if (INLINE_SPAN.test(node.name) && node.from < pos) return LIST_INLINE_REASON;
      if (node.name === "Paragraph") paragraph = node;
    }
    if (!paragraph || paragraph.from >= pos) continue;
    const previous = tree.resolveInner(pos, -1);
    if (previous.name === "HardBreak" && previous.to === pos
      && state.doc.sliceString(previous.from, previous.from + 1) === "\\") return LIST_INLINE_REASON;
    const entry = paragraphs.get(paragraph.from) ?? { to: paragraph.to, boundaries: [] };
    entry.boundaries.push(pos);
    paragraphs.set(paragraph.from, entry);
  }
  for (const [from, entry] of paragraphs) {
    const text = state.doc.sliceString(from, entry.to);
    if (!text.includes("~")) continue;
    if (!checkDocumentComplexity(text, "markdown").ok) return COMPLEXITY_REASON;
    // One long paragraph may have thousands of changed line boundaries and
    // strike spans. Find the first boundary after each span's start instead
    // of rescanning every boundary for every span.
    entry.boundaries.sort((a, b) => a - b);
    let crossing = false;
    visit(mathDocument.parse(text), "delete", (node) => {
      const start = from + (node.position?.start.offset ?? 0);
      const end = from + (node.position?.end.offset ?? text.length);
      let low = 0, high = entry.boundaries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (entry.boundaries[middle] <= start) low = middle + 1;
        else high = middle;
      }
      if (low < entry.boundaries.length && entry.boundaries[low] < end) crossing = true;
    });
    if (crossing) return LIST_INLINE_REASON;
  }
  return null;
}


function planListIndent(state: EditorState, context: ListContext, command: "indent" | "outdent"): FormattingEdit {
  const { items } = context;
  if (!items.length) return refused(LIST_LEVEL_REASON);
  const first = items[0], last = items[items.length - 1];
  const edits: ChangeSpec[] = [];
  let indent: number;
  let marker: string;
  let nextNumber: number;
  let spacing: string;
  if (command === "indent") {
    const previousNode = first.node.prevSibling;
    const parent = previousNode?.name === "ListItem" ? listItem(state, previousNode) : null;
    if (!parent) return refused(LIST_PARENT_REASON);
    indent = parent.contentColumn;
    const childList = parent.node.lastChild;
    const joining = childList?.name === first.list.name ? childList : null;
    const child = joining?.lastChild;
    const previousChild = child?.name === "ListItem" ? listItem(state, child) : null;
    if (joining) {
      const invalid = listSyntaxRefusal(state, context.tree, joining.from, joining.to);
      if (invalid) return refused(invalid);
    }
    marker = previousChild?.marker ?? first.marker;
    spacing = previousChild?.spacing ?? first.spacing;
    nextNumber = previousChild?.number != null ? previousChild.number + 1 : 1;
    const invalid = renumberFollowing(state, context, last, -items.length, edits);
    if (invalid) return refused(invalid);
  } else {
    const parentNode = first.list.parent;
    const parent = parentNode?.name === "ListItem" ? listItem(state, parentNode) : null;
    if (!parent) return refused(LIST_TOP_REASON);
    // With Markdown's contiguous subtrees, a trailing sibling cannot stay
    // under the old parent after an earlier sibling moves out, without either
    // reordering words or reparenting untouched items. Ask for that run together.
    if (last.node.nextSibling || !sameNode(parent.node.lastChild, first.list)) {
      return refused("Select the trailing sibling items together to outdent them.");
    }
    indent = parent.indent;
    const joining = first.list.name === parent.list.name;
    marker = joining ? parent.marker : first.marker;
    spacing = joining ? parent.spacing : first.spacing;
    nextNumber = joining ? (parent.number ?? 0) + 1 : first.number ?? 1;
    if (joining) {
      const invalid = renumberFollowing(state, context, parent, items.length, edits);
      if (invalid) return refused(invalid);
    } else {
      addListBoundaries(state, context.fromLine, context.toLine, edits);
    }
  }
  for (const item of items) {
    const prefix = /^\d/.test(marker) ? `${nextNumber++}${marker.slice(-1)}${spacing}` : marker + spacing;
    changeItem(state, item, indent, prefix, edits, item.task);
  }
  return finishListEdit(state, edits, false, context, command);
}

// Only the sequential suffix of the affected ordered run changes. Authored
// restarts and other lists remain intact, including when marker widths cross 9.
function renumberFollowing(state: EditorState, context: ListContext, after: ListItemInfo, delta: number, edits: ChangeSpec[]): string | null {
  if (after.number === null) return null;
  let expected = after.number + 1;
  for (let node = after.node.nextSibling; node; node = node.nextSibling) {
    const item = listItem(state, node);
    if (!item || item.number !== expected) break;
    if (expected + delta > 999999999 || expected + delta < 0) return "This numbering exceeds Markdown's supported range.";
    const invalid = listRangeRefusal(state, context.tree, item.node.from, item.node.to);
    if (invalid) return invalid;
    changeItem(state, item, item.indent, `${expected + delta}${item.marker.slice(-1)}${item.spacing}`, edits, item.task);
    expected++;
  }
  return null;
}


/** Existing Mod-[ / Mod-] keep generic indentation outside lists. A refused
 * list edit is consumed, so fixed-width fallback cannot damage the hierarchy. */
export function listAwareIndent(view: EditorView, command: "indent" | "outdent", report?: (result: EmphasisCommandResult) => void): boolean {
  if (view.composing || view.state.readOnly) {
    report?.({ ...refused(commandRefusal(view.state, view.composing)!).status, handled: true, applied: false });
    return true;
  }
  const { state } = view;
  const ranges = state.selection.ranges;
  const tree = treeCovering(state, ranges[0].from, ranges[ranges.length - 1].to);
  if (!tree) {
    report?.({ ...refused(LOADING_REASON).status, handled: true, applied: false });
    return true;
  }
  let inList = false;
  for (const selected of state.selection.ranges) {
    tree.iterate({ from: selected.from, to: selected.to, enter(node) {
      if (node.name === "ListItem" && (selected.empty
        ? node.from <= selected.head && node.to >= selected.head
        : intersects(node, selected.from, selected.to))) inList = true;
    } });
  }
  if (inList) {
    const result = applyListCommand(view, command);
    report?.(result);
    return result.handled;
  }
  return (command === "indent" ? indentMore : indentLess)(view);
}

export type BlockCommand = "paragraph" | "h1" | "h2" | "h3" | "divider" | "quote";
export interface BlockCommandStatus extends EmphasisCommandStatus {
  /** Zero is prose; null is mixed/unsupported. Existing H4–H6 stay distinct. */
  headingLevel: number | null;
}
const BLOCK_REASON = "Select an ordinary paragraph or a supported heading.";
const QUOTE_REASON = "Select ordinary text or one complete simple quote.";
const SETEXT_REASON = "Edit this Setext heading directly.";

type BlockLines = Exclude<ReturnType<typeof selectedBlockLines>, string>;

function topBlock(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node?.parent && node.parent.name !== "Document") node = node.parent;
  return node?.name !== "Document" && node && node.from <= pos && pos < node.to ? node : null;
}

function touchedBlocks({ tree, first, last }: BlockLines): SyntaxNode[] {
  const blocks: SyntaxNode[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.from <= last.to && node.to >= first.from
      && (first.from === last.to || (node.to > first.from && node.from < last.to))) blocks.push(node);
  }
  return blocks;
}

/** Structural content guards allow inline links/emphasis, never code/HTML/math. */
function blockContentRefusal(state: EditorState, tree: Tree, from: number, to: number): string | null {
  let invalid: string | null = null;
  tree.iterate({ from, to, enter(node) {
    if (!intersects(node, from, to)) return false;
    if (/^(?:HeaderMark|QuoteMark|Link|Image|Autolink|URL|LinkMark|TaskMarker)$/.test(node.name)) return;
    invalid ??= reasonForSyntax(node.name);
    if (node.name === "LinkReference") invalid = BLOCK_REASON;
    return !invalid;
  } });
  return protectedRangeRefusal(documentProtection(state), from, to, invalid);
}

function mapBlockSelection(state: EditorState, changes: ChangeSet): EditorSelection {
  const range = state.selection.main;
  const map = (pos: number, end: boolean) => {
    const line = state.doc.lineAt(pos);
    return changes.mapPos(pos, end || (range.empty && pos === line.to && line.length > 0) ? -1 : 1);
  };
  return EditorSelection.single(map(range.anchor, !range.empty && range.anchor > range.head),
    map(range.head, !range.empty && range.anchor <= range.head));
}

function blockEdit(state: EditorState, context: BlockLines, edits: ChangeSpec[], active: boolean,
  boundaries: number[], caret?: number): FormattingEdit {
  const changes = state.changes(edits);
  if (changes.empty) return { status: { available: true, active, reason: null }, changes: null, selection: null };
  const selection = caret == null ? mapBlockSelection(state, changes) : EditorSelection.single(caret);
  const candidate = state.update({ changes, selection }).state;
  const from = changes.mapPos(context.first.from, -1), to = changes.mapPos(context.last.to, 1);
  const tree = treeCovering(candidate, from, Math.max(to, selection.main.to));
  if (!tree) return refused(LOADING_REASON);
  const invalid = blockContentRefusal(candidate, tree, from, to)
    ?? inlineBoundaryRefusal(state, context.tree, boundaries)
    ?? inlineBoundaryRefusal(candidate, tree, boundaries.map((pos) => changes.mapPos(pos, 1)));
  if (invalid) return refused(invalid);
  return { status: { available: true, active, reason: null }, changes, selection };
}

export function blockCommandStatus(state: EditorState, command: BlockCommand, composing = false): BlockCommandStatus {
  const plan = planBlock(state, command, composing);
  const selected = selectedBlockLines(state);
  let headingLevel: number | null = null;
  if (typeof selected !== "string") {
    const blocks = touchedBlocks(selected);
    if (blocks.length === 0) headingLevel = 0;
    if (blocks.length === 1) {
      const name = blocks[0].name;
      headingLevel = name === "Paragraph" ? 0 : /^(?:ATX|Setext)Heading[1-6]$/.test(name) ? Number(name.slice(-1)) : null;
    }
  }
  return { ...plan.status, headingLevel };
}

export function applyBlockCommand(view: EditorView, command: BlockCommand): EmphasisCommandResult {
  return dispatchFormatting(view, planBlock(view.state, command, view.composing));
}

function planBlock(state: EditorState, command: BlockCommand, composing: boolean): FormattingEdit {
  const unavailable = commandRefusal(state, composing);
  if (unavailable) return refused(unavailable);
  const context = selectedBlockLines(state);
  if (typeof context === "string") return refused(context);
  const { first, last, tree } = context;
  if (first.from === 0 && first.text.startsWith("\uFEFF")) return refused("Edit the first line's markers directly when it has a byte-order mark.");
  const invalid = blockContentRefusal(state, tree, first.from, last.to);
  if (invalid) return refused(invalid);
  const blocks = touchedBlocks(context);
  if (command === "divider") return planDivider(state, context, blocks);
  if (command === "quote") return planQuote(state, context, blocks);
  if (blocks.some((node) => /^SetextHeading/.test(node.name))) return refused(SETEXT_REASON);
  const block = blocks[0];
  if (first.number !== last.number || blocks.length > 1 || (block && (block.parent?.name !== "Document"
    || !/^(?:Paragraph|ATXHeading[1-6])$/.test(block.name)
    || state.doc.lineAt(block.from).number !== state.doc.lineAt(block.to).number))) return refused(BLOCK_REASON);
  if (/^ *\t/.test(first.text)) return refused(BLOCK_REASON);
  const level = command === "paragraph" ? 0 : Number(command.slice(1));
  const oldLevel = block?.name.startsWith("ATXHeading") ? Number(block.name.slice(-1)) : 0;
  if (level === oldLevel) return { status: { available: true, active: true, reason: null }, changes: null, selection: null };
  const marks = block?.getChildren("HeaderMark") ?? [];
  const opening = marks[0];
  let start = opening?.to ?? first.from;
  if (opening) while (start < first.to && /[ \t]/.test(state.doc.sliceString(start, start + 1))) start++;
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  let end = closing?.from ?? first.to;
  if (closing) while (end > start && /[ \t]/.test(state.doc.sliceString(end - 1, end))) end--;
  const edits: ChangeSpec[] = [{ from: first.from, to: start, insert: level ? "#".repeat(level) + " " : "" }];
  if (closing) edits.push({ from: end, to: first.to });
  // Boundaries prevent heading→paragraph from silently joining inline syntax.
  addListBoundaries(state, first.number, last.number, edits);
  const boundaries = [first.from, ...(last.number < state.doc.lines ? [state.doc.line(last.number + 1).from] : [])];
  const plan = blockEdit(state, context, edits, false, boundaries);
  if (plan.changes) {
    const candidate = state.update({ changes: plan.changes }).state;
    const pos = candidate.doc.lineAt(plan.changes.mapPos(first.from, 1)).from;
    const parsed = treeCovering(candidate, pos, candidate.doc.lineAt(pos).to);
    const node = parsed && topBlock(parsed, pos);
    if (level ? node?.name !== `ATXHeading${level}` : node && node.name !== "Paragraph") return refused(BLOCK_REASON);
    // A plain trailing ### must not disappear as a new closing heading marker.
    if (level && (node?.getChildren("HeaderMark").length ?? 0) > 1) return refused(CHANGED_SYNTAX_REASON);
  }
  return plan;
}

function planDivider(state: EditorState, context: BlockLines, blocks: SyntaxNode[]): FormattingEdit {
  if (blocks.some((node) => !/^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12]|BulletList|OrderedList|HorizontalRule)$/.test(node.name))) return refused(BLOCK_REASON);
  for (const block of blocks) {
    if (block.name === "BulletList" || block.name === "OrderedList") {
      const invalid = listRangeRefusal(state, context.tree, block.from, block.to);
      if (invalid) return refused(invalid);
    }
  }
  const lastBlock = blocks[blocks.length - 1];
  const end = lastBlock ? state.doc.lineAt(lastBlock.to).to : context.last.to;
  const start = blocks[0]?.from ?? context.first.from;
  const invalid = blockContentRefusal(state, context.tree, start, end);
  if (invalid) return refused(invalid);
  const lineBreak = state.lineBreak;
  // Reuse existing blank space after the block; leave all existing bytes intact.
  let following = end;
  while (following < state.doc.length && /[ \t\n]/.test(state.doc.sliceString(following, following + 1))) following++;
  const gap = state.doc.sliceString(end, following);
  const newlines = (gap.match(/\n/g) ?? []).length;
  const before = end === 0 && !context.last.text.trim() ? "" : lineBreak.repeat(2);
  const next = topBlock(context.tree, following);
  const after = lineBreak.repeat(Math.max(0, (following < state.doc.length && next?.name !== "Paragraph" ? 4 : 2) - newlines));
  const insert = before + "* * *" + after;
  const tail = after.split(lineBreak).join("\n") + gap;
  const caret = end + before.split(lineBreak).join("\n").length + 5
    + tail.indexOf("\n", tail.indexOf("\n") + 1) + 1;
  return blockEdit(state, context, [{ from: end, insert }], false, [], caret);
}

function planQuote(state: EditorState, context: BlockLines, blocks: SyntaxNode[]): FormattingEdit {
  const { first, last } = context;
  const quote = blocks.length === 1 && blocks[0].name === "Blockquote" ? blocks[0] : null;
  if (quote) {
    if (first.number !== state.doc.lineAt(quote.from).number || last.number !== state.doc.lineAt(quote.to).number) return refused(QUOTE_REASON);
    for (let child = quote.firstChild; child; child = child.nextSibling) {
      if (child.name !== "QuoteMark" && child.name !== "Paragraph") return refused(QUOTE_REASON);
    }
  } else if (blocks.some((node) => node.name !== "Paragraph")) return refused(QUOTE_REASON);
  const edits: ChangeSpec[] = [];
  for (let number = first.number; number <= last.number; number++) {
    const line = state.doc.line(number);
    if (quote) {
      const prefix = /^ {0,3}> ?/.exec(line.text);
      // Lazy quote continuations have no prefix; removing the explicit marks
      // still preserves their text. Nested markers were refused above.
      if (prefix) edits.push({ from: line.from, to: line.from + prefix[0].length });
    } else edits.push({ from: line.from, insert: line.text.trim() ? "> " : ">" + (first.number === last.number ? " " : "") });
  }
  addListBoundaries(state, first.number, last.number, edits);
  const boundaries = [first.from, ...(last.number < state.doc.lines ? [state.doc.line(last.number + 1).from] : [])];
  const plan = blockEdit(state, context, edits, !!quote, boundaries);
  if (!plan.changes) return plan;
  const candidate = state.update({ changes: plan.changes }).state;
  const from = plan.changes.mapPos(first.from, 1), to = plan.changes.mapPos(last.to, -1);
  const parsed = treeCovering(candidate, from, to);
  if (!parsed) return refused(LOADING_REASON);
  const result = topBlock(parsed, candidate.doc.lineAt(from).from);
  if (!quote) {
    if (result?.name !== "Blockquote") return refused(QUOTE_REASON);
    for (let child = result.firstChild; child; child = child.nextSibling) {
      if (child.name !== "QuoteMark" && child.name !== "Paragraph") return refused(QUOTE_REASON);
    }
  } else {
    for (let node = parsed.topNode.firstChild; node; node = node.nextSibling) {
      if (node.from <= to && node.to > from && node.name !== "Paragraph") return refused(QUOTE_REASON);
    }
  }
  return plan;
}

export interface LinkCommandContext { filePath: string | null; session: object | number }
export interface LinkCommandInput { label: string; destination: string }
export interface LinkCommandIntent {
  readonly label: string;
  /** Captured only inside the command layer; the W04 bridge can hide this. */
  readonly view: EditorView;
  /** Editor-local document/selection revision; display/parser effects retain it. */
  readonly target: object;
  readonly context: LinkCommandContext;
}
const LINK_CONTEXT_REASON = "Select plain text in one paragraph, outside existing links or formatting.";
const LINK_STALE_REASON = "The document or selection changed. Open Link again.";
const activeLinkIntents = new WeakSet<LinkCommandIntent>();

// This derived identity never rewinds with history. It also distinguishes a
// selection moved away and restored using the very same EditorSelection object.
// The bridge remains the sole owner of the active form/intent.
export const linkCommandTarget = StateField.define<object>({
  create: () => ({}),
  update(target, transaction) {
    return transaction.docChanged || (transaction.selection && !transaction.startState.selection.eq(transaction.selection))
      ? {} : target;
  },
});

function linkRefusal(state: EditorState, composing: boolean): string | null {
  const unavailable = commandRefusal(state, composing);
  if (unavailable) return unavailable;
  const range = state.selection.main;
  const tree = treeCovering(state, range.from, range.to);
  if (!tree) return LOADING_REASON;
  const protection = documentProtection(state);
  if (!protection.ok) return protection.reason;
  const invalid = rangeRefusal(tree, range.from, range.to, protection);
  if (invalid) return invalid;
  const line = state.doc.lineAt(range.from);
  if (state.doc.lineAt(range.to).number !== line.number) return LINK_CONTEXT_REASON;
  const at = range.empty && range.from === line.to && line.length ? range.from - 1 : range.from;
  const block = textBlockAt(tree, at);
  if (!block && line.text.trim()) return LINK_CONTEXT_REASON;
  if (block && (range.from < block.from || range.to > block.to || /^SetextHeading/.test(block.name))) return LINK_CONTEXT_REASON;
  let crossing = false;
  tree.iterate({ from: range.from, to: range.to, enter(node) {
    if (intersects(node, range.from, range.to) && (INLINE_SPAN.test(node.name) || /^(?:Escape|Entity|LinkReference)$/.test(node.name))) crossing = true;
  } });
  if (crossing) return LINK_CONTEXT_REASON;
  if (!line.text.trim()) return null;
  // Reader-only single-tilde strike and autolinks must not become literal
  // labels. This is an explicit form-opening check, never toolbar feedback.
  try {
    const reader = protection.reader ?? parseReader(state.doc, state.lineBreak);
    let plain = false;
    visit(reader.tree, "text", (node, _index, parent) => {
      const start = (node.position?.start.offset ?? -1) + reader.offset;
      const end = (node.position?.end.offset ?? -1) + reader.offset;
      if (parent && (parent.type === "paragraph" || parent.type === "heading")
        && start <= range.from && end >= range.to
        && state.doc.sliceString(start, end) === node.value) plain = true;
    });
    return plain ? null : LINK_CONTEXT_REASON;
  } catch (error) { return isDocumentComplexityError(error) ? COMPLEXITY_REASON : LOADING_REASON; }
}

export function beginLinkCommand(view: EditorView, context: LinkCommandContext): { intent: LinkCommandIntent | null; reason: string | null } {
  const reason = linkRefusal(view.state, view.composing);
  if (reason) return { intent: null, reason };
  const { from, to } = view.state.selection.main;
  const target = view.state.field(linkCommandTarget, false);
  if (!target) return { intent: null, reason: LOADING_REASON };
  const intent = { label: view.state.sliceDoc(from, to), view, target, context: { ...context } };
  activeLinkIntents.add(intent);
  return { intent, reason: null };
}

export function linkCommandIsCurrent(view: EditorView, intent: LinkCommandIntent, context: LinkCommandContext): boolean {
  const current = activeLinkIntents.has(intent) && intent.view === view
    && view.state.field(linkCommandTarget, false) === intent.target
    && context.filePath === intent.context.filePath && context.session === intent.context.session;
  if (!current) activeLinkIntents.delete(intent);
  return current;
}

/** No mutation on cancel; focus returns only to the still-current editor. */
export function cancelLinkCommand(view: EditorView, intent: LinkCommandIntent, context: LinkCommandContext, restoreFocus = true): boolean {
  const current = linkCommandIsCurrent(view, intent, context);
  activeLinkIntents.delete(intent);
  if (current && restoreFocus) view.focus();
  return current;
}

export function applyLinkCommand(view: EditorView, intent: LinkCommandIntent, input: LinkCommandInput,
  context: LinkCommandContext): EmphasisCommandResult {
  const refuse = (reason: string) => ({ ...refused(reason).status, handled: true as const, applied: false });
  if (!linkCommandIsCurrent(view, intent, context)) return refuse(LINK_STALE_REASON);
  const invalid = linkRefusal(view.state, view.composing);
  if (invalid) return refuse(invalid);
  if (!input.label.trim() || /[\u0000-\u001f\u007f]/.test(input.label)) return refuse("Enter a label without line breaks or control characters.");
  const destination = markdownLinkDestination(input.destination, context.filePath);
  if (!destination) return refuse("Enter an http, https, mailto, #section, or relative document link.");
  const label = input.label.replace(/[\\`*_[\]<>~&]/g, "\\$&");
  const escapedDestination = destination.replace(/[ <>\\]/g, (char) => encodeURIComponent(char)).replace(/&/g, "&amp;");
  const insert = `[${label}](<${escapedDestination}>)`;
  const { from, to } = view.state.selection.main;
  const changes = view.state.changes({ from, to, insert });
  const selection = EditorSelection.single(from + insert.length);
  try {
    const candidate = changes.apply(view.state.doc);
    const reader = parseReader(candidate, view.state.lineBreak);
    let valid = false;
    visit(reader.tree, "link", (node) => {
      if (node.position?.start.offset !== from - reader.offset || node.position.end.offset !== from + insert.length - reader.offset) return;
      // A literal label cannot produce images, emphasis or nested links.
      valid = node.children.every((child) => child.type === "text")
        && node.children.map((child) => child.type === "text" ? child.value : "").join("") === input.label
        && node.url === destination.replace(/[ <>\\]/g, (char) => encodeURIComponent(char));
    });
    if (!valid) return refuse(CHANGED_SYNTAX_REASON);
  } catch (error) { return refuse(isDocumentComplexityError(error) ? COMPLEXITY_REASON : LOADING_REASON); }
  const result = dispatchFormatting(view, { changes, selection, status: { available: true, active: false, reason: null } });
  if (result.applied) activeLinkIntents.delete(intent);
  return result;
}


export type FormattingCommand = EmphasisCommand | ListCommand | BlockCommand;
export type ToolbarCommand = FormattingCommand | "link";
export interface FormattingFeedback {
  /** Available means safe to attempt. Apply always validates the live state. */
  available: boolean;
  /** null means available context cannot establish a uniform active state. */
  active: boolean | null;
  reason: string | null;
}
export interface FormattingToolbarState {
  commands: Record<ToolbarCommand, FormattingFeedback>;
  headingLevel: number | null;
}
const TOOLBAR_COMMANDS: readonly ToolbarCommand[] = [
  "paragraph", "h1", "h2", "h3", "bold", "italic", "bullets", "numbered",
  "divider", "checklist", "quote", "indent", "outdent", "link",
];

export function executeFormattingCommand(view: EditorView, command: FormattingCommand): EmphasisCommandResult {
  if (command === "bold" || command === "italic") return applyEmphasisCommand(view, command);
  if (command === "bullets" || command === "numbered" || command === "checklist"
    || command === "indent" || command === "outdent") return applyListCommand(view, command);
  return applyBlockCommand(view, command);
}

/** Feedback only: bounded existing-tree inspection, never a planner, candidate,
 * ensureSyntaxTree, cold protection/reader scan, or selection-sized text copy.
 * These limits bound feedback work, not which documents Apply can format. */
export function formattingToolbarState(state: EditorState, composing = false): FormattingToolbarState {
  const commands = Object.fromEntries(TOOLBAR_COMMANDS.map(command => [command,
    { available: true, active: null, reason: null }])) as FormattingToolbarState["commands"];
  const result: FormattingToolbarState = { commands, headingLevel: null };
  const disable = (ids: readonly ToolbarCommand[], reason: string) => {
    for (const id of ids) commands[id] = { available: false, active: null, reason };
  };
  const unavailable = commandRefusal(state, composing);
  if (unavailable) { disable(TOOLBAR_COMMANDS, unavailable); return result; }
  const range = state.selection.main;
  const tree = syntaxTree(state);
  const end = range.empty ? range.to : Math.max(range.from, range.to - 1);

  // Use authoritative facts only when already cached. Metadata near the start
  // can also be established with a small scan; an unclosed distant fence is
  // deliberately unknown until execution (or a cached protection result).
  const cached = protectionCache.get(state.doc)?.protection;
  if (cached) {
    const invalid = protectedRangeRefusal(cached, range.from, range.to, null);
    if (invalid) { disable(TOOLBAR_COMMANDS, invalid); return result; }
  } else if (state.doc.lines > 1 && FRONTMATTER_FENCE.test(state.doc.sliceString(0, Math.min(128, state.doc.line(1).to)).replace(/^\uFEFF/, ""))) {
    let protectedTo = 0;
    let closed = false;
    for (let number = 2; number <= Math.min(32, state.doc.lines); number++) {
      const line = state.doc.line(number);
      protectedTo = line.to;
      if (line.length <= 128 && FRONTMATTER_FENCE.test(line.text)) { closed = true; break; }
    }
    if (intersects({ from: 0, to: protectedTo }, range.from, range.to)) {
      disable(TOOLBAR_COMMANDS, METADATA_REASON); return result;
    }
    if (!closed) return result; // The bounded scan cannot establish the body yet.
  }
  if (tree.length < range.to || !syntaxTreeAvailable(state, range.to)) return result;

  // Structural actions allow links and emphasis, but protect code/HTML/tables.
  const structural = TOOLBAR_COMMANDS.filter(id => id !== "bold" && id !== "italic" && id !== "link");
  const inspect = (name: string) => {
    const reason = reasonForSyntax(name);
    if (reason) {
      disable(["bold", "italic", "link"], reason);
      if (!/^(?:HeaderMark|TaskMarker|Link|Image|Autolink|URL|LinkMark)$/.test(name)) disable(structural, reason);
    }
  };
  for (const pos of [range.from, end]) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
      if (node.from <= pos && pos < node.to) inspect(node.name);
    }
  }
  let complete = range.empty;
  if (!range.empty && range.to - range.from <= 4096) {
    let remaining = 192;
    complete = true;
    tree.iterate({ from: range.from, to: range.to, enter(node) {
      if (--remaining < 0) { complete = false; return false; }
      if (intersects(node, range.from, range.to)) inspect(node.name);
    } });
  }
  for (const command of ["bold", "italic"] as const) {
    if (!commands[command].available) continue;
    const active = innermost(tree, range.head, STYLE[command].node);
    if (range.empty) {
      commands[command].active = !!active;
      // wordAt can copy a very long source line. Restrict this optional empty
      // hint to nearby text; authoritative execution owns word selection.
      if (!active && !/[\p{L}\p{N}_]/u.test(state.doc.sliceString(Math.max(0, range.head - 1), Math.min(state.doc.length, range.head + 1)))) {
        disable([command], STYLE[command].empty);
      }
    } else if (active && isExactSpan(active, range.from, range.to)) commands[command].active = true;
    else if (complete && !emphasisNodes(tree, range.from, range.to).length) commands[command].active = false;
  }
  // A caret at a source line's end still belongs to that line's block.
  const previous = state.doc.sliceString(Math.max(0, range.from - 1), range.from);
  const next = state.doc.sliceString(range.from, Math.min(state.doc.length, range.from + 1));
  const blockEnd = range.empty && previous && previous !== "\n" && (!next || next === "\n") ? range.from - 1 : end;
  const firstBlock = topBlock(tree, range.empty ? blockEnd : range.from), lastBlock = topBlock(tree, blockEnd);
  if (range.empty && (!previous || previous === "\n") && (!next || next === "\n")) result.headingLevel = 0;
  if (!range.empty && !singleTextBlock(tree, range.from, range.to)) disable(["bold", "italic", "link"], CROSS_BLOCK_REASON);
  if (sameNode(firstBlock, lastBlock)) {
    const name = firstBlock!.name;
    result.headingLevel = name === "Paragraph" ? 0 : /^(?:ATX|Setext)Heading[1-6]$/.test(name) ? Number(name.slice(-1)) : null;
    if (/^SetextHeading/.test(name)) disable(["paragraph", "h1", "h2", "h3"], SETEXT_REASON);
    if (!/^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12])$/.test(name)) disable(["paragraph", "h1", "h2", "h3"], BLOCK_REASON);
    if (/^(?:BulletList|OrderedList)$/.test(name)) disable(["quote"], QUOTE_REASON);
    if (name === "Blockquote") commands.quote.active = true;
    else if (name === "Paragraph") commands.quote.active = false;
  }
  if (result.headingLevel !== null) {
    for (const [id, level] of [["paragraph", 0], ["h1", 1], ["h2", 2], ["h3", 3]] as const) {
      if (commands[id].available) commands[id].active = result.headingLevel === level;
    }
  }
  const firstItem = ancestor(tree.resolveInner(range.from, 1), "ListItem");
  const lastItem = ancestor(tree.resolveInner(end, 1), "ListItem");
  if (sameNode(firstItem, lastItem)) {
    const item = listItem(state, firstItem!);
    if (item) {
      for (const id of ["bullets", "numbered", "checklist"] as const) if (commands[id].available) commands[id].active = itemKind(item) === id;
      if (!firstItem!.prevSibling) disable(["indent"], LIST_PARENT_REASON);
      if (item.list.parent?.name === "Document") disable(["outdent"], LIST_TOP_REASON);
    }
  } else if (!firstItem && !lastItem && complete && sameNode(firstBlock, lastBlock) && firstBlock?.name === "Paragraph") {
    for (const id of ["bullets", "numbered", "checklist"] as const) if (commands[id].available) commands[id].active = false;
    disable(["indent", "outdent"], LIST_LEVEL_REASON);
  }
  return result;
}
