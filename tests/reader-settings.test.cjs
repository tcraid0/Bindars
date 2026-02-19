const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PARAGRAPH_SPACING_MAP,
  isParagraphSpacing,
  isPrintLayout,
  resolveParagraphSpacingCss,
} = require("../.tmp/workspace-tests/src/lib/reader-settings.js");

test("paragraph spacing options map to expected CSS values", () => {
  assert.equal(PARAGRAPH_SPACING_MAP.compact, "0.6em");
  assert.equal(PARAGRAPH_SPACING_MAP.comfortable, "1.25em");
  assert.equal(PARAGRAPH_SPACING_MAP.spacious, "1.5em");
});

test("paragraph spacing type guard accepts only supported values", () => {
  assert.equal(isParagraphSpacing("compact"), true);
  assert.equal(isParagraphSpacing("comfortable"), true);
  assert.equal(isParagraphSpacing("spacious"), true);
  assert.equal(isParagraphSpacing("wide"), false);
  assert.equal(isParagraphSpacing(""), false);
  assert.equal(isParagraphSpacing(null), false);
});

test("paragraph spacing resolver falls back to comfortable when invalid", () => {
  assert.equal(resolveParagraphSpacingCss("compact"), "0.6em");
  assert.equal(resolveParagraphSpacingCss("spacious"), "1.5em");
  assert.equal(resolveParagraphSpacingCss("wide"), "1.25em");
  assert.equal(resolveParagraphSpacingCss(undefined), "1.25em");
});

test("print layout type guard accepts only supported values", () => {
  assert.equal(isPrintLayout("standard"), true);
  assert.equal(isPrintLayout("book"), true);
  assert.equal(isPrintLayout("continuous"), false);
  assert.equal(isPrintLayout(""), false);
  assert.equal(isPrintLayout(null), false);
});
