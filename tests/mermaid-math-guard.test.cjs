// Mermaid hands `$$…$$` label math to its bundled KaTeX with no expansion
// limit (SEC-01). The guard refuses the inputs that let Mermaid's own text
// rewriting (entity decoding, HTML sanitizing, `\\` collapse) create or alter
// a math segment, and applies the shared math policy to the segments that
// reach KaTeX verbatim. The fixtures are plain strings checked without a DOM:
// the browser stand-in's sanitizer is not faithful, and predicting its output
// is how two bypasses slipped past the first version. The packaged WebKit app
// remains the authority for the sanitizer path.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const mermaidLoads = [];
const renders = [];
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request !== "mermaid") return originalLoad.call(this, request, ...rest);
  mermaidLoads.push(request);
  return {
    __esModule: true,
    default: {
      initialize() {},
      async render(id, chart) {
        renders.push(chart);
        return { svg: `<svg data-id="${id}"></svg>` };
      },
    },
  };
};

const {
  MermaidBlock,
  UNSUPPORTED_DIAGRAM_MATH_MESSAGE,
  unsupportedDiagramMath,
} = require("../.tmp/workspace-tests/src/components/MermaidBlock.js");
const { MATH_MAX_NODE_CHARS, MATH_MAX_TOTAL_CHARS } = require("../.tmp/workspace-tests/src/lib/document-complexity.js");

const node = (label) => `flowchart LR\n  A["${label}"]`;
const macro = "\\def\\x{a+a}\\x\\x";

// The interrupted reviewer's shape: one macro definition inside diagram math,
// then invocations. At 846 source characters the bundled KaTeX produced
// 52,172 MathML elements (522 KB) in 34 ms; at 5,000 characters it allocated
// 130 MB and ran 196 ms before its own expansion cap threw.
function macroMath(total) {
  const body = "a+".repeat(Math.floor(total / 6));
  const head = `\\def\\x{${body}}`;
  return head + "\\x ".repeat(Math.floor((total - head.length) / 3));
}

test("math that Mermaid's rewriting could create or alter is refused, so only verbatim segments reach KaTeX", () => {
  const rejected = {
    // Reconstructions of the three bypasses the packaged-app reviews reproduced.
    "coded dollar signs become delimiters after the guard ran": node(`<i></i>#36;#36;${macro}#36;#36;`),
    "sanitizing drops a script's contents and joins the text around it": node(`$$\\de<script>x</script>f\\x{a+a}\\x\\x$$`),
    "Markdown escapes in a markdown-string label become delimiters": 'flowchart LR\n  A["`\\$\\$\\def\\x{\\zzzUndefined}\\x\\$\\$`"]',
    "a half-escaped closing pair": node(`$$${macro}\\$\\$`),
    // Every other route to a coded dollar sign.
    "Mermaid dollar code without a tag": node(`#36;#36;${macro}#36;#36;`),
    "named dollar reference": node(`&dollar;&dollar;${macro}&dollar;&dollar;`),
    "decimal dollar reference": node(`&#36;&#36;${macro}&#36;&#36;`),
    "decimal dollar reference without semicolons": node(`&#36&#36${macro}&#36&#36`),
    "hex dollar reference with leading zeros": node(`&#x0024;&#x0024;${macro}&#x0024;&#x0024;`),
    // A dollar sign against something sanitizing may remove.
    "comment between two dollar signs": node(`$<!-- -->$${macro}$<!-- -->$`),
    "tag between two dollar signs": node(`$<i></i>$${macro}$<i></i>$`),
    // Rewritable material inside a verbatim segment.
    "macro split by a tag sanitizing drops": node(`$$\\d<foo>ef</foo>\\x{a}\\x$$`),
    "macro inside an attribute value": node(`$$<b title='${macro}'>b</b>$$`),
    "backslash as a decimal reference": node(`$$&#92;def&#92;x{a}&#92;x$$`),
    "backslash reference without a semicolon": node(`$$&#92def&#92x{a}&#92x$$`),
    "backslash as a Mermaid entity code": node(`$$#92;def#92;x{a}#92;x$$`),
    "end tag inside math": node(`$$a</b>\\def\\x{a}\\x$$`),
    // Verbatim segments the shared policy rejects.
    "reviewer shape": node(`$$${macroMath(846)}$$`),
    "double backslash, which Mermaid collapses": node(`$$\\\\def\\\\x{a+a+a}\\\\x\\\\x$$`),
    "KaTeX internal sequence": `sequenceDiagram\n  A->>B: $$\\tag{x}\\df@tag$$`,
    "one segment over the node budget": node(`$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2 + 1)}$$`),
    "segments over the diagram budget": `flowchart LR\n${["N0", "N1", "N2", "N3", "N4", "N5"].map((id) => `  ${id}["$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2 - 1)}$$"]`).join("\n")}`,
  };
  assert.ok(Math.ceil(MATH_MAX_TOTAL_CHARS / MATH_MAX_NODE_CHARS) < 6, "the budget fixture must exceed the diagram budget");

  for (const [label, chart] of Object.entries(rejected)) {
    assert.equal(unsupportedDiagramMath(chart), UNSUPPORTED_DIAGRAM_MATH_MESSAGE, label);
  }
});

