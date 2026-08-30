const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { act } = React;
const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
const { findEditorView, replaceEditorDocument } = require("./_helpers/codemirror.cjs");
const { installDom } = require("./_helpers/dom.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");
const {
  SNAPSHOT_INTERVAL_MS,
} = require("../.tmp/workspace-tests/src/hooks/usePersistenceCoordinator.js");

let flushSync;
let createRoot;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

function loadApp() {
  const originalLoad = Module._load;
  Module._load = function loadWithWelcomeFixture(request, parent, isMain) {
    if (request.endsWith("welcome.md?raw")) return "# Welcome fixture";
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../.tmp/workspace-tests/src/App.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

function clickButton(host, text, scope = host) {
  const button = Array.from(scope.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === text);
  assert.ok(button, `expected a ${text} button`);
  flushSync(() => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function dispatchShortcut(key) {
  flushSync(() => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
  });
}

async function renderApp({
  clearError = null,
  deferClear = null,
  deferSnapshot = null,
  storageStats = {
    streamCount: 23,
    snapshotCount: 47,
    totalBytes: 184 * 1024 * 1024,
    skippedCount: 2,
  },
} = {}) {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  document.documentElement.setAttribute("data-theme", "");
  mockWindows("main");
  const clearCalls = [];
  const storageStatsCalls = [];
  const snapshotWrites = [];
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [[], true];
        if (args.key === "hasSeenWelcome") return [true, true];
        return [null, false];
      case "plugin:store|set":
      case "plugin:window|set_title":
        return null;
      case "write_document_snapshot":
        snapshotWrites.push(args);
        if (deferSnapshot) return deferSnapshot.promise;
        return {
          snapshot: {
            id: "00000000000000000001-deadbeefdeadbeef.md",
            createdAtMs: 1,
            size: args.content.length,
          },
          merged: false,
          unchanged: false,
        };
      case "list_snapshot_drafts":
        return { drafts: [], skippedCount: 0 };
      case "get_snapshot_storage_stats":
        storageStatsCalls.push(args);
        return storageStats;
      case "clear_snapshot_history":
        clearCalls.push(args);
        if (deferClear) return deferClear.promise;
        if (clearError) throw clearError;
        return null;
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }), { shouldMockEvents: true });

  const App = loadApp();
  const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  flushSync(() => {
    root.render(React.createElement(ToastProvider, null, React.createElement(App)));
  });
  await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));
  dispatchShortcut("n");
  await waitFor(() => assert.ok(host.querySelector(".cm-editor")));

  return {
    host,
    clearCalls,
    storageStatsCalls,
    snapshotWrites,
    async cleanup() {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      host.remove();
      window.matchMedia = originalMatchMedia;
      clearMocks();
    },
  };
}

