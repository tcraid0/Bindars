const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ASSERTION_PATTERNS = [
  /assert\.(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual)\(\s*findEditorView\([^)]*\)\s*,/g,
  /assert\.(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual)\(\s*\w*View\s*,\s*\w*View\s*[,)]/g,
  /assert\.(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual)\(\s*document\.activeElement\s*,/g,
  /assert\.(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual)\(\s*[^,\n]*\.querySelector(?:All)?\([^)]*\)\s*,/g,
];

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(entryPath);
    return /\.test\.[cm]?js$/.test(entry.name) ? [entryPath] : [];
  });
}

function unsafeAssertionLines(source) {
  const lines = [];
  for (const pattern of ASSERTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

test("assertion tripwire recognizes its supported unsafe and safe forms", () => {
  const fixtures = [
    ["assert.equal(findEditorView(host), expected);", 1],
    ["assert.notEqual(previousView, nextView);", 1],
    ["assert.equal(document.activeElement, input);", 1],
    ["assert.equal(host.querySelector('.panel'), null);", 1],
    ["assert.deepEqual(host.querySelector('.panel'), null);", 1],
    ["assert.ok(findEditorView(host) === expected);", 0],
    ["assert.equal(view.state.sliceDoc(), 'text');", 0],
    ["assert.equal(document.activeElement?.textContent, 'Save');", 0],
    ["assert.equal(host.querySelectorAll('.panel').length, 1);", 0],
  ];

  for (const [source, expectedCount] of fixtures) {
    assert.equal(unsafeAssertionLines(source).length, expectedCount, source);
  }
});

test("tests avoid common direct DOM and EditorView diffing assertions", () => {
  const violations = [];
  for (const file of testFiles(__dirname)) {
    if (file === __filename) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const line of unsafeAssertionLines(source)) {
      violations.push(`${path.relative(__dirname, file)}:${line}`);
    }
  }

  assert.deepEqual(violations, []);
});
