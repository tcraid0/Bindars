import type { FileType } from "../types";
import { isWhitespaceCodeUnit } from "./word-count";

/**
 * These provisional ceilings reject roughly 15,000 minimal Markdown headings
 * (`# a\n`) or 10,000 minimal Fountain action blocks (`a\n\n`). Delimiters and
 * long Markdown inline runs consume the same budget, so those shapes cannot
 * bypass the line bound. The limits leave substantial room for ordinary books
 * and screenplays; they are safety ceilings, not measured UI latency targets.
 */
export const DOCUMENT_COMPLEXITY_POLICY = {
  markdown: { maxUnits: 30_000 },
  fountain: { maxUnits: 20_000 },
} as const satisfies Record<FileType, { maxUnits: number }>;

export const DOCUMENT_COMPLEXITY_MESSAGE =
  "This document has too much formatting to display safely. You can still edit it to simplify the content.";

/**
 * Consumer budgets for the Markdown passes whose output or cost grows much
 * faster than their input and whose shapes (whitespace-separated short tokens)
 * the structural-unit scanner cannot see. Crossing a budget degrades that node
 * gracefully — code keeps its text without syntax highlighting, math renders
 * as plain code, large documents keep straight quotes — instead of rejecting
 * the document, because the content stays fully readable.
 *
 * These are INPUT budgets. They are not proven upper bounds on generated
 * elements: expansion ratio is a measured property of each library, not a
 * guarantee. Measured on Node 25 with adversarial payloads, and provisional
 * pending V-01 WebView measurements:
 *
 * - highlight.js: ~0.5 spans per accepted char and ~10 ms per accepted KiB, so
 *   the document budget lands near 32k spans and ~0.65 s.
 * - KaTeX without explicit definitions or direct internal control sequences:
 *   worst observed 1.8 spans per char (`\dfrac` spam), so the document budget
 *   lands near 18k spans. Either route to a caller-supplied macro body breaks
 *   that ratio completely — an explicit `\def` expanded 2,468 chars into
 *   240,006 spans, and invoking KaTeX's internal `\df@tag` (which ordinary
 *   `\tag{…}` defines) expanded 4,526 chars into 994,972 spans and 41.5 MB —
 *   so `rehypeLimitExpensiveNodes` degrades both unsafe shapes to plain text,
 *   and MATH_MAX_EXPAND/MATH_MAX_SIZE bound the parser as defense in depth.
 * - remark-smartypants: quadratic in dense tiny tokens, ~0.9 s at the word
 *   ceiling.
 */
export const HIGHLIGHT_MAX_NODE_CHARS = 32_768;
export const HIGHLIGHT_MAX_TOTAL_CHARS = 65_536;
export const MATH_MAX_NODE_CHARS = 5_000;
export const MATH_MAX_TOTAL_CHARS = 10_000;
/** KaTeX macro-expansion cap; ordinary math needed under 64 in measurement. */
export const MATH_MAX_EXPAND = 256;
/** KaTeX user-sizing cap in em; the default is Infinity (a 1e9em rule renders). */
export const MATH_MAX_SIZE = 100;
/** Inclusive: documents with exactly this many prose words keep smartypants. */
export const SMARTYPANTS_MAX_WORDS = 32_768;

/**
 * Inclusive aggregate character ceiling for the smartypants gate. The
 * whitespace word count alone cannot bound the transformer's work:
 * remark-smartypants concatenates every `text`/`inlineCode` value (plus one
 * space per paragraph) into one parse-latin input, and parse-latin processes
 * punctuation-delimited fragments individually, so `a,a,a,…` counts as one
 * word but costs like thousands. Measured on Node 25: 65,541 chars of `a,`
 * fragments ≈ 1.0 s; 262,149 chars did not finish within 8 s.
 */
export const SMARTYPANTS_MAX_CHARS = 65_536;

