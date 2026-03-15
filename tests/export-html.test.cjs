const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildExportHtml } = require("../.tmp/workspace-tests/src/lib/export-html.js");
const { katexCssEmbedded } = require("../.tmp/workspace-tests/src/lib/generated/katex-css-embedded.js");

const headerSource = fs.readFileSync(path.join(__dirname, "../src/components/Header.tsx"), "utf8");

function buildFixture(overrides = {}) {
  return buildExportHtml({
    title: "Fixture",
    themeAttr: "dark",
    cssVars: "--bg-primary: #111; --code-bg: #222;",
    bodyHtml: "<article class=\"markdown-body file-content-enter\"><p>Hello</p></article>",
    katexCss: null,
    ...overrides,
  });
}

test("buildExportHtml emits a full HTML document with theme and css vars", () => {
  const html = buildFixture();

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="en" data-theme="dark">/);
  assert.match(html, /<title>Fixture<\/title>/);
  assert.match(html, /:root\s*\{\s*--bg-primary: #111; --code-bg: #222;/);
  assert.match(html, /<body>\s*<article class="markdown-body file-content-enter"><p>Hello<\/p><\/article>\s*<\/body>/);
});

test("buildExportHtml includes export parity styles", () => {
  const html = buildFixture();

  for (const needle of [
    "text-decoration: line-through;",
    "li.task-list-item",
    ".footnotes",
    ".mermaid-diagram",
    ".code-block-wrapper button",
    "var(--syntax-keyword)",
    "var(--syntax-comment)",
    ".hljs-subst { color: var(--syntax-base); }",
    ".fountain-note { font-style: italic; color: var(--text-muted);",
    ".fountain-credit { font-size: 1rem; margin: 0 0 0.25em; color: var(--text-secondary); }",
    ".fountain-page-break { border: none; border-top: 1px solid var(--border);",
  ]) {
    assert.equal(
      html.includes(needle),
      true,
      `expected export html to include ${needle}`,
    );
  }
});

test("buildExportHtml preserves the fountain root wrapper so screenplay base styles apply", () => {
  const html = buildFixture({
    bodyHtml: "<article class=\"fountain-body file-content-enter\"><p class=\"fountain-action\">INT. OFFICE - DAY</p></article>",
  });

  assert.match(html, /<article class="fountain-body file-content-enter">/);
  assert.match(html, /\.fountain-body \{ font-family: "Courier New", Courier, monospace;/);
});

test("buildExportHtml escapes title and theme attribute", () => {
  const html = buildFixture({
    title: "<unsafe>",
    themeAttr: "\"dark\"",
  });

  assert.match(html, /<title>&lt;unsafe&gt;<\/title>/);
  assert.match(html, /data-theme="&quot;dark&quot;"/);
});

test("buildExportHtml neutralizes closing style tags inside cssVars", () => {
  const html = buildFixture({
    cssVars: "--bg-primary: #111; </style><script>alert(1)</script>",
  });

  assert.doesNotMatch(html, /<\/style><script>/i);
  assert.match(html, /<\\\/style><script>alert\(1\)<\/script>/);
});

test("buildExportHtml only embeds katex css when provided", () => {
  const withoutMath = buildFixture();
  const withMath = buildFixture({
    katexCss: "@font-face{src:url(data:font/woff2;base64,AAAA)} .katex{display:inline-block;}",
  });

  assert.doesNotMatch(withoutMath, /data:font\/woff2;base64,/);
  assert.match(withMath, /data:font\/woff2;base64,/);
  assert.match(withMath, /\.katex-display/);
});

test("buildExportHtml expects embedded katex css to have no relative font references", () => {
  const html = buildFixture({
    katexCss: "@font-face{src:url(data:font/woff2;base64,AAAA)} .katex{display:inline-block;}",
  });

  assert.doesNotMatch(html, /url\(fonts\//);
});

test("generated katexCssEmbedded contains embedded font data and no relative URLs", () => {
  assert.doesNotMatch(katexCssEmbedded, /url\(fonts\//);
  assert.match(katexCssEmbedded, /url\(data:font\/woff2;base64,/);
  assert.equal(
    katexCssEmbedded.includes("@font-face"),
    true,
    "expected @font-face declarations in generated KaTeX CSS",
  );
  assert.equal(
    katexCssEmbedded.includes(".katex"),
    true,
    "expected .katex rules in generated KaTeX CSS",
  );
});

test("Header exports the rendered root, waits for Mermaid, and lazily imports KaTeX CSS for math exports", () => {
  assert.match(headerSource, /await waitForMermaidDiagrams\(el\)/);
  assert.match(headerSource, /const bodyHtml = el\.outerHTML/);
  assert.match(headerSource, /hasMath = el\.querySelector\("\.katex"\) !== null/);
  assert.match(headerSource, /await import\("\.\.\/lib\/generated\/katex-css-embedded"\)/);
});
