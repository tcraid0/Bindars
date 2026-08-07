const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");
const { whitespaceSeparatedAscii } = require("./markdown-complexity-fixtures.cjs");

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

test("workspace indexing purges a fresh v5 cache and rebuilds it under the current policy", async () => {
  await installDom();
  const { flushSync } = require("react-dom");
  const { createRoot } = require("react-dom/client");
  const store = require("../.tmp/workspace-tests/src/lib/store.js");
  const {
    WORKSPACE_INDEX_CACHE_KEY,
    WORKSPACE_INDEX_CACHE_VERSION,
  } = require("../.tmp/workspace-tests/src/lib/workspace-index.js");
  const originalStoreGet = store.storeGet;
  const originalStoreSet = store.storeSet;
  const writes = [];
  const legacyCache = {
    version: 5,
    rootPath: "/workspace",
    indexedAt: Date.now(),
    files: [
      { path: "/workspace/stale.md", relPath: "stale.md", name: "stale.md", mtimeMs: 0, size: 7 },
    ],
    docs: [
      {
        path: "/workspace/stale.md",
        relPath: "stale.md",
        name: "stale.md",
        title: "Stale",
        headings: [],
        bodyText: "stale",
        links: [],
        scenes: [],
      },
    ],
    processedCount: 1,
    readFailedCount: 0,
    complexitySkippedCount: 0,
    listSkippedCount: 0,
    limitHit: false,
  };
  store.storeGet = async (key) => key === "workspace:index:v5" ? legacyCache : null;
  store.storeSet = async (key, value) => {
    writes.push([key, value]);
    return true;
  };

  let listCalls = 0;
  mockIPC((command) => {
    if (command === "list_workspace_markdown_files") {
      listCalls += 1;
      return {
        files: [
          { path: "/workspace/fresh.md", relPath: "fresh.md", name: "fresh.md", mtimeMs: 0, size: 7 },
        ],
        skippedCount: 0,
        limitHit: false,
      };
    }
    if (command === "read_markdown_file") return "# Fresh";
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
      assert.equal(resultRef.current?.docs[0]?.title, "Fresh");
      assert.equal(listCalls, 1);
      assert.ok(writes.some(([key, value]) => key === "workspace:index:v5" && value === null));
      assert.ok(writes.some(
        ([key, value]) => key === WORKSPACE_INDEX_CACHE_KEY
          && value?.version === WORKSPACE_INDEX_CACHE_VERSION,
      ));
    });
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    store.storeGet = originalStoreGet;
    store.storeSet = originalStoreSet;
    clearMocks();
  }
});

test("workspace indexing skips oversized Markdown without reporting a read failure", async () => {
  await installDom();
  const { flushSync } = require("react-dom");
  const { createRoot } = require("react-dom/client");
  const store = require("../.tmp/workspace-tests/src/lib/store.js");
  const originalStoreGet = store.storeGet;
  const originalStoreSet = store.storeSet;
  store.storeGet = async () => null;
  store.storeSet = async () => true;

  const oversizedMarkdown = whitespaceSeparatedAscii(1_048_577);
  assert.equal(oversizedMarkdown.length, 1_048_577);
  mockIPC((command, args = {}) => {
    if (command === "list_workspace_markdown_files") {
      return {
        files: [
          { path: "/workspace/normal.md", relPath: "normal.md", name: "normal.md", mtimeMs: 0, size: 8 },
          { path: "/workspace/oversized.md", relPath: "oversized.md", name: "oversized.md", mtimeMs: 0, size: oversizedMarkdown.length },
        ],
        skippedCount: 0,
        limitHit: false,
      };
    }
    if (command === "read_markdown_file") {
      return args.path.endsWith("oversized.md") ? oversizedMarkdown : "# Normal";
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
