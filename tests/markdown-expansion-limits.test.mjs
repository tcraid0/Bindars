import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";

const require = createRequire(import.meta.url);

const {
  remarkPlugins,
  rehypePlugins,
  createRehypePlugins,
  rehypeLimitExpensiveNodes,
  remarkGatedSmartypants,
} = require("../.tmp/workspace-tests/src/lib/markdown-plugins.js");
const {
  HIGHLIGHT_MAX_NODE_CHARS,
  HIGHLIGHT_MAX_TOTAL_CHARS,
  MATH_MAX_NODE_CHARS,
  MATH_MAX_TOTAL_CHARS,
  MATH_MAX_EXPAND,
  MATH_MAX_SIZE,
  SMARTYPANTS_MAX_CHARS,
  SMARTYPANTS_MAX_WORDS,
  MARKDOWN_MAX_INDENT_COLUMNS,
  MARKDOWN_MAX_INLINE_NESTING,
  checkDocumentComplexity,
} = require("../.tmp/workspace-tests/src/lib/document-complexity.js");

function renderMarkdown(markdown, { remark = remarkPlugins, rehype = rehypePlugins } = {}) {
  return renderToStaticMarkup(
    React.createElement(Markdown, { remarkPlugins: remark, rehypePlugins: rehype }, markdown),
  );
}

// Production pipeline with reduced limiter budgets, for exact boundaries.
function reducedRehype(limits) {
  return [[rehypeLimitExpensiveNodes, limits], ...createRehypePlugins().slice(1)];
}

function reducedRemark(maxWords) {
  return [remarkGfm, [remarkGatedSmartypants, { maxWords }], remarkMath, remarkFrontmatter];
}

function reducedRemarkOptions(options) {
  return [remarkGfm, [remarkGatedSmartypants, options], remarkMath, remarkFrontmatter];
}

/**
 * One paragraph holding `assembledChars - 1` characters of text: the plugin
 * concatenates the text value plus one separator space for the paragraph,
 * giving exactly `assembledChars` of smartypants input. The `a,` fragments
 * keep the whitespace word count at 2 while parse-latin tokenizes each
 * fragment individually, so this shape cannot be caught by the word gate.
 */
function punctuationDocument(assembledChars) {
  const suffix = ' "hello"';
  const textChars = assembledChars - 1;
  const body = "a,".repeat(Math.floor((textChars - suffix.length) / 2));
  const pad = "a".repeat(textChars - suffix.length - body.length);
  return body + pad + suffix;
}

function nestedEmphasis(depth) {
  let content = "x";
  for (let index = 0; index < depth; index += 1) {
    content = `*a ${content} b*`;
  }
  return content;
}

// A fenced code node's hast text is its content plus one trailing newline.
function fenceWithNodeChars(nodeChars) {
  return `\`\`\`python\n${"1 ".repeat(nodeChars).slice(0, nodeChars - 1)}\n\`\`\`\n`;
}

// A math block's hast text is exactly its content.
function mathWithNodeChars(nodeChars) {
  return `$$\n${"x y ".repeat(nodeChars).slice(0, nodeChars)}\n$$\n`;
}

const countMatches = (html, re) => (html.match(re) ?? []).length;
const isHighlighted = (html) => /hljs-/.test(html);
const hasKatex = (html) => /class="katex/.test(html);

test("per-node code budget highlights immediately below and at the limit, not above", () => {
  const rehype = reducedRehype({ highlightMaxNodeChars: 16, highlightMaxTotalChars: 4096 });

  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(15), { rehype })), true);
  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(16), { rehype })), true);
  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(17), { rehype })), false);
});

test("aggregate code budget highlights immediately below and at the limit, not above", () => {
  const rehype = reducedRehype({ highlightMaxNodeChars: 4096, highlightMaxTotalChars: 24 });

  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(23), { rehype })), true);
  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(24), { rehype })), true);
  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(25), { rehype })), false);
});

test("aggregate code budget is spent across separate blocks, not reset per block", () => {
  const rehype = reducedRehype({ highlightMaxNodeChars: 16, highlightMaxTotalChars: 32 });
  const blocks = renderMarkdown(fenceWithNodeChars(16).repeat(3), { rehype }).split("<pre").slice(1);

  assert.equal(blocks.length, 3);
  assert.equal(isHighlighted(blocks[0]), true);
  assert.equal(isHighlighted(blocks[1]), true);
  assert.equal(isHighlighted(blocks[2]), false);
});

