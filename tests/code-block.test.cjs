const test = require("node:test");
const assert = require("node:assert/strict");
const { installDom } = require("./_helpers/dom.cjs");
const { renderComponent } = require("./_helpers/component-view.cjs");
const { CodeBlock } = require("../.tmp/workspace-tests/src/components/CodeBlock.js");

test("code controls are excluded from document text selection", async () => {
  await installDom();
  const view = renderComponent(CodeBlock, {
    language: "js", rawText: "const answer = 42;", children: "const answer = 42;",
  });
  try {
    const button = view.host.querySelector('[aria-label="Copy code to clipboard"]');
    assert.ok(button.classList.contains("select-none"));
    assert.ok(view.host.querySelector(".code-lang-chip").classList.contains("select-none"));
    assert.equal(view.host.querySelector("code").textContent, "const answer = 42;");
  } finally { view.cleanup(); }
});
