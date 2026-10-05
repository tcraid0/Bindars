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
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "load_annotations":
        return null;
      case "save_annotations":
        return null;
      case "get_setting":
        return null;
      case "set_setting":
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
    const savedAt = writes.at(-1).value.savedAt;
    assert.ok(Number.isSafeInteger(savedAt) && savedAt > 0);
    assert.deepEqual(writes.at(-1).value, {
      filePath: "/tmp/a.md",
      headingId: "third",
      savedAt,
    });
    assert.deepEqual(JSON.parse(window.localStorage.getItem("bindars-session")), {
      filePath: "/tmp/a.md",
      headingId: "third",
      savedAt,
    });

    activeHeadingId = "unloaded";
    window.dispatchEvent(new Event("beforeunload"));
    const unloaded = JSON.parse(window.localStorage.getItem("bindars-session"));
    assert.ok(unloaded.savedAt > savedAt);
    assert.deepEqual(unloaded, {
      filePath: "/tmp/a.md",
      headingId: "unloaded",
      savedAt: unloaded.savedAt,
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
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "load_annotations":
        return null;
      case "save_annotations":
        return null;
      case "get_setting":
        if (args.key === "session") {
          return { filePath: "/tmp/stored.md", headingId: "stored-heading" };
        }
        return null;
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


for (const [name, native, local, expected] of [
  ["invalid native path permits local fallback", { filePath: 42 }, { filePath: "/tmp/local.md", headingId: "local" }, { filePath: "/tmp/local.md", headingId: "local" }],
  ["object heading is normalized", { filePath: "/tmp/native.md", headingId: { toString: null } }, null, { filePath: "/tmp/native.md", headingId: null }],
  ["valid native keeps precedence", { filePath: "/tmp/native.md", headingId: "native" }, { filePath: "/tmp/local.md" }, { filePath: "/tmp/native.md", headingId: "native" }],
  ["newer local position wins", { filePath: "/tmp/a.md", headingId: "old", savedAt: 100 }, { filePath: "/tmp/a.md", headingId: "new", savedAt: 101 }, { filePath: "/tmp/a.md", headingId: "new" }],
  ["newer local file wins over legacy native", { filePath: "/tmp/old.md" }, { filePath: "/tmp/new.md", headingId: "new", savedAt: 101 }, { filePath: "/tmp/new.md", headingId: "new" }],
  ["newer native wins", { filePath: "/tmp/a.md", headingId: "native", savedAt: 102 }, { filePath: "/tmp/a.md", headingId: "local", savedAt: 101 }, { filePath: "/tmp/a.md", headingId: "native" }],
  ["timestamp ties keep native precedence", { filePath: "/tmp/a.md", headingId: "native", savedAt: 101 }, { filePath: "/tmp/a.md", headingId: "local", savedAt: 101 }, { filePath: "/tmp/a.md", headingId: "native" }],
  ["invalid timestamp cannot outrank native", { filePath: "/tmp/a.md", headingId: "native", savedAt: 100 }, { filePath: "/tmp/a.md", headingId: "local", savedAt: "999" }, { filePath: "/tmp/a.md", headingId: "native" }],
  ["blank paths are ignored", { filePath: "   " }, { filePath: "" }, null],
  ["NUL paths are ignored", { filePath: "/tmp/a\0.md" }, null, null],
  ["array and scalar records are ignored", [], 42, null],
  ["invalid local heading is normalized", null, { filePath: "/tmp/local.md", headingId: false }, { filePath: "/tmp/local.md", headingId: null }],
]) {
  test(`session decoder: ${name}`, async () => {
    await installDom();
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = window.localStorage;
    window.localStorage.clear();
    if (local !== null) window.localStorage.setItem("bindars-session", JSON.stringify(local));
    const store = require("../.tmp/workspace-tests/src/lib/store.js");
    const originalGet = store.storeGet;
    store.storeGet = async () => native;
    const { useSessionRestore } = require("../.tmp/workspace-tests/src/hooks/useSessionRestore.js");
    const restored = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    function Probe() {
      const state = useSessionRestore({ filePath: null, getActiveHeadingId: () => null,
        waitForInitialNativeOpen: async () => "none", onRestore: value => restored.push(value) });
      return String(state.restored);
    }
    try {
      await act(async () => root.render(React.createElement(Probe)));
      assert.equal(host.textContent, "true");
      assert.deepEqual(restored, expected ? [expected] : []);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      store.storeGet = originalGet;
      globalThis.localStorage = originalLocalStorage;
    }
  });
}

async function renderSessionProbe(context, { native = null, write = async () => true, now = Date.now() } = {}) {
  await installDom();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  window.localStorage.clear();
  const store = require("../.tmp/workspace-tests/src/lib/store.js");
  const writes = [];
  context.mock.method(store, "storeGet", async () => native);
  context.mock.method(store, "storeSet", async (key, session) => {
    assert.equal(key, "session");
    writes.push(session);
    const saved = await write(session);
    if (saved) native = session;
    return saved;
  });
  const { useSessionRestore } = require("../.tmp/workspace-tests/src/hooks/useSessionRestore.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root = createRoot(host);
  let api;
  let heading = "old";
  const restored = [];
  function Probe({ filePath }) {
    api = useSessionRestore({ filePath, getActiveHeadingId: () => heading,
      waitForInitialNativeOpen: async () => "none", onRestore: value => restored.push(value) });
    return null;
  }
  await act(async () => root.render(React.createElement(Probe, { filePath: "/tmp/a.md" })));
  return {
    api: () => api,
    writes,
    restored,
    native: () => native,
    setHeading(value) { heading = value; api.notifyPositionChanged(); },
    async relaunch() {
      await act(async () => root.unmount());
      restored.length = 0;
      root = createRoot(host);
      await act(async () => root.render(React.createElement(Probe, { filePath: null })));
    },
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      globalThis.localStorage = originalLocalStorage;
      context.mock.timers.reset();
    },
  };
}

test("exit flush saves the latest heading at 1999ms and the next launch restores it", async context => {
  const saved = deferred();
  const view = await renderSessionProbe(context, {
    native: { filePath: "/tmp/a.md", headingId: "old" }, write: () => saved.promise,
  });
  try {
    view.setHeading("latest");
    await act(async () => context.mock.timers.tick(1999));
    assert.equal(view.writes.length, 0);
    let finished = false;
    const flush = view.api().flushCurrentSession().then(() => { finished = true; });
    await act(async () => Promise.resolve());
    assert.equal(view.writes[0].headingId, "latest");
    assert.equal(finished, false, "exit must await native persistence");
    await act(async () => { saved.resolve(true); await flush; });
    await act(async () => context.mock.timers.tick(2000));
    assert.equal(view.writes.length, 1, "flushing cancels the old debounce");
    await view.relaunch();
    assert.deepEqual(view.restored, [{ filePath: "/tmp/a.md", headingId: "latest" }]);
  } finally {
    saved.resolve(true);
    await view.cleanup();
  }
});

test("exit flush waits for an older in-flight write before saving the newer position", async context => {
  const older = deferred();
  const newer = deferred();
  const view = await renderSessionProbe(context, { write: value => value.headingId === "old" ? older.promise : newer.promise });
  try {
    view.setHeading("old");
    await act(async () => context.mock.timers.tick(2000));
    assert.equal(view.writes.length, 1);
    view.setHeading("latest");
    let finished = false;
    const flush = view.api().flushCurrentSession().then(() => { finished = true; });
    await act(async () => Promise.resolve());
    assert.equal(view.writes.length, 1);
    assert.equal(JSON.parse(window.localStorage.getItem("bindars-session")).headingId, "latest");
    await act(async () => older.resolve(true));
    assert.deepEqual(view.writes.map(value => value.headingId), ["old", "latest"]);
    assert.equal(finished, false);
    await act(async () => { newer.resolve(true); await flush; });
    assert.equal(view.native().headingId, "latest");
  } finally {
    older.resolve(true);
    newer.resolve(true);
    await view.cleanup();
  }
});

for (const exit of ["beforeunload", "failed native flush"]) {
  test(`${exit} restores its newer local position over a valid native record`, async context => {
    const view = await renderSessionProbe(context, {
      native: { filePath: "/tmp/a.md", headingId: "old", savedAt: 100 }, write: async () => false, now: 100,
    });
    try {
      view.setHeading("latest");
      if (exit === "beforeunload") window.dispatchEvent(new Event("beforeunload"));
      else await act(async () => view.api().flushCurrentSession());
      assert.equal(view.native().headingId, "old");
      await view.relaunch();
      assert.deepEqual(view.restored, [{ filePath: "/tmp/a.md", headingId: "latest" }]);
    } finally {
      await view.cleanup();
    }
  });
}

for (const synchronous of [true, false]) {
  test(`session restore handles ${synchronous ? "thrown" : "rejected"} open failures`, async (context) => {
    await installDom();
    const store = require("../.tmp/workspace-tests/src/lib/store.js");
    context.mock.method(store, "storeGet", async () => ({ filePath: "/tmp/missing.md", headingId: null }));
    const warnings = context.mock.method(console, "warn", () => {});
    const { useSessionRestore } = require("../.tmp/workspace-tests/src/hooks/useSessionRestore.js");
    const host = document.createElement("div");
    const root = createRoot(host);
    const failure = new Error("restore failed");
    function Probe() {
      const state = useSessionRestore({ filePath: null, getActiveHeadingId: () => null,
        waitForInitialNativeOpen: async () => "none", onRestore: () => {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        } });
      return String(state.restored);
    }
    try {
      await act(async () => root.render(React.createElement(Probe)));
      assert.equal(host.textContent, "true");
      assert.equal(warnings.mock.calls.length, 1);
      assert.equal(warnings.mock.calls[0].arguments[1], failure);
    } finally {
      await act(async () => root.unmount());
    }
  });
}
