const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../src/app.css"), "utf8");
const mermaidBlock = fs.readFileSync(path.join(__dirname, "../src/components/MermaidBlock.tsx"), "utf8");

// These are CSS contracts, not layout/PDF tests. Match declarations attached
// to the requested selector, rather than accepting a rule elsewhere in the file.
function printDeclarations(selector) {
  const printCss = css.slice(css.indexOf("@media print")).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...printCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((value) => value.trim() === selector))
    .map(([, , declarations]) => declarations)
    .join("\n");
}

test("reader surfaces have no delayed entrance animation", () => {
  assert.doesNotMatch(css, /\.file-content-enter/);
  assert.doesNotMatch(css, /@keyframes\s+contentAppear/);
  assert.match(css, /\.empty-state-title\s*\{/);
});

test("print has one format without themed or book selectors", () => {
  assert.doesNotMatch(css, /data-print-themed|data-print-layout/);
});

test("print surfaces stay neutral without an active JavaScript print session", () => {
  for (const selector of ["#root", "#root > div", ".reading-surface"]) {
    const declarations = printDeclarations(selector);
    assert.match(declarations, /background(?:-color)?:\s*white\s*!important\s*;/);
    assert.match(declarations, /color:\s*black\s*!important\s*;/);
  }
  assert.match(
    printDeclarations(".reading-surface"),
    /background-image:\s*none\s*!important\s*;/,
  );
});

test("Markdown sections and frontmatter remain continuous", () => {
  assert.match(printDeclarations(".markdown-body h2"), /page-break-before:\s*auto/);
  assert.match(printDeclarations(".frontmatter-header"), /page-break-after:\s*auto/);
});

test("print css resets viewport height and overflow on root containers", () => {
  for (const selector of ["#root > div", "#root > div > .flex"]) {
    const declarations = printDeclarations(selector);
    assert.match(declarations, /height:\s*auto !important;/, selector);
    assert.match(declarations, /overflow:\s*visible !important;/, selector);
    assert.match(declarations, /min-height:\s*0 !important;/, selector);
  }
  assert.match(printDeclarations("#root > div > .flex"), /display:\s*block !important;/);
});

test("print tables remove screen clipping and allow unbroken cell text to wrap", () => {
  assert.match(printDeclarations(".markdown-table-wrapper"), /overflow:\s*visible !important;/);
  assert.match(printDeclarations(".markdown-body table"), /table-layout:\s*fixed;/);
  for (const selector of [".markdown-body th", ".markdown-body td"]) {
    assert.match(printDeclarations(selector), /overflow-wrap:\s*anywhere;/, selector);
    assert.match(printDeclarations(selector), /hyphens:\s*none;/, selector);
  }
});

test("print strikethrough and metadata separators stay dark independently of the screen theme", () => {
  for (const selector of [".markdown-body del", ".markdown-body s"]) {
    assert.match(printDeclarations(selector), /color:\s*black !important;/, selector);
  }
  assert.match(printDeclarations(".frontmatter-separator"), /color:\s*#444 !important;/);
});

test("print CSS hides chrome via data-printing attribute outside @media print", () => {
  const printStart = css.indexOf("@media print");
  const beforePrintBlock = css.slice(0, printStart);
  assert.ok(
    beforePrintBlock.includes("body[data-printing] .print-hide"),
    "body[data-printing] .print-hide selector must exist outside @media print block",
  );
});

test("print status is hidden on paper without masking the reader", () => {
  assert.doesNotMatch(css, /body\[data-printing\]::before/);
  assert.match(printDeclarations(".print-status"), /display:\s*none !important/);
});

test("screen css lets mermaid diagrams keep intrinsic width", () => {
  const printStart = css.indexOf("@media print");
  const beforePrintBlock = css.slice(0, printStart);
  const mermaidSvgRule = beforePrintBlock.match(/\.mermaid-diagram svg\s*\{[^}]+\}/);

  assert.ok(mermaidSvgRule, "screen .mermaid-diagram svg rule must exist");
  assert.equal(
    mermaidSvgRule[0].includes("max-width:"),
    false,
    "screen mermaid svg rule should not cap width",
  );
  assert.ok(
    mermaidSvgRule[0].includes("flex: 0 0 auto;"),
    "screen mermaid svg rule should prevent flexbox shrinking",
  );
});

test("markdown css styles strikethrough explicitly", () => {
  const printStart = css.indexOf("@media print");
  const beforePrintBlock = css.slice(0, printStart);

  assert.ok(
    beforePrintBlock.includes(".markdown-body del") &&
      beforePrintBlock.includes(".markdown-body s") &&
      beforePrintBlock.includes("text-decoration: line-through;"),
    "screen markdown css should style strikethrough text explicitly",
  );
});

test("mermaid config disables flowchart max-width on screen", () => {
  assert.ok(
    mermaidBlock.includes("useMaxWidth: false"),
    "MermaidBlock should disable flowchart max-width responsive shrinking",
  );
});

test("mermaid config enables root html labels", () => {
  assert.ok(
    mermaidBlock.includes("htmlLabels: true"),
    "MermaidBlock should enable Mermaid htmlLabels at the root config level",
  );
});

test("mermaid config sets arrowhead color from the theme", () => {
  assert.ok(
    mermaidBlock.includes("arrowheadColor: textSecondary"),
    "MermaidBlock should keep Mermaid arrowheads aligned with themed line color",
  );
});

test("screen css lets mermaid html labels overflow their foreignObject bounds", () => {
  const printStart = css.indexOf("@media print");
  const beforePrintBlock = css.slice(0, printStart);

  assert.ok(
    beforePrintBlock.includes(".mermaid-diagram svg foreignObject") &&
      beforePrintBlock.includes("overflow: visible;"),
    "screen mermaid CSS should avoid clipping HTML labels at foreignObject bounds",
  );
});

test("Fountain keeps structural page breaks and neutral title colors", () => {
  for (const selector of [".fountain-title-page", ".fountain-page-break"]) {
    assert.match(printDeclarations(selector), /page-break-after:\s*always/);
  }
  for (const selector of [".fountain-body", ".fountain-title", ".fountain-author", ".fountain-scene-heading"]) {
    assert.match(printDeclarations(selector), /color:\s*black !important/);
  }
});

test("Mermaid artwork keeps its matching backdrop and colors on paper", () => {
  const declarations = printDeclarations(".mermaid-diagram");
  assert.match(declarations, /background:\s*var\(--bg-secondary\) !important/);
  assert.match(declarations, /print-color-adjust:\s*exact/);
});

test("print css forces black text on table headers and cells", () => {
  for (const selector of [".markdown-body th", ".markdown-body td"]) {
    assert.match(printDeclarations(selector), /color:\s*black !important;/, selector);
  }
});

test("print css resets hljs colors for non-themed output", () => {
  for (const [selector, color] of [
    [".hljs", "#24292e"],
    [".hljs-subst", "#24292e"],
    [".hljs-keyword", "#d73a49"],
    [".hljs-string", "#032f62"],
    [".hljs-comment", "#6a737d"],
  ]) {
    assert.ok(printDeclarations(selector).includes(`color: ${color} !important;`), selector);
  }
});

test("print css defines sizes for all heading levels h1-h6", () => {
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const re = new RegExp(`\\.markdown-body ${level}[^,{]*\\{[^}]*font-size:\\s*\\d+pt`);
    assert.ok(
      re.test(printBlock),
      `${level} must have an explicit font-size in print CSS`,
    );
  }
});