test("per-node math budget renders KaTeX immediately below and at the limit, not above", () => {
  const rehype = reducedRehype({ mathMaxNodeChars: 16, mathMaxTotalChars: 4096 });

  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(15), { rehype })), true);
  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(16), { rehype })), true);
  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(17), { rehype })), false);
});

test("aggregate math budget renders KaTeX immediately below and at the limit, not above", () => {
  const rehype = reducedRehype({ mathMaxNodeChars: 4096, mathMaxTotalChars: 24 });

  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(23), { rehype })), true);
  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(24), { rehype })), true);
  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(25), { rehype })), false);
});

test("aggregate math budget is spent across separate blocks, not reset per block", () => {
  const rehype = reducedRehype({ mathMaxNodeChars: 16, mathMaxTotalChars: 32 });
  const html = renderMarkdown(mathWithNodeChars(16).repeat(3), { rehype });

  assert.equal(countMatches(html, /katex-display/g), 2);
});

test("test-only budgets cannot raise the production budgets", () => {
  const rehype = reducedRehype({
    highlightMaxNodeChars: Number.MAX_SAFE_INTEGER,
    mathMaxNodeChars: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(isHighlighted(renderMarkdown(fenceWithNodeChars(HIGHLIGHT_MAX_NODE_CHARS + 1), { rehype })), false);
  assert.equal(hasKatex(renderMarkdown(mathWithNodeChars(MATH_MAX_NODE_CHARS + 1), { rehype })), false);
});

test("math defining macros renders as plain text, since macros decouple output size from input size", () => {
  // Measured before this guard: 2,468 accepted chars expanded to 240,006 spans.
  const macro = `$$\n\\def\\x{${"x y ".repeat(240)}}${"\\x ".repeat(500)}\n$$\n`;
  const html = renderMarkdown(macro);

  assert.equal(hasKatex(html), false);
  assert.ok(countMatches(html, /<span/g) < 100);
});

test("every macro-definition form is degraded, and ordinary math is unaffected", () => {
  for (const definition of [
    "\\def\\a{x}\\a",
    "\\gdef\\a{x}\\a",
    "\\edef\\a{x}\\a",
    "\\xdef\\a{x}\\a",
    "\\let\\a\\alpha \\a",
    "\\futurelet\\a\\relax x",
    "\\global\\def\\a{x}\\a",
    "\\newcommand{\\a}{x}\\a",
    "\\renewcommand{\\a}{x}\\a",
    "\\providecommand{\\a}{x}\\a",
    "\\newenvironment{e}{}{}x",
    "\\renewenvironment{e}{}{}x",
  ]) {
    assert.equal(hasKatex(renderMarkdown(`$$\n${definition}\n$$\n`)), false, definition);
  }

  assert.equal(hasKatex(renderMarkdown("$$\n\\dfrac{a}{b} + \\sqrt{x^2} = \\sum_{i=0}^{n}\\alpha_i\n$$\n")), true);
});

test("KaTeX internal control sequences are degraded, because \\tag defines a macro body indirectly", () => {
  // \tag{…} compiles to \gdef\df@tag{\text{#1}}, so invoking \df@tag replays a
  // caller-supplied body. Measured before this guard: 4,526 accepted chars
  // expanded to 994,972 spans and 41.5 MB.
  const body = "$\\dfrac{a}{b}$".repeat(180);
  const amplified = `$$\n\\tag{${body}}${"\\df@tag ".repeat(250)}\n$$\n`;

  assert.ok(body.length + 250 * 8 < MATH_MAX_NODE_CHARS, "fixture must stay under the node budget");
  const html = renderMarkdown(amplified);
  assert.equal(hasKatex(html), false);
  assert.ok(countMatches(html, /<span/g) < 100);

  for (const internal of ["\\df@tag x", "\\@ifstar x", "\\text{a}\\z@ b"]) {
    assert.equal(hasKatex(renderMarkdown(`$$\n${internal}\n$$\n`)), false, internal);
  }
});

test("ordinary \\tag and literal @ text still render as math", () => {
  assert.equal(hasKatex(renderMarkdown("$$\nx + y = z \\tag{1}\n$$\n")), true);
  assert.equal(hasKatex(renderMarkdown("$$\n\\text{write to a@b.example}\n$$\n")), true);
});

test("macro expansions immediately below and at the cap render, above it degrades gracefully", () => {
  // \empty costs exactly one expansion, giving an exact, dependency-checked
  // boundary for MATH_MAX_EXPAND.
  const expansions = (count) => `$$\n${"\\empty ".repeat(count)}x\n$$\n`;

  assert.equal(hasKatex(renderMarkdown(expansions(MATH_MAX_EXPAND - 1))), true);
  assert.equal(hasKatex(renderMarkdown(expansions(MATH_MAX_EXPAND))), true);

  // Above the cap KaTeX reports a bounded parse error rather than expanding.
  const html = renderMarkdown(expansions(MATH_MAX_EXPAND + 1));
  assert.match(html, /katex-error/);
  assert.ok(countMatches(html, /<span/g) < 100);
});

test("math sizes immediately below and at the cap are preserved, above it is clamped", () => {
  const renderedWidth = (em) => {
    const html = renderMarkdown(`$$\n\\rule{${em}em}{1em}\n$$\n`);
    const match = /border-right-width:([0-9.]+)em/.exec(html);
    assert.ok(match, `expected a rendered width for ${em}em`);
    return Number(match[1]);
  };

  assert.equal(renderedWidth(MATH_MAX_SIZE - 1), MATH_MAX_SIZE - 1);
  assert.equal(renderedWidth(MATH_MAX_SIZE), MATH_MAX_SIZE);
  assert.equal(renderedWidth(MATH_MAX_SIZE + 1), MATH_MAX_SIZE);
});

test("user-specified math sizes are capped so layout cannot be driven to extremes", () => {
  const html = renderMarkdown("$$\n\\rule{1000000000em}{1em}\n$$\n");
  // Only layout-bearing values matter; the MathML annotation echoes the
  // original LaTeX source and costs nothing to lay out.
  const layoutEms = [...html.matchAll(/(?:style="[^"]*"|width="[^"]*")/g)]
    .flatMap((match) => [...match[0].matchAll(/([0-9.]+)em/g)])
    .map((match) => Number(match[1]));

  assert.ok(layoutEms.length > 0, "expected rendered em dimensions");
  assert.deepEqual(layoutEms.filter((value) => value > MATH_MAX_SIZE), []);
});

test("smartypants applies immediately below and at the word ceiling, not above", () => {
  const quoted = '"hello"';
  const document = (words) => `${"a ".repeat(words - 1)}${quoted}`;

  assert.match(renderMarkdown(document(7), { remark: reducedRemark(8) }), /“hello”/);
  assert.match(renderMarkdown(document(8), { remark: reducedRemark(8) }), /“hello”/);
  assert.doesNotMatch(renderMarkdown(document(9), { remark: reducedRemark(8) }), /“hello”/);
});

test("the production smartypants ceiling is inclusive at exactly its word count", () => {
  // The fixture sits in a heading because a paragraph of 32,768 words needs
  // at least 65,535 text characters plus the separator space the plugin
  // injects per paragraph — one character over SMARTYPANTS_MAX_CHARS, so the
  // word boundary is only observable where no paragraph separator is
  // counted. These fixtures sit at exactly both inclusive ceilings: 32,768
  // words and 65,536 assembled characters.
  const atLimit = `# "a${" a".repeat(SMARTYPANTS_MAX_WORDS - 1)}`;
  const aboveLimit = `# "a${" a".repeat(SMARTYPANTS_MAX_WORDS)}`;

  assert.match(renderMarkdown(atLimit), /“a/);
  assert.doesNotMatch(renderMarkdown(aboveLimit), /“a/);
});

test("the smartypants gate counts parsed prose, so false code delimiters cannot hide words", () => {
  const prose = `${"a ".repeat(SMARTYPANTS_MAX_WORDS)}"hello"`;
  const fixtures = {
    "backticks inside HTML comments": `<!-- \`\`\` -->\n\n${prose}\n\n<!-- \`\`\` -->\n`,
    "indented backticks": `    \`\`\`\n\n${prose}\n\n    \`\`\`\n`,
    "backticks inside inline code spans": `\`\` \`\`\` \`\`\n\n${prose}\n\n\`\` \`\`\` \`\`\n`,
    "backticks inside blockquotes": `> \`\`\`\n\n${prose}\n\n> \`\`\`\n`,
  };

  // The superseded implementation stripped fenced code from the raw source.
  // Each fixture must actually defeat that, or it proves nothing.
  const strippedByRawSourceRegex = (document) =>
    document.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");

  for (const [label, document] of Object.entries(fixtures)) {
    const wordsSeenByOldGate = strippedByRawSourceRegex(document).split(/\s+/).filter(Boolean).length;
    assert.ok(
      wordsSeenByOldGate <= SMARTYPANTS_MAX_WORDS,
      `${label}: fixture does not defeat raw-source stripping, so it is not a false delimiter`,
    );
    assert.doesNotMatch(renderMarkdown(document), /“hello”/, label);
  }
});

test("real fenced code is excluded from the prose count, so code-heavy documents keep typography", () => {
  const codeHeavy = `\`\`\`python\n${"1 ".repeat(SMARTYPANTS_MAX_WORDS * 2)}\n\`\`\`\n\nShe said "hello".\n`;
  assert.match(renderMarkdown(codeHeavy), /“hello”/);
});

test("punctuation fragments cannot bypass the aggregate smartypants character ceiling", () => {
  // 2 whitespace words and well below the structural-unit total: only the
  // character ceiling can gate this shape. The output proves behavior — at
  // or below the limit the quoted suffix becomes curly, above it smartypants
  // is skipped and the straight quotes remain.
  for (const assembledChars of [SMARTYPANTS_MAX_CHARS - 1, SMARTYPANTS_MAX_CHARS, SMARTYPANTS_MAX_CHARS + 1]) {
    const document = punctuationDocument(assembledChars);
    const complexity = checkDocumentComplexity(document, "markdown");
    assert.ok(complexity.ok, `fixture ${assembledChars} must stay under the structural policy`);
  }

  assert.match(renderMarkdown(punctuationDocument(SMARTYPANTS_MAX_CHARS - 1)), /“hello”/);
  assert.match(renderMarkdown(punctuationDocument(SMARTYPANTS_MAX_CHARS)), /“hello”/);
  assert.doesNotMatch(renderMarkdown(punctuationDocument(SMARTYPANTS_MAX_CHARS + 1)), /“hello”/);
});

test("the smartypants character boundary is exact at reduced test limits", () => {
  const remark = reducedRemarkOptions({ maxWords: 4_096, maxChars: 64 });

  assert.match(renderMarkdown(punctuationDocument(63), { remark }), /“hello”/);
  assert.match(renderMarkdown(punctuationDocument(64), { remark }), /“hello”/);
  assert.doesNotMatch(renderMarkdown(punctuationDocument(65), { remark }), /“hello”/);
});

test("test-only limits cannot raise the production smartypants character ceiling", () => {
  const remark = reducedRemarkOptions({ maxWords: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER });

  assert.match(renderMarkdown(punctuationDocument(SMARTYPANTS_MAX_CHARS), { remark }), /“hello”/);
  assert.doesNotMatch(renderMarkdown(punctuationDocument(SMARTYPANTS_MAX_CHARS + 1), { remark }), /“hello”/);
});

test("inline code values count toward the smartypants character ceiling", () => {
  const remark = reducedRemarkOptions({ maxWords: 4_096, maxChars: 48 });
  // 44 chars inside an inline code span, then a quoted suffix: 44 + 1
  // paragraph separator + 8 suffix chars = 53 > 48.
  const overLimit = `\`${"a,".repeat(22)}\` "hello"`;
  assert.doesNotMatch(renderMarkdown(overLimit, { remark }), /“hello”/);

  // 20 chars inside the span: 20 + 1 + 8 = 29 ≤ 48.
  const underLimit = `\`${"a,".repeat(10)}\` "hello"`;
  assert.match(renderMarkdown(underLimit, { remark }), /“hello”/);
});

test("real fenced code is excluded from the character count, so code-heavy documents keep typography", () => {
  const codeHeavy = `\`\`\`\n${"1".repeat(SMARTYPANTS_MAX_CHARS + 100)}\n\`\`\`\n\nShe said "hello".\n`;
  assert.match(renderMarkdown(codeHeavy), /“hello”/);
});

test("false code delimiters cannot hide punctuation fragments from the character gate", () => {
  const prose = punctuationDocument(SMARTYPANTS_MAX_CHARS + 1);
  const document = `<!-- \`\`\` -->\n\n${prose}\n\n<!-- \`\`\` -->\n`;

  // The superseded implementation inspected the raw source after regex fence
  // stripping. This fixture must actually defeat that, or it proves nothing.
  const stripped = document.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
  assert.ok(stripped.length < 100, "fixture does not defeat raw-source stripping");

  assert.doesNotMatch(renderMarkdown(document), /“hello”/);
});

test("the maximum accepted inline nesting renders without recursive conversion failure", () => {
  const atLimit = nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING);
  const aboveLimit = nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING + 1);

  assert.equal(checkDocumentComplexity(atLimit, "markdown").ok, true);
  assert.doesNotThrow(() => renderMarkdown(atLimit));
  assert.equal(checkDocumentComplexity(aboveLimit, "markdown").ok, false);
});