test("supported diagram math and ordinary diagrams pass the guard", () => {
  const accepted = {
    "fraction and root": 'flowchart LR\n  A["$$\\frac{a}{b} + \\sqrt{x^2}$$"] --> B',
    // The guard allows this; Mermaid's own sanitizer then hands KaTeX `a &lt; b` in HTML labels, which fails there regardless.
    "less-than with a space": node("$$a < b$$"),
    "matrix columns and rows": node("$$\\begin{matrix} a & b \\\\ c & d \\end{matrix}$$"),
    "escaped ampersand before one letter": node("$$\\text{R\\&D}$$"),
    "ordinary tag command": "sequenceDiagram\n  A->>B: $$x + y = z \\tag{1}$$",
    "at sign in text": node("$$\\text{write to a@b.example}$$"),
    "literal hash": node("$$\\#5 + \\$5$$"),
    "prices with single dollar signs": 'flowchart LR\n  A["Cost $5"] --> B["Total $12"]',
    "an escaped price": 'flowchart LR\n  A["Cost \\$5"] --> B',
    "an escaped pair around benign text": node("\\$\\$x + y\\$\\$"),
    "arrows containing angle brackets": "flowchart LR\n  A <--> B\n  C <-- \"$$x$$\" --> D",
    "class relations containing angle brackets": "classDiagram\n  A <|-- B\n  B --|> C",
    "no math": "flowchart LR\n  A --> B",
    "a segment exactly at the node budget": node(`$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2)}$$`),
  };

  for (const [label, chart] of Object.entries(accepted)) {
    assert.equal(unsupportedDiagramMath(chart), null, label);
  }
});

test("the documented false positives show the source rather than render", () => {
  const falsePositives = {
    "a price touching a tag": node("<b>$5</b>"),
    "a coded dollar sign used only as text": node("Cost #36;5"),
    "less-than without a space, which Mermaid's HTML labels also mangle": node("$$a<b$$"),
    "unpaired markers in two labels on one line pair up": 'flowchart LR\n  A["$$"] --> B["x \\def y $$"]',
    // Mermaid shows these two literally (no KaTeX call); the detection copy's
    // `\$` collapse pairs them, which is the cost of not parsing label grammar.
    "escaped pair around refused content in a plain label": node(`\\$\\$${macro}\\$\\$`),
    "mixed escaped pair around refused content": node(`$\\$${macro}$\\$`),
  };
  for (const [label, chart] of Object.entries(falsePositives)) {
    assert.equal(unsupportedDiagramMath(chart), UNSUPPORTED_DIAGRAM_MATH_MESSAGE, label);
  }
});

test("the guard is cheap on a diagram at the source limit", () => {
  const segment = `$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2)}$$`;
  const lines = [];
  while (lines.join("\n").length + segment.length + 20 < 50_000) {
    lines.push(`  N${lines.length}["${segment}"]`);
  }
  const chart = `flowchart LR\n${lines.join("\n")}`;
  assert.ok(chart.length > 45_000 && chart.length <= 50_000, `fixture length ${chart.length}`);

  const started = performance.now();
  const verdict = unsupportedDiagramMath(chart);
  const elapsed = performance.now() - started;

  assert.equal(verdict, UNSUPPORTED_DIAGRAM_MATH_MESSAGE, "over the diagram budget");
  assert.ok(elapsed < 1_000, `guard took ${elapsed.toFixed(1)} ms`);
  console.log(`mermaid math guard: ${chart.length} chars checked in ${elapsed.toFixed(1)} ms`);
});

test("the shared policy, not a second list, is what the diagram guard applies", () => {
  const { createMathBudget, MATH_UNSAFE_COMMAND_RE } = require("../.tmp/workspace-tests/src/lib/math-safety.js");
  for (const definition of ["\\def\\a{x}\\a", "\\newcommand{\\a}{x}\\a", "\\let\\a\\alpha", "\\df@tag x"]) {
    assert.ok(MATH_UNSAFE_COMMAND_RE.test(definition), definition);
    assert.equal(createMathBudget().accept(definition), false, definition);
    assert.equal(unsupportedDiagramMath(node(`$$${definition}$$`)), UNSUPPORTED_DIAGRAM_MATH_MESSAGE, definition);
  }
  assert.equal(createMathBudget().accept("\\frac{a}{b}"), true);
});

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

async function renderBlock(chart) {
  await installDom();
  globalThis.Element = window.Element;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MermaidBlock, { chart }));
  });
  return {
    host,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("a refused diagram shows its source and never loads or renders Mermaid; a supported one renders", async () => {
  const refused = node(`$$\\de<script>x</script>f\\x{a+a}\\x\\x$$`);
  const rendered = await renderBlock(refused);
  try {
    await waitFor(() => {
      assert.ok(rendered.host.querySelector(".mermaid-error"));
    });
    assert.equal(rendered.host.querySelector(".mermaid-error-message").textContent, UNSUPPORTED_DIAGRAM_MATH_MESSAGE);
    assert.equal(rendered.host.querySelector(".mermaid-error pre code").textContent, refused, "source preserved");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(renders, [], "Mermaid must not render");
    assert.deepEqual(mermaidLoads, [], "Mermaid must not even load");
  } finally {
    await rendered.cleanup();
  }

  const supported = 'flowchart LR\n  A["$$\\frac{a}{b}$$"] --> B';
  const control = await renderBlock(supported);
  try {
    await waitFor(() => {
      assert.deepEqual(renders, [supported]);
    });
    assert.ok(!control.host.querySelector(".mermaid-error"));
    assert.deepEqual(mermaidLoads, ["mermaid"]);
  } finally {
    await control.cleanup();
  }
});
