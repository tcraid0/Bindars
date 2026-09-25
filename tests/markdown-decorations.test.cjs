const test = require("node:test");
const assert = require("node:assert/strict");
const { Text } = require("@codemirror/state");
const {
  headingDecorations,
  markdownGfmParser,
} = require("../.tmp/workspace-tests/src/components/markdown-decorations.js");

function parseHeadings(source, from = 0, to = source.length) {
  return headingDecorations(
    markdownGfmParser.parse(source),
    Text.of(source.split("\n")),
    from,
    to,
  );
}

test("ATX heading levels 1 through 6 produce exact line and opening-marker ranges", () => {
  const source = [
    "# One",
    "## Two",
    "### Three",
    "#### Four",
    "##### Five",
    "###### Six",
  ].join("\n");

  const headings = parseHeadings(source);
  const offsets = ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"]
    .map((heading) => source.indexOf(heading));
  assert.deepEqual(headings.map(({ level, lineFrom, markerRanges }) => ({
    level,
    lineFrom,
    markerRanges,
  })), [
    { level: 1, lineFrom: offsets[0], markerRanges: [{ from: offsets[0], to: offsets[0] + 2 }] },
    { level: 2, lineFrom: offsets[1], markerRanges: [{ from: offsets[1], to: offsets[1] + 3 }] },
    { level: 3, lineFrom: offsets[2], markerRanges: [{ from: offsets[2], to: offsets[2] + 4 }] },
    { level: 4, lineFrom: offsets[3], markerRanges: [{ from: offsets[3], to: offsets[3] + 5 }] },
    { level: 5, lineFrom: offsets[4], markerRanges: [{ from: offsets[4], to: offsets[4] + 6 }] },
    { level: 6, lineFrom: offsets[5], markerRanges: [{ from: offsets[5], to: offsets[5] + 7 }] },
  ]);
});

test("invalid and code-contained hashes remain undecorated while a bare hash is a heading", () => {
  const source = [
    "####### Too many",
    "#Missing space",
    String.raw`\# escaped`,
    "`# inline code`",
    "```md",
    "# fenced code",
    "```",
    "#",
  ].join("\n");

  const headings = parseHeadings(source);
  const bareHashFrom = source.lastIndexOf("#");
  assert.deepEqual(headings, [{
    level: 1,
    lineFrom: bareHashFrom,
    markerRanges: [{ from: bareHashFrom, to: bareHashFrom + 1 }],
  }]);
});

test("closing hash runs are dimmed and extra separator spaces remain visible", () => {
  const source = "##  Title ##";
  assert.deepEqual(parseHeadings(source), [{
    level: 2,
    lineFrom: 0,
    markerRanges: [
      { from: 0, to: 3 },
      { from: 10, to: 12 },
    ],
  }]);
});

test("blockquoted ATX headings style their physical line and Setext headings stay plain", () => {
  const source = "> # Quoted\n\nSetext title\n============";
  assert.deepEqual(parseHeadings(source), [{
    level: 1,
    lineFrom: 0,
    markerRanges: [{ from: 2, to: 4 }],
  }]);
});

test("heading classification is bounded to syntax nodes intersecting the requested range", () => {
  const source = "# First\nbody\n## Second\ntail\n### Third";
  const secondStart = source.indexOf("## Second");
  const secondEnd = secondStart + "## Second".length;

  assert.deepEqual(parseHeadings(source, secondStart + 3, secondEnd), [{
    level: 2,
    lineFrom: secondStart,
    markerRanges: [{ from: secondStart, to: secondStart + 3 }],
  }]);
  assert.deepEqual(parseHeadings(source, source.indexOf("body"), secondStart), []);
  assert.deepEqual(parseHeadings(source, secondStart, secondStart), []);
});

function countVisitedNodes(source, from = source.length - 10, to = source.length) {
  const parsedTree = markdownGfmParser.parse(source);
  let visitedNodes = 0;
  const countingTree = {
    iterate(spec) {
      parsedTree.iterate({
        ...spec,
        enter(node) {
          visitedNodes += 1;
          return spec.enter(node);
        },
      });
    },
  };

  const headings = headingDecorations(
    countingTree,
    Text.of(source.split("\n")),
    from,
    to,
  );

  return { headings, visitedNodes };
}

test("heading classification skips inline descendants on a pathological wrapped line", () => {
  const source = `# ${"*word* ".repeat(20_000)}`;
  const { headings, visitedNodes } = countVisitedNodes(source);

  assert.equal(headings.length, 1);
  assert.deepEqual(headings[0].markerRanges, [{ from: 0, to: 2 }]);
  assert.ok(visitedNodes <= 20, `expected bounded traversal, visited ${visitedNodes} nodes`);
});

test("heading classification prunes inline-heavy non-heading leaf blocks", () => {
  const inlineContent = "*word* ".repeat(20_000);
  const paragraph = countVisitedNodes(inlineContent);
  assert.deepEqual(paragraph.headings, []);
  assert.ok(paragraph.visitedNodes <= 20, `paragraph visited ${paragraph.visitedNodes} nodes`);

  const quoteDepth = 40;
  const quotedParagraph = `${"> ".repeat(quoteDepth)}${inlineContent}`;
  const nested = countVisitedNodes(quotedParagraph);
  assert.deepEqual(nested.headings, []);
  assert.ok(
    nested.visitedNodes <= quoteDepth * 3 + 20,
    `nested paragraph visited ${nested.visitedNodes} nodes`,
  );
});

test("leaf-block pruning keeps headings inside list and blockquote containers discoverable", () => {
  const source = "- > ### Nested heading ###";
  assert.deepEqual(parseHeadings(source), [{
    level: 3,
    lineFrom: 0,
    markerRanges: [
      { from: source.indexOf("###"), to: source.indexOf("###") + 4 },
      { from: source.lastIndexOf("###"), to: source.length },
    ],
  }]);
});