test("maximum accepted list and inline nesting render safely when combined", () => {
  const inline = nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING);
  const lineCount = MARKDOWN_MAX_INDENT_COLUMNS / 2;
  const combined = Array.from(
    { length: lineCount },
    (_, index) => `${"  ".repeat(index)}- ${index === lineCount - 1 ? inline : "x"}`,
  ).join("\n");

  assert.equal(checkDocumentComplexity(combined, "markdown").ok, true);
  assert.doesNotThrow(() => renderMarkdown(combined));
});

test("cross-delimiter bypasses are rejected before the renderer can recurse", () => {
  // Every shape here nests emphasis 3,000 deep in the installed parser while
  // offering a run the scanner must not treat as a closer. Before the fix each
  // one passed preflight and then threw `RangeError: Maximum call stack size
  // exceeded` out of `mdast-util-to-hast`, so preflight is the only thing that
  // may run on them.
  const bypasses = {
    "inert `~` run": `${"*a~ ".repeat(3_000)}x${"*".repeat(3_000)}`,
    "inert `_` run": `${"*a_ ".repeat(3_000)}x${"*".repeat(3_000)}`,
    "marker-only `+` line": `${"*a\n+\n".repeat(3_000)}x${"*".repeat(3_000)}`,
    "rule-of-three closer": `${"*a b**c ".repeat(3_000)}x${"*".repeat(3_000)}`,
    "link-label closer": `${"*a [b*](c) ".repeat(3_000)}x${"*".repeat(3_000)}`,
    // The two backtick runs cannot pair: the heading ends the first paragraph,
    // so everything between them is ordinary inline content, not code.
    "code span split by a heading":
      `\`\` a\n# h\n${"*a ".repeat(3_000)}x${" b*".repeat(3_000)} \`\``,
  };

  for (const [label, source] of Object.entries(bypasses)) {
    assert.equal(checkDocumentComplexity(source, "markdown").ok, false, label);
  }
});

