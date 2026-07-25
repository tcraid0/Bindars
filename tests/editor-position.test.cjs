const test = require("node:test");
const assert = require("node:assert/strict");
const { installDom } = require("./_helpers/dom.cjs");

const {
  captureReaderAnchor,
  findFragmentElement,
  findHeadingElement,
  findSourceElement,
  restoreReaderAnchor,
} = require("../.tmp/workspace-tests/src/lib/editor-position.js");
const {
  countLogicalLines,
  offsetAtSourcePoint,
  sourcePointAtOffset,
} = require("../.tmp/workspace-tests/src/lib/source-lines.js");

function setRect(element, top, bottom, width = 100) {
  element.getBoundingClientRect = () => ({
    x: 0, y: top, top, bottom, left: 0, right: width,
    width, height: bottom - top, toJSON() {},
  });
}

test("fragment lookup is root-scoped, generic, and safe for selector punctuation", async () => {
  await installDom();
  const outside = document.createElement("div");
  outside.id = "user-content-fn:1";
  const root = document.createElement("article");
  root.innerHTML = [
    '<h2 id="café">Café</h2>',
    '<li id="user-content-fn:1">Footnote</li>',
    '<p id="duplicate">First duplicate</p>',
    '<h2 id="duplicate">Second duplicate</h2>',
  ].join("");
  document.body.append(outside, root);

  assert.equal(findFragmentElement(root, "café")?.textContent, "Café");
  assert.equal(findFragmentElement(root, "user-content-fn:1")?.textContent, "Footnote");
  assert.ok(!findHeadingElement(root, "user-content-fn:1"));
  assert.ok(findFragmentElement(root, outside.id) === root.querySelector("li"));
  assert.equal(findFragmentElement(root, "duplicate")?.textContent, "First duplicate");
  assert.ok(!findFragmentElement(root, ""));
});

test("logical source points share LF, CRLF, CR, and mixed-ending semantics", () => {
  for (const content of [
    "one\ntwo\nthree",
    "one\r\ntwo\r\nthree",
    "one\rtwo\rthree",
    "one\r\ntwo\rthree\nfour",
  ]) {
    const targetOffset = content.indexOf("two") + 2;
    const point = sourcePointAtOffset(content, targetOffset);
    assert.deepEqual(point, { line: 2, column: 3 });
    assert.equal(offsetAtSourcePoint(content, point), targetOffset);
    assert.equal(countLogicalLines(content), content.split(/\r\n|\r|\n/).length);
  }
});

test("reader anchors prefer the synchronously current source-backed heading", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.innerHTML = [
    '<h2 id="first" data-bindars-source-line="2" data-bindars-source-column="4">First</h2>',
    '<p data-bindars-source-line="4" data-bindars-source-column="1">Words</p>',
    '<h2 id="second" data-bindars-source-line="20" data-bindars-source-column="4">Second</h2>',
  ].join("");
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  Object.defineProperties(scrollRoot, {
    scrollTop: { value: 500, writable: true },
    clientHeight: { value: 400 },
    scrollHeight: { value: 1200 },
  });
  setRect(scrollRoot, 50, 450);
  setRect(root.querySelector("#first"), -450, -420);
  setRect(root.querySelector("p"), -350, -300);
  setRect(root.querySelector("#second"), 80, 110);

  assert.deepEqual(captureReaderAnchor(root, scrollRoot, "first", "ignored"), {
    source: { line: 20, column: 4 },
    viewportOffsetPx: 30,
  });
});

test("reader anchor uses a deterministic visible-text fallback when metadata is absent", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.innerHTML = "<p>Repeated words</p>";
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  setRect(scrollRoot, 0, 500);
  setRect(root.querySelector("p"), 120, 150);

  assert.deepEqual(
    captureReaderAnchor(root, scrollRoot, null, "Before\r\nRepeated words\rAgain Repeated words"),
    { source: { line: 2, column: 1 }, viewportOffsetPx: 120 },
  );
});

test("visible-text fallback resolves the visible repeated occurrence", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.innerHTML = "<p>Repeated words</p><p>Repeated words</p>";
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  setRect(scrollRoot, 0, 500);
  setRect(root.querySelectorAll("p")[0], -100, -70);
  setRect(root.querySelectorAll("p")[1], 120, 150);

  assert.deepEqual(
    captureReaderAnchor(root, scrollRoot, null, "Repeated words\r\n\r\nRepeated words"),
    { source: { line: 3, column: 1 }, viewportOffsetPx: 120 },
  );
});