/**
 * Markdown container and indentation ceilings. The structural-unit total
 * alone does not bound parser/renderer recursion or layout depth: a single
 * line of 4,000 nested blockquote markers costs only ~4,001 units but
 * overflowed mdast-util-to-hast's recursive blockquote conversion with
 * `RangeError: Maximum call stack size exceeded`, and ~1 MB of progressively
 * indented nested lists passed at ~2,000 units and rendered for ~12.7 s
 * (Node 25). The scanner therefore additionally enforces:
 *
 * - MARKDOWN_MAX_CONTAINER_DEPTH: markers in one line's leading container
 *   prefix (`>`, `-`/`+`/`*`, `1.`/`1)`, mixed). Tightest valid nesting
 *   needs at least two columns per level (`- `), so the indentation ceiling
 *   below independently bounds progressive nesting to the same depth.
 * - MARKDOWN_MAX_INDENT_COLUMNS: whitespace width throughout the leading
 *   container prefix, including indentation after `>` or a list marker,
 *   using four-column tab stops.
 * - one structural unit per MARKDOWN_INDENT_COLUMNS_PER_UNIT prefix-whitespace
 *   columns, so many moderately indented lines cannot sum to
 *   unbounded container open/close work under the unit ceiling.
 * - MARKDOWN_MAX_INLINE_NESTING: outstanding inline-emphasis delimiters
 *   within one source block. Valid emphasis nesting can recurse just as
 *   deeply as block containers, while consuming only two structural units
 *   per level. See `applyInlineDelimiterRun` for the exact invariant.
 *
 * All are provisional pending V-01 WebView measurements, and deliberately
 * far beyond ordinary documents (real nesting is a handful of levels).
 */
export const MARKDOWN_MAX_CONTAINER_DEPTH = 128;
export const MARKDOWN_MAX_INDENT_COLUMNS = 256;
export const MARKDOWN_INDENT_COLUMNS_PER_UNIT = 4;
export const MARKDOWN_MAX_INLINE_NESTING = 128;

/**
 * Resolve a production limit against an optional lower test limit. Shared so
 * the structural policy and the consumer budgets cannot diverge on whether a
 * test may raise a production ceiling (it may not).
 */
export function clampToProductionLimit(
  productionLimit: number,
  requestedLimit: number | undefined,
): number {
  if (requestedLimit === undefined || !Number.isFinite(requestedLimit)) {
    return productionLimit;
  }

  return Math.min(productionLimit, Math.max(0, Math.trunc(requestedLimit)));
}

export interface DocumentComplexityMeasurement {
  format: FileType;
  units: number;
  maxUnits: number;
}

export interface DocumentComplexityOptions {
  /** Tests may lower the production ceiling to exercise exact boundaries. */
  maxUnits?: number;
  /** Tests may lower the production Markdown container-depth ceiling. */
  maxMarkdownContainerDepth?: number;
  /** Tests may lower the production Markdown indentation ceiling. */
  maxMarkdownIndentColumns?: number;
  /** Tests may lower the production Markdown inline-nesting ceiling. */
  maxMarkdownInlineNesting?: number;
}

export type DocumentComplexityResult =
  | { ok: true; measurement: DocumentComplexityMeasurement }
  | { ok: false; error: DocumentComplexityError };

export class DocumentComplexityError extends Error {
  readonly format: FileType;
  readonly units: number;
  readonly maxUnits: number;

  constructor(measurement: DocumentComplexityMeasurement) {
    super(DOCUMENT_COMPLEXITY_MESSAGE);
    this.name = "DocumentComplexityError";
    this.format = measurement.format;
    this.units = measurement.units;
    this.maxUnits = measurement.maxUnits;
  }
}

/**
 * Scan potential parser/render expansion points with working memory that is
 * O(1) apart from the inline-delimiter stacks, which the nesting ceiling
 * bounds. The scan stops as soon as the effective ceiling is exceeded.
 */