test("ordinary delimiter-heavy documents are accepted and still render their formatting", () => {
  const lines = (count, make) => Array.from({ length: count }, (_, i) => make(i)).join("\n");
  const document = [
    lines(200, (i) => `The user_id field ${i} maps to account_id and MAX_RETRY_COUNT.`),
    "",
    lines(200, (i) => `Set \`max_retries_${i}\` and \`a*b*c\` here.`),
    "",
    `\`\`\`python\n${lines(200, (i) => `def handler_${i}(*args, **kwargs): user_name = a*b`)}\n\`\`\``,
    "",
    `~~~yaml\n${lines(200, (i) => `max_retry_count_${i}: 3`)}\n~~~`,
    "",
    `| field | type |\n| --- | --- |\n${lines(200, (i) => `| user_name_${i} | string |`)}`,
    "",
    "Real *emphasis*, **strong**, ~~struck~~, a [link](target_file.md), and `code_span`.",
    "",
    "Escaped \\*stars\\* and \\_underscores\\_ stay literal.",
  ].join("\n");

  assert.equal(checkDocumentComplexity(document, "markdown").ok, true);

  const html = renderMarkdown(document);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /<del>struck<\/del>/);
  assert.match(html, /<a href="target_file\.md">link<\/a>/);
  assert.match(html, /<code>code_span<\/code>/);
  assert.match(html, /<table[\s>]/);
  // Escaped delimiters and snake_case identifiers must not become formatting.
  assert.match(html, /\*stars\*/);
  assert.match(html, /user_id field 0/);
});

