const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeReadingStats,
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

test("computeReadingStats returns minimum 1 page for fountain", () => {
  const stats = computeReadingStats("hello world", "fountain");
  assert.equal(stats.pageCount, 1);
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