export function checkDocumentComplexity(
  content: string,
  format: FileType,
  options: DocumentComplexityOptions = {},
): DocumentComplexityResult {
  const maxUnits = effectiveLimit(format, options.maxUnits);
  const maxContainerDepth = clampToProductionLimit(
    MARKDOWN_MAX_CONTAINER_DEPTH,
    options.maxMarkdownContainerDepth,
  );
  const maxIndentColumns = clampToProductionLimit(
    MARKDOWN_MAX_INDENT_COLUMNS,
    options.maxMarkdownIndentColumns,
  );
  const maxInlineNesting = clampToProductionLimit(
    MARKDOWN_MAX_INLINE_NESTING,
    options.maxMarkdownInlineNesting,
  );
  const units = countStructuralUnits(content, format, maxUnits, {
    maxContainerDepth,
    maxIndentColumns,
    maxInlineNesting,
  });
  const measurement = { format, units, maxUnits };

  if (units > maxUnits) {
    return { ok: false, error: new DocumentComplexityError(measurement) };
  }

  return { ok: true, measurement };
}

export function assertDocumentComplexity(
  content: string,
  format: FileType,
  options: DocumentComplexityOptions = {},
): DocumentComplexityMeasurement {
  const result = checkDocumentComplexity(content, format, options);
  if (!result.ok) throw result.error;
  return result.measurement;
}

export function isDocumentComplexityError(error: unknown): error is DocumentComplexityError {
  return error instanceof DocumentComplexityError;
}

function effectiveLimit(format: FileType, requestedLimit: number | undefined): number {
  return clampToProductionLimit(DOCUMENT_COMPLEXITY_POLICY[format].maxUnits, requestedLimit);
}

interface MarkdownLimits {
  maxContainerDepth: number;
  maxIndentColumns: number;
  maxInlineNesting: number;
}

/** A fenced code block may be indented by at most three columns. */
const FENCE_MAX_INDENT_COLUMNS = 3;

