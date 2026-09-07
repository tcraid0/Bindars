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
const { highlightSearchMatches, clearSearchHighlights } = require("../.tmp/workspace-tests/src/hooks/useSearch.js");

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

test("search skips the visually hidden KaTeX MathML copy of a formula", async () => {
  const rendered = await renderReader("Energy is $$E = mc^2$$ here.\n\nPlain energy text.");
  try {
    // "mc" exists only inside the formula: the hidden MathML copy would count
    // as a match the reader can never show.
    assert.deepEqual(highlightSearchMatches(rendered.article, "mc"), []);
    clearSearchHighlights(rendered.article);

    const matches = highlightSearchMatches(rendered.article, "energy");
    assert.equal(matches.length, 2);
    assert.ok(matches.every((mark) => !mark.closest(".katex")));
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
    assert.ok(matches.every((mark) => !mark.closest("text")), "no mark inside SVG <text>");
    assert.equal(matches.filter((mark) => mark.closest("foreignObject")).length, 1);
    assert.equal(rendered.article.querySelector("svg text").textContent, "Alice");

    clearSearchHighlights(rendered.article);
    assert.equal(rendered.article.querySelectorAll("mark").length, 0);
    assert.equal(rendered.article.querySelector("foreignObject div").textContent, "Alice label");
  } finally {
    await act(async () => svgRoot.unmount());
    await rendered.cleanup();
  }
});
