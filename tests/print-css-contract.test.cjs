const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../src/app.css"), "utf8");

test("print css scopes themed output behind active print state", () => {
  assert.equal(
    css.includes("body[data-print-themed]"),
    false,
    "themed print selectors must require data-printing as well",
  );
  assert.equal(
    css.includes("body[data-printing][data-print-themed]"),
    true,
    "themed print selector should be explicitly gated",
  );
});

test("print css neutralizes reading surface background for standard pdf output", () => {
  assert.equal(
    css.includes("body[data-printing] .reading-surface"),
    true,
    "reading surface print reset selector must exist",
  );
  assert.equal(
    css.includes("background-image: none !important;"),
    true,
    "reading surface print reset should disable theme textures/gradients",
  );
});

test("print css keeps section page breaks only in book layout", () => {
  assert.equal(
    css.includes("body[data-printing][data-print-layout=\"book\"] .markdown-body h2"),
    true,
    "book layout h2 page-break selector should exist",
  );
  assert.equal(
    css.includes("page-break-before: auto;"),
    true,
    "standard layout should not force section page breaks",
  );
});

test("print css resets viewport height and overflow on root containers", () => {
  // Extract the @media print block
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  // #root > div must get height: auto and overflow: visible
  assert.ok(
    printBlock.includes("#root > div") &&
      printBlock.includes("height: auto !important") &&
      printBlock.includes("overflow: visible !important"),
    "#root > div must reset height and overflow for print",
  );

  // The inner flex wrapper must also be reset
  assert.ok(
    printBlock.includes("#root > div > .flex"),
    "inner flex wrapper (#root > div > .flex) must be targeted in print CSS",
  );
});

test("print CSS hides chrome via data-printing attribute outside @media print", () => {
  const printStart = css.indexOf("@media print");
  const beforePrintBlock = css.slice(0, printStart);
  assert.ok(
    beforePrintBlock.includes("body[data-printing] .print-hide"),
    "body[data-printing] .print-hide selector must exist outside @media print block",
  );
});

test("print CSS keeps the print handoff overlay scoped to active print state", () => {
  const printStart = css.indexOf("@media print");
  const beforePrintBlock = css.slice(0, printStart);

  assert.ok(
    beforePrintBlock.includes("body[data-printing]::before"),
    "body[data-printing]::before overlay selector must exist outside @media print",
  );
});

test("frontmatter title-page break is scoped to book layout", () => {
  assert.equal(
    css.includes("body[data-printing][data-print-layout=\"book\"] .frontmatter-header"),
    true,
    "frontmatter title-page behavior should be scoped to book layout",
  );
});

test("print css forces black text on table headers and cells", () => {
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  // Find the .markdown-body th rule and check it has color: black
  const thRule = printBlock.match(/\.markdown-body th\s*\{[^}]+\}/);
  assert.ok(thRule, ".markdown-body th rule must exist in print CSS");
  assert.ok(
    thRule[0].includes("color: black !important"),
    "table header must force black text in print",
  );

  // Find the .markdown-body td rule and check it has color: black
  const tdRule = printBlock.match(/\.markdown-body td\s*\{[^}]+\}/);
  assert.ok(tdRule, ".markdown-body td rule must exist in print CSS");
  assert.ok(
    tdRule[0].includes("color: black !important"),
    "table cell must force black text in print",
  );
});

test("print css resets hljs colors for non-themed output", () => {
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  assert.ok(
    printBlock.includes("body:not([data-print-themed]) .hljs"),
    "non-themed hljs base color reset must exist in print CSS",
  );
  assert.ok(
    printBlock.includes("body:not([data-print-themed]) .hljs-keyword"),
    "non-themed hljs keyword color reset must exist in print CSS",
  );
  assert.ok(
    printBlock.includes("body:not([data-print-themed]) .hljs-string"),
    "non-themed hljs string color reset must exist in print CSS",
  );
  assert.ok(
    printBlock.includes("body:not([data-print-themed]) .hljs-comment"),
    "non-themed hljs comment color reset must exist in print CSS",
  );
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
      printBlock.includes(selector) && printBlock.includes("break-inside: avoid;"),
      `${selector} must opt into break-inside avoidance in print`,
    );
  }
});

test("print css repeats table headers across page breaks", () => {
  const printStart = css.indexOf("@media print");
  const printBlock = css.slice(printStart);

  assert.ok(
    printBlock.includes(".markdown-body thead") &&
      printBlock.includes("display: table-header-group;"),
    "print CSS should promote table headers to repeat across pages",
  );
});