function countStructuralUnits(
  content: string,
  format: FileType,
  maxUnits: number,
  markdownLimits: MarkdownLimits,
): number {
  if (content.length === 0) return 0;

  const scanLinePrefixes = format === "markdown";
  let units = 1;
  let textRunLength = 0;
  let lineStart = scanLinePrefixes;
  let lineHasContent = false;

  const inline = createInlineNestingState();
  // Inline state is meaningless inside code, so both a top-level fenced block
  // and a resolved code span suspend it. `suppressInlineUntil` is the index of
  // the last suspended character.
  let fenceMarker = 0;
  let fenceLength = 0;
  let suppressInlineUntil = -1;
  // Code-span detection needs lookahead, bounded by the line it starts on.
  // That still leaves one pathological case — many unmatched backtick runs on
  // a single very long line, each scanning to the end of it — so every scanned
  // character is charged here and the total stays linear in the document. Once
  // spent, backticks are charged as ordinary structure and their contents keep
  // counting delimiters, which can only over-count.
  let codeSpanLookahead = content.length * 2;

  for (let index = 0; index < content.length; index += 1) {
    if (lineStart) {
      lineStart = false;
      const prefix = scanMarkdownLinePrefix(content, index, markdownLimits);
      if (prefix.overLimit) return maxUnits + 1;
      units += prefix.units;
      if (units > maxUnits) return maxUnits + 1;
      // A consumed container marker is real source content. Letting it leave
      // the line looking blank would reset inline state on a line the parser
      // does not treat as a block boundary at all: a lone `+` is an empty list
      // item, which cannot interrupt a paragraph, so every delimiter opened
      // before it stays open.
      if (prefix.depth > 0) lineHasContent = true;

      if (prefix.depth === 0 && prefix.columns <= FENCE_MAX_INDENT_COLUMNS) {
        const fence = scanFenceBoundary(content, prefix.nextIndex, fenceMarker, fenceLength);
        if (fence.kind === "open") {
          fenceMarker = fence.marker;
          fenceLength = fence.length;
        } else if (fence.kind === "close") {
          fenceMarker = 0;
          fenceLength = 0;
        }
        if (fence.kind !== "none") {
          // A fence boundary ends the preceding paragraph, and its own
          // backticks or tildes are structure rather than inline delimiters.
          resetInlineNesting(inline);
          lineHasContent = true;
          suppressInlineUntil = findLineEnd(content, prefix.nextIndex);
        }
      }

      index = prefix.nextIndex - 1;
      continue;
    }

    const code = content.charCodeAt(index);
    const inlineSuppressed = fenceMarker !== 0 || index <= suppressInlineUntil;

    if (code === 0x0d) {
      if (content.charCodeAt(index + 1) === 0x0a) index += 1;
      units += 1;
      textRunLength = 0;
      lineStart = scanLinePrefixes;
      // Only a genuinely blank source line ends the block that inline
      // delimiters live in.
      if (!lineHasContent) resetInlineNesting(inline);
      lineHasContent = false;
    } else if (code === 0x0a) {
      units += 1;
      textRunLength = 0;
      lineStart = scanLinePrefixes;
      if (!lineHasContent) resetInlineNesting(inline);
      lineHasContent = false;
    } else if (format === "markdown") {
      if (code === 0x5c && !inlineSuppressed) {
        // A backslash escape makes the next ASCII punctuation character
        // literal text, so it can never act as a delimiter, code-span fence,
        // or barrier.
        units += 1;
        const escaped = content.charCodeAt(index + 1);
        if (isAsciiPunctuation(escaped)) {
          if (isChargedMarkdownCharacter(escaped)) units += 1;
          index += 1;
        }
        textRunLength = 0;
        lineHasContent = true;
      } else if (code === 0x60) {
        const runLength = markdownDelimiterRunLength(content, index, code);
        units += runLength;
        textRunLength = 0;
        lineHasContent = true;
        if (!inlineSuppressed && codeSpanLookahead > 0) {
          const span = findCodeSpanEnd(content, index + runLength, runLength);
          codeSpanLookahead -= span.scanned;
          if (span.end >= 0) suppressInlineUntil = span.end;
        }
        index += runLength - 1;
      } else if (isMarkdownInlineDelimiter(code)) {
        const runLength = markdownDelimiterRunLength(content, index, code);
        units += runLength;
        textRunLength = 0;
        lineHasContent = true;
        if (!inlineSuppressed) {
          const open = applyInlineDelimiterRun(inline, content, index, runLength, code);
          if (open > markdownLimits.maxInlineNesting) return maxUnits + 1;
        }
        index += runLength - 1;
      } else if (isInlineMatchingBarrier(code)) {
        // Link labels, autolinks, and raw HTML are separate content regions: a
        // delimiter inside one cannot close an opener outside it, and vice
        // versa. Sealing the current openers keeps the estimate conservative
        // without modelling link resolution.
        units += 1;
        textRunLength = 0;
        lineHasContent = true;
        if (!inlineSuppressed) sealInlineNesting(inline);
      } else if (isMarkdownStructuralCharacter(code)) {
        units += 1;
        textRunLength = 0;
        lineHasContent = true;
      } else if (isWhitespaceCodeUnit(code)) {
        // Only spaces and tabs make a line blank in CommonMark. Every other
        // whitespace character — NBSP, ideographic space, U+FEFF, vertical
        // tab, form feed — is ordinary paragraph content, so a line holding
        // just one of them does not end the block the delimiters live in.
        if (!isBlankLineWhitespace(code)) lineHasContent = true;
        textRunLength = 0;
      } else {
        lineHasContent = true;
        textRunLength += 1;
        // Bound very long inline constructs such as math even without delimiters.
        if (textRunLength % 16 === 0) units += 1;
      }
    } else if (isFountainInlineStructuralCharacter(code)) {
      units += 1;
      textRunLength = 0;
    } else if (isWhitespaceCodeUnit(code)) {
      textRunLength = 0;
    }

    if (units > maxUnits) return maxUnits + 1;
  }

  return units;
}

interface MarkdownPrefixScan {
  /** Structural units consumed by the line prefix (markers + indentation). */
  units: number;
  /** Index of the first character after the prefix. */
  nextIndex: number;
  /** Container markers recognized in the prefix. */
  depth: number;
  /** Whitespace columns measured across the prefix. */
  columns: number;
  /** True when the container-depth or indentation ceiling is exceeded. */
  overLimit: boolean;
}

