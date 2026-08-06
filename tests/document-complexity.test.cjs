const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const {
  checkDocumentComplexity,
  DOCUMENT_COMPLEXITY_MESSAGE,
  DOCUMENT_COMPLEXITY_POLICY,
  DocumentComplexityError,
  MARKDOWN_INDENT_COLUMNS_PER_UNIT,
  MARKDOWN_MAX_CONTAINER_DEPTH,
  MARKDOWN_MAX_INDENT_COLUMNS,
  MARKDOWN_MAX_INLINE_NESTING,
} = require("../.tmp/workspace-tests/src/lib/document-complexity.js");
const {
  prepareReaderDocument,
} = require("../.tmp/workspace-tests/src/lib/document-processing.js");
const {
  inlineNestingBypasses,
  splitCodeSpanBypasses,
  whitespaceOnlyLineBypasses,
  blankLineControls,
  fencedCodeLookalike,
} = require("./markdown-complexity-fixtures.cjs");
const { parseFountain } = require("../.tmp/workspace-tests/src/lib/fountain.js");
const { parseSlides } = require("../.tmp/workspace-tests/src/lib/slide-parser.js");
const {
  tryBuildWorkspaceDoc,
} = require("../.tmp/workspace-tests/src/lib/workspace-index.js");
const {
  DocumentComplexityNotice,
} = require("../.tmp/workspace-tests/src/components/DocumentComplexityNotice.js");
const { WorkspacePanel } = require("../.tmp/workspace-tests/src/components/WorkspacePanel.js");

function contentWithExactUnits(format, units) {
  if (units === 0) return "";
  const marker = format === "markdown" ? "#" : "*";
  return `a${marker.repeat(units - 1)}`;
}

function makeMeta(name) {
  return {
    path: `/workspace/${name}`,
    relPath: name,
    name,
    mtimeMs: 0,
    size: 0,
  };
}

function nestedEmphasis(depth, marker = "*") {
  let content = "x";
  for (let index = 0; index < depth; index += 1) {
    content = `${marker}a ${content} b${marker}`;
  }
  return content;
}

function quotedProgressiveList(lines) {
  return Array.from(
    { length: lines },
    (_, index) => `> ${"  ".repeat(index)}- x`,
  ).join("\n");
}

test("production complexity policy defines explicit provisional safety ceilings", () => {
  assert.deepEqual(DOCUMENT_COMPLEXITY_POLICY, {
    markdown: { maxUnits: 30_000 },
    fountain: { maxUnits: 20_000 },
  });
});

for (const format of ["markdown", "fountain"]) {
  test(`${format} complexity accepts immediately below and at the limit, then rejects above it`, () => {
    const maxUnits = DOCUMENT_COMPLEXITY_POLICY[format].maxUnits;
    const below = checkDocumentComplexity(contentWithExactUnits(format, maxUnits - 1), format);
    const at = checkDocumentComplexity(contentWithExactUnits(format, maxUnits), format);
    const above = checkDocumentComplexity(contentWithExactUnits(format, maxUnits + 1), format);

    assert.equal(below.ok, true);
    assert.equal(below.measurement.units, maxUnits - 1);
    assert.equal(at.ok, true);
    assert.equal(at.measurement.units, maxUnits);
    assert.equal(above.ok, false);
    assert.ok(above.error instanceof DocumentComplexityError);
    assert.equal(above.error.units, maxUnits + 1);
    assert.equal(above.error.message, DOCUMENT_COMPLEXITY_MESSAGE);
  });
}

test("dense Markdown headings and Fountain action blocks consume the structural budget", () => {
  const markdownAtLimit = `${"# a\n".repeat(3)}# a`;
  const fountainAtLimit = `${"a\n\n".repeat(3)}a\n`;

  assert.equal(checkDocumentComplexity(markdownAtLimit, "markdown", { maxUnits: 8 }).ok, true);
  assert.equal(checkDocumentComplexity(`${markdownAtLimit}\n`, "markdown", { maxUnits: 8 }).ok, false);
  assert.equal(checkDocumentComplexity(fountainAtLimit, "fountain", { maxUnits: 8 }).ok, true);
  assert.equal(checkDocumentComplexity(`${fountainAtLimit}\n`, "fountain", { maxUnits: 8 }).ok, false);
});

