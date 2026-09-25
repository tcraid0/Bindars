const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeReadingStats,
  formatReadingStatsSummary,
  formatWordCount,
} = require("../.tmp/workspace-tests/src/lib/reading-stats.js");

test("computeReadingStats returns pageCount for fountain files", () => {
  // 480 words at 160 words/page = 3 pages
  const words = Array(480).fill("word").join(" ");
  const stats = computeReadingStats(words, "fountain");
  assert.equal(stats.pageCount, 3);
  assert.equal(stats.wordCount, 480);
});

test("computeReadingStats returns undefined pageCount for markdown", () => {
  const words = Array(500).fill("word").join(" ");
  const stats = computeReadingStats(words, "markdown");
  assert.equal(stats.pageCount, undefined);
  assert.equal(stats.wordCount, 500);
});

test("computeReadingStats returns undefined pageCount when no fileType", () => {
  const words = Array(100).fill("word").join(" ");
  const stats = computeReadingStats(words);
  assert.equal(stats.pageCount, undefined);
});

test("computeReadingStats skips a Fountain title page with indented continuation lines", () => {
  const stats = computeReadingStats("Title: A\n    continued\n\tmore\nAuthor: B\n\nHello world", "fountain");
  assert.equal(stats.wordCount, 2);
});

test("computeReadingStats returns minimum 1 page for fountain", () => {
  const stats = computeReadingStats("hello world", "fountain");
  assert.equal(stats.pageCount, 1);
});

test("computeReadingStats counts dense tiny words without splitting into a word array", () => {
  const denseWordCount = 200_000;
  const content = "a ".repeat(denseWordCount);
  const originalSplit = String.prototype.split;
  String.prototype.split = function forbiddenSplit() {
    throw new Error("word counting must not split the document into an array");
  };

  let stats;
  try {
    stats = computeReadingStats(content, "markdown");
  } finally {
    String.prototype.split = originalSplit;
  }

  assert.equal(stats.wordCount, denseWordCount);
});

test("computeReadingStats rounds page count correctly", () => {
  // 240 words / 160 = 1.5, rounds to 2
  const words = Array(240).fill("word").join(" ");
  const stats = computeReadingStats(words, "fountain");
  assert.equal(stats.pageCount, 2);

  // 190 words / 160 = 1.1875, rounds to 1
  const words2 = Array(190).fill("word").join(" ");
  const stats2 = computeReadingStats(words2, "fountain");
  assert.equal(stats2.pageCount, 1);
});

test("formatReadingStatsSummary uses screenplay page and runtime overrides when provided", () => {
  const stats = {
    wordCount: 480,
    readingTimeMinutes: 2,
    pageCount: 2,
  };

  assert.equal(
    formatReadingStatsSummary(stats, { pageCount: 3, runtimeMinutes: 3 }),
    "~3 pg · ~3 min · 480 words",
  );
});

test("formatReadingStatsSummary falls back to default reading stats output", () => {
  const stats = {
    wordCount: 500,
    readingTimeMinutes: 2,
  };

  assert.equal(
    formatReadingStatsSummary(stats),
    "500 words · 2 min",
  );
});

test("computeReadingStats skips frontmatter after a leading byte-order mark", () => {
  const markdown = "---\ntitle: Field notes\nauthor: Ada\n---\n\nSeven words of body text are here.\n";
  assert.equal(computeReadingStats(markdown, "markdown").wordCount, 7);
  assert.equal(computeReadingStats(`\uFEFF${markdown}`, "markdown").wordCount, 7);
});