/**
 * Scan one Markdown line's leading indentation and container prefix. This is
 * a conservative source approximation, not a CommonMark parser: when syntax
 * is ambiguous it prefers counting a marker, so malformed prefixes err
 * toward rejection. Prefix characters consumed here are charged exactly what
 * the character loop would have charged them (one unit per `>`, unordered
 * marker, or ordered-list delimiter), plus the new indentation charge, so
 * non-indented documents measure identically to before.
 */
function scanMarkdownLinePrefix(
  content: string,
  start: number,
  limits: MarkdownLimits,
): MarkdownPrefixScan {
  let index = start;
  let units = 0;
  let columns = 0;

  // Leading container prefix: repeated blockquote and list markers with
  // optional space/tab separators, for example `> > `, `- - `, `> 1. `.
  // Whitespace is measured before and between every marker; otherwise an
  // outer blockquote could hide progressively indented lists after its `>`.
  let depth = 0;
  for (;;) {
    while (index < content.length) {
      const whitespace = content.charCodeAt(index);
      const previousColumns = columns;
      if (whitespace === 0x20) {
        columns += 1;
      } else if (whitespace === 0x09) {
        columns += MARKDOWN_INDENT_COLUMNS_PER_UNIT - (columns % MARKDOWN_INDENT_COLUMNS_PER_UNIT);
      } else {
        break;
      }

      units += Math.floor(columns / MARKDOWN_INDENT_COLUMNS_PER_UNIT)
        - Math.floor(previousColumns / MARKDOWN_INDENT_COLUMNS_PER_UNIT);
      index += 1;
      if (columns > limits.maxIndentColumns) {
        return { units, nextIndex: index, depth, columns, overLimit: true };
      }
    }

    const code = content.charCodeAt(index);
    if (code === 0x3e) {
      // >
      depth += 1;
      units += 1;
      index += 1;
    } else if (isUnorderedListMarker(content, index)) {
      depth += 1;
      units += 1;
      index += 1;
    } else {
      const orderedLength = orderedListMarkerLength(content, index);
      if (orderedLength === 0) break;
      depth += 1;
      // One unit for the `.`/`)` delimiter; digits were never charged.
      units += 1;
      index += orderedLength;
    }

    if (depth > limits.maxContainerDepth) {
      return { units, nextIndex: index, depth, columns, overLimit: true };
    }
  }

  return { units, nextIndex: index, depth, columns, overLimit: false };
}

type FenceBoundary =
  | { kind: "none" }
  | { kind: "open"; marker: number; length: number }
  | { kind: "close" };

/**
 * Recognize a fenced code-block boundary at a line's first content character.
 *
 * Only fences that start at container depth zero are honoured. A fence opened
 * inside a list item or blockquote ends when that container ends, which this
 * line-oriented scanner cannot see; ignoring those fences keeps their contents
 * counted as ordinary text, which can only over-count.
 */
function scanFenceBoundary(
  content: string,
  index: number,
  openMarker: number,
  openLength: number,
): FenceBoundary {
  const code = content.charCodeAt(index);
  if (code !== 0x60 && code !== 0x7e) return { kind: "none" };

  const length = markdownDelimiterRunLength(content, index, code);
  if (length < 3) return { kind: "none" };

  if (openMarker !== 0) {
    if (code !== openMarker || length < openLength) return { kind: "none" };
    // A closing fence carries nothing but trailing whitespace.
    return isBlankToLineEnd(content, index + length) ? { kind: "close" } : { kind: "none" };
  }

  // A backtick info string may not contain a backtick, so such a line is not
  // a fence at all and its content must keep counting normally.
  if (code === 0x60 && lineContainsBacktick(content, index + length)) return { kind: "none" };

  return { kind: "open", marker: code, length };
}

function findLineEnd(content: string, index: number): number {
  let scan = index;
  while (scan < content.length) {
    const code = content.charCodeAt(scan);
    if (code === 0x0a || code === 0x0d) return scan - 1;
    scan += 1;
  }
  return content.length - 1;
}