async function openClearRecoveryDialog(host) {
  const settingsToggle = host.querySelector('button[aria-label="Toggle reader settings"]');
  assert.ok(settingsToggle, "expected the reader settings toggle");
  flushSync(() => {
    settingsToggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const clearButton = Array.from(host.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === "Clear recovery history…");
  assert.ok(clearButton, "expected the clear recovery history control");
  await waitFor(() => {
    assert.match(host.textContent, /Recovery data: 184 MB across 23 documents\./);
    assert.match(host.textContent, /2 entries couldn’t be inspected/);
  });
  // Guard against regressing the bounded, scrollable panel: without it the
  // Recovery section is clipped and unreachable at the 400px minimum window
  // height, even though happy-dom would still click it happily. happy-dom has
  // no layout engine, so this can only lock in the sizing *contract* — real
  // visibility is proven by the WebKit verification pass, where an absolute
  // panel inside the `.relative` body double-counted the header and pushed the
  // bottom off-screen. It must be viewport-fixed and capped by dvh, not vh.
  const panel = clearButton.closest(".overflow-y-auto");
  assert.ok(panel, "the settings panel must scroll so Recovery stays reachable");
  assert.ok(panel.classList.contains("fixed"), "the panel must be viewport-fixed, not absolute");
  const panelStyle = panel.getAttribute("style") ?? "";
  assert.match(panelStyle, /max-height/);
  assert.match(panelStyle, /dvh/, "panel height must use dvh for a WebKit-accurate viewport");
  assert.doesNotMatch(panelStyle, /\b100vh\b/, "panel must not fall back to the inflated 100vh");
  assert.doesNotMatch(
    panelStyle,
    /\banimation\s*:/,
    "reader settings must open immediately instead of feeling delayed",
  );
  clickButton(host, "Clear recovery history…");
  const dialog = await waitFor(() => {
    const found = host.querySelector('[role="dialog"]');
    assert.ok(found, "expected the clear-recovery confirmation dialog");
    assert.match(found.textContent, /permanently deletes/);
    assert.match(found.textContent, /original files are not touched/);
    return found;
  });
  // A destructive dialog must start on the safe choice, so Enter cancels.
  await waitFor(() => {
    const active = document.activeElement;
    assert.ok(active, "expected a focused element inside the dialog");
    assert.equal(active.textContent.trim(), "Cancel");
  });
  return dialog;
}

test("Cancel closes the confirmation and leaves recovery history untouched", async () => {
  const rendered = await renderApp();

  try {
    const dialog = await openClearRecoveryDialog(rendered.host);
    clickButton(rendered.host, "Cancel", dialog);

    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
    assert.equal(rendered.clearCalls.length, 0);
    assert.doesNotMatch(rendered.host.textContent, /Recovery history cleared/);
  } finally {
    await rendered.cleanup();
  }
});

test("confirming deletes recovery history once and announces success", async () => {
  const rendered = await renderApp();

  try {
    const dialog = await openClearRecoveryDialog(rendered.host);
    clickButton(rendered.host, "Delete history", dialog);

    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
    await waitFor(() => assert.match(rendered.host.textContent, /Recovery history cleared/));
    assert.equal(rendered.clearCalls.length, 1);
    await waitFor(() => assert.equal(
      rendered.storageStatsCalls.length,
      2,
      "storage usage must refresh after clearing",
    ));
  } finally {
    await rendered.cleanup();
  }
});

test("success is announced only after the backend deletion completes", async () => {
  const deferClear = deferred();
  const rendered = await renderApp({ deferClear });

  try {
    const dialog = await openClearRecoveryDialog(rendered.host);
    clickButton(rendered.host, "Delete history", dialog);

    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
    await waitFor(() => assert.equal(rendered.clearCalls.length, 1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.doesNotMatch(
      rendered.host.textContent,
      /Recovery history cleared/,
      "success must not be claimed while the deletion is still pending",
    );

    await act(async () => {
      deferClear.resolve(null);
      await Promise.resolve();
    });
    await waitFor(() => assert.match(rendered.host.textContent, /Recovery history cleared/));
  } finally {
    await rendered.cleanup();
  }
});

test("successful deletion is announced without waiting for a later snapshot write", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const deferClear = deferred();
  const deferSnapshot = deferred();
  const rendered = await renderApp({ deferClear, deferSnapshot });

  try {
    const dialog = await openClearRecoveryDialog(rendered.host);
    clickButton(rendered.host, "Delete history", dialog);
    await waitFor(() => assert.equal(rendered.clearCalls.length, 1));

    flushSync(() => {
      replaceEditorDocument(findEditorView(rendered.host), "words written while clearing");
    });
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      deferClear.resolve(null);
      await Promise.resolve();
    });
    await waitFor(() => assert.equal(rendered.snapshotWrites.length, 1));
    assert.match(rendered.host.textContent, /Recovery history cleared/);
  } finally {
    deferSnapshot.resolve({
      snapshot: {
        id: "00000000000000000002-deadbeefdeadbeef.md",
        createdAtMs: 2,
        size: 28,
      },
      merged: false,
      unchanged: false,
    });
    await rendered.cleanup();
  }
});

test("a failed clear reports the error and never claims success", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  const rendered = await renderApp({ clearError: new Error("history locked") });

  try {
    console.warn = (...args) => { warnings.push(args); };
    const dialog = await openClearRecoveryDialog(rendered.host);
    clickButton(rendered.host, "Delete history", dialog);

    await waitFor(() => assert.match(
      rendered.host.textContent,
      /Couldn't clear recovery history\. Some snapshots may remain\./,
    ));
    assert.doesNotMatch(rendered.host.textContent, /Recovery history cleared/);
    assert.equal(rendered.clearCalls.length, 1);
    assert.ok(
      warnings.some((args) => String(args[0]).includes("Failed to clear recovery history")),
      "the failure should be logged for diagnostics",
    );
  } finally {
    console.warn = originalWarn;
    await rendered.cleanup();
  }
});
