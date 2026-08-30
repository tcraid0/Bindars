const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act, StrictMode } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { installDom } = require("./_helpers/dom.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

test("useNativeOpen survives StrictMode replay and consumes the initial path once", async () => {
  await installDom();
  const nativeOpen = createNativeOpenIpc("/tmp/strict launch.md");
  mockIPC(nativeOpen.wrap((command) => {
    throw new Error(`Unexpected IPC command: ${command}`);
  }), { shouldMockEvents: true });
  const { useNativeOpen } = require("../.tmp/workspace-tests/src/hooks/useNativeOpen.js");
  const opened = [];
  let initialSelection = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    const native = useNativeOpen({ onOpenPath: (path) => opened.push(path) });
    React.useEffect(() => {
      void native.waitForInitialNativeOpen().then((selection) => {
        initialSelection = selection;
      });
    }, [native.waitForInitialNativeOpen]);
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(StrictMode, null, React.createElement(Probe)));
      await Promise.resolve();
    });
    await waitFor(() => assert.equal(initialSelection, "native"));
    assert.deepEqual(opened, ["/tmp/strict launch.md"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});

test("a wake received during an in-flight drain causes another atomic take", async () => {
  await installDom();
  const firstTake = deferred();
  let takeCount = 0;
  mockIPC((command) => {
    if (command !== "take_pending_open_path") {
      throw new Error(`Unexpected IPC command: ${command}`);
    }
    takeCount += 1;
    if (takeCount === 1) return firstTake.promise;
    if (takeCount === 2) return "/tmp/during-drain.md";
    return null;
  }, { shouldMockEvents: true });
  const { useNativeOpen } = require("../.tmp/workspace-tests/src/hooks/useNativeOpen.js");
  const opened = [];
  let waitForInitialNativeOpen = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    const native = useNativeOpen({ onOpenPath: (path) => opened.push(path) });
    waitForInitialNativeOpen = native.waitForInitialNativeOpen;
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await waitFor(() => assert.equal(takeCount, 1));
    await act(async () => {
      await emit("bindars://native-open-available");
      firstTake.resolve(null);
      await firstTake.promise;
    });
    await waitFor(() => assert.deepEqual(opened, ["/tmp/during-drain.md"]));
    assert.equal(await waitForInitialNativeOpen(), "native");
    assert.ok(takeCount >= 2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});

test("redundant wakes do not redeliver, but the same path can be reopened later", async () => {
  await installDom();
  const nativeOpen = createNativeOpenIpc("/tmp/reopen.md");
  mockIPC(nativeOpen.wrap((command) => {
    throw new Error(`Unexpected IPC command: ${command}`);
  }), { shouldMockEvents: true });
  const { useNativeOpen } = require("../.tmp/workspace-tests/src/hooks/useNativeOpen.js");
  const opened = [];
  let waitForInitialNativeOpen = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    const native = useNativeOpen({ onOpenPath: (path) => opened.push(path) });
    waitForInitialNativeOpen = native.waitForInitialNativeOpen;
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await waitForInitialNativeOpen(), "native");
    assert.deepEqual(opened, ["/tmp/reopen.md"]);

    await act(async () => {
      await emit("bindars://native-open-available");
    });
    assert.deepEqual(opened, ["/tmp/reopen.md"]);

    nativeOpen.setPendingPath("/tmp/reopen.md");
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.deepEqual(opened, ["/tmp/reopen.md", "/tmp/reopen.md"]));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});

test("a pending atomic take is ignored after unmount", async () => {
  await installDom();
  const pendingTake = deferred();
  let takeCount = 0;
  mockIPC((command) => {
    if (command !== "take_pending_open_path") {
      throw new Error(`Unexpected IPC command: ${command}`);
    }
    takeCount += 1;
    return pendingTake.promise;
  }, { shouldMockEvents: true });
  const { useNativeOpen } = require("../.tmp/workspace-tests/src/hooks/useNativeOpen.js");
  const opened = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    useNativeOpen({ onOpenPath: (path) => opened.push(path) });
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await waitFor(() => assert.equal(takeCount, 1));
    await act(async () => root.unmount());
    await act(async () => {
      pendingTake.resolve("/tmp/too-late.md");
      await pendingTake.promise;
    });
    assert.deepEqual(opened, []);
  } finally {
    host.remove();
    clearMocks();
  }
});

test("an initial drain failure is reported and resolves startup selection as none", async () => {
  await installDom();
  mockIPC((command) => {
    if (command === "take_pending_open_path") {
      throw new Error("native intake unavailable");
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  }, { shouldMockEvents: true });
  const { useNativeOpen } = require("../.tmp/workspace-tests/src/hooks/useNativeOpen.js");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let waitForInitialNativeOpen = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    const native = useNativeOpen({ onOpenPath() {} });
    waitForInitialNativeOpen = native.waitForInitialNativeOpen;
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await waitForInitialNativeOpen(), "none");
    assert.ok(warnings.some((entry) => String(entry[0]).includes("Failed to drain")));
  } finally {
    console.warn = originalWarn;
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});

test("a dispatch callback failure is contained and later native opens still drain", async () => {
  await installDom();
  const nativeOpen = createNativeOpenIpc("/tmp/throw-once.md");
  mockIPC(nativeOpen.wrap((command) => {
    throw new Error(`Unexpected IPC command: ${command}`);
  }), { shouldMockEvents: true });
  const { useNativeOpen } = require("../.tmp/workspace-tests/src/hooks/useNativeOpen.js");
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  const opened = [];
  let dispatchCount = 0;
  let waitForInitialNativeOpen = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    const native = useNativeOpen({
      onOpenPath(path) {
        dispatchCount += 1;
        if (dispatchCount === 1) throw new Error("dispatch failed");
        opened.push(path);
      },
    });
    waitForInitialNativeOpen = native.waitForInitialNativeOpen;
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await waitForInitialNativeOpen(), "native");
    assert.ok(errors.some((entry) => String(entry[0]).includes("Failed to dispatch")));

    nativeOpen.setPendingPath("/tmp/after-dispatch-error.md");
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.deepEqual(opened, ["/tmp/after-dispatch-error.md"]));
  } finally {
    console.error = originalError;
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});