test("visible-text occurrence matching is bounded by neighboring source markers", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.className = "fountain-body";
  root.innerHTML = [
    "<p>Repeated words</p>",
    '<h3 data-bindars-source-line="3" data-bindars-source-column="1">INT. ROOM - DAY</h3>',
    "<p>Repeated words</p>",
  ].join("");
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  setRect(scrollRoot, 0, 500);
  setRect(root.querySelectorAll("p")[0], -100, -70);
  setRect(root.querySelector("h3"), -50, -20);
  setRect(root.querySelectorAll("p")[1], 120, 150);

  assert.deepEqual(
    captureReaderAnchor(
      root,
      scrollRoot,
      null,
      "Repeated words\n\nINT. ROOM - DAY\n\nRepeated words",
    ),
    { source: { line: 5, column: 1 }, viewportOffsetPx: 120 },
  );
});

test("visible-text fallback rejects text fragments embedded in larger source words", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.className = "fountain-body";
  root.innerHTML = "<p>He</p>";
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  setRect(scrollRoot, 0, 500);
  setRect(root.querySelector("p"), 120, 150);

  assert.equal(captureReaderAnchor(root, scrollRoot, null, "Hello there"), null);
});

test("visible-text fallback matches a whole formatted block or fails safely", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.className = "fountain-body";
  root.innerHTML = "<p><span>He </span><em>waits</em></p>";
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  setRect(scrollRoot, 0, 500);
  setRect(root.querySelector("p"), 120, 150);

  assert.equal(
    captureReaderAnchor(root, scrollRoot, null, "Hello before\n\nHe *waits*"),
    null,
  );
});

test("Fountain pre-scene text wins when the first scene is below the active threshold", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.className = "fountain-body";
  root.innerHTML = [
    "<p>Opening action</p>",
    '<h3 id="int-office" data-bindars-source-line="3" data-bindars-source-column="1">INT. OFFICE - DAY</h3>',
  ].join("");
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  Object.defineProperties(scrollRoot, {
    scrollTop: { value: 0, writable: true },
    clientHeight: { value: 400 },
    scrollHeight: { value: 900 },
  });
  setRect(scrollRoot, 0, 400);
  setRect(root.querySelector("p"), 20, 50);
  setRect(root.querySelector("h3"), 200, 230);

  assert.deepEqual(
    captureReaderAnchor(root, scrollRoot, "int-office", "Opening action\n\nINT. OFFICE - DAY"),
    { source: { line: 1, column: 1 }, viewportOffsetPx: 20 },
  );
});

test("reader restoration chooses the nearest preceding source block and restores its viewport offset directly", async () => {
  await installDom();
  const scrollRoot = document.createElement("main");
  const root = document.createElement("article");
  root.innerHTML = [
    '<p id="one" data-bindars-source-line="3" data-bindars-source-column="1">One</p>',
    '<p id="two" data-bindars-source-line="8" data-bindars-source-column="1">Two</p>',
  ].join("");
  scrollRoot.appendChild(root);
  document.body.appendChild(scrollRoot);
  Object.defineProperties(scrollRoot, {
    scrollTop: { value: 300, writable: true },
    clientHeight: { value: 200 },
    scrollHeight: { value: 1000 },
  });
  setRect(scrollRoot, 50, 250);
  setRect(root.querySelector("#two"), 200, 230);

  assert.equal(findSourceElement(root, { line: 9, column: 5 }).id, "two");
  assert.equal(restoreReaderAnchor(root, scrollRoot, { line: 9, column: 5 }, 40), true);
  assert.equal(scrollRoot.scrollTop, 410);
  assert.match(root.querySelector("#two").outerHTML, /data-bindars-source-line="8"/);
});

test("reader restoration keeps a line-start editor target on that line's rendered block", async () => {
  await installDom();
  const root = document.createElement("article");
  root.innerHTML = [
    '<p id="previous" data-bindars-source-line="3" data-bindars-source-column="1">Previous</p>',
    '<h2 id="heading" data-bindars-source-line="5" data-bindars-source-column="4">Heading</h2>',
  ].join("");

  assert.equal(findSourceElement(root, { line: 5, column: 1 }).id, "heading");
});

test("reader restoration prefers a same-line preceding node over a following node", async () => {
  await installDom();
  const root = document.createElement("article");
  root.innerHTML = [
    '<span id="before" data-bindars-source-line="5" data-bindars-source-column="2">Before</span>',
    '<span id="after" data-bindars-source-line="5" data-bindars-source-column="10">After</span>',
  ].join("");

  assert.equal(findSourceElement(root, { line: 5, column: 6 }).id, "before");
});
