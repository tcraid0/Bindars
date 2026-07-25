const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const {
  MermaidBlock,
  removeMermaidTempElements,
  waitForDocumentFontsReady,
} = require("../.tmp/workspace-tests/src/components/MermaidBlock.js");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("waitForDocumentFontsReady waits for document fonts readiness", async () => {
  const deferred = createDeferred();
  const doc = { fonts: { ready: deferred.promise } };
  let finished = false;

  const waitPromise = waitForDocumentFontsReady(doc).then(() => {
    finished = true;
  });

  await Promise.resolve();
  assert.equal(finished, false);

  deferred.resolve();
  await waitPromise;
  assert.equal(finished, true);
});

test("waitForDocumentFontsReady resolves when the document does not expose fonts", async () => {
  await assert.doesNotReject(() => waitForDocumentFontsReady({}));
});

test("waitForDocumentFontsReady ignores font readiness rejection", async () => {
  const doc = { fonts: { ready: Promise.reject(new Error("font load failed")) } };

  await assert.doesNotReject(() => waitForDocumentFontsReady(doc));
});

test("removeMermaidTempElements removes strict and sandbox wrappers only", async () => {
  await installDom();
  const id = "mermaid-test";
  const strictWrapper = document.createElement("div");
  strictWrapper.id = `d${id}`;
  const sandboxWrapper = document.createElement("iframe");
  sandboxWrapper.id = `i${id}`;
  const unrelatedElement = document.createElement("div");
  unrelatedElement.id = id;
  document.body.append(strictWrapper, sandboxWrapper, unrelatedElement);

  removeMermaidTempElements(id);

  assert.ok(!document.getElementById(`d${id}`));
  assert.ok(!document.getElementById(`i${id}`));
  assert.ok(document.getElementById(id) === unrelatedElement);
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

test("invalid Mermaid diagrams render the app error state without leaving body orphans", async () => {
  await installDom();
  globalThis.Element = window.Element;
  globalThis.SVGElement = window.SVGElement;
  globalThis.HTMLDivElement = window.HTMLDivElement;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(MermaidBlock, { chart: "graph TD; A-->" }));
    });

    await waitFor(() => {
      assert.ok(host.querySelector(".mermaid-error"));
    });
    assert.ok(!document.body.querySelector('[id^="dmermaid-"]'));

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      assert.ok(host.querySelector(".mermaid-error"));
    });
    assert.ok(!document.body.querySelector('[id^="dmermaid-"]'));
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});
