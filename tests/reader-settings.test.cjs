const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FONT_CSS_MAP,
  PARAGRAPH_SPACING_MAP,
  isFontFamily,
  isParagraphSpacing,
  isPrintLayout,
  resolveFontCss,
  resolveParagraphSpacingCss,
} = require("../.tmp/workspace-tests/src/lib/reader-settings.js");

test("font family type guard accepts only supported values", () => {
  assert.equal(isFontFamily("newsreader"), true);
  assert.equal(isFontFamily("source-sans-3"), true);
  assert.equal(isFontFamily("dm-sans"), true);
  assert.equal(isFontFamily("roboto-slab"), true);
  assert.equal(isFontFamily("atkinson"), true);
  assert.equal(isFontFamily("opendyslexic"), true);
  assert.equal(isFontFamily("serif"), false);
  assert.equal(isFontFamily(""), false);
  assert.equal(isFontFamily(null), false);
});

test("font family resolver maps supported values and falls back to newsreader", () => {
  assert.equal(resolveFontCss("newsreader"), FONT_CSS_MAP.newsreader);
  assert.equal(resolveFontCss("source-sans-3"), FONT_CSS_MAP["source-sans-3"]);
  assert.equal(resolveFontCss("dm-sans"), FONT_CSS_MAP["dm-sans"]);
  assert.equal(resolveFontCss("roboto-slab"), FONT_CSS_MAP["roboto-slab"]);
  assert.equal(resolveFontCss("atkinson"), FONT_CSS_MAP.atkinson);
  assert.equal(resolveFontCss("opendyslexic"), FONT_CSS_MAP.opendyslexic);
  assert.equal(resolveFontCss("serif"), FONT_CSS_MAP.newsreader);
  assert.equal(resolveFontCss(undefined), FONT_CSS_MAP.newsreader);
});

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