test("print css makes h1/h2 border-bottom visible", () => {
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  // Look for a rule targeting h1 and h2 with border-bottom-color
  assert.ok(
    printBlock.includes("border-bottom-color: #999 !important"),
    "h1/h2 must override border-bottom-color to a visible value in print",
  );
});

test("print css keeps large printable blocks together where possible", () => {
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  for (const selector of [
    ".markdown-body blockquote",
    ".markdown-body pre",
    ".markdown-body table",
    ".markdown-body img",
    ".mermaid-diagram",
    ".markdown-body section.footnotes",
  ]) {
    assert.ok(
      printBlock.includes(selector) && printDeclarations(selector).includes("break-inside: avoid;"),
      `${selector} must opt into break-inside avoidance in print`,
    );
  }
});

test("print css requests repeating table headers", () => {
  assert.match(printDeclarations(".markdown-body thead"), /display:\s*table-header-group;/);
});

test("native and CSS print margins agree in physical units", () => {
  assert.match(printDeclarations("@page"), /margin:\s*2cm\s*;/);
  const native = fs.readFileSync(path.join(__dirname, "../src-tauri/src/printing.rs"), "utf8");
  assert.match(native, /PRINT_MARGIN_POINTS:\s*f64\s*=\s*2\.0\s*\/\s*2\.54\s*\*\s*72\.0/);
});