function isBlankToLineEnd(content: string, index: number): boolean {
  let scan = index;
  while (scan < content.length) {
    const code = content.charCodeAt(scan);
    if (code === 0x0a || code === 0x0d) return true;
    if (!isWhitespaceCodeUnit(code)) return false;
    scan += 1;
  }
  return true;
}

function lineContainsBacktick(content: string, index: number): boolean {
  let scan = index;
  while (scan < content.length) {
    const code = content.charCodeAt(scan);
    if (code === 0x0a || code === 0x0d) return false;
    if (code === 0x60) return true;
    scan += 1;
  }
  return false;
}

interface CodeSpanScan {
  /** Index of the last character of the closing run, or -1 when unclosed. */
  end: number;
  /** Characters examined, charged against the shared lookahead budget. */
  scanned: number;
}

/**
 * Find the code span closed by a backtick run of exactly `size` on the same
 * line.
 *
 * Inline parsing happens per block, so a code span cannot pair across any
 * construct that ends the paragraph — not only a blank line, but an ATX
 * heading, thematic break, list marker, fence, blockquote, or HTML block.
 * Rather than re-deriving which lines interrupt a paragraph, and leaking a
 * bypass for every rule missed, the search stops at the first line ending. A
 * code span written across a soft line break is then simply not recognized,
 * and its contents keep counting, which can only over-count.
 */
function findCodeSpanEnd(content: string, start: number, size: number): CodeSpanScan {
  let index = start;

  while (index < content.length) {
    const code = content.charCodeAt(index);
    if (code === 0x0a || code === 0x0d) break;

    if (code === 0x60) {
      const length = markdownDelimiterRunLength(content, index, code);
      if (length === size) return { end: index + length - 1, scanned: index + length - start };
      index += length;
      continue;
    }

    index += 1;
  }

  return { end: -1, scanned: index - start };
}

const DELIMITER_ASTERISK = 0x2a;
const DELIMITER_UNDERSCORE = 0x5f;
const DELIMITER_TILDE = 0x7e;

/** Each delimiter owns one opener stack; see `delimiterSlot`. */
const SLOT_ASTERISK = 0;
const SLOT_UNDERSCORE = 1;
const SLOT_TILDE = 2;
const DELIMITER_SLOT_COUNT = 3;

const CHARACTER_OTHER = 0;
const CHARACTER_WHITESPACE = 1;
const CHARACTER_PUNCTUATION = 2;

/**
 * Mirrors micromark-util-classify-character. `/\s/` already covers every code
 * unit `isWhitespaceCodeUnit` does, including U+FEFF, so it is the single
 * definition of whitespace here. Input edges count as whitespace.
 */
const UNICODE_WHITESPACE_PATTERN = /\s/;
const UNICODE_PUNCTUATION_PATTERN = /\p{P}|\p{S}/u;

function classifyCharacter(code: number): number {
  if (Number.isNaN(code)) return CHARACTER_WHITESPACE;

  const character = String.fromCharCode(code);
  if (UNICODE_WHITESPACE_PATTERN.test(character)) return CHARACTER_WHITESPACE;
  if (UNICODE_PUNCTUATION_PATTERN.test(character)) return CHARACTER_PUNCTUATION;
  // An unpaired surrogate lands here, which only makes a run look openable.
  return CHARACTER_OTHER;
}

interface InlineOpener {
  /** Delimiter characters still available to open emphasis. */
  remaining: number;
  /** Whether this run could also act as a closer, for the rule of three. */
  canClose: boolean;
}

interface InlineNestingState {
  /** One opener stack per delimiter character, indexed by `delimiterSlot`. */
  stacks: InlineOpener[][];
  /** Stack height below which closers may not reach, per delimiter. */
  floors: number[];
  /** Outstanding opener characters across every delimiter. */
  totalOpen: number;
}

function createInlineNestingState(): InlineNestingState {
  return {
    stacks: [[], [], []],
    floors: [0, 0, 0],
    totalOpen: 0,
  };
}

function resetInlineNesting(state: InlineNestingState): void {
  for (let slot = 0; slot < DELIMITER_SLOT_COUNT; slot += 1) {
    state.stacks[slot].length = 0;
    state.floors[slot] = 0;
  }
  state.totalOpen = 0;
}

