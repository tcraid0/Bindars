const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC, mockConvertFileSrc } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

const { MarkdownRenderer } = require("../.tmp/workspace-tests/src/components/MarkdownRenderer.js");
const { MermaidSvg } = require("../.tmp/workspace-tests/src/components/MermaidBlock.js");
const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
const { useSearch, highlightSearchMatches, clearSearchHighlights } = require("../.tmp/workspace-tests/src/hooks/useSearch.js");

test("dense search rebuilds a text node without per-match live splits or range walks", async t => {
  await installDom();
  const { createSmartypantsFixture } = await import("../scripts/generate-document-performance-fixtures.mjs");
  const fixture = createSmartypantsFixture(2048, "punctuation");
  const [heading, body] = fixture.content.split("\n\n");
  const article = document.createElement("article");
  for (const [tag, text] of [["h1", heading.slice(2)], ["p", body]]) {
    const element = document.createElement(tag); element.textContent = text; article.append(element);
  }
  document.body.append(article);
  const text = article.textContent;
  const split = t.mock.method(window.Text.prototype, "splitText");
  const intersects = t.mock.method(window.Range.prototype, "intersectsNode");
  try {
    const matches = highlightSearchMatches(article, "a");
    assert.equal(matches.length, 995);
    assert.ok(matches.every(([mark]) => /^a$/i.test(mark.textContent)));
    assert.equal(article.textContent, text);
    assert.equal(split.mock.callCount(), 0, "dense search must not split the live node per match");
    assert.equal(intersects.mock.callCount(), 0, "dense search must not rediscover each range's nodes");
    clearSearchHighlights(article);
    assert.equal(article.textContent, text);
    assert.equal(highlightSearchMatches(article, "a").length, 995, "repeat searches preserve counts");
  } finally { article.remove(); }
});

test("search preserves order, formatting, annotations and text across mixed match boundaries", async () => {
  await installDom();
  const article = document.createElement("article");
  article.innerHTML = '<p>ab a<em>b</em> <strong>ab</strong> a<mark data-highlight-id="saved">b ab</mark> ab</p><p>ab</p>';
  document.body.append(article);
  const text = article.textContent;
  const annotation = article.querySelector('[data-highlight-id="saved"]');
  try {
    for (const query of ["ab", "b", "ab"]) {
      clearSearchHighlights(article);
      const matches = highlightSearchMatches(article, query);
      assert.equal(matches.length, 7);
      assert.equal(article.textContent, text);
      const allMarks = [...article.querySelectorAll("mark.search-highlight")];
      assert.deepEqual(matches.flat(), allMarks, "match navigation stays in document order");
      assert.ok(article.querySelector("em"));
      assert.ok(article.querySelector("strong"));
      assert.ok(annotation === article.querySelector('[data-highlight-id="saved"]'));
      assert.equal(annotation.textContent, "b ab");
    }
    clearSearchHighlights(article);
    assert.equal(article.textContent, text);
    assert.equal(article.querySelectorAll("mark").length, 1, "clearing search keeps the annotation");
  } finally { article.remove(); }
});

test("dense mixed-format search batches fragments and restores the original nodes", async t => {
  await installDom();
  const article = document.createElement("article");
  article.innerHTML = `<p>${"ab ".repeat(1000)}a<em>b</em> a<mark data-highlight-id="saved">b ab</mark></p>`;
  document.body.append(article);
  const text = article.textContent;
  const emphasis = article.querySelector("em");
  const annotation = article.querySelector('[data-highlight-id="saved"]');
  const originalNodes = [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    originalNodes.push({ node, parent: node.parentNode, text: node.data });
  }
  t.mock.method(window.Text.prototype, "splitText", () => {
    assert.fail("dense mixed-format search must not split live nodes per match");
  });
  t.mock.method(window.Range.prototype, "intersectsNode", () => {
    assert.fail("crossing matches must not cause per-match range walks");
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const matches = highlightSearchMatches(article, "ab");
      assert.equal(matches.length, 1003, "crossing fragments count as one logical match");
      assert.deepEqual(matches.map(parts => parts.map(mark => mark.textContent).join("")), Array(1003).fill("ab"));
      const marks = [...article.querySelectorAll("mark.search-highlight")];
      assert.equal(marks.length, 1005);
      assert.deepEqual(matches.flat(), marks, "navigation follows document order");
      assert.ok(article.querySelector("em") === emphasis);
      assert.ok(article.querySelector('[data-highlight-id="saved"]') === annotation);
      assert.equal(emphasis.textContent, "b");
      assert.equal(annotation.textContent, "b ab");
      assert.equal(article.textContent, text);
      clearSearchHighlights(article);
      for (const { node, parent, text } of originalNodes) {
        assert.ok(node.parentNode === parent, "clearing restores the original parent");
        assert.equal(node.data, text);
      }
      assert.equal(article.querySelectorAll("mark").length, 1, "clearing retains the annotation");
    }
  } finally { article.remove(); }
});

