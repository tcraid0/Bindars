import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import { sanitizeSchema } from "./sanitize-schema";
import type { PluggableList } from "unified";
import type { Root, RootContent } from "hast";
import type { Root as MdastRoot, RootContent as MdastContent } from "mdast";
import { rehypeSourcePositions } from "./markdown-source-position";
import {
  clampToProductionLimit,
  HIGHLIGHT_MAX_NODE_CHARS,
  HIGHLIGHT_MAX_TOTAL_CHARS,
  MATH_MAX_EXPAND,
  MATH_MAX_NODE_CHARS,
  MATH_MAX_SIZE,
  MATH_MAX_TOTAL_CHARS,
  SMARTYPANTS_MAX_CHARS,
  SMARTYPANTS_MAX_WORDS,
} from "./document-complexity";
import { countWords } from "./word-count";

declare const __BINDARS_DOCUMENT_PERFORMANCE_PROBE__: boolean | undefined;

interface DocumentPerformanceProbeEvent {
  type: "markdown-pipeline";
  atMs: number;
  smartypants: {
    applied: boolean;
    chars: number;
    words: number;
    measureMs: number;
    transformMs: number;
  };
}

interface DocumentPerformanceEventLoopProbe {
  intervalMs: number;
  startedAtMs: number;
  lastSampleAtMs: number;
  sampleCount: number;
  maxGapMs: number;
  maxDelayMs: number;
}

type DocumentPerformanceProbeGlobal = typeof globalThis & {
  __BINDARS_DOCUMENT_PERFORMANCE_EVENTS__?: DocumentPerformanceProbeEvent[];
  __BINDARS_DOCUMENT_PERFORMANCE_EVENT_LOOP__?: DocumentPerformanceEventLoopProbe;
  __BINDARS_DOCUMENT_PERFORMANCE_RESET_EVENT_LOOP__?: () => void;
};

const DOCUMENT_PERFORMANCE_EVENT_LOOP_INTERVAL_MS = 16;

function documentPerformanceProbeEnabled(): boolean {
  return typeof __BINDARS_DOCUMENT_PERFORMANCE_PROBE__ !== "undefined"
    && __BINDARS_DOCUMENT_PERFORMANCE_PROBE__;
}

function recordDocumentPerformanceEvent(event: DocumentPerformanceProbeEvent): void {
  if (!documentPerformanceProbeEnabled()) return;
  const probeGlobal = globalThis as DocumentPerformanceProbeGlobal;
  const events = probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_EVENTS__ ?? [];
  if (!probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_EVENTS__) {
    probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_EVENTS__ = events;
  }
  if (events.length < 256) events.push(event);
}

function resetDocumentPerformanceEventLoopProbe(): void {
  const now = performance.now();
  const probeGlobal = globalThis as DocumentPerformanceProbeGlobal;
  probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_EVENT_LOOP__ = {
    intervalMs: DOCUMENT_PERFORMANCE_EVENT_LOOP_INTERVAL_MS,
    startedAtMs: now,
    lastSampleAtMs: now,
    sampleCount: 0,
    maxGapMs: 0,
    maxDelayMs: 0,
  };
}

function startDocumentPerformanceEventLoopProbe(): void {
  if (!documentPerformanceProbeEnabled()) return;
  const probeGlobal = globalThis as DocumentPerformanceProbeGlobal;
  if (probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_RESET_EVENT_LOOP__) return;

  probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_RESET_EVENT_LOOP__ =
    resetDocumentPerformanceEventLoopProbe;
  resetDocumentPerformanceEventLoopProbe();
  globalThis.setInterval(() => {
    const state = probeGlobal.__BINDARS_DOCUMENT_PERFORMANCE_EVENT_LOOP__;
    if (!state) return;
    const now = performance.now();
    const gapMs = now - state.lastSampleAtMs;
    state.lastSampleAtMs = now;
    state.sampleCount += 1;
    state.maxGapMs = Math.max(state.maxGapMs, gapMs);
    state.maxDelayMs = Math.max(state.maxDelayMs, gapMs - state.intervalMs);
  }, DOCUMENT_PERFORMANCE_EVENT_LOOP_INTERVAL_MS);
}

startDocumentPerformanceEventLoopProbe();

export interface SmartypantsGateOptions {
  /** Tests may lower the production ceiling to exercise exact boundaries. */
  maxWords?: number;
  /** Tests may lower the production character ceiling to exercise exact boundaries. */
  maxChars?: number;
}

export interface SmartypantsInputMeasurement {
  words: number;
  chars: number;
}