/** Openers below the barrier can no longer be closed in this block. */
function sealInlineNesting(state: InlineNestingState): void {
  for (let slot = 0; slot < DELIMITER_SLOT_COUNT; slot += 1) {
    state.floors[slot] = state.stacks[slot].length;
  }
}

/**
 * Slot owned by one inline delimiter, or -1 for anything else. Callers reach
 * this only behind `isMarkdownInlineDelimiter`, so -1 is unreachable; naming
 * every case keeps an unexpected character out of the tilde stack instead of
 * silently sharing it.
 */
function delimiterSlot(code: number): number {
  switch (code) {
    case DELIMITER_ASTERISK:
      return SLOT_ASTERISK;
    case DELIMITER_UNDERSCORE:
      return SLOT_UNDERSCORE;
    case DELIMITER_TILDE:
      return SLOT_TILDE;
    default:
      return -1;
  }
}

/**
 * Update the outstanding-opener estimate for one delimiter run and return the
 * new total.
 *
 * The invariant this maintains is that the total never falls below the inline
 * nesting depth the installed parser can still build, because every emphasis
 * node consumes at least one outstanding opener character, and every opener of
 * a nested chain is outstanding at once when its innermost opener is scanned.
 * Keeping the estimate safe therefore means never releasing an opener the
 * parser would keep:
 *
 * - Each delimiter character owns its own stack, so an inert `~` cannot cancel
 *   an open `*`.
 * - A run only closes when micromark's flanking rules let it, including the
 *   extra restriction that makes intraword `_` inert in `user_name`.
 * - micromark's rule of three is applied with the same current run sizes; when
 *   it blocks the nearest opener this scan stops instead of searching earlier
 *   openers, which can only leave more outstanding.
 * - Closers cannot reach openers sealed behind a link, autolink, or raw-HTML
 *   barrier.
 *
 * Every divergence from the parser therefore over-counts rather than under-
 * counts. This remains a source estimate, not a proven parser-depth bound: it
 * bounds emphasis recursion specifically, alongside the separate container and
 * indentation ceilings.
 */
function applyInlineDelimiterRun(
  state: InlineNestingState,
  content: string,
  index: number,
  runLength: number,
  code: number,
): number {
  const before = classifyCharacter(content.charCodeAt(index - 1));
  const afterCode = content.charCodeAt(index + runLength);
  const after = classifyCharacter(afterCode);

  // micromark-core-commonmark/dev/lib/attention.js and
  // micromark-extension-gfm-strikethrough/dev/lib/syntax.js.
  const leftFlanking = after === CHARACTER_OTHER
    || (after === CHARACTER_PUNCTUATION && before !== CHARACTER_OTHER);
  const rightFlanking = before === CHARACTER_OTHER
    || (before === CHARACTER_PUNCTUATION && after !== CHARACTER_OTHER);

  let canOpen: boolean;
  let canClose: boolean;

  if (code === DELIMITER_TILDE) {
    // GFM strikethrough never uses a run longer than two tildes, so a longer
    // run is literal text that neither opens nor closes.
    if (runLength > 2) return state.totalOpen;
    canOpen = leftFlanking;
    canClose = rightFlanking;
  } else if (code === DELIMITER_UNDERSCORE) {
    canOpen = leftFlanking && (before !== CHARACTER_OTHER || !rightFlanking);
    canClose = rightFlanking && (after !== CHARACTER_OTHER || !leftFlanking);
  } else {
    // Asterisk. GFM registers `~` as an attention marker, which lets a
    // following tilde force `*`/`_` open. The mirrored rule that forces a run
    // closed is deliberately not applied, because closing early would
    // under-count.
    canOpen = leftFlanking || afterCode === DELIMITER_TILDE;
    canClose = rightFlanking;
  }

  const slot = delimiterSlot(code);
  if (slot < 0) return state.totalOpen;
  const stack = state.stacks[slot];
  let remaining = runLength;

  if (canClose) {
    while (remaining > 0 && stack.length > state.floors[slot]) {
      const opener = stack[stack.length - 1];
      if (
        (opener.canClose || canOpen)
        && remaining % 3 !== 0
        && (opener.remaining + remaining) % 3 === 0
      ) {
        break;
      }

      const use = opener.remaining > 1 && remaining > 1 ? 2 : 1;
      opener.remaining -= use;
      remaining -= use;
      state.totalOpen -= use;
      if (opener.remaining === 0) stack.pop();
    }
  }

  if (canOpen && remaining > 0) {
    stack.push({ remaining, canClose });
    state.totalOpen += remaining;
  }

  return state.totalOpen;
}

