const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const Markdown = require("react-markdown").default;
const katex = require("katex");
const { remarkPlugins, rehypePlugins } = require("../../.tmp/workspace-tests/src/lib/markdown-plugins.js");
const { MATH_MAX_EXPAND } = require("../../.tmp/workspace-tests/src/lib/document-complexity.js");

// Actual Bindars Markdown plugins, including sanitization BEFORE KaTeX.
// Synthetic prerequisite only: these mutations do not come from a document.
const renderMath = (source) => renderToStaticMarkup(
  React.createElement(Markdown, { remarkPlugins, rehypePlugins }, `$$\n${source}\n$$`),
);
const commands = [
  String.raw`\href{https://example.invalid/probe}{x}`,
  String.raw`\href{javascript:alert(1)}{x}`,
  String.raw`\includegraphics{https://example.invalid/probe.png}`,
  String.raw`\htmlStyle{color:red}{x}`,
  String.raw`\htmlClass{injected-class}{x}`,
  String.raw`\htmlId{injected-id}{x}`,
];
function assertUntrusted(render) {
  for (const source of commands) {
    const html = render(source);
    assert.match(html, /class="katex/);
    assert.doesNotMatch(html, /<a\b|<img\b|style="color:red"|class="injected-class"|id="injected-id"/, source);
  }
}
function withPrototype(values, run) {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(Object.prototype, key, { value, writable: true, configurable: true });
    }
    run();
  } finally {
    for (const key of Object.keys(values)) {
      const previous = Object.hasOwn(before, key) ? before[key] : undefined;
      if (previous) Object.defineProperty(Object.prototype, key, previous);
      else delete Object.prototype[key];
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  }
}

function main() {
  // Normal behavior and an explicit-trust positive control make a false pass
  // from a broken renderer or an invalid attack expression unlikely.
  assertUntrusted(renderMath);
  assert.match(katex.renderToString(commands[0], { trust: true }), /<a\b/);
  const ordinary = String.raw`\frac{\alpha+\beta}{\sqrt{x^2}}`;
  const baseline = renderMath(ordinary);
  const undefinedMacro = renderMath(String.raw`\inherited`);
  assert.match(baseline, /<math\b/);
  const scenario = process.argv[2];
  switch (scenario) {
    case "trust":
      withPrototype({ trust: true }, () => {
        assertUntrusted(renderMath);
        assertUntrusted((source) => katex.renderToString(source));
        assert.equal(renderMath(ordinary), baseline);
      });
      break;
    case "options": {
      const inherited = Object.create({ trust: true, output: "html", displayMode: true, macros: { "\\inherited": "x" } });
      assertUntrusted((source) => katex.renderToString(source, inherited));
      assert.equal(katex.renderToString("x", inherited), katex.renderToString("x"));
      assert.throws(() => katex.renderToString(String.raw`\inherited`, inherited), /Undefined control sequence/);
      break;
    }
    case "defaults":
      withPrototype({ default: true }, () => {
        assertUntrusted(renderMath);
        assert.equal(renderMath(ordinary), baseline);
      });
      break;
    case "processor": {
      let calls = 0;
      withPrototype({ processor: () => { calls++; return true; } }, () => {
        assertUntrusted(renderMath);
        assertUntrusted((source) => katex.renderToString(source, { trust: false }));
        assert.equal(renderMath(ordinary), baseline);
        assert.equal(calls, 0, "inherited setting processors must never run");
      });
      break;
    }
    case "namespace":
      withPrototype({ "\\inherited": "POLLUTED" }, () => {
        assert.match(renderMath(String.raw`\inherited`), /katex-error/);
        assert.throws(() => katex.renderToString(String.raw`\inherited`), { name: "ParseError", message: /(?:Undefined control sequence|No function handler).*\\inherited/ });
        // Low-level upstream namespace restoration. Bindars itself refuses
        // macro definitions before rendering; this does not relax that guard.
        const macros = {};
        katex.renderToString(String.raw`{\def\inherited{x}\inherited}`, { macros });
        assert.equal(Object.hasOwn(macros, "\\inherited"), false);
        assert.throws(() => katex.renderToString(String.raw`\inherited`, { macros }), { name: "ParseError", message: /(?:Undefined control sequence|No function handler).*\\inherited/ });
      });
      break;
    case "limits":
      withPrototype({ maxExpand: Infinity, macros: { "\\inherited": "x" }, output: "html", strict: "ignore" }, () => {
        assert.equal(renderMath(ordinary), baseline, "inherited output/strict/macros must not change ordinary math");
        assert.equal(renderMath(String.raw`\inherited`), undefinedMacro);
        assert.match(renderMath("\\empty ".repeat(MATH_MAX_EXPAND + 1) + "x"), /katex-error/);
        assert.throws(() => katex.renderToString("\\empty ".repeat(1001) + "x"), /Too many expansions/);
      });
      break;
    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
  console.log(`PASS ${scenario}`);
}
try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