test("rebuilt matches retain Unicode offsets and do not cross blocks or hidden text", async () => {
  await installDom();
  const article = document.createElement("article");
  article.innerHTML = '<p>😀 İ K k <strong>K</strong> k</p><p>a<span class="sr-only">hidden</span>b</p><p>a</p><p>b</p>';
  const text = article.textContent;
  const matches = highlightSearchMatches(article, "k");
  assert.deepEqual(matches.map(([mark]) => mark.textContent), ["K", "k", "K", "k"]);
  assert.equal(article.textContent, text);
  clearSearchHighlights(article);
  assert.deepEqual(highlightSearchMatches(article, "ab"), []);
  assert.equal(highlightSearchMatches(article, "😀").length, 1);
  assert.equal(article.textContent, text);
});

test("search uses the current motion preference for queued searches and navigation", async t => {
  await installDom();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scrolling = [];
  t.mock.method(window.HTMLElement.prototype, "scrollIntoView", options => scrolling.push(options.behavior));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let search, setMotion;
  function Probe() {
    const [motion, update] = React.useState(false); setMotion = update;
    const ref = React.useRef(null);
    search = useSearch(ref, motion);
    return React.createElement("article", { ref }, "Needle and another needle.");
  }
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => search.setQuery("needle"));
    await act(async () => setMotion(true));
    await act(async () => t.mock.timers.tick(150));
    assert.equal(search.matchCount, 2);
    assert.equal(scrolling.at(-1), "auto", "a pending search must use the new preference");
    await act(async () => search.next());
    assert.equal(scrolling.at(-1), "auto");
    await act(async () => setMotion(false));
    await act(async () => search.previous());
    assert.equal(scrolling.at(-1), "smooth");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

const readerSettings = {
  fontSize: 18,
  contentWidth: 72,
  lineHeight: 1.6,
  fontFamily: "newsreader",
  paragraphSpacing: "comfortable",
  sceneLensEnabled: true,
  reducedEffects: false,
};

async function renderReader(content) {
  await installDom();
  globalThis.matchMedia = window.matchMedia.bind(window);
  mockConvertFileSrc("macos");
  mockIPC(() => "/tmp");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ToastProvider, null, React.createElement(MarkdownRenderer, {
      content,
      filePath: "/tmp/document.md",
      imagesAuthorized: true,
      settings: readerSettings,
      contentRef: React.createRef(),
      onOpenFragment: () => false,
    })));
    await Promise.resolve();
  });
  return {
    article: host.querySelector("article"),
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      clearMocks();
    },
  };
}

test("search keeps React's original text nodes attached and restores them when cleared", async () => {
  const rendered = await renderReader("# Search\n\nneedle first and another needle.\n\nA needle inside **needle bold** and *last needle*.");
  const originalNodes = [];
  const walker = document.createTreeWalker(rendered.article, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    originalNodes.push({ node, parent: node.parentNode, text: node.data });
  }
  try {
    for (const query of ["needle", "last", "needle"]) {
      assert.ok(highlightSearchMatches(rendered.article, query).length > 0);
      for (const { node } of originalNodes) {
        assert.ok(rendered.article.contains(node), "search must retain React's text nodes");
      }
      clearSearchHighlights(rendered.article);
      for (const { node, parent, text } of originalNodes) {
        assert.ok(node.parentNode === parent, "clearing must restore the original parent");
        assert.equal(node.data, text, "clearing must restore the original node's full text");
      }
      assert.equal(rendered.article.querySelectorAll("mark").length, 0);
    }
  } finally {
    await rendered.cleanup();
  }
});

test("search skips the visually hidden KaTeX MathML copy of a formula", async () => {
  const rendered = await renderReader("Energy is $$E = mc^2$$ here.\n\nPlain energy text.");
  try {
    // "mc" exists only inside the formula: the hidden MathML copy would count
    // as a match the reader can never show.
    const formulaMatches = highlightSearchMatches(rendered.article, "mc");
    assert.equal(formulaMatches.length, 1);
    assert.ok(formulaMatches.flat().every((mark) => !mark.closest(".katex-mathml")));
    clearSearchHighlights(rendered.article);

    const matches = highlightSearchMatches(rendered.article, "energy");
    assert.equal(matches.length, 2);
    assert.ok(matches.flat().every((mark) => !mark.closest(".katex")));
    assert.ok(rendered.article.querySelector(".katex-mathml"), "the formula itself stays intact");
  } finally {
    await rendered.cleanup();
  }
});

test("search leaves SVG diagram text alone but still highlights HTML diagram labels", async () => {
  const rendered = await renderReader("Alice talks to Bob.");
  const svgHost = document.createElement("div");
  rendered.article.appendChild(svgHost);
  const svgRoot = createRoot(svgHost);
  try {
    await act(async () => {
      svgRoot.render(React.createElement(MermaidSvg, {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="1">Alice</text>'
          + '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Alice label</div></foreignObject></svg>',
      }));
    });

    const matches = highlightSearchMatches(rendered.article, "alice");
    assert.equal(matches.length, 2);
    assert.ok(matches.flat().every((mark) => !mark.closest("text")), "no mark inside SVG <text>");
    assert.equal(matches.flat().filter((mark) => mark.closest("foreignObject")).length, 1);
    assert.equal(rendered.article.querySelector("svg text").textContent, "Alice");

    clearSearchHighlights(rendered.article);
    assert.equal(rendered.article.querySelectorAll("mark").length, 0);
    assert.equal(rendered.article.querySelector("foreignObject div").textContent, "Alice label");
  } finally {
    await act(async () => svgRoot.unmount());
    await rendered.cleanup();
  }
});
