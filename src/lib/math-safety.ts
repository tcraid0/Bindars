import {
  clampToProductionLimit,
  MATH_MAX_NODE_CHARS,
  MATH_MAX_TOTAL_CHARS,
} from "./document-complexity";

/**
 * KaTeX macro expansion decouples output size from input size, so math that
 * can define or invoke a macro body is never handed to KaTeX. Two routes were
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
export const MATH_UNSAFE_COMMAND_RE =
  /\\(?:[gex]?def|let|futurelet|global|newcommand|renewcommand|providecommand|newenvironment|renewenvironment)\b|\\[a-zA-Z]*@/i;

export interface MathBudgetLimits {
  /** Tests may lower the production budgets to exercise exact boundaries. */
  maxNodeChars?: number;
  maxTotalChars?: number;
}

export interface MathBudget {
  /**
   * Whether `source` may be handed to KaTeX. Its length is charged against
   * the per-node and aggregate input budgets. `views` are the texts KaTeX
   * would actually receive after the caller's own pipeline (`source` itself
   * by default); every one must be free of macro definitions and KaTeX
   * internal control sequences. Accepting consumes the aggregate budget.
   */
  accept(source: string, views?: readonly string[]): boolean;
}

/**
 * The one math-safety policy for every KaTeX consumer: ordinary Markdown math
 * in `rehypeLimitExpensiveNodes` and math inside Mermaid diagram labels in
 * `MermaidBlock`. The input budgets bound KaTeX's work for ordinary math by
 * the measured expansion ratios in document-complexity.ts; the command check
 * removes the two shapes whose output size is not bounded by input size.
 * Each budget covers one rendering unit: a document, or one diagram.
 */
export function createMathBudget(limits: MathBudgetLimits = {}): MathBudget {
  const maxNode = clampToProductionLimit(MATH_MAX_NODE_CHARS, limits.maxNodeChars);
  let remaining = clampToProductionLimit(MATH_MAX_TOTAL_CHARS, limits.maxTotalChars);

  return {
    accept(source, views = [source]) {
      if (source.length > maxNode || source.length > remaining) return false;
      if (views.some((view) => MATH_UNSAFE_COMMAND_RE.test(view))) return false;
      remaining -= source.length;
      return true;
    },
  };
}