test("ordinary Markdown and Fountain documents remain below their production limits", () => {
  const markdown = checkDocumentComplexity([
    "# Release notes",
    "",
    "A normal paragraph with [one link](./details.md).",
    "",
    "- first",
    "- second",
  ].join("\n"), "markdown");
  const fountain = parseFountain([
    "Title: A Small Story",
    "",
    "INT. OFFICE - DAY",
    "",
    "RILEY",
    "Hello there.",
  ].join("\n"));

  assert.equal(markdown.ok, true);
  assert.equal(fountain.scenes.length, 1);
});

test("long delimiter-free inline constructs still consume bounded structural units", () => {
  const result = checkDocumentComplexity("a".repeat(16), "markdown", { maxUnits: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.error.units, 2);
});

test("reader preparation rejects both formats before statistics or Fountain expansion", () => {
  const markdown = prepareReaderDocument(contentWithExactUnits("markdown", 9), "markdown", { maxUnits: 8 });
  const fountain = prepareReaderDocument(contentWithExactUnits("fountain", 9), "fountain", { maxUnits: 8 });

  assert.deepEqual(markdown, { status: "too-complex", message: DOCUMENT_COMPLEXITY_MESSAGE });
  assert.deepEqual(fountain, { status: "too-complex", message: DOCUMENT_COMPLEXITY_MESSAGE });
});

test("Fountain parser rejects over-limit input during preflight", () => {
  assert.throws(
    () => parseFountain(contentWithExactUnits("fountain", 9), { maxUnits: 8 }),
    DocumentComplexityError,
  );
});

test("presentation parsing shares the Markdown policy boundary", () => {
  assert.doesNotThrow(() => parseSlides(contentWithExactUnits("markdown", 8), { maxUnits: 8 }));
  assert.throws(
    () => parseSlides(contentWithExactUnits("markdown", 9), { maxUnits: 8 }),
    DocumentComplexityError,
  );
});

test("workspace indexing distinguishes complexity skips for both formats", () => {
  const markdown = tryBuildWorkspaceDoc(
    makeMeta("dense.md"),
    contentWithExactUnits("markdown", 9),
    { maxUnits: 8 },
  );
  const fountain = tryBuildWorkspaceDoc(
    makeMeta("dense.fountain"),
    contentWithExactUnits("fountain", 9),
    { maxUnits: 8 },
  );

  assert.deepEqual(markdown, { status: "too-complex" });
  assert.deepEqual(fountain, { status: "too-complex" });
});

test("the rejection notice uses the shared non-technical message", () => {
  const html = renderToStaticMarkup(
    React.createElement(DocumentComplexityNotice, {
      contentRef: React.createRef(),
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Document too complex/);
  assert.ok(html.includes(DOCUMENT_COMPLEXITY_MESSAGE));
});

/* ------------------------------------------------------------ */
/*  Markdown container-depth and indentation ceilings (F-06)     */
/* ------------------------------------------------------------ */

test("nested blockquotes immediately below and at the depth limit pass, above it is rejected", () => {
  const below = checkDocumentComplexity(`${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH - 1)}x`, "markdown");
  const at = checkDocumentComplexity(`${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH)}x`, "markdown");
  const above = checkDocumentComplexity(`${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH + 1)}x`, "markdown");

  assert.equal(below.ok, true);
  assert.equal(at.ok, true);
  assert.equal(above.ok, false);
  // The fixture is tiny in structural units, so the depth limit — not the
  // 30,000-unit total — must be what rejects it. The sentinel also proves
  // the scanner exited as soon as the limit was exceeded.
  assert.ok(at.measurement.units < 300, "fixture must stay far below the unit total");
  assert.equal(above.error.units, DOCUMENT_COMPLEXITY_POLICY.markdown.maxUnits + 1);
});

test("the depth limit covers tight, mixed, ordered, and unordered container prefixes", () => {
  const overDepth = MARKDOWN_MAX_CONTAINER_DEPTH + 1;
  const fixtures = {
    "blockquote without spaces": ">".repeat(overDepth),
    "unordered -": "- ".repeat(overDepth),
    "unordered +": "+ ".repeat(overDepth),
    "unordered *": "* ".repeat(overDepth),
    "ordered 1.": "1. ".repeat(overDepth),
    "ordered 1)": "1) ".repeat(overDepth),
    "mixed blockquote/list": "> - ".repeat(Math.ceil(overDepth / 2)),
    "mixed ordered in blockquote": "> 1. ".repeat(Math.ceil(overDepth / 2)),
  };

  for (const [label, prefix] of Object.entries(fixtures)) {
    assert.equal(checkDocumentComplexity(`${prefix}x`, "markdown").ok, false, label);
  }

  // At-limit controls for every marker shape still pass.
  for (const marker of ["> ", "- ", "+ ", "* ", "1. ", "1) "]) {
    const prefix = marker.repeat(MARKDOWN_MAX_CONTAINER_DEPTH);
    assert.equal(checkDocumentComplexity(`${prefix}x`, "markdown").ok, true, `${marker} at limit`);
  }
  for (const marker of ["> - ", "> 1. "]) {
    const prefix = marker.repeat(MARKDOWN_MAX_CONTAINER_DEPTH / 2);
    assert.equal(checkDocumentComplexity(`${prefix}x`, "markdown").ok, true, `${marker} at limit`);
  }
});

test("ordered markers need 1-9 digits and a follower, so lookalikes are not containers", () => {
  // Not markers: 10 digits, no delimiter follower, decimal point text.
  assert.equal(checkDocumentComplexity("1234567890. x", "markdown").ok, true);
  assert.equal(checkDocumentComplexity("1.5", "markdown").ok, true);
  assert.equal(checkDocumentComplexity("2024-01-01", "markdown").ok, true);
  // But a conservative scanner treats malformed deep prefixes as containers.
  assert.equal(checkDocumentComplexity(`${"1. ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH + 1)}x`, "markdown").ok, false);
});

test("leading spaces immediately below and at the indentation limit pass, above it is rejected", () => {
  const below = checkDocumentComplexity(`${" ".repeat(MARKDOWN_MAX_INDENT_COLUMNS - 1)}x`, "markdown");
  const at = checkDocumentComplexity(`${" ".repeat(MARKDOWN_MAX_INDENT_COLUMNS)}x`, "markdown");
  const above = checkDocumentComplexity(`${" ".repeat(MARKDOWN_MAX_INDENT_COLUMNS + 1)}x`, "markdown");

  assert.equal(below.ok, true);
  assert.equal(at.ok, true);
  assert.equal(above.ok, false);
  assert.ok(at.measurement.units < 300, "fixture must stay far below the unit total");
  assert.equal(above.error.units, DOCUMENT_COMPLEXITY_POLICY.markdown.maxUnits + 1);
});

test("leading tabs use four-column tab stops for both the ceiling and the charge", () => {
  const tabsAtLimit = MARKDOWN_MAX_INDENT_COLUMNS / MARKDOWN_INDENT_COLUMNS_PER_UNIT;

  assert.equal(checkDocumentComplexity(`${"\t".repeat(tabsAtLimit - 1)}x`, "markdown").ok, true);
  assert.equal(checkDocumentComplexity(`${"\t".repeat(tabsAtLimit)}x`, "markdown").ok, true);
  assert.equal(checkDocumentComplexity(`${"\t".repeat(tabsAtLimit + 1)}x`, "markdown").ok, false);

  // Tab stops: a tab advances to the next multiple of four columns.
  const unitDelta = (content) => {
    const result = checkDocumentComplexity(content, "markdown");
    assert.ok(result.ok, content);
    return result.measurement.units;
  };
  assert.equal(unitDelta("x"), 1);
  assert.equal(unitDelta(" x"), 1);
  assert.equal(unitDelta("   x"), 1);
  assert.equal(unitDelta("    x"), 2);
  assert.equal(unitDelta("\tx"), 2);
  assert.equal(unitDelta(" \tx"), 2, "tab from column 1 stops at column 4");
  assert.equal(unitDelta("   \tx"), 2, "tab from column 3 stops at column 4");
  assert.equal(unitDelta("    \tx"), 3, "tab from column 4 stops at column 8");
});

test("leading indentation charges one structural unit per four columns", () => {
  const unitsOf = (content) => {
    const result = checkDocumentComplexity(content, "markdown");
    assert.ok(result.ok, content);
    return result.measurement.units;
  };

  assert.equal(unitsOf("        x"), 1 + Math.floor(8 / MARKDOWN_INDENT_COLUMNS_PER_UNIT));
  assert.equal(unitsOf("    a\n    b"), 4);
  assert.ok(unitsOf("    x") > unitsOf("x"));
});

test("progressively indented nested lists are bounded by the indentation ceiling", () => {
  const progressive = (lines) => Array.from(
    { length: lines },
    (_, index) => `${"  ".repeat(index)}- x`,
  ).join("\n");

  // Two columns per nesting level plus the final marker's separator: at the
  // ceiling the last line uses 255 prefix-whitespace columns; one more level
  // crosses it at 257.
  const at = progressive(MARKDOWN_MAX_INDENT_COLUMNS / 2);
  const above = progressive(MARKDOWN_MAX_INDENT_COLUMNS / 2 + 1);

  const atResult = checkDocumentComplexity(at, "markdown");
  assert.equal(atResult.ok, true);
  // The accepted maximum is heavily charged by indentation, so many such
  // structures cannot accumulate under the unit total either.
  assert.ok(atResult.measurement.units > 4_000);
  assert.equal(checkDocumentComplexity(above, "markdown").ok, false);
});

test("indentation after an outer container is still charged and bounded", () => {
  // The blockquote marker contributes one separator column, leaving 255
  // columns for the last accepted list item and crossing the ceiling on the
  // next level. The superseded scanner skipped all whitespace after `>`.
  const at = quotedProgressiveList(MARKDOWN_MAX_INDENT_COLUMNS / 2);
  const above = quotedProgressiveList(MARKDOWN_MAX_INDENT_COLUMNS / 2 + 1);

  const atResult = checkDocumentComplexity(at, "markdown");
  assert.equal(atResult.ok, true);
  assert.ok(atResult.measurement.units > 4_000, "nested indentation must consume aggregate units");
  assert.equal(checkDocumentComplexity(above, "markdown").ok, false);
});

test("tabs after a container marker cannot bypass the indentation ceiling", () => {
  assert.equal(
    checkDocumentComplexity(">\t- x", "markdown", { maxMarkdownIndentColumns: 8 }).ok,
    true,
  );
  assert.equal(
    checkDocumentComplexity(">\t\t- x", "markdown", { maxMarkdownIndentColumns: 8 }).ok,
    false,
  );
});

test("nested inline emphasis is bounded immediately below, at, and above its limit", () => {
  const below = checkDocumentComplexity(nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING - 1), "markdown");
  const at = checkDocumentComplexity(nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING), "markdown");
  const above = checkDocumentComplexity(nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING + 1), "markdown");

  assert.equal(below.ok, true);
  assert.equal(at.ok, true);
  assert.equal(above.ok, false);
  assert.ok(at.measurement.units < 300, "fixture must stay far below the structural-unit total");
  assert.equal(above.error.units, DOCUMENT_COMPLEXITY_POLICY.markdown.maxUnits + 1);
});

