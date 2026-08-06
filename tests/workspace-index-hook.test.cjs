const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

test("workspace cache preparation failure leaves indexing with an actionable error", async () => {
  await installDom();
  const { flushSync } = require("react-dom");
  const { createRoot } = require("react-dom/client");
  const store = require("../.tmp/workspace-tests/src/lib/store.js");
  const originalStoreGet = store.storeGet;
  store.storeGet = async () => {
    throw new Error("workspace cache unavailable");
  };
  const { useWorkspaceIndex } = require(
    "../.tmp/workspace-tests/src/hooks/useWorkspaceIndex.js"
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const resultRef = { current: null };

  function Probe() {
    resultRef.current = useWorkspaceIndex("/tmp/bindars-workspace");
    return null;
  }

  try {
    flushSync(() => root.render(React.createElement(Probe)));

    await waitFor(() => {
      assert.equal(resultRef.current?.state.status, "error");
      assert.equal(resultRef.current?.state.error, "workspace cache unavailable");
    });
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    store.storeGet = originalStoreGet;
  }
});

test("workspace indexing skips complex files without reporting a read failure", async () => {
  await installDom();
  const { flushSync } = require("react-dom");
  const { createRoot } = require("react-dom/client");
  const store = require("../.tmp/workspace-tests/src/lib/store.js");
  const originalStoreGet = store.storeGet;
  const originalStoreSet = store.storeSet;
  store.storeGet = async () => null;
  store.storeSet = async () => true;

  const denseMarkdown = `a${"#".repeat(30_000)}`;
  mockIPC((command, args = {}) => {
    if (command === "list_workspace_markdown_files") {
      return {
        files: [
          { path: "/workspace/normal.md", relPath: "normal.md", name: "normal.md", mtimeMs: 0, size: 8 },
          { path: "/workspace/dense.md", relPath: "dense.md", name: "dense.md", mtimeMs: 0, size: denseMarkdown.length },
        ],
        skippedCount: 0,
        limitHit: false,
      };
    }
    if (command === "read_markdown_file") {
      return args.path.endsWith("dense.md") ? denseMarkdown : "# Normal";
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });

  const { useWorkspaceIndex } = require(
    "../.tmp/workspace-tests/src/hooks/useWorkspaceIndex.js"
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const resultRef = { current: null };

  function Probe() {
    resultRef.current = useWorkspaceIndex("/workspace");
    return null;
  }

  try {
    flushSync(() => root.render(React.createElement(Probe)));

    await waitFor(() => {
      assert.equal(resultRef.current?.state.status, "ready");
      assert.equal(resultRef.current?.state.indexedCount, 1);
      assert.equal(resultRef.current?.state.complexitySkippedCount, 1);
      assert.equal(resultRef.current?.state.readFailedCount, 0);
    });
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    store.storeGet = originalStoreGet;
    store.storeSet = originalStoreSet;
    clearMocks();
  }
});
