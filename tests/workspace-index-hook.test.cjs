const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
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
