/**
 * Shared adversarial fixtures for the Markdown complexity ceilings.
 *
 * Both the source-level suite (`document-complexity.test.cjs`) and the
 * installed-pipeline suite (`markdown-expansion-limits.test.mjs`) assert
 * against the same catalogue, so neither can quietly stop covering a shape the
 * other still checks.
 */

/**
 * Shapes that drove the inline-nesting counter back down with a run the
 * installed parser cannot use as a closer, letting emphasis keep nesting. At
 * 3,000 levels each of these produced a real tree deep enough to overflow
 * `mdast-util-to-hast` with `RangeError: Maximum call stack size exceeded`.
 *
 * Each segment opens one `*` and then offers a false closer; the tail closes
 * every opener at once so the parser really does build the nested tree.
 */
const BYPASS_SEGMENTS = {
  "inert `~` run": "*a~ ",
  "inert `_` run": "*a_ ",
  "marker-only `+` line": "*a\n+\n",
  "rule-of-three closer": "*a b**c ",
  "link-label closer": "*a [b*](c) ",
  "autolink closer": "*a <http://x/*> ",
  "escaped closer": "*a\\* ",
  "code-span closer": "*a `*` ",
  "over-long tilde run": "*a~~~ ",
};

/** Lines that end a paragraph, so two backtick runs around them cannot pair. */
const PARAGRAPH_INTERRUPTERS = {
  "ATX heading": "# h",
  "thematic break": "***",
  "list marker": "- i",
};

function inlineNestingBypasses(levels = 3_000) {
  const fixtures = {};
  for (const [label, segment] of Object.entries(BYPASS_SEGMENTS)) {
    fixtures[label] = `${segment.repeat(levels)}x${"*".repeat(levels)}`;
  }
  return fixtures;
}

function splitCodeSpanBypasses(levels = 3_000) {
  const nested = `${"*a ".repeat(levels)}x${" b*".repeat(levels)} \`\``;
  const fixtures = {};
  for (const [label, interrupter] of Object.entries(PARAGRAPH_INTERRUPTERS)) {
    fixtures[`code span split by a ${label}`] = `\`\` a\n${interrupter}\n${nested}`;
  }
  return fixtures;
}

/**
 * The same shape with an unclosed fence instead, which must stay accepted: the
 * fence really does run to the end of the document, so the parser sees one
 * shallow code block (measured top-level blocks `paragraph`, `code`).
 */
function fencedCodeLookalike(levels = 3_000) {
  return `\`\` a\n\`\`\`\n${"*a ".repeat(levels)}x${" b*".repeat(levels)} \`\``;
}

module.exports = {
  BYPASS_SEGMENTS,
  PARAGRAPH_INTERRUPTERS,
  inlineNestingBypasses,
  splitCodeSpanBypasses,
  fencedCodeLookalike,
};
