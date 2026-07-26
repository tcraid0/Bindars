import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";

const require = createRequire(import.meta.url);

const { remarkPlugins, rehypePlugins } = require("../.tmp/workspace-tests/src/lib/markdown-plugins.js");
const { MarkdownRenderer } = require("../.tmp/workspace-tests/src/components/MarkdownRenderer.js");
const { FountainRenderer } = require("../.tmp/workspace-tests/src/components/FountainRenderer.js");
const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
const { buildWorkspaceDoc } = require("../.tmp/workspace-tests/src/lib/workspace-index.js");

const readerSettings = {
  fontSize: 18,
  contentWidth: 72,
  lineHeight: 1.6,
  fontFamily: "newsreader",
  paragraphSpacing: "comfortable",
  sceneLensEnabled: true,
  reducedEffects: false,
  printLayout: "standard",
  printWithTheme: false,
};

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(Markdown, { remarkPlugins, rehypePlugins }, markdown),
  );
}

function buildMeta(name = "doc.md") {
  return {
    path: `/workspace/${name}`,
    relPath: name,
    name,
    mtimeMs: 0,
    size: 0,
  };
}

function renderedHeadingId(markdown) {
  const html = renderMarkdown(markdown);
  const match = /<h[1-6] id="([^"]+)"/.exec(html);
  assert.ok(match, `expected rendered heading id in ${html}`);
  return match[1];
}

function indexedHeadingId(markdown) {
  const doc = buildWorkspaceDoc(buildMeta(), markdown);
  const id = doc.headings[0]?.id;
  assert.ok(id, "expected indexed heading id");
  return id;
}

function renderMarkdownRenderer(content) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      convertFileSrc: (filePath, protocol = "asset") => `${protocol}://${filePath}`,
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    clearTimeout,
    setTimeout,
  };
  globalThis.document = {
    documentElement: {
      getAttribute: () => "light",
    },
  };

  try {
    return renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(MarkdownRenderer, {
          content,
          filePath: "/workspace/current.md",
          settings: readerSettings,
          contentRef: React.createRef(),
          onOpenFragment: () => false,
        }),
      ),
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
}

function renderFountainRenderer(content) {
  return renderToStaticMarkup(
    React.createElement(FountainRenderer, {
      content,
      filePath: "/workspace/current.fountain",
      settings: readerSettings,
      contentRef: React.createRef(),
    }),
  );
}

test("reader surfaces do not animate same-document remounts", () => {
  assert.doesNotMatch(renderMarkdownRenderer("# Markdown"), /file-content-enter/);
  assert.doesNotMatch(renderFountainRenderer("INT. OFFICE - DAY"), /file-content-enter/);
});

test("GFM render includes tables, task lists, strikethrough, footnotes, and autolinks", () => {
  const html = renderMarkdown(
    [
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "~~deleted~~",
      "",
      "Footnote[^1]",
      "",
      "[^1]: note",
      "",
      "https://example.com",
    ].join("\n"),
  );

  assert.match(html, /<table(?:\s|>)/);
  assert.match(html, /<thead>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked=""/);
  assert.match(html, /<del>deleted<\/del>/);
  assert.match(html, /data-footnote-ref/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test("syntax highlighting emits highlight.js classes for fenced code", () => {
  const html = renderMarkdown("```js\nconst answer = 42;\n```");

  assert.match(html, /class="hljs language-js"/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /hljs-number/);
});

test("KaTeX renders inline math with double-dollar delimiters", () => {
  const html = renderMarkdown("Inline $$E = mc^2$$");

  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /class="katex-display"/);
});

test("KaTeX renders display math", () => {
  const html = renderMarkdown(["$$", "\\int_0^1 x^2 \\, dx", "$$"].join("\n"));

  assert.match(html, /class="katex-display"/);
});

test("invalid KaTeX input renders without throwing", () => {
  assert.doesNotThrow(() => renderMarkdown("Bad $$\\notacommand$$"));

  const html = renderMarkdown("Bad $$\\notacommand$$");
  assert.match(html, /class="katex"/);
  assert.match(html, /\\notacommand/);
});

test("single-dollar delimiters render as literal text, not math", () => {
  const html = renderMarkdown("Inline $E = mc^2$ stays literal");

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$E = mc\^2\$/);
});

test("currency amounts in prose are never parsed as math", () => {
  const samples = [
    "A typical engineer ran somewhere between $150 to $250 per month in tokens.",
    "The heaviest users were anywhere from $500 to $2,000 a month.",
    "the CTO spent about $1,200 running a single two-hour demo.",
    "a subscription: $20/$100/$200 per month",
    "a $200 plan could translate to roughly $8,000 of usage in a month.",
  ];

  for (const sample of samples) {
    const html = renderMarkdown(sample);
    assert.doesNotMatch(html, /class="katex"/, `unexpected math in: ${sample}`);
    const dollarCount = (html.match(/\$/g) || []).length;
    const sourceDollarCount = (sample.match(/\$/g) || []).length;
    assert.equal(dollarCount, sourceDollarCount, `lost dollar signs in: ${sample}`);
  }
});

test("currency amounts across a soft line break stay literal", () => {
  const html = renderMarkdown("between $150\nand $250 per month");

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$150/);
  assert.match(html, /\$250/);
});