/**
 * Measure the exact mdast input remark-smartypants assembles: it concatenates
 * every `text` value and `inlineCode` value (the latter as a same-length
 * placeholder) plus one separator space per `paragraph`, then runs parse-latin
 * over the whole string. Counting the same nodes is the only faithful measure
 * — counting the raw source instead lets a document whose backticks sit inside
 * an HTML comment (or an indented, unclosed, or container fence) hide real
 * prose from the gate.
 *
 * Words alone cannot bound that work: parse-latin tokenizes on punctuation,
 * so `a,a,a,…` is one whitespace-delimited word but thousands of fragments.
 * The character total therefore bounds the aggregate transformer input while
 * the word total keeps the original prose ceiling; either one exceeding its
 * policy ceiling disables smartypants. Counting happens in one traversal,
 * stops as soon as either ceiling is passed, and allocates no copy of the
 * document.
 */
export function measureSmartypantsInput(
  tree: MdastRoot,
  stopAfterWords = Infinity,
  stopAfterChars = Infinity,
): SmartypantsInputMeasurement {
  let words = 0;
  let chars = 0;

  const visit = (node: MdastRoot | MdastContent): void => {
    if (words > stopAfterWords || chars > stopAfterChars) return;
    if (node.type === "text" || node.type === "inlineCode") {
      words += countWords(node.value);
      chars += node.value.length;
      return;
    }
    if (node.type === "paragraph") {
      // The plugin injects one separator space per visited paragraph.
      chars += 1;
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
        if (words > stopAfterWords || chars > stopAfterChars) return;
      }
    }
  };

  visit(tree);
  return { words, chars };
}

/**
 * remark-smartypants, skipped for documents above the policy's word or
 * character ceiling. Gating inside the transformer keeps one parse and one
 * plugin list: the decision uses the tree that has already been parsed.
 */
export function remarkGatedSmartypants(options: SmartypantsGateOptions = {}) {
  const maxWords = clampToProductionLimit(SMARTYPANTS_MAX_WORDS, options.maxWords);
  const maxChars = clampToProductionLimit(SMARTYPANTS_MAX_CHARS, options.maxChars);
  // remark-smartypants is a plain factory returning a synchronous transformer;
  // it does not use its unified `this` context.
  const transform = (remarkSmartypants as unknown as () => (tree: MdastRoot) => void)();

  return (tree: MdastRoot): void => {
    const probeEnabled = documentPerformanceProbeEnabled();
    const startedAt = probeEnabled ? performance.now() : 0;
    const input = measureSmartypantsInput(tree, maxWords, maxChars);
    const measuredAt = probeEnabled ? performance.now() : 0;
    const applied = input.words <= maxWords && input.chars <= maxChars;
    if (applied) transform(tree);
    if (probeEnabled) {
      const transformedAt = performance.now();
      recordDocumentPerformanceEvent({
        type: "markdown-pipeline",
        atMs: startedAt,
        smartypants: {
          applied,
          chars: input.chars,
          words: input.words,
          measureMs: measuredAt - startedAt,
          transformMs: transformedAt - measuredAt,
        },
      });
    }
  };
}

export const remarkPlugins: PluggableList = [
  remarkGfm,
  remarkGatedSmartypants,
  // singleDollarTextMath off: single $...$ stays literal text so currency in
  // prose ("$150 to $250") never parses as math; inline math uses $$...$$
  [remarkMath, { singleDollarTextMath: false }],
  remarkFrontmatter,
];

export interface ExpensiveNodeLimits {
  /** Tests may lower the production budgets to exercise exact boundaries. */
  highlightMaxNodeChars?: number;
  highlightMaxTotalChars?: number;
  mathMaxNodeChars?: number;
  mathMaxTotalChars?: number;
}

const MATH_CLASS_NAMES = new Set(["language-math", "math-display", "math-inline"]);

/**
 * KaTeX macro expansion decouples output size from input size, so math that
 * can define or invoke a macro body is degraded to plain text. Two routes were
 * measured, both far outside the character budget's expansion ratio:
 *
 * - explicit definitions: 2,468 chars expanded to 240,006 spans;
 * - KaTeX internal control sequences: `\tag{…}` compiles to
 *   `\gdef\df@tag{\text{#1}}` (katex/src/macros.ts), so invoking `\df@tag`
 *   directly replays a caller-supplied body that may re-enter math mode with
 *   `$…$`. 4,526 accepted chars expanded to 994,972 spans and 41.5 MB.
 *
 * Internal sequences are matched by their `@`, which ordinary math never uses
 * in a control sequence (TeX gives `@` a non-letter catcode outside package
 * internals). Ordinary `\tag{…}` keeps working; only direct use of the
 * internals is rejected. A false positive costs styling on that one node.
 */