test("inline nesting is tracked across soft lines and reset by a blank block boundary", () => {
  const softLines = nestedEmphasis(5).replaceAll("a ", "a\n");
  assert.equal(
    checkDocumentComplexity(softLines, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
    false,
  );

  const separateParagraphs = Array.from({ length: 20 }, () => nestedEmphasis(4)).join("\n\n");
  assert.equal(
    checkDocumentComplexity(separateParagraphs, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
    true,
  );
});

test("many sequential emphasized phrases do not count as nested", () => {
  const paragraph = Array.from({ length: MARKDOWN_MAX_INLINE_NESTING + 20 }, () => "*word*,").join(" ");
  assert.equal(checkDocumentComplexity(paragraph, "markdown").ok, true);
});

test("strong, underscore, and strikethrough delimiters share the inline-nesting ceiling", () => {
  for (const marker of ["**", "_", "~~"]) {
    assert.equal(
      checkDocumentComplexity(nestedEmphasis(5, marker), "markdown", { maxMarkdownInlineNesting: 4 }).ok,
      false,
      marker,
    );
  }
});

test("CRLF line endings reset prefix scanning for both depth and indentation", () => {
  const deepSecondLine = `plain\r\n${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH + 1)}x`;
  const indentedSecondLine = `plain\r\n${" ".repeat(MARKDOWN_MAX_INDENT_COLUMNS + 1)}x`;

  assert.equal(checkDocumentComplexity(deepSecondLine, "markdown").ok, false);
  assert.equal(checkDocumentComplexity(indentedSecondLine, "markdown").ok, false);
  assert.equal(checkDocumentComplexity("1. a\r\n2. b\r\n> quote", "markdown").ok, true);
});

test("ordinary Markdown containers, code blocks, and nested lists stay accepted", () => {
  const ordinary = [
    "> Ordinary blockquote.",
    ">",
    "> - nested list in a quote",
    "> - second item",
    "",
    "- one",
    "  - two",
    "    - three",
    "      - four",
    "",
    "1. first",
    "2. second",
    "",
    "    indented code block",
    "    spans two lines",
    "",
    "\t- tab-indented list item",
  ].join("\n");

  const result = checkDocumentComplexity(ordinary, "markdown");
  assert.equal(result.ok, true);
});

test("test-only Markdown limits can lower but never raise production ceilings", () => {
  const deep = `${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH + 1)}x`;
  const indented = `${" ".repeat(MARKDOWN_MAX_INDENT_COLUMNS + 1)}x`;
  const inline = nestedEmphasis(MARKDOWN_MAX_INLINE_NESTING + 1);

  assert.equal(checkDocumentComplexity(deep, "markdown", { maxMarkdownContainerDepth: 10_000 }).ok, false);
  assert.equal(checkDocumentComplexity(indented, "markdown", { maxMarkdownIndentColumns: 10_000 }).ok, false);
  assert.equal(checkDocumentComplexity(inline, "markdown", { maxMarkdownInlineNesting: 10_000 }).ok, false);
  assert.equal(checkDocumentComplexity("> ".repeat(5), "markdown", { maxMarkdownContainerDepth: 4 }).ok, false);
  assert.equal(checkDocumentComplexity(`${" ".repeat(9)}x`, "markdown", { maxMarkdownIndentColumns: 8 }).ok, false);
  assert.equal(checkDocumentComplexity(nestedEmphasis(5), "markdown", { maxMarkdownInlineNesting: 4 }).ok, false);
  assert.equal(checkDocumentComplexity("> ".repeat(4), "markdown", { maxMarkdownContainerDepth: 4 }).ok, true);
  assert.equal(checkDocumentComplexity(`${" ".repeat(8)}x`, "markdown", { maxMarkdownIndentColumns: 8 }).ok, true);
  assert.equal(checkDocumentComplexity(nestedEmphasis(4), "markdown", { maxMarkdownInlineNesting: 4 }).ok, true);
});

test("no run the parser cannot use as a closer can release inline nesting", () => {
  // Cross-delimiter cancellation, a marker-only line, micromark's rule of
  // three, link and autolink content, escapes, code spans, and tilde runs too
  // long to be strikethrough. See the shared fixture module for each shape.
  for (const [label, source] of Object.entries(inlineNestingBypasses())) {
    assert.equal(checkDocumentComplexity(source, "markdown").ok, false, label);
  }
});

test("an empty list item does not end the paragraph that holds open delimiters", () => {
  // A lone `+` is an empty list item, which cannot interrupt a paragraph, so
  // the parser keeps every delimiter open across it. Only a blank line does.
  const markerOnly = `${"*a\n+\n".repeat(6)}x`;
  const blankLines = `${"*a\n\n".repeat(6)}x`;

  assert.equal(
    checkDocumentComplexity(markerOnly, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
    false,
  );
  assert.equal(
    checkDocumentComplexity(blankLines, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
    true,
  );
});

test("only spaces and tabs make a line blank enough to reset inline state", () => {
  // CommonMark counts a line blank only when it holds nothing but spaces or
  // tabs. A line holding one NBSP, ideographic space, U+FEFF, vertical tab or
  // form feed is paragraph content, so the parser carries every delimiter
  // across it — measured emphasis depth 129 where the scanner once saw a
  // block boundary and reset to zero.
  for (const [label, source] of Object.entries(whitespaceOnlyLineBypasses())) {
    assert.equal(checkDocumentComplexity(source, "markdown").ok, false, label);
  }

  // The whitespace that genuinely does end a paragraph must still reset, or
  // ordinary documents would accumulate nesting they never had.
  for (const [label, source] of Object.entries(blankLineControls())) {
    assert.equal(checkDocumentComplexity(source, "markdown").ok, true, label);
  }
});

test("a code span cannot be paired across a line that ends the paragraph", () => {
  // Inline parsing happens per block, so the two backtick runs never form a
  // code span: the middle line ends the first paragraph. Suppressing inline
  // accounting between them hid 3,000 levels of real emphasis, which the
  // installed parser builds and `mdast-util-to-hast` then overflows.
  for (const [label, source] of Object.entries(splitCodeSpanBypasses())) {
    assert.equal(checkDocumentComplexity(source, "markdown").ok, false, label);
  }

  // The same shape with an unclosed fence instead stays accepted, and must:
  // the fence really does run to the end of the document, so the parser sees
  // one shallow code block (measured top-level blocks `paragraph`, `code`).
  assert.equal(checkDocumentComplexity(fencedCodeLookalike(), "markdown").ok, true);

  // A code span that opens and closes on one line still suppresses its
  // contents, which is what keeps delimiter-heavy inline code accepted.
  assert.equal(
    checkDocumentComplexity(`\`${"*".repeat(500)}\``, "markdown").ok,
    true,
  );
});

test("inline nesting survives CRLF and lone-CR soft breaks, and resets on either blank line", () => {
  // The scanner consumes CRLF as one ending and a lone CR as another, so both
  // must behave exactly like LF for inline state: a soft break keeps every
  // opener, and a blank line drops them.
  for (const ending of ["\n", "\r\n", "\r"]) {
    const softBreaks = `${`*a${ending}`.repeat(6)}x`;
    const blankLines = `${`*a${ending}${ending}`.repeat(6)}x`;

    assert.equal(
      checkDocumentComplexity(softBreaks, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
      false,
      `soft breaks with ${JSON.stringify(ending)}`,
    );
    assert.equal(
      checkDocumentComplexity(blankLines, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
      true,
      `blank lines with ${JSON.stringify(ending)}`,
    );
  }
});

test("Unicode whitespace and punctuation classify delimiters like the parser does", () => {
  // Flanking is decided over Unicode classes, not ASCII. An ideographic space
  // before `*` leaves it opening-only; a Chinese full stop after it is
  // punctuation, so the run cannot open against a letter on its left.
  const ideographicSpace = "　";
  const fullStop = "。";

  assert.equal(
    checkDocumentComplexity(`${`a${ideographicSpace}*b`.repeat(6)}`, "markdown", {
      maxMarkdownInlineNesting: 4,
    }).ok,
    false,
    "Unicode whitespace before a run leaves it able to open",
  );
  assert.equal(
    checkDocumentComplexity(`${`a*${fullStop}`.repeat(200)}`, "markdown").ok,
    true,
    "a run closed by Unicode punctuation after a letter cannot open",
  );
  // Emphasis whose content is non-ASCII still counts, so the ceiling is not
  // an ASCII-only guard.
  let nested = "你好";
  for (let index = 0; index < 6; index += 1) nested = `*あ ${nested} い*`;
  assert.equal(
    checkDocumentComplexity(nested, "markdown", { maxMarkdownInlineNesting: 4 }).ok,
    false,
  );
});

test("spending the code-span lookahead budget degrades conservatively", () => {
  // Unmatched backtick runs sharing one long line are the only shape that can
  // spend the budget: each scans to the end of that line and finds no partner.
  // Once spent, code spans stop being recognized and their contents count as
  // ordinary text, which can only over-count — never hide nesting.
  const padding = "word ".repeat(1_000);
  let burnBudget = "";
  for (let size = 2; size <= 7; size += 1) burnBudget += `${"`".repeat(size)}${padding}`;
  const heavyCodeSpan = `\`${"*a ".repeat(200)}\``;

  // Each half is cheap on its own, and the code span suppresses its delimiters.
  assert.equal(checkDocumentComplexity(burnBudget, "markdown").ok, true);
  assert.equal(checkDocumentComplexity(heavyCodeSpan, "markdown").ok, true);

  // Together, the budget is gone before the span is reached, so its 200
  // openers are charged and the document is refused rather than mismeasured.
  assert.equal(
    checkDocumentComplexity(`${burnBudget} ${heavyCodeSpan}`, "markdown").ok,
    false,
  );
});

test("mixed delimiter nesting is bounded immediately below, at, and above the ceiling", () => {
  const mixed = (depth) => {
    const markers = ["*", "_", "~"];
    let content = "x";
    for (let index = 0; index < depth; index += 1) {
      const marker = markers[index % markers.length];
      content = `${marker}a ${content} b${marker}`;
    }
    return content;
  };

  assert.equal(checkDocumentComplexity(mixed(MARKDOWN_MAX_INLINE_NESTING - 1), "markdown").ok, true);
  assert.equal(checkDocumentComplexity(mixed(MARKDOWN_MAX_INLINE_NESTING), "markdown").ok, true);
  assert.equal(checkDocumentComplexity(mixed(MARKDOWN_MAX_INLINE_NESTING + 1), "markdown").ok, false);
  assert.equal(
    checkDocumentComplexity(mixed(MARKDOWN_MAX_INLINE_NESTING + 1), "markdown", {
      maxMarkdownInlineNesting: 10_000,
    }).ok,
    false,
    "a test-only limit cannot raise the production inline ceiling",
  );
});

test("ordinary technical documents stay accepted far past the reported failure points", () => {
  const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join("\n");
  // Every fixture is at least six times the size that rejected before the fix,
  // and none of them contains a blank line to reset inline state.
  const documents = {
    yaml: `\`\`\`yaml\n${lines(400, (i) => `max_retry_count_${i}: 3`)}\n\`\`\``,
    json: `\`\`\`json\n{\n${lines(400, (i) => `  "field_name_${i}": 1,`)}\n}\n\`\`\``,
    shell: `\`\`\`sh\n${lines(400, (i) => `export MY_VAR_${i}=1`)}\n\`\`\``,
    tildeFence: `~~~python\n${lines(400, (i) => `user_name_${i} = compute(a_b, c_d)`)}\n~~~`,
    pythonArgs: `\`\`\`python\n${lines(400, (i) => `def handler_${i}(*args, **kwargs): return a*b`)}\n\`\`\``,
    table: `| field | type |\n| --- | --- |\n${lines(400, (i) => `| user_name_${i} | string |`)}`,
    identifiers: lines(400, (i) => `The user_id field ${i} maps to account_id and MAX_RETRY_COUNT.`),
    inlineCode: lines(400, (i) => `Set \`max_retries_${i}\` and \`a*b*c\` before **${i}**.`),
    escaped: lines(400, (i) => `Literal \\*stars\\* and \\_underscores\\_ on line ${i}.`),
    prose: lines(400, (i) => `Read *report_${i}.md*, ~~old~~ notes, and [link_${i}](a_b.md).`),
  };

  for (const [label, source] of Object.entries(documents)) {
    assert.equal(checkDocumentComplexity(source, "markdown").ok, true, label);
  }
});

test("reader preparation rejects a deep-container document before any Markdown parsing", () => {
  // ~130 structural units: far below the unit total, so only the new
  // container-depth limit can reject it.
  const prepared = prepareReaderDocument(
    `${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH + 1)}deep`,
    "markdown",
  );

  assert.deepEqual(prepared, { status: "too-complex", message: DOCUMENT_COMPLEXITY_MESSAGE });
});

test("workspace diagnostics explain complexity skips separately from read failures", () => {
  const html = renderToStaticMarkup(React.createElement(WorkspacePanel, {
    rootPath: "/workspace",
    state: {
      rootPath: "/workspace",
      status: "ready",
      fileCount: 2,
      processedCount: 2,
      indexedCount: 1,
      indexedAt: 1,
      error: null,
      listSkippedCount: 0,
      readFailedCount: 0,
      complexitySkippedCount: 1,
      limitHit: false,
    },
    backlinks: [],
    mentions: [],
    onChooseRoot() {},
    onClearRoot() {},
    onReindex() {},
    onOpenPath() {},
    onOpenPalette() {},
  }));

  assert.match(html, /1 file was too complex to index safely/);
  assert.doesNotMatch(html, /failed to read/);
});