function isMarkdownInlineDelimiter(code: number): boolean {
  return code === DELIMITER_ASTERISK
    || code === DELIMITER_UNDERSCORE
    || code === DELIMITER_TILDE;
}

/** `[`, `]`, `<`, `>`: the source edges of separate inline content regions. */
function isInlineMatchingBarrier(code: number): boolean {
  return code === 0x5b || code === 0x5d || code === 0x3c || code === 0x3e;
}

/**
 * Whether a character costs one structural unit anywhere it appears. Used only
 * to charge an escaped character the same as an unescaped one, so escaping
 * cannot change a document's measured size.
 */
function isChargedMarkdownCharacter(code: number): boolean {
  return isMarkdownInlineDelimiter(code)
    || isInlineMatchingBarrier(code)
    || isMarkdownStructuralCharacter(code)
    || code === 0x60; // backtick
}

function markdownDelimiterRunLength(content: string, start: number, code: number): number {
  let length = 1;
  while (content.charCodeAt(start + length) === code) length += 1;
  return length;
}

/**
 * Space and tab are the only whitespace CommonMark counts toward a blank line.
 * Deliberately narrower than `isWhitespaceCodeUnit`, which answers the
 * different question of what separates words.
 */
function isBlankLineWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

function isAsciiPunctuation(code: number): boolean {
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}

/** `-`/`+`/`*` followed by whitespace or end of line/input. */
function isUnorderedListMarker(content: string, index: number): boolean {
  const code = content.charCodeAt(index);
  if (code !== 0x2d && code !== 0x2b && code !== 0x2a) return false;
  return isMarkdownMarkerFollower(content.charCodeAt(index + 1));
}

/**
 * Length of an ordered-list marker (`1.` / `12)`) at `index`, or 0. Up to
 * nine digits followed by `.` or `)` and then whitespace or end of
 * line/input, matching CommonMark's marker shape.
 */
function orderedListMarkerLength(content: string, index: number): number {
  let digits = 0;
  while (digits < 9) {
    const code = content.charCodeAt(index + digits);
    if (code < 0x30 || code > 0x39) break;
    digits += 1;
  }
  if (digits === 0) return 0;
  const delimiter = content.charCodeAt(index + digits);
  if (delimiter !== 0x2e && delimiter !== 0x29) return 0;
  if (!isMarkdownMarkerFollower(content.charCodeAt(index + digits + 1))) return 0;
  return digits + 1;
}

function isMarkdownMarkerFollower(code: number): boolean {
  // Space, tab, LF, CR, or past the end of the input (NaN from charCodeAt).
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || Number.isNaN(code);
}

/**
 * Structural characters charged one unit each. Inline delimiters (`*`, `_`,
 * `~`), backticks, and the barrier characters are charged by their own
 * branches in `countStructuralUnits`, which own the single definition of what
 * each of those characters means.
 */
function isMarkdownStructuralCharacter(code: number): boolean {
  switch (code) {
    case 0x21: // !
    case 0x23: // #
    case 0x24: // $
    case 0x26: // &
    case 0x28: // (
    case 0x29: // )
    case 0x2b: // +
    case 0x2d: // -
    case 0x2e: // .
    case 0x3a: // :
    case 0x40: // @
    case 0x5c: // backslash
    case 0x5e: // ^
    case 0x7c: // |
      return true;
    default:
      return false;
  }
}

function isFountainInlineStructuralCharacter(code: number): boolean {
  return code === 0x2a || code === 0x5e || code === 0x5f;
}