const MATH_UNSAFE_COMMAND_RE =
  /\\(?:[gex]?def|let|futurelet|global|newcommand|renewcommand|providecommand|newenvironment|renewenvironment)\b|\\[a-zA-Z]*@/i;

type HastElement = Extract<RootContent, { type: "element" }>;

function elementClassNames(element: HastElement): string[] {
  const className = element.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  if (typeof className === "string") return className.split(/\s+/);
  return [];
}

function nodeText(node: Root | RootContent): string {
  if (node.type === "text") return node.value;
  if ("children" in node) {
    let text = "";
    for (const child of node.children) text += nodeText(child);
    return text;
  }
  return "";
}

function nodeTextLength(node: Root | RootContent): number {
  if (node.type === "text") return node.value.length;
  if ("children" in node) {
    let length = 0;
    for (const child of node.children) length += nodeTextLength(child);
    return length;
  }
  return 0;
}

/**
 * Runs before rehype-highlight and rehype-katex. Adds `no-highlight` (which
 * rehype-highlight honors) to oversized or over-budget code blocks and strips
 * the math classes rehype-katex looks for from oversized, over-budget, or
 * unsafe math nodes — those defining a macro explicitly or using a KaTeX
 * internal control sequence — so both passes skip them. The budgets bound
 * input; see the policy constants in document-complexity.ts for the measured
 * expansion ratios behind them.
 */
export function rehypeLimitExpensiveNodes(options: ExpensiveNodeLimits = {}) {
  const highlightMaxNode = clampToProductionLimit(HIGHLIGHT_MAX_NODE_CHARS, options.highlightMaxNodeChars);
  const highlightMaxTotal = clampToProductionLimit(HIGHLIGHT_MAX_TOTAL_CHARS, options.highlightMaxTotalChars);
  const mathMaxNode = clampToProductionLimit(MATH_MAX_NODE_CHARS, options.mathMaxNodeChars);
  const mathMaxTotal = clampToProductionLimit(MATH_MAX_TOTAL_CHARS, options.mathMaxTotalChars);

  return (tree: Root): void => {
    let highlightBudget = highlightMaxTotal;
    let mathBudget = mathMaxTotal;

    const visit = (node: Root | RootContent, parent: Root | RootContent | null): void => {
      if (node.type === "element") {
        const classes = elementClassNames(node);
        const isMath = classes.some((name) => MATH_CLASS_NAMES.has(name));
        // rehype-highlight only processes `pre > code` carrying a language
        // class, so only those consume the highlight budget.
        const isHighlightable =
          !isMath &&
          node.tagName === "code" &&
          parent?.type === "element" &&
          parent.tagName === "pre" &&
          classes.some((name) => name.startsWith("language-"));

        if (isMath) {
          const text = nodeText(node);
          if (
            text.length > mathMaxNode ||
            text.length > mathBudget ||
            MATH_UNSAFE_COMMAND_RE.test(text)
          ) {
            node.properties = {
              ...node.properties,
              className: classes.filter((name) => !MATH_CLASS_NAMES.has(name)),
            };
          } else {
            mathBudget -= text.length;
          }
        } else if (isHighlightable) {
          const length = nodeTextLength(node);
          if (length > highlightMaxNode || length > highlightBudget) {
            node.properties = {
              ...node.properties,
              className: [...classes, "no-highlight"],
            };
          } else {
            highlightBudget -= length;
          }
        }
      }

      if ("children" in node) {
        for (const child of node.children) visit(child, node);
      }
    };

    visit(tree, null);
  };
}

// Order matters:
// 1. rehypeLimitExpensiveNodes: marks oversized code/math so the expansion
//    passes below skip them
// 2. rehype-slug: generates heading IDs for TOC
// 3. rehype-highlight: adds syntax highlighting classes
// 4. rehype-sanitize: strips unsafe HTML (preserves math nodes via schema)
// 5. rehype-katex: converts math nodes to KaTeX HTML (runs AFTER sanitize
//    because its output is trusted library-generated HTML)
export function createRehypePlugins(lineOffset = 0): PluggableList {
  return [
    rehypeLimitExpensiveNodes,
    rehypeSlug,
    // plainText math: remark-math emits `language-math` code blocks, which the
    // highlighter has no grammar for and would flag with a file message
    [rehypeHighlight, { plainText: ["math"] }],
    [rehypeSourcePositions, { lineOffset }],
    [rehypeSanitize, sanitizeSchema],
    [rehypeKatex, { maxExpand: MATH_MAX_EXPAND, maxSize: MATH_MAX_SIZE }],
  ];
}

export const rehypePlugins: PluggableList = createRehypePlugins();