test("worst-case segmented payloads stay within the measured expansion ratios", () => {
  // These ratios are measured for these shapes, not proven parser invariants:
  // highlight.js ~0.5 spans/char, KaTeX without macros worst 1.8 spans/char.
  const codeBlocks = Math.ceil(HIGHLIGHT_MAX_TOTAL_CHARS / HIGHLIGHT_MAX_NODE_CHARS) + 2;
  const codeHtml = renderMarkdown(fenceWithNodeChars(HIGHLIGHT_MAX_NODE_CHARS).repeat(codeBlocks));
  assert.ok(
    countMatches(codeHtml, /<span/g) <= HIGHLIGHT_MAX_TOTAL_CHARS,
    "highlight spans exceeded the character budget",
  );

  const mathBlocks = Math.ceil(MATH_MAX_TOTAL_CHARS / MATH_MAX_NODE_CHARS) + 2;
  const mathHtml = renderMarkdown(mathWithNodeChars(MATH_MAX_NODE_CHARS).repeat(mathBlocks));
  assert.ok(
    countMatches(mathHtml, /<span/g) <= MATH_MAX_TOTAL_CHARS * 2,
    "math spans exceeded twice the character budget",
  );
  assert.equal(countMatches(mathHtml, /katex-display/g), Math.floor(MATH_MAX_TOTAL_CHARS / MATH_MAX_NODE_CHARS));
});
