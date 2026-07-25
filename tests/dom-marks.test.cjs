const test = require("node:test");
const assert = require("node:assert/strict");
const { installDom } = require("./_helpers/dom.cjs");

const {
  clearSearchHighlights,
  highlightSearchMatches,
} = require("../.tmp/workspace-tests/src/hooks/useSearch.js");
const {
  clearAnnotationHighlights,
  findAnchor,
  wrapRange,
} = require("../.tmp/workspace-tests/src/lib/text-anchoring.js");

function setContent(html) {
  document.body.innerHTML = `<main id="content">${html}</main>`;
  return document.getElementById("content");
}

function annotate(container, exact, id = "hl-1") {
  const range = findAnchor({ prefix: "", exact, suffix: "" }, container);
  assert.ok(range, `expected range for ${exact}`);
  wrapRange(range, "annotation-highlight-yellow", id);
}

function count(container, selector) {
  return container.querySelectorAll(selector).length;
}

test("search can highlight text inside an annotation mark", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma.</p>");

  annotate(container, "beta");
  const matches = highlightSearchMatches(container, "beta");

  assert.equal(matches.length, 1);
  assert.equal(count(container, "mark[data-highlight-id]"), 1);
  assert.equal(count(container, "mark.search-highlight"), 1);
  assert.equal(container.textContent, "Alpha beta gamma.");
});

test("reapplying annotations preserves active search marks", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma.</p>");

  highlightSearchMatches(container, "beta");
  annotate(container, "beta");
  clearAnnotationHighlights(container);
  annotate(container, "beta");

  assert.equal(count(container, "mark[data-highlight-id]"), 1);
  assert.equal(count(container, "mark.search-highlight"), 1);
  assert.equal(container.textContent, "Alpha beta gamma.");
});

test("clearing search keeps annotation marks", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma.</p>");

  annotate(container, "beta");
  highlightSearchMatches(container, "beta");
  clearSearchHighlights(container);

  assert.equal(count(container, "mark[data-highlight-id]"), 1);
  assert.equal(count(container, "mark.search-highlight"), 0);
  assert.equal(container.textContent, "Alpha beta gamma.");
});

test("clearing search removes active search marks", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma.</p>");

  const matches = highlightSearchMatches(container, "beta");
  assert.equal(matches.length, 1);
  matches[0].className = "search-highlight-active";
  clearSearchHighlights(container);

  assert.equal(count(container, "mark.search-highlight-active"), 0);
  assert.equal(count(container, "mark.search-highlight"), 0);
  assert.equal(container.textContent, "Alpha beta gamma.");
});

test("clearing annotations keeps search marks", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma.</p>");

  highlightSearchMatches(container, "beta");
  annotate(container, "beta");
  clearAnnotationHighlights(container);

  assert.equal(count(container, "mark[data-highlight-id]"), 0);
  assert.equal(count(container, "mark.search-highlight"), 1);
  assert.equal(container.textContent, "Alpha beta gamma.");
});

test("overlapping annotation and search ranges preserve each other", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma delta.</p>");

  annotate(container, "beta gamma");
  highlightSearchMatches(container, "gamma");
  clearSearchHighlights(container);

  assert.equal(count(container, "mark[data-highlight-id]"), 1);
  assert.equal(container.textContent, "Alpha beta gamma delta.");
});

test.todo("search matches a query spanning an annotation boundary (cross-node)");

test("identical annotation and search ranges can be cleared independently", async () => {
  await installDom();
  const container = setContent("<p>Alpha beta gamma.</p>");

  annotate(container, "beta");
  highlightSearchMatches(container, "beta");
  clearAnnotationHighlights(container);

  assert.equal(count(container, "mark[data-highlight-id]"), 0);
  assert.equal(count(container, "mark.search-highlight"), 1);
  assert.equal(container.textContent, "Alpha beta gamma.");
});