test("escaped and code-span dollar amounts stay literal", () => {
  const html = renderMarkdown("Escaped \\$150 and `$150 to $250` in code");

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$150 to \$250/);
});

test("dollar amounts in GFM table cells stay literal", () => {
  const html = renderMarkdown(
    ["| plan | price |", "| --- | --- |", "| range | $10 to $20 |", "| $10 | $20 |"].join("\n"),
  );

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$10 to \$20/);
});

test("double-dollar inline math works inside a GFM table cell", () => {
  const html = renderMarkdown(
    ["| formula |", "| --- |", "| $$x^2$$ |"].join("\n"),
  );

  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /class="katex-display"/);
});

test("MarkdownRenderer routes mermaid fenced blocks to MermaidBlock", () => {
  const html = renderMarkdownRenderer("```mermaid\ngraph TD; A-->B;\n```");

  assert.match(html, /class="mermaid-diagram mermaid-loading"/);
  assert.match(html, /class="mermaid-diagram mermaid-loading"[^>]+data-bindars-source-line="1"/);
  assert.match(html, /Rendering diagram/);
  assert.doesNotMatch(html, /<pre><code class="hljs language-mermaid"/);
});

test("workspace heading IDs match the rendered SmartyPants slug pipeline", () => {
  for (const markdown of [
    "## Results -- Final",
    "## Results --- Final",
    "## Wait... What",
    "## \"Quoted\" and 'Single'",
  ]) {
    assert.equal(indexedHeadingId(markdown), renderedHeadingId(markdown));
  }
});

test("MarkdownRenderer does not serialize react-markdown node props", () => {
  const html = renderMarkdownRenderer(
    [
      "![Alt text](./image.png)",
      "",
      "[Target](./target.md)",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
    ].join("\n"),
  );

  assert.match(html, /<img[^>]+src="asset:\/\/\/workspace\/image\.png"[^>]+alt="Alt text"/);
  assert.match(html, /<a href="\.\/target\.md">Target<\/a>/);
  assert.match(html, /<table(?:\s|>)/);
  assert.doesNotMatch(html, /\snode="/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("MarkdownRenderer resolves encoded local image filenames before creating asset urls", () => {
  const html = renderMarkdownRenderer("![Cover](<café cover.png>)");

  assert.match(html, /src="asset:\/\/\/workspace\/café cover\.png"/);
});

test("MarkdownRenderer carries authoritative source points through the plugin chain", () => {
  const html = renderMarkdownRenderer([
    "---",
    "title: Positioned",
    "---",
    "",
    "## **Formatted** [heading](./target.md) -- now",
    "",
    "Setext &amp; emoji 👋",
    "--------------------",
    "",
    "> Quoted paragraph",
    "",
    "```md",
    "## Not a heading",
    "```",
  ].join("\n"));

  assert.match(html, /<h2[^>]+data-bindars-source-line="5"[^>]+data-bindars-source-column="6"/);
  assert.match(html, /<h2[^>]+id="setext--emoji-"[^>]+data-bindars-source-line="7"/);
  assert.match(html, /<blockquote[^>]+data-bindars-source-line="10"/);
  assert.match(html, /class="code-block-wrapper"[^>]+data-bindars-source-line="12"/);
  assert.equal((html.match(/data-bindars-source-line=/g) || []).length >= 4, true);
  assert.doesNotMatch(html, /id="not-a-heading"/);
});
