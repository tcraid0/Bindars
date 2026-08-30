const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

test("session persistence reads the latest heading from a getter without parent state", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  window.localStorage.clear();
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  const writes = [];
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        return [null, false];
      case "plugin:store|set":
        writes.push(args);
        return null;
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  });

  const { useSessionRestore } = require("../.tmp/workspace-tests/src/hooks/useSessionRestore.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let activeHeadingId = "first";
  let notifyPositionChanged = null;
  let parentRenderCount = 0;

  function Probe({ filePath }) {
    parentRenderCount += 1;
    const session = useSessionRestore({
      filePath,
      getActiveHeadingId: () => activeHeadingId,
      onRestore: () => {},
      waitForInitialNativeOpen: async () => "none",
    });
    notifyPositionChanged = session.notifyPositionChanged;
    return null;
  }

  try {
    flushSync(() => root.render(React.createElement(Probe, { filePath: "/tmp/a.md" })));
    await act(async () => Promise.resolve());
    const rendersAfterRestore = parentRenderCount;

    activeHeadingId = "second";
    notifyPositionChanged();
    activeHeadingId = "third";
    notifyPositionChanged();

    context.mock.timers.tick(1_999);
    await act(async () => Promise.resolve());
    assert.equal(writes.length, 0);

    context.mock.timers.tick(1);
    await act(async () => Promise.resolve());
    assert.equal(
      parentRenderCount,
      rendersAfterRestore,
      "heading notifications must not require parent renders",
    );
    assert.deepEqual(writes.at(-1).value, {
      filePath: "/tmp/a.md",
      headingId: "third",
    });
    assert.deepEqual(JSON.parse(window.localStorage.getItem("bindars-session")), {
      filePath: "/tmp/a.md",
      headingId: "third",
    });

    activeHeadingId = "unloaded";
    window.dispatchEvent(new Event("beforeunload"));
    assert.deepEqual(JSON.parse(window.localStorage.getItem("bindars-session")), {
      filePath: "/tmp/a.md",
      headingId: "unloaded",
    });
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    clearMocks();
    globalThis.localStorage = originalLocalStorage;
  }
});

test("stored session restore waits for the initial native source decision", async () => {
  await installDom();
  window.localStorage.clear();
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  const nativeDecision = deferred();
  const restoredSessions = [];
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "session") {
          return [{ filePath: "/tmp/stored.md", headingId: "stored-heading" }, true];
        }
        return [null, false];
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  });

  const { useSessionRestore } = require("../.tmp/workspace-tests/src/hooks/useSessionRestore.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    useSessionRestore({
      filePath: null,
      getActiveHeadingId: () => null,
      onRestore: (session) => restoredSessions.push(session),
      waitForInitialNativeOpen: () => nativeDecision.promise,
    });
    return null;
  }

  try {
    flushSync(() => root.render(React.createElement(Probe)));
    await act(async () => Promise.resolve());
    assert.deepEqual(restoredSessions, []);

    await act(async () => {
      nativeDecision.resolve("none");
      await nativeDecision.promise;
      await Promise.resolve();
    });
    assert.deepEqual(restoredSessions, [{
      filePath: "/tmp/stored.md",
      headingId: "stored-heading",
    }]);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    clearMocks();
    globalThis.localStorage = originalLocalStorage;
  }
});
