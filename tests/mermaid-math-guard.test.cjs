// Mermaid hands `$$…$$` label math to KaTeX with no expansion limit of its own
// (SEC-01). These tests prove the shared math policy rejects such math before
// Mermaid is loaded or asked to render, with controls for supported diagram
// math. The Mermaid module is faked for the whole file so a render call is
// observable; the real-Mermaid error path stays in mermaid-block.test.cjs.
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

test.before(async () => {
  await installDom();
  globalThis.Element = window.Element;
  globalThis.DOMParser = window.DOMParser;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
});

// The interrupted reviewer's shape: one macro definition inside diagram math,
// then invocations. At 846 source characters the bundled KaTeX produced
// 52,172 MathML elements (522 KB) in 34 ms; at 5,000 characters it allocated
// 130 MB and ran 196 ms before its own expansion cap threw.
function macroMath(total) {
  const body = "a+".repeat(Math.floor(total / 6));
  const head = `\\def\\x{${body}}`;
  return head + "\\x ".repeat(Math.floor((total - head.length) / 3));
}

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

test("macro math inside a diagram label is rejected before Mermaid is loaded or rendered", async () => {
  const fixtures = {
    "reviewer shape": `flowchart LR\n  A["$$${macroMath(846)}$$"]`,
    "double backslash, which Mermaid collapses": 'flowchart LR\n  A["$$\\\\def\\\\x{a+a+a}\\\\x\\\\x$$"]',
    "entity-encoded backslash beside a tag, which the sanitizer decodes": 'flowchart LR\n  A["$$<i></i>&#92;def&#92;x{a}&#92;x$$"]',
    "Mermaid entity code beside a tag": 'flowchart LR\n  A["$$<i></i>#92;def#92;x{a}#92;x$$"]',
    "macro split by a dropped tag": 'flowchart LR\n  A["$$\\d<foo>ef</foo>\\x{a}\\x$$"]',
    "macro inside an attribute value": 'flowchart LR\n  A["$$<b title=\'\\def\\x{a}\\x\'>b</b>$$"]',
    "KaTeX internal sequence": 'sequenceDiagram\n  A->>B: $$\\tag{x}\\df@tag$$',
    "one segment over the node budget": `flowchart LR\n  A["$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2 + 1)}$$"]`,
    "segments over the diagram budget": `flowchart LR\n${"ab".repeat(3).split("").map((_, i) => `  N${i}["$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2 - 1)}$$"]`).join("\n")}`,
  };
  const budgetedSegments = Math.ceil(MATH_MAX_TOTAL_CHARS / MATH_MAX_NODE_CHARS);
  assert.ok(budgetedSegments < 6, "fixture must hold more budgeted segments than the diagram budget allows");

  for (const [label, chart] of Object.entries(fixtures)) {
    assert.equal(unsupportedDiagramMath(chart), UNSUPPORTED_DIAGRAM_MATH_MESSAGE, label);

    renders.length = 0;
    const rendered = await renderBlock(chart);
    try {
      await waitFor(() => {
        assert.ok(rendered.host.querySelector(".mermaid-error"), label);
      });
      assert.equal(rendered.host.querySelector(".mermaid-error-message").textContent, UNSUPPORTED_DIAGRAM_MATH_MESSAGE, label);
      assert.equal(rendered.host.querySelector(".mermaid-error pre code").textContent, chart, `${label}: source preserved`);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.deepEqual(renders, [], `${label}: Mermaid must not render`);
      assert.deepEqual(mermaidLoads, [], `${label}: Mermaid must not even load`);
    } finally {
      await rendered.cleanup();
    }
  }
});

test("supported diagram math and plain diagrams still reach Mermaid's render", async () => {
  const controls = {
    "flowchart fraction": 'flowchart LR\n  A["$$\\frac{a}{b} + \\sqrt{x^2}$$"] --> B',
    "sequence message with ordinary tag": "sequenceDiagram\n  A->>B: $$x + y = z \\tag{1}$$",
    "less-than and matrix columns": 'flowchart LR\n  A["$$a < b, \\begin{matrix} a & b \\end{matrix}$$"]',
    "entity-encoded backslash without a tag stays literal for KaTeX, so it is harmless": 'flowchart LR\n  A["$$&#92;frac{a}{b}$$"]',
    "no math": "flowchart LR\n  A --> B",
    "a segment exactly at the node budget": `flowchart LR\n  A["$$${"a+".repeat(MATH_MAX_NODE_CHARS / 2)}$$"]`,
  };

  for (const [label, chart] of Object.entries(controls)) {
    assert.equal(unsupportedDiagramMath(chart), null, label);

    renders.length = 0;
    const rendered = await renderBlock(chart);
    try {
      await waitFor(() => {
        assert.deepEqual(renders, [chart], label);
      });
      assert.ok(!rendered.host.querySelector(".mermaid-error"), label);
    } finally {
      await rendered.cleanup();
    }
  }
  assert.deepEqual(mermaidLoads, ["mermaid"]);
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
    assert.equal(unsupportedDiagramMath(`flowchart LR\n  A["$$${definition}$$"]`), UNSUPPORTED_DIAGRAM_MATH_MESSAGE, definition);
  }
  // A view KaTeX would see is checked even when the source itself looks safe.
  assert.equal(createMathBudget().accept("&#92;def", ["\\def"]), false);
  assert.equal(createMathBudget().accept("\\frac{a}{b}", ["\\frac{a}{b}", "<b>\\frac{a}{b}</b>"]), true);
});
