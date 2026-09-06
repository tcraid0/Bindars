const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { act } = React;
const { undo } = require("@codemirror/commands");
const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { installDom } = require("./_helpers/dom.cjs");
const { findEditorView, replaceEditorDocument } = require("./_helpers/codemirror.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");
const { waitForReconciliationWindow } = require("./_helpers/reconciliation.cjs");
const { whitespaceSeparatedAscii } = require("./markdown-complexity-fixtures.cjs");
const {
  markdownFormattingEnabled,
} = require("../.tmp/workspace-tests/src/components/markdown-decorations.js");
const {
  FILE_WATCHER_UNAVAILABLE_EVENT,
} = require("../.tmp/workspace-tests/src/hooks/useFileWatcher.js");
const {
  APP_RESUMED_EVENT,
} = require("../.tmp/workspace-tests/src/hooks/useReconciliationLifecycle.js");

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

function successfulSnapshotWrite(args) {
  return {
    snapshot: {
      id: "00000000000000000001-deadbeefdeadbeef.md",
      createdAtMs: 1,
      size: args.content.length,
    },
    merged: false,
    unchanged: false,
  };
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

async function waitForEditorPublication() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 240));
  });
}

async function requestNativeOpenAfterFailedBoundarySave(rendered, targetPath, words) {
  dispatchShortcut("e");
  await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
  updateEditor(rendered.host, words);
  await waitForEditorPublication();

  const failedBoundarySave = deferred();
  rendered.deferNextWrite(failedBoundarySave);
  rendered.setPendingNativeOpenPath(targetPath);
  await act(async () => {
    await emit("bindars://native-open-available");
  });
  await waitFor(() => assert.ok(failedBoundarySave.args));
  await act(async () => {
    failedBoundarySave.reject(new Error("Boundary save failed"));
    await Promise.resolve();
  });

  return waitFor(() => {
    const dialog = rendered.host.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /Unsaved changes/);
    return dialog;
  });
}

async function requestNativeOpenAndDiscardIfPrompted(rendered, targetPath) {
  rendered.setPendingNativeOpenPath(targetPath);
  await act(async () => {
    await emit("bindars://native-open-available");
  });

  const dialog = await waitFor(() => {
    if (rendered.openedPaths().includes(targetPath)) return null;
    const candidate = rendered.host.querySelector('[role="dialog"]');
    assert.ok(candidate);
    return candidate;
  });
  if (dialog) clickButton(rendered.host, "Discard", dialog);
  await waitFor(() => assert.ok(rendered.openedPaths().includes(targetPath)));
  const fileName = targetPath.split("/").at(-1);
  await waitFor(() => assert.ok(rendered.host.textContent.includes(fileName)));
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

function keyboardEvent(key, options = {}) {
  const { altGraph = false, ...eventOptions } = options;
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...eventOptions,
  });
  const nativeGetModifierState = event.getModifierState.bind(event);
  Object.defineProperty(event, "getModifierState", {
    value(modifier) {
      return modifier === "AltGraph" ? altGraph : nativeGetModifierState(modifier);
    },
  });
  return event;
}

function dispatchWindowKey(key, options = {}) {
  const event = keyboardEvent(key, options);
  flushSync(() => window.dispatchEvent(event));
  return event;
}

function dispatchShortcut(key, options = {}) {
  return dispatchWindowKey(key, { ctrlKey: true, ...options });
}

function dispatchEditorKey(host, key, options = {}) {
  return dispatchElementKey(findEditorView(host).contentDOM, key, options);
}

function dispatchElementKey(target, key, options = {}) {
  const event = keyboardEvent(key, options);
  flushSync(() => target.dispatchEvent(event));
  return event;
}

function clickButton(host, text, scope = host) {
  const button = Array.from(scope.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === text);
  assert.ok(button, `expected a ${text} button`);
  flushSync(() => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function updateEditor(host, value) {
  const view = findEditorView(host);
  flushSync(() => {
    replaceEditorDocument(view, value);
  });
  return view;
}

async function renderEditorApp({
  onRender,
  markdownFormattingStored,
  markdownFormattingRead,
  markdownFormattingWriteError,
  markdownFormattingLocal,
  preserveMarkdownFormattingLocal = false,
  startNew = true,
  snapshotDrafts = [],
  snapshotEntriesByDraft = {},
  snapshotContents = {},
  themeGet,
  themeLocal,
  themeLocalLegacy,
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
  if (typeof markdownFormattingLocal === "boolean") {
    window.localStorage.setItem("bindars-markdown-formatting-enabled", String(markdownFormattingLocal));
  } else if (!preserveMarkdownFormattingLocal) {
    window.localStorage.removeItem("bindars-markdown-formatting-enabled");
  }
  if (typeof themeLocal === "string") {
    window.localStorage.setItem("bindars-theme", themeLocal);
  } else {
    window.localStorage.removeItem("bindars-theme");
  }
  if (typeof themeLocalLegacy === "string") {
    window.localStorage.setItem("markdown-reader-theme", themeLocalLegacy);
  } else {
    window.localStorage.removeItem("markdown-reader-theme");
  }
  mockWindows("main");
  const storeWrites = [];
  const snapshotWrites = [];
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "theme" && themeGet !== undefined) {
          return themeGet;
        }
        if (args.key === "recent-files") return [[], true];
        if (args.key === "hasSeenWelcome") return [true, true];
        if (args.key === "markdown-formatting-enabled" && markdownFormattingRead) {
          return markdownFormattingRead;
        }
        if (args.key === "markdown-formatting-enabled" && typeof markdownFormattingStored === "boolean") {
          return [markdownFormattingStored, true];
        }
        return [null, false];
      case "plugin:store|set":
        storeWrites.push(args);
        if (args.key === "markdown-formatting-enabled" && markdownFormattingWriteError) {
          throw markdownFormattingWriteError;
        }
        return null;
      case "plugin:window|set_title":
        return null;
      case "write_document_snapshot":
        snapshotWrites.push(args);
        return successfulSnapshotWrite(args);
      case "list_snapshot_drafts":
        return { drafts: snapshotDrafts, skippedCount: 0 };
      case "list_document_snapshots":
        return snapshotEntriesByDraft[args.document.id] ?? [];
      case "read_document_snapshot":
        if (!(args.snapshotId in snapshotContents)) {
          throw new Error(`Missing snapshot fixture: ${args.snapshotId}`);
        }
        return snapshotContents[args.snapshotId];
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }), { shouldMockEvents: true });

  const App = loadApp();
  const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  const app = React.createElement(App);
  const renderedApp = onRender
    ? React.createElement(React.Profiler, { id: "App", onRender }, app)
    : app;
  flushSync(() => {
    root.render(React.createElement(ToastProvider, null, renderedApp));
  });
  await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));
  if (startNew) {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));
  }

  return {
    host,
    storeWrites,
    snapshotWrites,
    async cleanup() {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      host.remove();
      window.localStorage.removeItem("bindars-theme");
      window.localStorage.removeItem("markdown-reader-theme");
      window.matchMedia = originalMatchMedia;
      clearMocks();
    },
  };
}

test("App cycles every theme from focused CodeMirror without disturbing editor state", async () => {
  const rendered = await renderEditorApp();

  try {
    const documentText = "# Theme draft\n\nUnicode: café — 你好 👋\n";
    const view = updateEditor(rendered.host, documentText);
    await waitForEditorPublication();
    view.dispatch({ selection: { anchor: 2, head: 24 } });
    view.focus();

    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    const cycles = [
      { attribute: "sepia", options: { ctrlKey: true } },
      { attribute: "dark", options: { metaKey: true } },
      { attribute: "deep-dark", options: { ctrlKey: true } },
      { attribute: "", options: { metaKey: true } },
    ];

    for (const { attribute, options } of cycles) {
      const event = dispatchEditorKey(rendered.host, "t", {
        ...options,
        shiftKey: true,
      });

      assert.equal(event.defaultPrevented, true);
      assert.equal(document.documentElement.getAttribute("data-theme"), attribute);
      assert.ok(findEditorView(rendered.host) === view);
      assert.equal(view.state.sliceDoc(), documentText);
      assert.equal(view.state.selection.main.anchor, 2);
      assert.equal(view.state.selection.main.head, 24);
      assert.ok(document.activeElement === view.contentDOM);
    }

    assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "");
  } finally {
    await rendered.cleanup();
  }
});

test("theme switching preserves pending edits and ignores composing shortcuts", async () => {
  const rendered = await renderEditorApp();

  try {
    const view = findEditorView(rendered.host);
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));

    const cleanThemeChange = dispatchEditorKey(rendered.host, "t", {
      ctrlKey: true,
      shiftKey: true,
    });
    assert.equal(cleanThemeChange.defaultPrevented, true);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    await waitForEditorPublication();
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));

    for (const options of [
      { ctrlKey: true, shiftKey: true, isComposing: true },
      { metaKey: true, shiftKey: true, keyCode: 229 },
    ]) {
      const event = dispatchEditorKey(rendered.host, "t", options);
      assert.equal(event.defaultPrevented, false);
      assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    }

    const pendingDocument = "Pending — 你好 👋\nsecond line";
    updateEditor(rendered.host, pendingDocument);
    view.dispatch({ selection: { anchor: 8, head: 18 } });
    const pendingThemeChange = dispatchEditorKey(rendered.host, "t", {
      ctrlKey: true,
      shiftKey: true,
    });

    assert.equal(pendingThemeChange.defaultPrevented, true);
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.ok(findEditorView(rendered.host) === view);
    assert.equal(view.state.sliceDoc(), pendingDocument);
    assert.equal(view.state.selection.main.anchor, 8);
    assert.equal(view.state.selection.main.head, 18);
    assert.ok(document.activeElement === view.contentDOM);
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));

    await waitForEditorPublication();
    assert.equal(
      rendered.host.querySelectorAll('[aria-label="Unsaved changes"]').length,
      1,
    );
    assert.ok(findEditorView(rendered.host) === view);
    assert.equal(view.state.sliceDoc(), pendingDocument);
    assert.ok(document.activeElement === view.contentDOM);
  } finally {
    await rendered.cleanup();
  }
});

// Every user-facing theme-change route funnels through useTheme's
// setTheme/cycleTheme callbacks: the Header "Switch theme" button, the global
// Ctrl/Cmd+Shift+T shortcut, and the ReaderControls theme swatches (click and
// arrow-key navigation). These tests change the theme through each entry point
// while the stored theme load is still pending and prove the late stored value
// cannot overwrite the newer user choice.

function themeWritesOf(rendered) {
  return rendered.storeWrites
    .filter((write) => write.key === "theme")
    .map((write) => write.value);
}

async function resolveStoredTheme(storedTheme, value) {
  await act(async () => {
    storedTheme.resolve(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForThemeWrites(rendered, values) {
  await waitFor(() => assert.deepEqual(themeWritesOf(rendered), values));
}

// The compiled app reads the bare `localStorage` global, which Node does not
// define; bind it to the test window so theme seeding and assertions are live.
function bindAppLocalStorage() {
  const original = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  return function restoreAppLocalStorage() {
    globalThis.localStorage = original;
  };
}

test("a stored theme applies over a seeded localStorage theme when no user action occurs", async () => {
  const restoreLocalStorage = bindAppLocalStorage();
  const storedTheme = deferred();
  const rendered = await renderEditorApp({
    themeGet: storedTheme.promise,
    themeLocal: "dark",
  });

  try {
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.deepEqual(themeWritesOf(rendered), []);

    await resolveStoredTheme(storedTheme, ["sepia", true]);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    assert.equal(window.localStorage.getItem("bindars-theme"), "sepia");
    await waitForThemeWrites(rendered, ["sepia"]);
  } finally {
    await rendered.cleanup();
    restoreLocalStorage();
  }
});

test("a stored theme arriving after the Ctrl+Shift+T cycle keeps the user's theme", async () => {
  const restoreLocalStorage = bindAppLocalStorage();
  const storedTheme = deferred();
  const rendered = await renderEditorApp({ themeGet: storedTheme.promise });

  try {
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    // Startup must not persist the temporary default before hydration settles.
    assert.deepEqual(themeWritesOf(rendered), []);

    const cycle = dispatchEditorKey(rendered.host, "t", {
      ctrlKey: true,
      shiftKey: true,
    });
    assert.equal(cycle.defaultPrevented, true);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    await waitForThemeWrites(rendered, ["sepia"]);

    await resolveStoredTheme(storedTheme, ["deep-dark", true]);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    assert.equal(window.localStorage.getItem("bindars-theme"), "sepia");
    assert.deepEqual(themeWritesOf(rendered), ["sepia"]);
  } finally {
    await rendered.cleanup();
    restoreLocalStorage();
  }
});

test("a stored theme arriving after the toolbar theme button keeps the user's theme", async () => {
  const restoreLocalStorage = bindAppLocalStorage();
  const storedTheme = deferred();
  const rendered = await renderEditorApp({ themeGet: storedTheme.promise });

  try {
    const button = rendered.host.querySelector('button[aria-label^="Switch theme (current:"]');
    assert.ok(button, "expected the Header theme button");
    flushSync(() => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    await waitForThemeWrites(rendered, ["sepia"]);

    await resolveStoredTheme(storedTheme, ["dark", true]);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    assert.deepEqual(themeWritesOf(rendered), ["sepia"]);
  } finally {
    await rendered.cleanup();
    restoreLocalStorage();
  }
});

test("a stored theme arriving after a settings swatch selection keeps the user's theme", async () => {
  const restoreLocalStorage = bindAppLocalStorage();
  const storedTheme = deferred();
  const rendered = await renderEditorApp({ themeGet: storedTheme.promise });

  try {
    const toggle = rendered.host.querySelector('button[aria-label="Toggle reader settings"]');
    assert.ok(toggle, "expected the reader settings toggle");
    flushSync(() => {
      toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    const swatch = rendered.host.querySelector('button[aria-label="Dark theme"]');
    assert.ok(swatch, "expected the Dark theme swatch");
    flushSync(() => {
      swatch.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    await waitForThemeWrites(rendered, ["dark"]);

    await resolveStoredTheme(storedTheme, ["sepia", true]);
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.deepEqual(themeWritesOf(rendered), ["dark"]);
  } finally {
    await rendered.cleanup();
    restoreLocalStorage();
  }
});

test("a stored theme arriving after settings swatch arrow navigation keeps the user's theme", async () => {
  const restoreLocalStorage = bindAppLocalStorage();
  const storedTheme = deferred();
  const rendered = await renderEditorApp({ themeGet: storedTheme.promise });

  try {
    const toggle = rendered.host.querySelector('button[aria-label="Toggle reader settings"]');
    assert.ok(toggle, "expected the reader settings toggle");
    flushSync(() => {
      toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    const lightSwatch = rendered.host.querySelector('button[aria-label="Light theme"]');
    assert.ok(lightSwatch, "expected the selected Light theme swatch");
    const arrow = new window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => {
      lightSwatch.focus();
      lightSwatch.dispatchEvent(arrow);
    });
    assert.equal(arrow.defaultPrevented, true);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    const sepiaSwatch = rendered.host.querySelector('button[aria-label="Sepia theme"]');
    assert.ok(document.activeElement === sepiaSwatch);
    await waitForThemeWrites(rendered, ["sepia"]);

    await resolveStoredTheme(storedTheme, ["dark", true]);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    assert.deepEqual(themeWritesOf(rendered), ["sepia"]);
  } finally {
    await rendered.cleanup();
    restoreLocalStorage();
  }
});

test("an editor transaction burst causes no React commits until one debounced publication", async () => {
  let commitCount = 0;
  const rendered = await renderEditorApp({
    onRender() { commitCount += 1; },
  });

  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const view = findEditorView(rendered.host);
    const baseline = commitCount;

    for (const character of "burst") {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: character },
      });
    }

    assert.equal(view.state.sliceDoc(), "burst");
    assert.equal(
      commitCount,
      baseline,
      "CodeMirror transactions must not commit the React tree per keystroke",
    );

    await waitForEditorPublication();
    assert.equal(commitCount, baseline + 1);
    assert.equal(
      rendered.host.querySelectorAll('[aria-label="Unsaved changes"]').length,
      1,
    );
  } finally {
    await rendered.cleanup();
  }
});

test("search-panel Escape closes only the panel before closed-panel Escape guards exit", async () => {
  const rendered = await renderEditorApp();

  try {
    const view = updateEditor(rendered.host, "Dirty search words");
    assert.equal(dispatchEditorKey(rendered.host, "f", { ctrlKey: true }).defaultPrevented, true);
    const searchField = rendered.host.querySelector('input[name="search"]');
    assert.ok(searchField);
    searchField.focus();

    const panelEscape = dispatchElementKey(searchField, "Escape");
    assert.equal(panelEscape.defaultPrevented, true);
    assert.ok(!rendered.host.querySelector(".cm-panel"));
    assert.ok(findEditorView(rendered.host) === view);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));

    const exitEscape = dispatchEditorKey(rendered.host, "Escape");
    assert.equal(exitEscape.defaultPrevented, true);
    await waitFor(() => assert.ok(rendered.host.querySelector('[role="dialog"]')));
    assert.ok(findEditorView(rendered.host) === view);
  } finally {
    await rendered.cleanup();
  }
});

test("non-save App shortcuts are suppressed while the CodeMirror search panel owns focus", async () => {
  const rendered = await renderEditorApp();

  try {
    const view = findEditorView(rendered.host);
    const initialTheme = document.documentElement.getAttribute("data-theme");
    dispatchEditorKey(rendered.host, "f", { ctrlKey: true });
    const searchField = rendered.host.querySelector('input[name="search"]');
    assert.ok(searchField);
    searchField.focus();

    for (const [key, options] of [
      ["k", { ctrlKey: true }],
      ["n", { ctrlKey: true }],
      ["o", { ctrlKey: true }],
      ["e", { ctrlKey: true }],
      ["m", { ctrlKey: true, altKey: true }],
      ["t", { ctrlKey: true, shiftKey: true }],
    ]) {
      const event = dispatchElementKey(searchField, key, options);
      assert.equal(event.defaultPrevented, true, `${key} should not reach App or the WebView`);
      assert.ok(findEditorView(rendered.host) === view);
      assert.ok(rendered.host.querySelector(".cm-panel"));
      assert.ok(!rendered.host.querySelector('[role="dialog"]'));
      assert.ok(!rendered.host.querySelector('[role="combobox"]'));
      assert.equal(document.documentElement.getAttribute("data-theme"), initialTheme);
    }
  } finally {
    await rendered.cleanup();
  }
});

test("Markdown formatting shortcut toggles only in the editor and respects panels and IME", async () => {
  const rendered = await renderEditorApp();

  try {
    const view = findEditorView(rendered.host);
    assert.equal(view.state.field(markdownFormattingEnabled), true);

    const toggleOff = dispatchEditorKey(rendered.host, "m", { ctrlKey: true, altKey: true });
    assert.equal(toggleOff.defaultPrevented, true);
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    await waitFor(() => {
      const formattingWrite = rendered.storeWrites
        .findLast((write) => write.key === "markdown-formatting-enabled");
      assert.deepEqual(formattingWrite?.value, false);
    });

    const formattingButton = rendered.host.querySelector('button[aria-label="Toggle markup formatting"]');
    assert.ok(formattingButton);
    assert.equal(formattingButton.getAttribute("aria-pressed"), "false");
    assert.equal(formattingButton.textContent.trim(), "Plain");
    flushSync(() => formattingButton.click());
    assert.equal(view.state.field(markdownFormattingEnabled), true);
    assert.equal(formattingButton.getAttribute("aria-pressed"), "true");

    const metaToggle = dispatchEditorKey(rendered.host, "m", { metaKey: true, altKey: true });
    assert.equal(metaToggle.defaultPrevented, true);
    assert.equal(view.state.field(markdownFormattingEnabled), false);

    const altGraphToggle = dispatchEditorKey(rendered.host, "m", {
      ctrlKey: true,
      altKey: true,
      altGraph: true,
    });
    assert.equal(altGraphToggle.defaultPrevented, false);
    assert.equal(view.state.field(markdownFormattingEnabled), false);

    dispatchEditorKey(rendered.host, "f", { ctrlKey: true });
    const searchField = rendered.host.querySelector('input[name="search"]');
    assert.ok(searchField);
    searchField.focus();
    const panelToggle = dispatchElementKey(searchField, "m", { ctrlKey: true, altKey: true });
    assert.equal(panelToggle.defaultPrevented, true);
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    dispatchElementKey(searchField, "Escape");

    for (const options of [
      { ctrlKey: true, altKey: true, isComposing: true },
      { metaKey: true, altKey: true, keyCode: 229 },
    ]) {
      const imeToggle = dispatchEditorKey(rendered.host, "m", options);
      assert.equal(imeToggle.defaultPrevented, false);
      assert.equal(view.state.field(markdownFormattingEnabled), false);
    }

    const exit = dispatchEditorKey(rendered.host, "e", { ctrlKey: true });
    assert.equal(exit.defaultPrevented, true);
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    const readerToggle = dispatchWindowKey("m", { ctrlKey: true, altKey: true });
    assert.equal(readerToggle.defaultPrevented, false);

    const focus = dispatchWindowKey("f", { ctrlKey: true, shiftKey: true });
    assert.equal(focus.defaultPrevented, true);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const focusView = findEditorView(rendered.host);
    assert.equal(focusView.state.field(markdownFormattingEnabled), false);
    assert.ok(!rendered.host.querySelector("header"));
    const focusFormattingButton = rendered.host.querySelector('button[aria-label="Toggle markup formatting"]');
    assert.ok(focusFormattingButton);
    flushSync(() => focusFormattingButton.click());
    assert.equal(focusView.state.field(markdownFormattingEnabled), true);
  } finally {
    await rendered.cleanup();
  }
});

test("a fresh edit session honors the persisted Markdown formatting preference", async () => {
  const rendered = await renderEditorApp({ markdownFormattingStored: false });

  try {
    await waitFor(() => {
      assert.equal(findEditorView(rendered.host).state.field(markdownFormattingEnabled), false);
    });
  } finally {
    await rendered.cleanup();
  }
});

test("a delayed stored-off preference never paints an enabled editor state", async () => {
  const preferenceRead = deferred();
  const rendered = await renderEditorApp({ markdownFormattingRead: preferenceRead.promise });

  try {
    const view = findEditorView(rendered.host);
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    const formattingButton = rendered.host.querySelector('button[aria-label="Toggle markup formatting"]');
    assert.ok(formattingButton);
    assert.equal(formattingButton.getAttribute("aria-pressed"), "false");

    preferenceRead.resolve([false, true]);
    await waitFor(() => {
      assert.equal(view.state.field(markdownFormattingEnabled), false);
      assert.equal(window.localStorage.getItem("bindars-markdown-formatting-enabled"), "false");
    });
  } finally {
    await rendered.cleanup();
  }
});

test("a valid local preference stays authoritative over a stale Tauri value", async () => {
  const rendered = await renderEditorApp({
    markdownFormattingLocal: false,
    markdownFormattingStored: true,
  });

  try {
    const view = findEditorView(rendered.host);
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    await waitFor(() => {
      const formattingWrites = rendered.storeWrites
        .filter((write) => write.key === "markdown-formatting-enabled");
      assert.deepEqual(formattingWrites.map((write) => write.value), [false]);
    });
  } finally {
    await rendered.cleanup();
  }
});

test("a resolved default is seeded locally for the next synchronous mount", async () => {
  const first = await renderEditorApp();
  try {
    await waitFor(() => {
      assert.equal(window.localStorage.getItem("bindars-markdown-formatting-enabled"), "true");
    });
  } finally {
    await first.cleanup();
  }

  const delayedRead = deferred();
  const second = await renderEditorApp({
    markdownFormattingRead: delayedRead.promise,
    preserveMarkdownFormattingLocal: true,
  });
  try {
    assert.equal(findEditorView(second.host).state.field(markdownFormattingEnabled), true);
    delayedRead.resolve([false, true]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(findEditorView(second.host).state.field(markdownFormattingEnabled), true);
  } finally {
    await second.cleanup();
  }
});

test("a user toggle wins over a stale delayed formatting preference", async () => {
  const preferenceRead = deferred();
  const rendered = await renderEditorApp({ markdownFormattingRead: preferenceRead.promise });

  try {
    const view = findEditorView(rendered.host);
    const toggle = dispatchEditorKey(rendered.host, "m", { ctrlKey: true, altKey: true });
    assert.equal(toggle.defaultPrevented, true);
    assert.equal(view.state.field(markdownFormattingEnabled), false);

    preferenceRead.resolve([true, true]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    assert.equal(window.localStorage.getItem("bindars-markdown-formatting-enabled"), "false");
  } finally {
    await rendered.cleanup();
  }
});

test("rapid formatting toggles persist in order with the last value winning", async () => {
  const rendered = await renderEditorApp();

  try {
    const view = findEditorView(rendered.host);
    for (let index = 0; index < 5; index += 1) {
      dispatchEditorKey(rendered.host, "m", { ctrlKey: true, altKey: true });
    }
    assert.equal(view.state.field(markdownFormattingEnabled), false);

    await waitFor(() => {
      const values = rendered.storeWrites
        .filter((write) => write.key === "markdown-formatting-enabled")
        .map((write) => write.value);
      assert.deepEqual(values, [true, false, true, false, true, false]);
    });
  } finally {
    await rendered.cleanup();
  }
});

test("formatting preference read and write failures keep a usable session fallback", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  let rendered = null;

  try {
    console.warn = (...args) => { warnings.push(args); };
    rendered = await renderEditorApp({
      markdownFormattingRead: Promise.reject(new Error("read failed")),
      markdownFormattingWriteError: new Error("write failed"),
    });
    const view = findEditorView(rendered.host);
    await waitFor(() => assert.equal(view.state.field(markdownFormattingEnabled), true));

    dispatchEditorKey(rendered.host, "m", { ctrlKey: true, altKey: true });
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    assert.equal(window.localStorage.getItem("bindars-markdown-formatting-enabled"), "false");
    await waitFor(() => assert.ok(warnings.length >= 2));
  } finally {
    console.warn = originalWarn;
    if (rendered) await rendered.cleanup();
  }

  const restarted = await renderEditorApp({
    markdownFormattingStored: true,
    preserveMarkdownFormattingLocal: true,
  });
  try {
    assert.equal(findEditorView(restarted.host).state.field(markdownFormattingEnabled), false);
  } finally {
    await restarted.cleanup();
  }
});

test("the empty state restores the latest orphan draft into a dirty unsaved session", async () => {
  const snapshotId = "00000000000000005000-3333333333333333.md";
  const recoveredWords = "Recovered words from before the crash.";
  const rendered = await renderEditorApp({
    startNew: false,
    snapshotDrafts: [{
      id: "draft-recovery",
      name: "Untitled.md",
      latestSnapshotAtMs: 5_000,
      snapshotCount: 2,
    }],
    snapshotEntriesByDraft: {
      "draft-recovery": [{ id: snapshotId, createdAtMs: 5_000, size: recoveredWords.length }],
    },
    snapshotContents: { [snapshotId]: recoveredWords },
  });

  try {
    clickButton(rendered.host, "Restore an unsaved draft…");
    const draftChoice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Untitled\.md/);
      return candidate;
    });
    flushSync(() => draftChoice.click());

    await waitFor(() => {
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), recoveredWords);
      assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    });
    await waitFor(() => assert.ok(rendered.snapshotWrites.length >= 1));
    assert.deepEqual(rendered.snapshotWrites[0].document, {
      kind: "draft",
      id: "draft-recovery",
      name: "Untitled.md",
    });
    assert.equal(rendered.snapshotWrites[0].content, recoveredWords);
  } finally {
    await rendered.cleanup();
  }
});

test("App routes Ctrl+N through guarded New behavior and invalidates welcome publication", async () => {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  mockWindows("main");
  const welcomeRead = deferred();
  const writes = [];
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [[], true];
        if (args.key === "hasSeenWelcome") return welcomeRead.promise;
        return [null, false];
      case "plugin:store|set":
        return null;
      case "plugin:window|set_title":
        return null;
      case "plugin:dialog|save":
        return "/tmp/Saved before New.md";
      case "write_markdown_file_if_unmodified": {
        writes.push(args);
        return {
          conflict: false,
          currentRevision: { mtimeMs: 2, size: args.content.length, contentHash: "saved" },
          canonicalPath: "/tmp/Saved before New.md",
          name: "Saved before New.md",
        };
      }
      case "write_document_snapshot":
        return successfulSnapshotWrite(args);
      case "retire_snapshot_draft":
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

  try {
    flushSync(() => {
      root.render(React.createElement(ToastProvider, null, React.createElement(App)));
    });
    await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));

    assert.equal(dispatchShortcut("n").defaultPrevented, true);
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));
    await act(async () => {
      welcomeRead.resolve([false, true]);
      await Promise.resolve();
    });

    let view = findEditorView(host);
    assert.equal(view.state.sliceDoc(), "");
    assert.ok(document.activeElement === view.contentDOM);
    assert.match(host.textContent, /Untitled\.md/);
    assert.doesNotMatch(host.textContent, /Welcome fixture/);

    assert.equal(dispatchShortcut("e").defaultPrevented, true);
    await waitFor(() => assert.ok(!host.querySelector(".cm-editor")));
    dispatchShortcut("n", { metaKey: true, ctrlKey: false });
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));

    view = updateEditor(host, "Direct save words");
    clickButton(host, "Save");
    await waitFor(() => assert.equal(writes.length, 1));
    assert.equal(findEditorView(host).state.sliceDoc(), "Direct save words");
    assert.ok(findEditorView(host) === view, "direct save should keep the edit session mounted");

    const cleanEditor = findEditorView(host);
    dispatchShortcut("n");
    await waitFor(() => assert.ok(findEditorView(host) !== cleanEditor));

    view = findEditorView(host);
    assert.ok(document.activeElement === view.contentDOM);
    updateEditor(host, "Keep these words");
    await waitForEditorPublication();
    assert.ok(host.querySelector('[aria-label="Unsaved changes"]'));
    dispatchShortcut("n");
    const cancelDialog = await waitFor(() => {
      const dialog = host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      return dialog;
    });
    assert.match(cancelDialog.textContent, /Unsaved changes/);

    dispatchWindowKey("Escape");
    await waitFor(() => assert.ok(!host.querySelector('[role="dialog"]')));
    assert.equal(findEditorView(host).state.sliceDoc(), "Keep these words");
    assert.ok(document.activeElement === findEditorView(host).contentDOM);

    dispatchShortcut("n");
    const discardDialog = await waitFor(() => {
      const dialog = host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      return dialog;
    });
    clickButton(host, "Discard", discardDialog);
    await waitFor(() => assert.equal(findEditorView(host).state.sliceDoc(), ""));
    assert.ok(document.activeElement === findEditorView(host).contentDOM);

    updateEditor(host, "Save these words");
    dispatchShortcut("n");
    const saveDialog = await waitFor(() => {
      const dialog = host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      return dialog;
    });
    clickButton(host, "Save", saveDialog);
    await waitFor(() => assert.equal(findEditorView(host).state.sliceDoc(), ""));

    assert.equal(writes.length, 2);
    assert.equal(writes[0].content, "Direct save words");
    assert.equal(writes[1].content, "Save these words");
    assert.equal(writes[1].expectedRevision, null);
    assert.equal(writes[1].force, true);
    assert.ok(document.activeElement === findEditorView(host).contentDOM);
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    host.remove();
    clearMocks();
  }
});

test("App flushes pending CodeMirror content for exit, open, unload, and close guards", async () => {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  mockWindows("main");
  let saveDialogCount = 0;
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
      case "plugin:dialog|save":
        saveDialogCount += 1;
        return null;
      case "write_document_snapshot":
        return successfulSnapshotWrite(args);
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }), { shouldMockEvents: true });

  const App = loadApp();
  const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    flushSync(() => {
      root.render(React.createElement(ToastProvider, null, React.createElement(App)));
    });
    await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));
    dispatchShortcut("n");
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));

    updateEditor(host, "Pending exit words");
    const beforeUnload = new window.Event("beforeunload", {
      bubbles: false,
      cancelable: true,
    });
    window.dispatchEvent(beforeUnload);
    assert.equal(beforeUnload.defaultPrevented, true);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(host.querySelector('[role="dialog"]')));
    dispatchWindowKey("Escape");
    await waitFor(() => assert.ok(!host.querySelector('[role="dialog"]')));
    assert.equal(findEditorView(host).state.sliceDoc(), "Pending exit words");
    assert.ok(document.activeElement === findEditorView(host).contentDOM);

    const selectionView = findEditorView(host);
    selectionView.dispatch({ selection: { anchor: 0, head: 7 } });
    assert.equal(dispatchEditorKey(host, "Escape").defaultPrevented, true);
    await waitFor(() => assert.ok(host.querySelector('[role="dialog"]')));
    dispatchWindowKey("Escape");
    await waitFor(() => assert.ok(!host.querySelector('[role="dialog"]')));
    assert.ok(findEditorView(host) === selectionView);
    assert.equal(selectionView.state.selection.main.anchor, 0);
    assert.equal(selectionView.state.selection.main.head, 7);
    assert.ok(document.activeElement === selectionView.contentDOM);

    dispatchEditorKey(host, "o", { ctrlKey: true });
    await waitFor(() => assert.ok(host.querySelector('[role="dialog"]')));
    assert.equal(saveDialogCount, 0, "Open must not bypass the dirty guard");
    flushSync(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    await waitFor(() => assert.ok(!host.querySelector('[role="dialog"]')));

    for (const [key, options] of [
      ["n", { ctrlKey: true, isComposing: true }],
      ["s", { ctrlKey: true, isComposing: true }],
      ["e", { ctrlKey: true, isComposing: true }],
      ["o", { ctrlKey: true, isComposing: true }],
      ["Escape", { isComposing: true }],
    ]) {
      const event = dispatchEditorKey(host, key, options);
      assert.equal(event.defaultPrevented, false);
    }
    assert.ok(!host.querySelector('[role="dialog"]'));
    assert.equal(saveDialogCount, 0);
    assert.equal(findEditorView(host).state.sliceDoc(), "Pending exit words");

    await act(async () => {
      await emit("tauri://close-requested");
    });
    await waitFor(() => assert.ok(host.querySelector('[role="dialog"]')));
    assert.equal(findEditorView(host).state.sliceDoc(), "Pending exit words");
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    host.remove();
    clearMocks();
  }
});

test("App save-as preserves typing and adopts the canonical path before the next save", async () => {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  mockWindows("main");
  const dialogs = [];
  const writes = [];
  const recoveryOperations = [];
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
      case "plugin:dialog|save": {
        const operation = deferred();
        dialogs.push(operation);
        return operation.promise;
      }
      case "write_markdown_file_if_unmodified": {
        const operation = deferred();
        writes.push({ args, ...operation });
        return operation.promise;
      }
      case "write_document_snapshot":
        recoveryOperations.push({ kind: "snapshot", ...args });
        return successfulSnapshotWrite(args);
      case "retire_snapshot_draft":
        recoveryOperations.push({ kind: "retire", document: args.document });
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

  try {
    flushSync(() => {
      root.render(React.createElement(ToastProvider, null, React.createElement(App)));
    });
    await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));
    dispatchShortcut("n");
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));
    const view = findEditorView(host);

    updateEditor(host, "Before dialog");
    await waitForEditorPublication();
    const draftSnapshot = await waitFor(() => {
      const operation = recoveryOperations.find((candidate) => (
        candidate.kind === "snapshot" && candidate.document.kind === "draft"
      ));
      assert.ok(operation);
      return operation;
    });
    dispatchShortcut("s");
    await waitFor(() => assert.equal(dialogs.length, 1));
    dispatchShortcut("s");
    assert.equal(dialogs.length, 1, "duplicate save must not open a second dialog");

    updateEditor(host, "While dialog waits");
    await act(async () => {
      dialogs[0].resolve("/tmp/Canonical draft.md");
      await Promise.resolve();
    });
    await waitFor(() => assert.equal(writes.length, 1));
    assert.equal(writes[0].args.content, "While dialog waits");

    updateEditor(host, "While write waits");
    recoveryOperations.length = 0;
    await act(async () => {
      writes[0].resolve({
        conflict: false,
        currentRevision: { mtimeMs: 2, size: 18, contentHash: "saved" },
        canonicalPath: "/tmp/Canonical draft.md",
        name: "Canonical draft.md",
      });
      await Promise.resolve();
    });

    await waitFor(() => assert.match(host.textContent, /Canonical draft\.md/));
    const retirementIndex = await waitFor(() => {
      const index = recoveryOperations.findIndex((operation) => operation.kind === "retire");
      assert.ok(index >= 0);
      return index;
    });
    const adoptedSnapshotIndex = recoveryOperations.findIndex((operation) => (
      operation.kind === "snapshot"
      && operation.document.kind === "file"
      && operation.document.path === "/tmp/Canonical draft.md"
      && operation.content === "While write waits"
    ));
    assert.ok(adoptedSnapshotIndex >= 0);
    assert.ok(adoptedSnapshotIndex < retirementIndex);
    assert.deepEqual(recoveryOperations[retirementIndex].document, draftSnapshot.document);
    assert.ok(findEditorView(host) === view);
    assert.equal(view.state.sliceDoc(), "While write waits");
    assert.ok(document.activeElement === view.contentDOM);

    updateEditor(host, "After canonical path adoption");
    dispatchShortcut("s");
    await waitFor(() => assert.equal(writes.length, 2));
    assert.equal(writes[1].args.path, "/tmp/Canonical draft.md");
    await act(async () => {
      writes[1].resolve({
        conflict: false,
        currentRevision: { mtimeMs: 3, size: writes[1].args.content.length, contentHash: "saved-again" },
        canonicalPath: "/tmp/Canonical draft.md",
        name: "Canonical draft.md",
      });
      await writes[1].promise;
    });
    assert.ok(findEditorView(host) === view);
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    host.remove();
    clearMocks();
  }
});

async function renderContinuityApp({
  requestedPath = "/tmp/continuity.md",
  canonicalPath = requestedPath,
  initialNativePath,
  initialContent = null,
  readySelector = "#second",
  restoreHeadingId,
  storedHighlights = [],
  snapshotEntries = [],
  snapshotContents = {},
  initialOpenOperation = null,
  workspaceFiles = [],
} = {}) {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  window.localStorage.clear();
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mockWindows("main");
  let diskContent = initialContent ?? [
    "# First",
    "",
    "Opening words.",
    "",
    "## Second",
    "",
    "Closing words.",
  ].join("\n");
  let conflictNextWrite = false;
  let deferredOpen = initialOpenOperation;
  let deferredOpenDialog = null;
  let deferredWrite = null;
  let deferredWatch = null;
  let deferredUnwatch = null;
  let watchError = null;
  let deferredSnapshotWrite = null;
  let deferredSnapshotRead = null;
  let fileWriteError = null;
  let openDialogPath = null;
  let saveDialogPath = "/tmp/virtual-continuity.md";
  const operationLog = [];
  const openedPaths = [];
  const snapshotOperationLog = [];
  const snapshotWrites = [];
  const retiredDrafts = [];
  const fileWrites = [];
  let windowCloseCount = 0;
  let windowDestroyCount = 0;
  let documentSnapshotListCount = 0;
  let snapshotWriteError = null;
  let snapshotListError = null;
  let revisionNumber = 1;
  const nativeOpen = createNativeOpenIpc(initialNativePath === undefined
    ? (restoreHeadingId === undefined ? requestedPath : null)
    : initialNativePath);
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [[], true];
        if (args.key === "workspace:root" && workspaceFiles.length) return ["/tmp", true];
        if (args.key === `annotations:${canonicalPath}`) {
          return [{ highlights: storedHighlights, bookmarks: [], version: 2 }, true];
        }
        if (args.key === "session" && restoreHeadingId !== undefined) {
          return [{ filePath: requestedPath, headingId: restoreHeadingId }, true];
        }
        return [null, false];
      case "list_workspace_markdown_files":
        return { files: workspaceFiles, skippedCount: 0, limitHit: false };
      case "read_markdown_file":
        return `# ${workspaceFiles.find((file) => file.path === args.path).name}`;
      case "plugin:store|set":
      case "plugin:window|set_title":
        return null;
      case "plugin:window|close":
        windowCloseCount += 1;
        return null;
      case "plugin:window|destroy":
        // The Tauri API destroys the window when a close request goes
        // unprevented; count it so tests can catch a close-guard escape.
        windowDestroyCount += 1;
        return null;
      case "plugin:dialog|open":
        if (deferredOpenDialog) {
          const operation = deferredOpenDialog;
          deferredOpenDialog = null;
          return operation.promise;
        }
        return openDialogPath;
      case "unwatch_file":
        if (deferredUnwatch) {
          const operation = deferredUnwatch;
          deferredUnwatch = null;
          operationLog.push("unwatch");
          return operation.promise;
        }
        return null;
      case "watch_file":
        operationLog.push("watch");
        if (watchError) {
          const error = watchError;
          watchError = null;
          throw error;
        }
        if (deferredWatch) {
          const operation = deferredWatch;
          deferredWatch = null;
          return operation.promise;
        }
        return null;
      case "open_markdown_file":
        operationLog.push("open");
        openedPaths.push(args.path);
        if (deferredOpen) {
          const operation = deferredOpen;
          deferredOpen = null;
          operation.args = args;
          return operation.promise;
        }
        return {
          canonicalPath: args.path === requestedPath ? canonicalPath : args.path,
          name: (args.path === requestedPath ? canonicalPath : args.path).split("/").at(-1),
          content: diskContent,
          revision: { mtimeMs: revisionNumber, size: diskContent.length, contentHash: `r${revisionNumber}` },
        };
      case "write_markdown_file_if_unmodified":
        fileWrites.push(args);
        if (fileWriteError) {
          const error = fileWriteError;
          fileWriteError = null;
          throw error;
        }
        if (deferredWrite) {
          const operation = deferredWrite;
          deferredWrite = null;
          operation.args = args;
          return operation.promise;
        }
        if (conflictNextWrite) {
          conflictNextWrite = false;
          return {
            conflict: true,
            canonicalPath: args.path,
            name: args.path.split("/").at(-1),
            currentRevision: { mtimeMs: ++revisionNumber, size: diskContent.length, contentHash: `r${revisionNumber}` },
          };
        }
        diskContent = args.content;
        return {
          conflict: false,
          canonicalPath: args.path,
          name: args.path.split("/").at(-1),
          currentRevision: { mtimeMs: ++revisionNumber, size: diskContent.length, contentHash: `r${revisionNumber}` },
        };
      case "plugin:dialog|save":
        return saveDialogPath;
      case "write_document_snapshot": {
        snapshotWrites.push(args);
        const operation = {
          phase: "start",
          content: args.content,
          preservePrevious: args.preservePrevious,
        };
        snapshotOperationLog.push(operation);
        if (snapshotWriteError) {
          const error = snapshotWriteError;
          snapshotWriteError = null;
          snapshotOperationLog.push({ ...operation, phase: "error" });
          throw error;
        }
        const finish = (result) => {
          snapshotOperationLog.push({ ...operation, phase: "finish" });
          return result;
        };
        if (deferredSnapshotWrite) {
          const pending = deferredSnapshotWrite;
          deferredSnapshotWrite = null;
          pending.args = args;
          return pending.promise.then(finish);
        }
        return finish(successfulSnapshotWrite(args));
      }
      case "retire_snapshot_draft":
        retiredDrafts.push(args.document);
        return null;
      case "list_document_snapshots":
        documentSnapshotListCount += 1;
        if (snapshotListError) {
          const error = snapshotListError;
          snapshotListError = null;
          throw error;
        }
        return snapshotEntries;
      case "read_document_snapshot":
        if (deferredSnapshotRead) {
          const operation = deferredSnapshotRead;
          deferredSnapshotRead = null;
          operation.args = args;
          return operation.promise;
        }
        if (!(args.snapshotId in snapshotContents)) {
          throw new Error(`Missing snapshot fixture: ${args.snapshotId}`);
        }
        return snapshotContents[args.snapshotId];
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }), { shouldMockEvents: true });

  const App = loadApp();
  const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const scrolledIds = [];
  let firstEditorLineVisible = false;
  const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  const originalGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    if (this.id) scrolledIds.push(this.id);
  };
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (
      firstEditorLineVisible
      && (this.classList?.contains("cm-editor")
        || this.classList?.contains("cm-scroller")
        || this.classList?.contains("cm-content"))
    ) {
      return {
        x: 0, y: 50, top: 50, bottom: 450, left: 0, right: 800,
        width: 800, height: 400, toJSON() {},
      };
    }
    if (firstEditorLineVisible && this.classList?.contains("cm-line")) {
      const top = 100;
      return {
        x: 0, y: top, top, bottom: top + 20, left: 0, right: 300,
        width: 300, height: 20, toJSON() {},
      };
    }
    const sourceLine = Number.parseInt(this.dataset?.bindarsSourceLine ?? "", 10);
    const main = host.querySelector("main");
    if (Number.isInteger(sourceLine) && main) {
      const top = 50 + sourceLine * 100 - main.scrollTop;
      return {
        x: 0, y: top, top, bottom: top + 30, left: 0, right: 300,
        width: 300, height: 30, toJSON() {},
      };
    }
    return originalGetBoundingClientRect.call(this);
  };

  function positionReaderAtFirst() {
    const main = host.querySelector("main");
    Object.defineProperties(main, {
      scrollTop: { value: 0, writable: true, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 2000, configurable: true },
    });
    main.getBoundingClientRect = () => ({ top: 50, bottom: 450, height: 400, left: 0, right: 800, width: 800, x: 0, y: 50, toJSON() {} });
  }

  flushSync(() => root.render(React.createElement(ToastProvider, null, React.createElement(App))));
  await waitFor(() => assert.ok(host.querySelector(readySelector)));
  positionReaderAtFirst();

  return {
    host,
    scrolledIds,
    positionReaderAtFirst,
    showFirstEditorLine() { firstEditorLineVisible = true; },
    readerScrollTop: () => host.querySelector("main").scrollTop,
    diskContent: () => diskContent,
    conflictNextWrite() { conflictNextWrite = true; },
    deferNextOpen(operation) { deferredOpen = operation; },
    deferNextOpenDialog(operation) { deferredOpenDialog = operation; },
    deferNextWrite(operation) { deferredWrite = operation; },
    deferNextWatch(operation) { deferredWatch = operation; },
    deferNextUnwatch(operation) { deferredUnwatch = operation; },
    failNextWatch(error) { watchError = error; },
    deferNextSnapshotWrite(operation) { deferredSnapshotWrite = operation; },
    deferNextSnapshotRead(operation) { deferredSnapshotRead = operation; },
    setOpenDialogPath(path) { openDialogPath = path; },
    setSaveDialogPath(path) { saveDialogPath = path; },
    failNextFileWrite(error) { fileWriteError = error; },
    setPendingNativeOpenPath(path) { nativeOpen.setPendingPath(path); },
    clearOperationLog() { operationLog.length = 0; },
    operationLog: () => [...operationLog],
    openedPaths: () => [...openedPaths],
    clearOpenedPaths() { openedPaths.length = 0; },
    clearSnapshotOperationLog() { snapshotOperationLog.length = 0; },
    snapshotOperationLog: () => snapshotOperationLog.map((operation) => ({ ...operation })),
    snapshotWrites: () => [...snapshotWrites],
    retiredDrafts: () => [...retiredDrafts],
    fileWrites: () => [...fileWrites],
    windowCloseCount: () => windowCloseCount,
    windowDestroyCount: () => windowDestroyCount,
    documentSnapshotListCount: () => documentSnapshotListCount,
    failNextSnapshotWrite(error) { snapshotWriteError = error; },
    failNextSnapshotList(error) { snapshotListError = error; },
    setDiskContent(content) { diskContent = content; },
    openResult(content = diskContent, revision = revisionNumber) {
      return {
        canonicalPath,
        name: canonicalPath.split("/").at(-1),
        content,
        revision: {
          mtimeMs: revision,
          size: content.length,
          contentHash: `r${revision}`,
        },
      };
    },
    revision: () => revisionNumber,
    async cleanup() {
      window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      globalThis.IntersectionObserver = originalIntersectionObserver;
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      host.remove();
      clearMocks();
    },
  };
}

test("read-only Fountain document offers Save As and preserves its file type", async () => {
  const rendered = await renderContinuityApp({
    requestedPath: "/tmp/continuity.fountain",
    initialContent: "INT. ORIGINAL ROOM - DAY\n\nALICE\nOriginal words.",
    readySelector: ".fountain-scene-heading",
  });

  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const editedContent = "INT. WRITABLE ROOM - DAY\n\nALICE\nEdited read-only words.";
    updateEditor(rendered.host, editedContent);
    await waitForEditorPublication();
    const originalDiskContent = rendered.diskContent();

    rendered.failNextFileWrite({
      category: "readOnly",
      operation: "saveDocument",
      message: "This file is read-only and was not changed.",
      detail: "/tmp/continuity.fountain has mode 0444",
    });
    clickButton(rendered.host, "Save");

    await waitFor(() => {
      assert.match(rendered.host.textContent, /read-only and was not changed/);
      assert.equal(rendered.fileWrites().length, 1);
    });
    assert.equal(rendered.diskContent(), originalDiskContent);

    rendered.setSaveDialogPath("/tmp/Writable Copy.fountain");
    clickButton(rendered.host, "Save As…");

    await waitFor(() => {
      assert.equal(rendered.fileWrites().length, 2);
      assert.match(rendered.host.textContent, /Writable Copy\.fountain/);
    });
    assert.equal(rendered.fileWrites()[0].path, "/tmp/continuity.fountain");
    assert.equal(rendered.fileWrites()[1].path, "/tmp/Writable Copy.fountain");
    assert.equal(rendered.fileWrites()[1].force, true);
    assert.equal(rendered.fileWrites()[1].expectedRevision, null);
    assert.equal(rendered.diskContent(), editedContent);
    assert.doesNotMatch(rendered.host.textContent, /bindars-error|mode 0444/);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".fountain-scene-heading")));
  } finally {
    await rendered.cleanup();
  }
});

test("read-only Markdown document offers Save As and adopts the writable copy", async () => {
  const rendered = await renderContinuityApp();

  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Edited read-only words");
    await waitForEditorPublication();
    const originalDiskContent = rendered.diskContent();

    rendered.failNextFileWrite({
      category: "readOnly",
      operation: "saveDocument",
      message: "This file is read-only and was not changed.",
      detail: "/tmp/continuity.md has mode 0444",
    });
    clickButton(rendered.host, "Save");

    await waitFor(() => {
      assert.match(rendered.host.textContent, /read-only and was not changed/);
      assert.equal(rendered.fileWrites().length, 1);
    });
    assert.equal(rendered.diskContent(), originalDiskContent);

    rendered.setSaveDialogPath("/tmp/Writable Copy.md");
    clickButton(rendered.host, "Save As…");

    await waitFor(() => {
      assert.equal(rendered.fileWrites().length, 2);
      assert.match(rendered.host.textContent, /Writable Copy\.md/);
    });
    assert.equal(rendered.fileWrites()[0].path, "/tmp/continuity.md");
    assert.equal(rendered.fileWrites()[1].path, "/tmp/Writable Copy.md");
    assert.equal(rendered.fileWrites()[1].force, true);
    assert.equal(rendered.fileWrites()[1].expectedRevision, null);
    assert.equal(rendered.diskContent(), "Edited read-only words");
    assert.doesNotMatch(rendered.host.textContent, /bindars-error|mode 0444/);
  } finally {
    await rendered.cleanup();
  }
});

test("oversized Markdown keeps exact editing and print available without entering presentation", async () => {
  await installDom();
  const { DOCUMENT_COMPLEXITY_MESSAGE, DOCUMENT_COMPLEXITY_POLICY } = require(
    "../.tmp/workspace-tests/src/lib/document-complexity.js"
  );
  const slideParser = require("../.tmp/workspace-tests/src/lib/slide-parser.js");
  const originalParseSlides = slideParser.parseSlides;
  const originalPrint = window.print;
  let slideParseCount = 0;
  let printCount = 0;
  slideParser.parseSlides = (...args) => {
    slideParseCount += 1;
    return originalParseSlides(...args);
  };
  window.print = () => {
    printCount += 1;
  };

  const sourceLimit = DOCUMENT_COMPLEXITY_POLICY.markdown.maxSourceCodeUnits;
  const initialContent = whitespaceSeparatedAscii(sourceLimit + 1);
  assert.equal(initialContent.length, 1_048_577, "fixture must pin the production boundary independently");
  const rendered = await renderContinuityApp({
    initialContent,
    readySelector: '[role="alert"]',
  });

  try {
    const notice = rendered.host.querySelector('main [role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent, /Document too large or complex/);
    assert.ok(notice.textContent.includes(DOCUMENT_COMPLEXITY_MESSAGE));
    assert.doesNotMatch(rendered.host.textContent, /Opening file/);

    dispatchWindowKey("F5");
    assert.equal(slideParseCount, 0);
    assert.ok(!rendered.host.querySelector(".presentation-overlay"));

    dispatchShortcut("p");
    await waitFor(() => assert.equal(printCount, 1));
    assert.ok(rendered.host.querySelector('main [role="alert"]'));
    flushSync(() => window.dispatchEvent(new window.Event("afterprint")));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), initialContent);
  } finally {
    slideParser.parseSlides = originalParseSlides;
    window.print = originalPrint;
    await rendered.cleanup();
  }
});

test("deeply nested Markdown containers are rejected before the renderer grows them", async () => {
  await installDom();
  const {
    DOCUMENT_COMPLEXITY_MESSAGE,
    DOCUMENT_COMPLEXITY_POLICY,
    MARKDOWN_MAX_CONTAINER_DEPTH,
  } = require("../.tmp/workspace-tests/src/lib/document-complexity.js");
  const slideParser = require("../.tmp/workspace-tests/src/lib/slide-parser.js");
  const originalParseSlides = slideParser.parseSlides;
  const originalPrint = window.print;
  let slideParseCount = 0;
  let printCount = 0;
  slideParser.parseSlides = (...args) => {
    slideParseCount += 1;
    return originalParseSlides(...args);
  };
  window.print = () => {
    printCount += 1;
  };

  // About 130 structural units: far below the unit ceiling, so only the new
  // container-depth limit rejects this document before ReactMarkdown can
  // recurse into it.
  const initialContent = `${"> ".repeat(MARKDOWN_MAX_CONTAINER_DEPTH + 1)}deep`;
  assert.ok(
    MARKDOWN_MAX_CONTAINER_DEPTH * 2 + 4 < DOCUMENT_COMPLEXITY_POLICY.markdown.maxUnits,
    "fixture must stay far below the structural-unit ceiling",
  );
  const rendered = await renderContinuityApp({
    initialContent,
    readySelector: '[role="alert"]',
  });

  try {
    const notice = rendered.host.querySelector('main [role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent, /Document too large or complex/);
    assert.ok(notice.textContent.includes(DOCUMENT_COMPLEXITY_MESSAGE));
    assert.doesNotMatch(rendered.host.textContent, /Opening file/);
    assert.ok(!rendered.host.querySelector("blockquote"), "no nested structure was rendered");

    dispatchWindowKey("F5");
    assert.equal(slideParseCount, 0);
    assert.ok(!rendered.host.querySelector(".presentation-overlay"));

    dispatchShortcut("p");
    await waitFor(() => assert.equal(printCount, 1));
    assert.ok(rendered.host.querySelector('main [role="alert"]'));
    flushSync(() => window.dispatchEvent(new window.Event("afterprint")));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), initialContent);
  } finally {
    slideParser.parseSlides = originalParseSlides;
    window.print = originalPrint;
    await rendered.cleanup();
  }
});

test("deeply nested inline Markdown is rejected before recursive rendering", async () => {
  await installDom();
  const {
    DOCUMENT_COMPLEXITY_MESSAGE,
    DOCUMENT_COMPLEXITY_POLICY,
    MARKDOWN_MAX_INLINE_NESTING,
  } = require("../.tmp/workspace-tests/src/lib/document-complexity.js");
  const slideParser = require("../.tmp/workspace-tests/src/lib/slide-parser.js");
  const originalParseSlides = slideParser.parseSlides;
  let slideParseCount = 0;
  slideParser.parseSlides = (...args) => {
    slideParseCount += 1;
    return originalParseSlides(...args);
  };

  let initialContent = "x";
  for (let index = 0; index <= MARKDOWN_MAX_INLINE_NESTING; index += 1) {
    initialContent = `*a ${initialContent} b*`;
  }
  assert.ok(
    MARKDOWN_MAX_INLINE_NESTING * 2 + 4 < DOCUMENT_COMPLEXITY_POLICY.markdown.maxUnits,
    "fixture must stay far below the structural-unit ceiling",
  );
  const rendered = await renderContinuityApp({
    initialContent,
    readySelector: '[role="alert"]',
  });

  try {
    const notice = rendered.host.querySelector('main [role="alert"]');
    assert.ok(notice);
    assert.ok(notice.textContent.includes(DOCUMENT_COMPLEXITY_MESSAGE));
    assert.doesNotMatch(rendered.host.textContent, /Opening file/);
    assert.ok(!rendered.host.querySelector("em"), "no nested inline structure was rendered");

    dispatchWindowKey("F5");
    assert.equal(slideParseCount, 0);
    assert.ok(!rendered.host.querySelector(".presentation-overlay"));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), initialContent);
  } finally {
    slideParser.parseSlides = originalParseSlides;
    await rendered.cleanup();
  }
});

test("mixed-delimiter inline nesting is rejected before the renderer grows a recursive tree", async () => {
  await installDom();
  const {
    DOCUMENT_COMPLEXITY_MESSAGE,
    DOCUMENT_COMPLEXITY_POLICY,
    MARKDOWN_MAX_INLINE_NESTING,
  } = require("../.tmp/workspace-tests/src/lib/document-complexity.js");
  const slideParser = require("../.tmp/workspace-tests/src/lib/slide-parser.js");
  const originalParseSlides = slideParser.parseSlides;
  const originalPrint = window.print;
  let slideParseCount = 0;
  let printCount = 0;
  slideParser.parseSlides = (...args) => {
    slideParseCount += 1;
    return originalParseSlides(...args);
  };
  window.print = () => {
    printCount += 1;
  };

  // `*`, `_`, and `~` share one ceiling, and an inert `~` run between the
  // openers must not release any of them: this is the shape that reached
  // `RangeError: Maximum call stack size exceeded` before the fix.
  const markers = ["*", "_", "~"];
  let initialContent = "x~ ";
  for (let index = 0; index <= MARKDOWN_MAX_INLINE_NESTING; index += 1) {
    initialContent = `${markers[index % markers.length]}a ${initialContent} b${markers[index % markers.length]}`;
  }
  assert.ok(
    initialContent.length < DOCUMENT_COMPLEXITY_POLICY.markdown.maxUnits,
    "fixture must stay far below the structural-unit ceiling",
  );
  const rendered = await renderContinuityApp({
    initialContent,
    readySelector: '[role="alert"]',
  });

  try {
    const notice = rendered.host.querySelector('main [role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent, /Document too large or complex/);
    assert.ok(notice.textContent.includes(DOCUMENT_COMPLEXITY_MESSAGE));
    assert.doesNotMatch(rendered.host.textContent, /Opening file/);
    assert.ok(!rendered.host.querySelector("em"), "no nested emphasis was rendered");
    assert.ok(!rendered.host.querySelector("del"), "no nested strikethrough was rendered");

    dispatchWindowKey("F5");
    assert.equal(slideParseCount, 0);
    assert.ok(!rendered.host.querySelector(".presentation-overlay"));

    dispatchShortcut("p");
    await waitFor(() => assert.equal(printCount, 1));
    assert.ok(rendered.host.querySelector('main [role="alert"]'));
    flushSync(() => window.dispatchEvent(new window.Event("afterprint")));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), initialContent);
  } finally {
    slideParser.parseSlides = originalParseSlides;
    window.print = originalPrint;
    await rendered.cleanup();
  }
});

test("overly complex Fountain documents get the same rejection notice while editing stays available", async () => {
  await installDom();
  const { DOCUMENT_COMPLEXITY_MESSAGE, DOCUMENT_COMPLEXITY_POLICY } = require(
    "../.tmp/workspace-tests/src/lib/document-complexity.js"
  );

  const initialContent = `a${"*".repeat(DOCUMENT_COMPLEXITY_POLICY.fountain.maxUnits)}`;
  const rendered = await renderContinuityApp({
    requestedPath: "/tmp/continuity.fountain",
    initialContent,
    readySelector: '[role="alert"]',
  });

  try {
    const notice = rendered.host.querySelector('main [role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent, /Document too large or complex/);
    assert.ok(notice.textContent.includes(DOCUMENT_COMPLEXITY_MESSAGE));
    assert.doesNotMatch(rendered.host.textContent, /Opening file/);
    assert.ok(!rendered.host.querySelector(".fountain-scene-heading"));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), initialContent);
  } finally {
    await rendered.cleanup();
  }
});

test("Save As keeps the draft stream when the adopted-file checkpoint fails", async () => {
  const rendered = await renderContinuityApp();

  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Words before Save As");
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.document.kind === "draft"));
    });

    const pendingWrite = deferred();
    rendered.deferNextWrite(pendingWrite);
    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.fileWrites().length, 1));

    const newerWords = "Words typed while the Save As write waits";
    updateEditor(rendered.host, newerWords);
    rendered.failNextSnapshotWrite(new Error("app-data unavailable"));
    await act(async () => {
      pendingWrite.resolve({
        conflict: false,
        canonicalPath: "/tmp/virtual-continuity.md",
        name: "virtual-continuity.md",
        currentRevision: {
          mtimeMs: 2,
          size: rendered.fileWrites()[0].content.length,
          contentHash: "saved-as",
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      assert.match(rendered.host.textContent, /virtual-continuity\.md/);
      assert.ok(rendered.snapshotWrites().some((write) => (
        write.document.kind === "file" && write.content === newerWords
      )));
    });
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), newerWords);
    assert.deepEqual(rendered.retiredDrafts(), []);
  } finally {
    await rendered.cleanup();
  }
});

test("restore snapshots the current file first, preserves the boundary, and returns dirty", async () => {
  const snapshotId = "00000000000000001000-1111111111111111.md";
  const restoredWords = "# First\n\nWords from an earlier snapshot.";
  const rendered = await renderContinuityApp({
    snapshotEntries: [{ id: snapshotId, createdAtMs: 1_000, size: restoredWords.length }],
    snapshotContents: { [snapshotId]: restoredWords },
  });

  try {
    const beforeRestore = rendered.diskContent();
    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    const choice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      return candidate;
    });
    flushSync(() => choice.click());

    await waitFor(() => {
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), restoredWords);
      assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    });
    const safetyWrites = rendered.snapshotWrites().slice(0, 2);
    assert.deepEqual(safetyWrites.map((write) => ({
      content: write.content,
      preservePrevious: write.preservePrevious,
    })), [
      { content: beforeRestore, preservePrevious: true },
      { content: restoredWords, preservePrevious: true },
    ]);

    dispatchShortcut("s");
    await waitFor(() => {
      assert.equal(rendered.diskContent(), restoredWords);
      assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    });
    assert.ok(rendered.host.querySelector(".cm-editor"));
  } finally {
    await rendered.cleanup();
  }
});

test("snapshot restore errors show safe native messages without diagnostic detail", async () => {
  const rendered = await renderContinuityApp();

  try {
    rendered.failNextSnapshotList({
      category: "unknown",
      operation: "accessRecoveryData",
      message: "Bindars could not access recovery data.",
      detail: "/private/recovery/snapshots: No such file or directory",
    });
    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());

    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /could not access recovery data/);
      return candidate;
    });
    assert.doesNotMatch(dialog.textContent, /private\/recovery|No such file|\[object Object\]/);
  } finally {
    await rendered.cleanup();
  }
});

test("restore aborts without changing the editor when its safety snapshot fails", async () => {
  const snapshotId = "00000000000000001000-2222222222222222.md";
  const rendered = await renderContinuityApp({
    snapshotEntries: [{ id: snapshotId, createdAtMs: 1_000, size: 9 }],
    snapshotContents: { [snapshotId]: "old words" },
  });

  try {
    const beforeRestore = rendered.diskContent();
    rendered.failNextSnapshotWrite(new Error("app-data disk full"));
    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    const choice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      return candidate;
    });
    flushSync(() => choice.click());

    await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.match(dialog.textContent, /app-data disk full/);
    });
    assert.ok(!rendered.host.querySelector(".cm-editor"));
    assert.equal(rendered.diskContent(), beforeRestore);
    assert.match(rendered.host.querySelector("article").textContent, /Opening words/);
  } finally {
    await rendered.cleanup();
  }
});

test("reader restore aborts a watcher publication before React commits it", async () => {
  const snapshotId = "00000000000000001000-6666666666666666.md";
  const restoredWords = "# First\n\nWords selected for restore.";
  const backupWrite = deferred();
  const checkpointWrite = deferred();
  const watcherOpen = deferred();
  const rendered = await renderContinuityApp({
    snapshotEntries: [{ id: snapshotId, createdAtMs: 1_000, size: restoredWords.length }],
    snapshotContents: { [snapshotId]: restoredWords },
  });

  try {
    const initialWords = rendered.diskContent();
    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    const choice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      return candidate;
    });

    rendered.deferNextSnapshotWrite(backupWrite);
    flushSync(() => choice.click());
    await waitFor(() => {
      assert.ok(backupWrite.args);
      assert.equal(backupWrite.args.content, initialWords);
    });

    rendered.deferNextSnapshotWrite(checkpointWrite);
    await act(async () => {
      backupWrite.resolve(successfulSnapshotWrite(backupWrite.args));
      await backupWrite.promise;
    });
    await waitFor(() => {
      assert.ok(checkpointWrite.args);
      assert.equal(checkpointWrite.args.content, restoredWords);
      assert.equal(checkpointWrite.args.preservePrevious, true);
    });

    const externalWords = "# First\n\nWords published before the reader rerenders.";
    rendered.setDiskContent(externalWords);
    rendered.clearOperationLog();
    rendered.deferNextOpen(watcherOpen);
    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));

    await act(async () => {
      watcherOpen.resolve(rendered.openResult(externalWords, 2));
      await watcherOpen.promise;
      const articleBeforeCommit = rendered.host.querySelector("article");
      assert.ok(articleBeforeCommit);
      assert.match(articleBeforeCommit.textContent, /Opening words/);
      assert.doesNotMatch(articleBeforeCommit.textContent, /published before the reader rerenders/i);
      checkpointWrite.resolve(successfulSnapshotWrite(checkpointWrite.args));
      await checkpointWrite.promise;
    });

    await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.match(dialog.textContent, /changed before the snapshot could be restored/i);
    });
    assert.ok(!rendered.host.querySelector(".cm-editor"));
    assert.match(rendered.host.querySelector("article").textContent, /published before the reader rerenders/i);
    assert.equal(rendered.diskContent(), externalWords);
    assert.equal(rendered.snapshotWrites().length, 2);
  } finally {
    await rendered.cleanup();
  }
});

test("reader restore aborts if a watcher reload changes its captured baseline", async () => {
  const snapshotId = "00000000000000001000-5555555555555555.md";
  const restoredWords = "# First\n\nWords selected for restore.";
  const backupWrite = deferred();
  const watcherOpen = deferred();
  const rendered = await renderContinuityApp({
    snapshotEntries: [{ id: snapshotId, createdAtMs: 1_000, size: restoredWords.length }],
    snapshotContents: { [snapshotId]: restoredWords },
  });

  try {
    const initialWords = rendered.diskContent();
    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    const choice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      return candidate;
    });

    rendered.deferNextSnapshotWrite(backupWrite);
    flushSync(() => choice.click());
    await waitFor(() => {
      assert.ok(backupWrite.args);
      assert.equal(backupWrite.args.content, initialWords);
      assert.equal(backupWrite.args.preservePrevious, true);
    });

    const externalWords = "# First\n\nWords written by another application.";
    rendered.setDiskContent(externalWords);
    rendered.clearOperationLog();
    rendered.deferNextOpen(watcherOpen);
    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));
    await act(async () => {
      watcherOpen.resolve(rendered.openResult(externalWords, 2));
      await watcherOpen.promise;
    });
    await waitFor(() => {
      const article = rendered.host.querySelector("article");
      assert.ok(article);
      assert.match(article.textContent, /Words written by another application/);
    });

    await act(async () => {
      backupWrite.resolve(successfulSnapshotWrite(backupWrite.args));
      await backupWrite.promise;
    });
    await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.match(dialog.textContent, /changed before the snapshot could be restored/i);
    });
    assert.ok(!rendered.host.querySelector(".cm-editor"));
    assert.equal(rendered.diskContent(), externalWords);
    assert.equal(rendered.snapshotWrites().length, 1);
  } finally {
    await rendered.cleanup();
  }
});

test("reader restore waits for a queued merge-enabled snapshot before safety writes", async () => {
  const snapshotId = "00000000000000001000-3333333333333333.md";
  const restoredWords = "# First\n\nWords selected for restore.";
  const queuedSnapshot = deferred();
  const selectedRead = deferred();
  const rendered = await renderContinuityApp({
    snapshotEntries: [{ id: snapshotId, createdAtMs: 1_000, size: restoredWords.length }],
    snapshotContents: { [snapshotId]: restoredWords },
  });

  try {
    const baseline = rendered.diskContent();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    rendered.clearSnapshotOperationLog();
    rendered.deferNextSnapshotWrite(queuedSnapshot);
    const discardedWords = `${baseline}\n\nNew words that will be discarded.`;
    updateEditor(rendered.host, discardedWords);
    await waitForEditorPublication();
    await waitFor(() => assert.ok(queuedSnapshot.args));
    assert.equal(queuedSnapshot.args.preservePrevious, false);

    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const reloadDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.match(dialog.textContent, /File changed/);
      return dialog;
    });
    clickButton(rendered.host, "Reload", reloadDialog);
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));

    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    // The dialog must not populate — and no safety write may start — while
    // the merge-enabled automatic write (and the capture behind it) is queued.
    await waitFor(() => {
      assert.match(rendered.host.querySelector('[role="dialog"]').textContent, /Loading snapshots/);
    });
    assert.equal(rendered.snapshotWrites().filter((write) => write.content === baseline).length, 0);
    assert.ok(!rendered.host.querySelector('[role="dialog"] li button'));

    await act(async () => {
      queuedSnapshot.resolve(successfulSnapshotWrite(queuedSnapshot.args));
      await queuedSnapshot.promise;
    });
    const choice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      return candidate;
    });
    rendered.deferNextSnapshotRead(selectedRead);
    flushSync(() => choice.click());
    await waitFor(() => assert.ok(selectedRead.args));
    selectedRead.resolve(restoredWords);
    await waitFor(() => {
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), restoredWords);
      assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    });
    assert.deepEqual(rendered.snapshotOperationLog().slice(0, 8), [
      { phase: "start", content: discardedWords, preservePrevious: false },
      { phase: "finish", content: discardedWords, preservePrevious: false },
      // The Reload discard capture queues behind the deferred automatic write
      // and lands before the drained reader backup/checkpoint pair.
      { phase: "start", content: discardedWords, preservePrevious: true },
      { phase: "finish", content: discardedWords, preservePrevious: true },
      { phase: "start", content: baseline, preservePrevious: true },
      { phase: "finish", content: baseline, preservePrevious: true },
      { phase: "start", content: restoredWords, preservePrevious: true },
      { phase: "finish", content: restoredWords, preservePrevious: true },
    ]);
  } finally {
    await rendered.cleanup();
  }
});

test("a dismissed late restore cannot replace typing from the resumed editor", async () => {
  const snapshotId = "00000000000000001000-4444444444444444.md";
  const oldWords = "# First\n\nWords from before dismissal.";
  const snapshotRead = deferred();
  const rendered = await renderContinuityApp({
    snapshotEntries: [{ id: snapshotId, createdAtMs: 1_000, size: oldWords.length }],
    snapshotContents: { [snapshotId]: oldWords },
  });

  try {
    rendered.deferNextSnapshotRead(snapshotRead);
    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    const choice = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"] li button');
      assert.ok(candidate);
      return candidate;
    });
    flushSync(() => choice.click());

    const closeButton = await waitFor(() => {
      const candidate = Array.from(rendered.host.querySelectorAll('[role="dialog"] button'))
        .find((button) => button.textContent === "Close");
      assert.ok(candidate);
      assert.equal(candidate.disabled, true);
      return candidate;
    });
    const reactPropsKey = Object.keys(closeButton)
      .find((key) => key.startsWith("__reactProps$"));
    assert.ok(reactPropsKey);
    // Bypass the disabled control intentionally: the generation guard must
    // remain safe even if another App path dismisses the dialog in the future.
    flushSync(() => closeButton[reactPropsKey].onClick());
    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const resumedWords = `${rendered.diskContent()}\n\nTyping after dismissal.`;
    updateEditor(rendered.host, resumedWords);

    snapshotRead.resolve(oldWords);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(findEditorView(rendered.host).state.sliceDoc(), resumedWords);
  } finally {
    await rendered.cleanup();
  }
});

test("Ctrl+S remains global while the CodeMirror search panel owns focus", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const savedWords = `${rendered.diskContent()}\n\nSaved from search.`;
    updateEditor(rendered.host, savedWords);
    dispatchEditorKey(rendered.host, "f", { ctrlKey: true });
    const searchField = rendered.host.querySelector('input[name="search"]');
    assert.ok(searchField);
    searchField.focus();

    const saveEvent = dispatchElementKey(searchField, "s", { ctrlKey: true });

    assert.equal(saveEvent.defaultPrevented, true);
    await waitFor(() => assert.equal(rendered.diskContent(), savedWords));
    assert.ok(rendered.host.querySelector(".cm-panel"));
    assert.ok(rendered.host.querySelector(".cm-editor"));
  } finally {
    await rendered.cleanup();
  }
});

test("automatic snapshot warnings show safe native messages and leave document saves working", async () => {
  const rendered = await renderContinuityApp();
  const nativeMessage = "Bindars could not access recovery data.";
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    rendered.failNextSnapshotWrite({
      category: "unknown",
      operation: "accessRecoveryData",
      message: nativeMessage,
      detail: "/private/recovery/snapshots: permission denied",
    });
    const words = `${rendered.diskContent()}\n\nWords protected by a normal save.`;
    updateEditor(rendered.host, words);
    await waitForEditorPublication();

    await waitFor(() => {
      const warning = rendered.host.querySelector('[aria-label^="Save warning:"]');
      assert.ok(warning);
      const expected = `Recovery snapshots are temporarily unavailable; retrying automatically: ${nativeMessage}`;
      assert.equal(warning.getAttribute("aria-label"), `Save warning: ${expected}`);
      assert.equal(warning.getAttribute("title"), expected);
    });
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), words);

    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.diskContent(), words));
  } finally {
    await rendered.cleanup();
  }
});

test("an idle autosave conflict warns quietly and waits for manual save to open one dialog", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    rendered.conflictNextWrite();
    updateEditor(rendered.host, `${rendered.diskContent()}\n\nConflicting local words.`);
    await waitForEditorPublication();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_700));
    });

    const warning = await waitFor(() => {
      const candidate = rendered.host.querySelector('[aria-label^="Save warning:"]');
      assert.ok(candidate);
      return candidate;
    });
    assert.match(warning.getAttribute("aria-label"), /file changed outside Bindars/i);
    assert.equal(rendered.fileWrites().length, 1);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));

    dispatchShortcut("s");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /File changed on disk/);
      return candidate;
    });
    assert.ok(dialog);
    assert.equal(rendered.fileWrites().length, 1);
  } finally {
    await rendered.cleanup();
  }
});

test("an unresolved conflict stays dirty after Undo and cannot report a false save", async () => {
  const rendered = await renderContinuityApp();
  try {
    const baseline = rendered.diskContent();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = updateEditor(rendered.host, `${baseline}\n\nLocal conflicting words.`);
    await waitForEditorPublication();

    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const firstDialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /File changed/);
      return candidate;
    });
    clickButton(rendered.host, "Cancel", firstDialog);
    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));

    flushSync(() => assert.equal(undo(view), true));
    await waitForEditorPublication();
    assert.equal(view.state.sliceDoc(), baseline);
    const saveButton = Array.from(rendered.host.querySelectorAll("button"))
      .find((candidate) => candidate.textContent.trim() === "Save");
    assert.ok(saveButton);
    assert.equal(saveButton.disabled, false);
    assert.ok(rendered.host.querySelector('[aria-label^="Save warning:"]'));

    const writeCount = rendered.fileWrites().length;
    dispatchShortcut("s");
    const secondDialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /File changed/);
      return candidate;
    });
    assert.equal(rendered.fileWrites().length, writeCount);
    assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));

    clickButton(rendered.host, "Cancel", secondDialog);
    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
    dispatchShortcut("e");
    await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /File changed/);
      assert.ok(rendered.host.querySelector(".cm-editor"));
    });
  } finally {
    await rendered.cleanup();
  }
});

test("file switching flushes the pending autosave before opening the next file", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const switchedWords = `${rendered.diskContent()}\n\nSaved before switch.`;
    updateEditor(rendered.host, switchedWords);
    rendered.setOpenDialogPath("/tmp/switched.md");

    dispatchShortcut("o");

    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    await waitFor(() => assert.match(rendered.host.textContent, /switched\.md/));
    assert.equal(rendered.fileWrites()[0].content, switchedWords);
    assert.equal(rendered.diskContent(), switchedWords);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    await rendered.cleanup();
  }
});

test("the initial native open wins over stored session restore", async () => {
  const rendered = await renderContinuityApp({
    requestedPath: "/tmp/stored-session.md",
    canonicalPath: "/tmp/stored-session.md",
    restoreHeadingId: "stored-heading",
    initialNativePath: "/tmp/finder-launch.md",
    readySelector: "article",
  });
  try {
    await waitFor(() => assert.match(rendered.host.textContent, /finder-launch\.md/));
    assert.deepEqual(rendered.openedPaths(), ["/tmp/finder-launch.md"]);
  } finally {
    await rendered.cleanup();
  }
});

test("a same-path native request takes over a live session restore without a second read", async () => {
  const restoreOpen = deferred();
  const requestedPath = "/tmp/stored-session.md";
  const rendered = await renderContinuityApp({
    requestedPath,
    restoreHeadingId: "stored-heading",
    initialOpenOperation: restoreOpen,
    readySelector: "main",
  });

  try {
    await waitFor(() => assert.equal(restoreOpen.args?.path, requestedPath));
    assert.deepEqual(rendered.openedPaths(), [requestedPath]);

    rendered.setPendingNativeOpenPath(requestedPath);
    await act(async () => {
      await emit("bindars://native-open-available");
      await Promise.resolve();
    });
    assert.deepEqual(
      rendered.openedPaths(),
      [requestedPath],
      "the user action must take over the session read instead of starting another one",
    );
    assert.ok(!rendered.host.querySelector('[role="alert"]'));

    await act(async () => {
      restoreOpen.resolve(rendered.openResult());
      await restoreOpen.promise;
    });
    await waitFor(() => assert.match(rendered.host.textContent, /stored-session\.md/));
    assert.deepEqual(rendered.openedPaths(), [requestedPath]);
    assert.ok(!rendered.host.querySelector('[role="alert"]'));
  } finally {
    restoreOpen.resolve(rendered.openResult());
    await rendered.cleanup();
  }
});

test("native file switching honors Save, Discard, and Cancel for dirty documents", async (context) => {
  for (const choice of ["Save", "Discard", "Cancel"]) {
    await context.test(choice, async () => {
      const rendered = await renderContinuityApp();
      const targetPath = `/tmp/native-${choice.toLowerCase()}.md`;
      const localWords = `${rendered.diskContent()}\n\nKeep ${choice} words.`;
      try {
        const dialog = await requestNativeOpenAfterFailedBoundarySave(
          rendered,
          targetPath,
          localWords,
        );

        if (choice === "Cancel") {
          dispatchWindowKey("Escape");
          await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
          assert.equal(findEditorView(rendered.host).state.sliceDoc(), localWords);
          assert.match(rendered.host.textContent, /continuity\.md/);
          assert.doesNotMatch(rendered.host.textContent, /native-cancel\.md/);
        } else {
          clickButton(rendered.host, choice, dialog);
          await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
          await waitFor(() => assert.match(rendered.host.textContent, new RegExp(`native-${choice.toLowerCase()}\\.md`)));
          if (choice === "Save") {
            assert.equal(rendered.diskContent(), localWords);
          }
        }

        const retryPath = `/tmp/native-after-${choice.toLowerCase()}.md`;
        await requestNativeOpenAndDiscardIfPrompted(rendered, retryPath);
      } finally {
        await rendered.cleanup();
      }
    });
  }
});

test("a failed open after Discard keeps disk content without restoring discarded edits", async () => {
  const rendered = await renderContinuityApp();
  const discardedWords = `${rendered.diskContent()}\n\nThese words must stay discarded.`;
  const failedOpen = deferred();

  try {
    const dialog = await requestNativeOpenAfterFailedBoundarySave(
      rendered,
      "/tmp/unavailable-after-discard.md",
      discardedWords,
    );
    rendered.deferNextOpen(failedOpen);
    clickButton(rendered.host, "Discard", dialog);
    await waitFor(() => assert.equal(
      failedOpen.args?.path,
      "/tmp/unavailable-after-discard.md",
    ));

    await act(async () => {
      failedOpen.reject({
        category: "resourceUnavailable",
        operation: "readDocument",
        message: "The replacement file is unavailable.",
        detail: "provider offline",
      });
      try { await failedOpen.promise; } catch { /* expected */ }
    });

    await waitFor(() => assert.match(rendered.host.textContent, /replacement file is unavailable/i));
    assert.ok(!rendered.host.querySelector(".cm-editor"));
    assert.match(rendered.host.querySelector("article").textContent, /Opening words/);
    assert.doesNotMatch(rendered.host.textContent, /These words must stay discarded/);
    assert.match(rendered.host.textContent, /continuity\.md/);
    assert.doesNotMatch(rendered.host.textContent, /unavailable-after-discard\.md/);
  } finally {
    failedOpen.reject(new Error("test cleanup"));
    await rendered.cleanup();
  }
});

test("a failed Save during native file switching preserves the current document", async () => {
  const rendered = await renderContinuityApp();
  const localWords = `${rendered.diskContent()}\n\nUnsaved after a failed retry.`;
  try {
    const dialog = await requestNativeOpenAfterFailedBoundarySave(
      rendered,
      "/tmp/native-failed-save.md",
      localWords,
    );
    const failedRetry = deferred();
    rendered.deferNextWrite(failedRetry);
    clickButton(rendered.host, "Save", dialog);
    await waitFor(() => assert.ok(failedRetry.args));
    await act(async () => {
      failedRetry.reject(new Error("Retry failed"));
      await Promise.resolve();
    });

    await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), localWords);
    assert.match(rendered.host.textContent, /continuity\.md/);
    assert.doesNotMatch(rendered.host.textContent, /native-failed-save\.md/);

    await requestNativeOpenAndDiscardIfPrompted(rendered, "/tmp/native-after-failed-save.md");
  } finally {
    await rendered.cleanup();
  }
});

test("native file switching drains the snapshot queue before replacing the document", async () => {
  const rendered = await renderContinuityApp();
  try {
    const dialog = await requestNativeOpenAfterFailedBoundarySave(
      rendered,
      "/tmp/native-after-snapshot.md",
      `${rendered.diskContent()}\n\nRecover these discarded words.`,
    );
    const snapshot = deferred();
    rendered.clearOperationLog();
    rendered.clearOpenedPaths();
    rendered.deferNextSnapshotWrite(snapshot);
    clickButton(rendered.host, "Discard", dialog);

    await waitFor(() => assert.ok(snapshot.args));
    assert.ok(
      !rendered.openedPaths().includes("/tmp/native-after-snapshot.md"),
      "the replacement open must wait for the queued snapshot write",
    );
    const editButton = rendered.host.querySelector('button[aria-label="Switch to edit mode"]');
    assert.ok(editButton);
    assert.equal(editButton.disabled, true);
    assert.ok(!rendered.host.querySelector('button[aria-label="Restore snapshot"]'));
    dispatchShortcut("e");
    assert.ok(!rendered.host.querySelector(".cm-editor"));

    await act(async () => {
      snapshot.resolve(successfulSnapshotWrite(snapshot.args));
      await snapshot.promise;
    });
    await waitFor(() => assert.ok(rendered.openedPaths().includes("/tmp/native-after-snapshot.md")));
    await waitFor(() => assert.match(rendered.host.textContent, /native-after-snapshot\.md/));
    await waitFor(() => assert.equal(
      rendered.host.querySelector('button[aria-label="Switch to edit mode"]')?.disabled,
      false,
    ));
  } finally {
    await rendered.cleanup();
  }
});

test("a later native open is consumed as busy while an admitted open is still running", async () => {
  const rendered = await renderContinuityApp();
  try {
    const firstOpen = deferred();
    rendered.clearOpenedPaths();
    rendered.deferNextOpen(firstOpen);
    rendered.setPendingNativeOpenPath("/tmp/first-native.md");
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.equal(firstOpen.args?.path, "/tmp/first-native.md"));

    rendered.setPendingNativeOpenPath("/tmp/second-native.md");
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.match(
      rendered.host.textContent,
      /finishing another file action/i,
    ));
    assert.deepEqual(rendered.openedPaths(), ["/tmp/first-native.md"]);

    const content = "# First native\n";
    await act(async () => {
      firstOpen.resolve({
        canonicalPath: "/tmp/first-native.md",
        name: "first-native.md",
        content,
        revision: { mtimeMs: 2, size: content.length, contentHash: "first-native" },
      });
      await firstOpen.promise;
    });
    await waitFor(() => assert.match(rendered.host.textContent, /first-native\.md/));
    assert.deepEqual(rendered.openedPaths(), ["/tmp/first-native.md"]);

    await requestNativeOpenAndDiscardIfPrompted(rendered, "/tmp/after-admitted-open.md");
  } finally {
    await rendered.cleanup();
  }
});

test("Cancel releases a slow admitted open while its native read remains abandoned", async () => {
  const rendered = await renderContinuityApp();
  const stalledOpen = deferred();
  try {
    rendered.clearOpenedPaths();
    rendered.deferNextOpen(stalledOpen);
    rendered.setPendingNativeOpenPath("/tmp/continuity.md");
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.equal(
      stalledOpen.args?.path,
      "/tmp/continuity.md",
    ));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_050));
    });
    const status = rendered.host.querySelector('[role="status"]');
    assert.ok(status);
    assert.match(status.textContent, /Still opening/);
    assert.ok(status.querySelector("button") === null);
    const cancelButton = Array.from(rendered.host.querySelectorAll("button"))
      .find((button) => button.textContent.trim() === "Cancel");
    assert.ok(cancelButton);
    cancelButton.focus();
    assert.ok(document.activeElement === cancelButton);
    flushSync(() => cancelButton.click());

    await waitFor(() => assert.doesNotMatch(rendered.host.textContent, /Still opening/));
    const readingSurface = rendered.host.querySelector("main");
    assert.ok(document.activeElement === readingSurface);
    assert.equal(readingSurface.getAttribute("tabindex"), "-1");
    await waitFor(() => assert.ok(
      Array.from(rendered.host.querySelectorAll('[role="status"]'))
        .some((candidate) => /Opening canceled/.test(candidate.textContent)),
    ));
    assert.match(rendered.host.querySelector("article").textContent, /Opening words/);
    await waitFor(() => assert.equal(
      rendered.host.querySelector('button[aria-label="Switch to edit mode"]')?.disabled,
      false,
    ));

    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    const reconciliationError = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="alert"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /still waiting on an earlier request/i);
      return candidate;
    });
    assert.match(reconciliationError.textContent, /quit and reopen Bindars/i);
    assert.doesNotMatch(reconciliationError.textContent, /Retry/i);
    assert.deepEqual(rendered.openedPaths(), ["/tmp/continuity.md"]);

    const healthyOpen = deferred();
    rendered.deferNextOpen(healthyOpen);
    rendered.setPendingNativeOpenPath("/tmp/Healthy-after-cancel.md");
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.equal(
      healthyOpen.args?.path,
      "/tmp/Healthy-after-cancel.md",
    ));
    const healthyContent = "# Healthy after cancel\n";
    await act(async () => {
      healthyOpen.resolve({
        canonicalPath: "/tmp/Healthy-after-cancel.md",
        name: "Healthy-after-cancel.md",
        content: healthyContent,
        revision: {
          mtimeMs: 2,
          size: healthyContent.length,
          contentHash: "healthy-after-cancel",
        },
      });
      await healthyOpen.promise;
    });
    await waitFor(() => assert.match(rendered.host.textContent, /Healthy-after-cancel\.md/));

    await act(async () => {
      stalledOpen.resolve(rendered.openResult("# Late stale file\n", 3));
      await stalledOpen.promise;
      await Promise.resolve();
    });
    assert.match(rendered.host.querySelector("article").textContent, /Healthy after cancel/);
    assert.doesNotMatch(rendered.host.textContent, /Late stale file/);
  } finally {
    stalledOpen.resolve(rendered.openResult());
    await rendered.cleanup();
  }
});

test("native close flushes the pending autosave before closing the window", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const closingWords = `${rendered.diskContent()}\n\nSaved before close.`;
    updateEditor(rendered.host, closingWords);

    await act(async () => {
      await emit("tauri://close-requested");
    });

    await waitFor(() => assert.equal(rendered.windowCloseCount(), 1));
    assert.equal(rendered.fileWrites()[0].content, closingWords);
    assert.equal(rendered.diskContent(), closingWords);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    await rendered.cleanup();
  }
});

test("clean exit restores cursor movement and scroll-only movement", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    let view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3 } });
    dispatchShortcut("e");
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));

    rendered.positionReaderAtFirst();
    rendered.showFirstEditorLine();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    view = findEditorView(rendered.host);
    const main = rendered.host.querySelector("main");
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => view.state.doc.line(5).from,
    });
    const visibleLine = view.contentDOM.querySelector(".cm-line");
    assert.ok(visibleLine);
    assert.ok(visibleLine.getBoundingClientRect().bottom > main.getBoundingClientRect().top);
    view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
    main.scrollTop = 500;
    main.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 500 }));
    const unchangedSelection = view.state.selection.main.head;
    dispatchShortcut("e");
    assert.equal(unchangedSelection, view.state.doc.line(1).from);
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));
  } finally {
    await rendered.cleanup();
  }
});

test("save-and-exit restores the surviving edited position", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = updateEditor(rendered.host, `${rendered.diskContent()}\n\n## Third\nSaved words.`);
    view.dispatch({ selection: { anchor: view.state.doc.line(9).from + 3 } });
    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("#third")));
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    assert.match(rendered.host.querySelector("article").textContent, /Saved words/);
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 900));
    await act(async () => {
      reconciliation.resolve(rendered.openResult(rendered.diskContent(), rendered.revision()));
      await reconciliation.promise;
    });
  } finally {
    await rendered.cleanup();
  }
});

test("save with newer edits stays dirty until the exit boundary flushes the newer buffer", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const savedSnapshot = "# First\n\nSaved snapshot.";
    const newerBuffer = `${savedSnapshot}\n\nNewer unsaved words.`;
    updateEditor(rendered.host, savedSnapshot);
    await waitForEditorPublication();

    const write = deferred();
    rendered.deferNextWrite(write);
    dispatchShortcut("s");
    await waitFor(() => assert.equal(write.args?.content, savedSnapshot));
    updateEditor(rendered.host, newerBuffer);
    rendered.setDiskContent(savedSnapshot);
    await act(async () => {
      write.resolve({
        conflict: false,
        canonicalPath: "/tmp/continuity.md",
        name: "continuity.md",
        currentRevision: { mtimeMs: 2, size: savedSnapshot.length, contentHash: "saved" },
      });
      await write.promise;
    });
    await waitFor(() => assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]')));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), newerBuffer);

    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    assert.match(rendered.host.querySelector("article").textContent, /Saved snapshot/);
    assert.match(rendered.host.querySelector("article").textContent, /Newer unsaved words/);
    assert.equal(rendered.diskContent(), newerBuffer);
    reconciliation.resolve(rendered.openResult(newerBuffer, rendered.revision()));
  } finally {
    await rendered.cleanup();
  }
});

test("clean exit restores immediately and equal reconciliation does not restore twice", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3 } });
    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));
    assert.doesNotMatch(rendered.host.textContent, /Opening file/);

    rendered.host.querySelector("main").scrollTop = 123;
    await act(async () => {
      reconciliation.resolve(rendered.openResult(rendered.diskContent(), rendered.revision() + 1));
      await reconciliation.promise;
    });
    assert.equal(rendered.readerScrollTop(), 123);
  } finally {
    await rendered.cleanup();
  }
});

test("exit waits for watcher activation before reconciliation", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.clearOperationLog();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const watcher = deferred();
    const reconciliation = deferred();
    rendered.deferNextWatch(watcher);
    rendered.deferNextOpen(reconciliation);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch"]));

    await act(async () => {
      watcher.resolve(null);
      await watcher.promise;
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch", "open"]));
    reconciliation.resolve(rendered.openResult());
  } finally {
    await rendered.cleanup();
  }
});

test("watcher setup failure after editor exit queues only the editor-exit reconciliation", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    rendered.failNextWatch(new Error("watch setup unavailable"));
    rendered.clearOperationLog();

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch", "open"]));
    await act(async () => {
      await waitForReconciliationWindow();
    });

    assert.deepEqual(rendered.operationLog(), ["watch", "open"]);
  } finally {
    await rendered.cleanup();
  }
});

test("watcher drop after a deferred stale editor-exit still reconciles", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));

    const watcher = deferred();
    rendered.deferNextWatch(watcher);
    rendered.clearOperationLog();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch"]));

    const openDialog = deferred();
    rendered.deferNextOpenDialog(openDialog);
    dispatchShortcut("o");
    await act(async () => Promise.resolve());

    await act(async () => {
      watcher.resolve(null);
      await watcher.promise;
    });
    assert.deepEqual(rendered.operationLog(), ["watch"]);

    const editorExitProbe = deferred();
    rendered.deferNextOpen(editorExitProbe);
    await act(async () => {
      openDialog.resolve(null);
      await openDialog.promise;
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch", "open"]));

    const sameFileOpen = deferred();
    rendered.setOpenDialogPath("/tmp/continuity.md");
    rendered.deferNextOpen(sameFileOpen);
    dispatchShortcut("o");
    await waitFor(() => assert.match(
      rendered.host.textContent,
      /still waiting on an earlier request/i,
    ));
    assert.deepEqual(rendered.operationLog(), ["watch", "open"]);
    let retryButton = Array.from(rendered.host.querySelectorAll("button"))
      .find((candidate) => candidate.textContent.trim() === "Retry");
    assert.ok(retryButton);
    assert.equal(retryButton.disabled, true);

    await act(async () => {
      editorExitProbe.resolve(rendered.openResult());
      await editorExitProbe.promise;
      await Promise.resolve();
    });
    retryButton = await waitFor(() => {
      const candidate = Array.from(rendered.host.querySelectorAll("button"))
        .find((button) => button.textContent.trim() === "Retry");
      assert.ok(candidate);
      assert.equal(candidate.disabled, false);
      assert.match(rendered.host.querySelector('[role="alert"]').textContent, /Retry is now available/);
      return candidate;
    });
    flushSync(() => retryButton.click());
    await waitFor(() => assert.deepEqual(
      rendered.operationLog(),
      ["watch", "open", "open"],
    ));

    await act(async () => {
      sameFileOpen.resolve(rendered.openResult());
      await sameFileOpen.promise;
    });

    const dropProbe = deferred();
    rendered.deferNextOpen(dropProbe);
    await act(async () => {
      await emit(FILE_WATCHER_UNAVAILABLE_EVENT, { path: "/tmp/continuity.md" });
      await waitForReconciliationWindow();
    });
    await waitFor(() => assert.deepEqual(
      rendered.operationLog(),
      ["watch", "open", "open", "open"],
    ));

    await act(async () => {
      dropProbe.resolve(rendered.openResult());
      await dropProbe.promise;
    });
  } finally {
    await rendered.cleanup();
  }
});

test("an active watcher reload cannot steal a queued editor-exit source anchor", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3 } });

    const watcherSetup = deferred();
    const watcherProbe = deferred();
    const exitProbe = deferred();
    rendered.clearOperationLog();
    rendered.deferNextWatch(watcherSetup);
    rendered.deferNextOpen(watcherProbe);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch"]));

    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch", "open"]));

    rendered.deferNextOpen(exitProbe);
    await act(async () => {
      watcherSetup.resolve(null);
      await watcherSetup.promise;
    });
    rendered.host.querySelector("main").scrollTop = 123;

    const external = `${rendered.diskContent()}\n\nExternal watcher words.`;
    await act(async () => {
      watcherProbe.resolve(rendered.openResult(external, rendered.revision() + 1));
      await watcherProbe.promise;
    });
    await waitFor(() => assert.match(
      rendered.host.querySelector("article").textContent,
      /External watcher words/,
    ));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));
    await waitFor(() => assert.deepEqual(
      rendered.operationLog(),
      ["watch", "open", "open"],
    ));

    await act(async () => {
      exitProbe.resolve(rendered.openResult(external, rendered.revision() + 1));
      await exitProbe.promise;
    });
    assert.equal(rendered.readerScrollTop(), 500);
  } finally {
    await rendered.cleanup();
  }
});

test("replacement watch waits for the same-path unwatch to complete", async () => {
  const rendered = await renderContinuityApp();
  try {
    const unwatch = deferred();
    const reconciliation = deferred();
    rendered.clearOperationLog();
    rendered.deferNextUnwatch(unwatch);
    rendered.deferNextOpen(reconciliation);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["unwatch"]));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    assert.deepEqual(rendered.operationLog(), ["unwatch"]);

    await act(async () => {
      unwatch.resolve(null);
      await unwatch.promise;
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["unwatch", "watch", "open"]));
    reconciliation.resolve(rendered.openResult());
  } finally {
    await rendered.cleanup();
  }
});

test("re-entry cancels reconciliation while watcher activation is pending", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const watcher = deferred();
    rendered.clearOperationLog();
    rendered.deferNextWatch(watcher);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch"]));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));

    await act(async () => {
      watcher.resolve(null);
      await watcher.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(rendered.operationLog(), ["watch"]);
  } finally {
    await rendered.cleanup();
  }
});

test("navigation invalidates reconciliation while watcher activation is pending", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const watcher = deferred();
    rendered.clearOperationLog();
    rendered.deferNextWatch(watcher);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["watch"]));

    rendered.setOpenDialogPath("/tmp/other.md");
    dispatchShortcut("o");
    await waitFor(() => assert.match(rendered.host.textContent, /other\.md/));
    assert.equal(rendered.operationLog().filter((operation) => operation === "open").length, 1);

    await act(async () => {
      watcher.resolve(null);
      await watcher.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.operationLog().filter((operation) => operation === "open").length, 1);

    rendered.setOpenDialogPath("/tmp/continuity.md");
    dispatchShortcut("o");
    await waitFor(() => assert.match(rendered.host.textContent, /continuity\.md/));
    assert.equal(rendered.operationLog().filter((operation) => operation === "open").length, 2);
  } finally {
    await rendered.cleanup();
  }
});

test("an equal-byte watcher reload updates metadata without restoring a heading", async () => {
  const rendered = await renderContinuityApp();
  try {
    const main = rendered.host.querySelector("main");
    main.scrollTop = 123;
    rendered.clearOperationLog();
    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 123));
  } finally {
    await rendered.cleanup();
  }
});

test("positive focus and native resume coalesce into one reader reconciliation", async () => {
  const rendered = await renderContinuityApp();
  try {
    const reconciliation = deferred();
    const externalWords = `${rendered.diskContent()}\n\nLifecycle reader words.`;
    rendered.deferNextOpen(reconciliation);
    rendered.clearOperationLog();

    await act(async () => {
      await emit("tauri://blur");
      await emit("tauri://focus");
      await emit(APP_RESUMED_EVENT);
      await waitForReconciliationWindow();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));

    await act(async () => {
      reconciliation.resolve(rendered.openResult(
        externalWords,
        rendered.revision() + 1,
      ));
      await reconciliation.promise;
    });
    await waitFor(() => assert.match(
      rendered.host.querySelector("article").textContent,
      /Lifecycle reader words/,
    ));
    assert.equal(
      rendered.operationLog().filter((operation) => operation === "open").length,
      1,
    );
  } finally {
    await rendered.cleanup();
  }
});

test("native resume protects an exact dirty editor buffer from external bytes", async () => {
  const rendered = await renderContinuityApp();
  try {
    const localWords = `${rendered.diskContent()}\n\nExact local lifecycle words.`;
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, localWords);
    await waitForEditorPublication();

    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    rendered.clearOperationLog();
    await act(async () => {
      await emit(APP_RESUMED_EVENT);
      await waitForReconciliationWindow();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));

    await act(async () => {
      reconciliation.resolve(rendered.openResult(
        "# External\n\nDifferent lifecycle bytes.",
        rendered.revision() + 1,
      ));
      await reconciliation.promise;
    });
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), localWords);
    await waitFor(() => assert.match(
      rendered.host.querySelector('[aria-label^="Save warning:"]').getAttribute("aria-label"),
      /file changed outside Bindars/i,
    ));
  } finally {
    await rendered.cleanup();
  }
});

test("positive focus refreshes a clean editor through the mounted surface", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = findEditorView(rendered.host);
    const reconciliation = deferred();
    const externalWords = "# External\n\nClean lifecycle refresh.";
    rendered.deferNextOpen(reconciliation);
    rendered.clearOperationLog();

    await act(async () => {
      await emit("tauri://focus");
      await waitForReconciliationWindow();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));

    await act(async () => {
      reconciliation.resolve(rendered.openResult(
        externalWords,
        rendered.revision() + 1,
      ));
      await reconciliation.promise;
    });
    assert.ok(findEditorView(rendered.host) === view);
    assert.equal(view.state.sliceDoc(), externalWords);
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    assert.ok(!rendered.host.querySelector('[aria-label^="Save warning:"]'));
  } finally {
    await rendered.cleanup();
  }
});

test("native watcher health loss uses the same reader reconciliation authority", async () => {
  const rendered = await renderContinuityApp();
  try {
    const reconciliation = deferred();
    const externalWords = `${rendered.diskContent()}\n\nWatcher fallback words.`;
    rendered.deferNextOpen(reconciliation);
    rendered.clearOperationLog();

    await act(async () => {
      await emit(FILE_WATCHER_UNAVAILABLE_EVENT, { path: "/tmp/continuity.md" });
      await waitForReconciliationWindow();
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));

    await act(async () => {
      reconciliation.resolve(rendered.openResult(
        externalWords,
        rendered.revision() + 1,
      ));
      await reconciliation.promise;
    });
    await waitFor(() => assert.match(
      rendered.host.querySelector("article").textContent,
      /Watcher fallback words/,
    ));
  } finally {
    await rendered.cleanup();
  }
});

test("watcher setup failure probes the newly opened reader through reconciliation", async () => {
  const rendered = await renderContinuityApp();
  try {
    const nextPath = "/tmp/watcher-fallback.md";
    rendered.setOpenDialogPath(nextPath);
    rendered.failNextWatch(new Error("watch setup unavailable"));
    rendered.clearOperationLog();

    dispatchShortcut("o");
    await waitFor(() => assert.match(rendered.host.textContent, /watcher-fallback\.md/));
    await waitFor(() => assert.equal(
      rendered.operationLog().filter((operation) => operation === "open").length,
      2,
    ));
    assert.deepEqual(rendered.openedPaths().slice(-2), [nextPath, nextPath]);
  } finally {
    await rendered.cleanup();
  }
});

test("a watcher signal deferred by a canceled Open dialog reconciles the original document", async () => {
  const rendered = await renderContinuityApp();
  try {
    const openDialog = deferred();
    const reconciliation = deferred();
    const external = `${rendered.diskContent()}\n\nChanged while Open was pending.`;
    rendered.deferNextOpenDialog(openDialog);
    rendered.deferNextOpen(reconciliation);
    rendered.clearOperationLog();

    dispatchShortcut("o");
    await act(async () => Promise.resolve());
    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    assert.deepEqual(rendered.operationLog(), []);

    await act(async () => {
      openDialog.resolve(null);
      await openDialog.promise;
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));
    await act(async () => {
      reconciliation.resolve(rendered.openResult(external, rendered.revision() + 1));
      await reconciliation.promise;
    });
    await waitFor(() => assert.match(
      rendered.host.querySelector("article").textContent,
      /Changed while Open was pending/,
    ));
  } finally {
    await rendered.cleanup();
  }
});

test("a watcher signal deferred by a failed Open reconciles the retained document", async () => {
  const rendered = await renderContinuityApp();
  try {
    const failedOpen = deferred();
    const reconciliation = deferred();
    const external = `${rendered.diskContent()}\n\nChanged while Open failed.`;
    rendered.setOpenDialogPath("/tmp/other.md");
    rendered.deferNextOpen(failedOpen);
    rendered.clearOperationLog();

    dispatchShortcut("o");
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));
    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    assert.deepEqual(rendered.operationLog(), ["open"]);
    rendered.deferNextOpen(reconciliation);

    await act(async () => {
      failedOpen.reject(new Error("Open failed"));
      try { await failedOpen.promise; } catch { /* expected */ }
    });
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open", "open"]));
    assert.equal(rendered.openedPaths().at(-1), "/tmp/continuity.md");
    await act(async () => {
      reconciliation.resolve(rendered.openResult(external, rendered.revision() + 1));
      await reconciliation.promise;
    });
    await waitFor(() => assert.match(
      rendered.host.querySelector("article").textContent,
      /Changed while Open failed/,
    ));
  } finally {
    await rendered.cleanup();
  }
});

test("presentation defers watcher reconciliation until the reader returns", async () => {
  const originalMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  const rendered = await renderContinuityApp();
  try {
    const reconciliation = deferred();
    const externalWords = `${rendered.diskContent()}\n\nExternal presentation words.`;
    rendered.deferNextOpen(reconciliation);
    rendered.clearOperationLog();

    const exportButton = rendered.host.querySelector('[aria-label="Export options"]');
    assert.ok(exportButton);
    flushSync(() => exportButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    const presentButton = Array.from(rendered.host.querySelectorAll('[role="group"][aria-label="Export options"] button'))
      .find((button) => button.textContent.includes("Present as Slides"));
    assert.ok(presentButton);
    assert.equal(presentButton.disabled, false);
    flushSync(() => presentButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    await waitFor(() => assert.ok(rendered.host.querySelector(".presentation-overlay")));
    await act(async () => {
      await emit("file-changed", { path: "/tmp/continuity.md" });
      await Promise.resolve();
    });
    assert.deepEqual(rendered.operationLog(), []);

    dispatchWindowKey("Escape");
    await waitFor(() => assert.deepEqual(rendered.operationLog(), ["open"]));
    await act(async () => {
      reconciliation.resolve(rendered.openResult(externalWords, rendered.revision() + 1));
      await reconciliation.promise;
    });
    await waitFor(() => assert.match(
      rendered.host.querySelector("article").textContent,
      /External presentation words/,
    ));
  } finally {
    await rendered.cleanup();
    globalThis.matchMedia = originalMatchMedia;
  }
});

test("reader progress is repopulated when its unchanged-content span remounts", async () => {
  const rendered = await renderContinuityApp();
  try {
    const main = rendered.host.querySelector("main");
    main.scrollTop = 500;
    main.dispatchEvent(new window.Event("scroll"));
    await waitFor(() => assert.match(rendered.host.querySelector("header").textContent, /31%/));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.doesNotMatch(rendered.host.querySelector("header").textContent, /31%/);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    await waitFor(() => assert.match(rendered.host.querySelector("header").textContent, /31%/));
  } finally {
    await rendered.cleanup();
  }
});

test("focus mode progress is populated without the standard progress bar", async () => {
  const rendered = await renderContinuityApp();
  try {
    const main = rendered.host.querySelector("main");
    main.scrollTop = 500;
    main.dispatchEvent(new window.Event("scroll"));
    await waitFor(() => assert.match(rendered.host.querySelector("header").textContent, /31%/));

    const focusEvent = dispatchWindowKey("f", { ctrlKey: true, shiftKey: true });
    assert.equal(focusEvent.defaultPrevented, true);
    await waitFor(() => assert.ok(!rendered.host.querySelector("header")));
    assert.match(rendered.host.textContent, /31%/);
  } finally {
    await rendered.cleanup();
  }
});

test("changed reconciliation updates reader content and performs one corrective restoration", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3 } });
    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));

    rendered.host.querySelector("main").scrollTop = 123;
    const externallyChanged = `${rendered.diskContent()}\n\nExternal words.`;
    await act(async () => {
      reconciliation.resolve(rendered.openResult(externallyChanged, rendered.revision() + 1));
      await reconciliation.promise;
    });
    await waitFor(() => assert.match(rendered.host.querySelector("article").textContent, /External words/));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 500));
  } finally {
    await rendered.cleanup();
  }
});

test("annotation highlights are reapplied after an unchanged reader remount", async () => {
  const rendered = await renderContinuityApp({
    storedHighlights: [{
      id: "opening-highlight",
      prefix: "",
      exact: "Opening words",
      suffix: ".",
      color: "yellow",
      createdAt: 1,
      nearestHeadingId: "first",
    }],
  });
  try {
    await waitFor(() => assert.equal(
      rendered.host.querySelectorAll('mark[data-highlight-id="opening-highlight"]').length,
      1,
    ));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await waitFor(() => assert.equal(
      rendered.host.querySelectorAll('mark[data-highlight-id="opening-highlight"]').length,
      1,
    ));
    reconciliation.resolve(rendered.openResult());
  } finally {
    await rendered.cleanup();
  }
});

test("rapid re-entry supersedes stale reconciliation content and target publication", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const staleReconciliation = deferred();
    rendered.deferNextOpen(staleReconciliation);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const activeView = findEditorView(rendered.host);
    const activeText = activeView.state.sliceDoc();
    const scrollCount = rendered.scrolledIds.length;
    await act(async () => {
      staleReconciliation.resolve(rendered.openResult("# Stale external\n\nWrong reader content.", rendered.revision() + 1));
      await staleReconciliation.promise;
    });
    assert.equal(activeView.state.sliceDoc(), activeText);
    assert.equal(rendered.scrolledIds.length, scrollCount);

    const currentReconciliation = deferred();
    rendered.deferNextOpen(currentReconciliation);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    assert.doesNotMatch(rendered.host.querySelector("article").textContent, /Wrong reader content/);
    currentReconciliation.resolve(rendered.openResult());
  } finally {
    await rendered.cleanup();
  }
});

test("ambiguous missing and unavailable reconciliation keep the reader document recoverable", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    let reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await act(async () => {
      reconciliation.reject(new Error("Permission denied"));
      try { await reconciliation.promise; } catch { /* expected */ }
    });
    await waitFor(() => assert.match(rendered.host.textContent, /Permission denied/));
    assert.ok(rendered.host.querySelector("article"));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await act(async () => {
      reconciliation.reject({
        category: "notFound",
        operation: "resolveDocument",
        message: "This file is no longer available.",
        detail: "/tmp/continuity.md: No such file or directory",
      });
      try { await reconciliation.promise; } catch { /* expected */ }
    });
    await waitFor(() => assert.match(rendered.host.textContent, /no longer available/));
    assert.doesNotMatch(rendered.host.textContent, /deleted outside Bindars/);
    assert.ok(rendered.host.querySelector("article"));
    assert.match(rendered.host.querySelector("article").textContent, /Opening words/);

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchShortcut("e");
    await act(async () => {
      reconciliation.reject({
        category: "resourceUnavailable",
        operation: "readDocument",
        message: "The resource is temporarily unavailable, so Bindars could not read the document.",
        detail: "/tmp/continuity.md: operation timed out",
      });
      try { await reconciliation.promise; } catch { /* expected */ }
    });
    await waitFor(() => assert.match(rendered.host.textContent, /temporarily unavailable/));
    assert.doesNotMatch(rendered.host.textContent, /deleted outside Bindars/);
    assert.ok(rendered.host.querySelector("article"));
  } finally {
    await rendered.cleanup();
  }
});

test("discard and conflict reload restore the original reader anchor", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    let view = updateEditor(rendered.host, `${rendered.diskContent()}\n\n## Discarded\nWords`);
    view.dispatch({ selection: { anchor: view.state.doc.line(9).from + 3 } });
    const failedBoundarySave = deferred();
    rendered.deferNextWrite(failedBoundarySave);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(failedBoundarySave.args));
    await act(async () => {
      failedBoundarySave.reject(new Error("disk full"));
      try { await failedBoundarySave.promise; } catch { /* expected */ }
    });
    const discardDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      return dialog;
    });
    clickButton(rendered.host, "Discard", discardDialog);
    await waitFor(() => assert.ok(rendered.host.querySelector("#first")));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 0));
    assert.ok(!rendered.host.querySelector("#discarded"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, `${rendered.diskContent()}\n\n## Conflicting\nUnsaved words.`);
    await waitForEditorPublication();
    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const conflictDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, /File changed/);
      return dialog;
    });
    clickButton(rendered.host, "Reload", conflictDialog);
    await waitFor(() => assert.ok(rendered.host.querySelector("#first")));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 0));
    assert.ok(!rendered.host.querySelector("#conflicting"));
  } finally {
    await rendered.cleanup();
  }
});

test("manual conflict overwrite reconfirms newer typing without exiting edit mode", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "# Manual overwrite\n\nFirst local snapshot.");
    await waitForEditorPublication();

    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const conflictDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, /File changed/);
      return dialog;
    });

    const overwrite = deferred();
    rendered.deferNextWrite(overwrite);
    clickButton(rendered.host, "Overwrite", conflictDialog);
    await waitFor(() => assert.equal(overwrite.args?.force, true));
    updateEditor(rendered.host, "# Manual overwrite\n\nNewer words typed during overwrite.");

    await act(async () => {
      overwrite.resolve({
        conflict: false,
        canonicalPath: "/tmp/continuity.md",
        name: "continuity.md",
        currentRevision: { mtimeMs: 3, size: overwrite.args.content.length, contentHash: "overwrite" },
      });
      await overwrite.promise;
    });

    const reconfirmDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, /Unsaved changes/);
      return dialog;
    });
    clickButton(rendered.host, "Save", reconfirmDialog);

    await waitFor(() => assert.match(rendered.diskContent(), /Newer words typed during overwrite/));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    assert.ok(rendered.host.querySelector(".cm-editor"));
    assert.equal(
      findEditorView(rendered.host).state.sliceDoc(),
      "# Manual overwrite\n\nNewer words typed during overwrite.",
    );
  } finally {
    await rendered.cleanup();
  }
});

test("exit conflict overwrite reconfirms newer typing before completing the exit", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "# Exit overwrite\n\nFirst local snapshot.");
    await waitForEditorPublication();

    rendered.conflictNextWrite();
    dispatchShortcut("e");
    const conflictDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, /File changed/);
      return dialog;
    });
    const overwrite = deferred();
    rendered.deferNextWrite(overwrite);
    clickButton(rendered.host, "Overwrite", conflictDialog);
    await waitFor(() => assert.equal(overwrite.args?.force, true));
    updateEditor(rendered.host, "# Exit overwrite\n\nNewer words typed during overwrite.");

    await act(async () => {
      overwrite.resolve({
        conflict: false,
        canonicalPath: "/tmp/continuity.md",
        name: "continuity.md",
        currentRevision: { mtimeMs: 3, size: overwrite.args.content.length, contentHash: "overwrite" },
      });
      await overwrite.promise;
    });

    const reconfirmDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.match(dialog.textContent, /Unsaved changes/);
      return dialog;
    });
    clickButton(rendered.host, "Save", reconfirmDialog);

    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    assert.match(rendered.host.querySelector("article").textContent, /Newer words typed during overwrite/);
  } finally {
    await rendered.cleanup();
  }
});

test("a stale exit reload cannot restore into a newer virtual session", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const staleReload = deferred();
    rendered.deferNextOpen(staleReload);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    const scrollCount = rendered.scrolledIds.length;
    dispatchShortcut("n");
    await waitFor(() => assert.equal(findEditorView(rendered.host).state.sliceDoc(), ""));
    await act(async () => {
      staleReload.resolve({
        canonicalPath: "/tmp/continuity.md",
        name: "continuity.md",
        content: rendered.diskContent(),
        revision: {
          mtimeMs: rendered.revision(),
          size: rendered.diskContent().length,
          contentHash: `r${rendered.revision()}`,
        },
      });
      await Promise.resolve();
    });
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), "");
    assert.equal(rendered.scrolledIds.length, scrollCount);
  } finally {
    await rendered.cleanup();
  }
});

test("virtual save-as scopes restoration to the adopted document", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = updateEditor(rendered.host, "# Virtual\n\n## Kept\nSaved after adoption.");
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 3 } });
    dispatchShortcut("e");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      return candidate;
    });
    clickButton(rendered.host, "Save", dialog);
    await waitFor(() => assert.ok(rendered.host.querySelector("#kept")));
    await waitFor(() => assert.equal(rendered.readerScrollTop(), 300));
  } finally {
    await rendered.cleanup();
  }
});

test("heading restoration uses the canonical path returned by open", async () => {
  const rendered = await renderContinuityApp({
    requestedPath: "/tmp/link-to-continuity.md",
    canonicalPath: "/canonical/continuity.md",
    restoreHeadingId: "second",
  });
  try {
    await waitFor(() => assert.equal(rendered.scrolledIds.at(-1), "second"));
    assert.match(rendered.host.textContent, /continuity\.md/);
  } finally {
    await rendered.cleanup();
  }
});

test("discarding a dirty draft captures the abandoned words before the session ends", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const abandonedWords = "Words the user is about to throw away";
    updateEditor(rendered.host, abandonedWords);
    await waitForEditorPublication();

    dispatchShortcut("e");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);

    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => (
        write.document.kind === "draft"
        && write.content === abandonedWords
        && write.preservePrevious === true
      )));
    });
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    await rendered.cleanup();
  }
});

test("conflict reload captures the local words before showing external bytes", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const localWords = `${rendered.diskContent()}\n\nLocal words lost to the reload.`;
    updateEditor(rendered.host, localWords);
    await waitForEditorPublication();

    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const conflictDialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /File changed/);
      return candidate;
    });
    clickButton(rendered.host, "Reload", conflictDialog);

    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => (
        write.document.kind === "file"
        && write.content === localWords
        && write.preservePrevious === true
      )));
    });
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    await rendered.cleanup();
  }
});

test("a failed discard capture warns and never blocks the discard", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Words that will fail to snapshot");
    await waitForEditorPublication();
    // Let the automatic first-edit snapshot land so the armed failure hits
    // the discard capture, not the automatic write.
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.document.kind === "draft"));
    });

    rendered.failNextSnapshotWrite(new Error("app-data unavailable"));
    dispatchShortcut("e");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);

    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    await waitFor(() => {
      assert.match(rendered.host.textContent, /Couldn't snapshot the discarded text/);
    });
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    const attemptedCaptures = rendered.snapshotWrites().filter((write) => (
      write.document.kind === "draft"
      && write.content === "Words that will fail to snapshot"
      && write.preservePrevious === true
    ));
    assert.equal(attemptedCaptures.length, 1, "exactly one capture attempt, no retry");
  } finally {
    await rendered.cleanup();
  }
});

test("native close waits for the queued discard capture before destroying the window", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "First draft words");
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => (
        write.document.kind === "draft" && write.content === "First draft words"
      )));
    });

    const slowWrite = deferred();
    rendered.deferNextSnapshotWrite(slowWrite);
    const newestWords = "First draft words, then the newest unsaved line";
    updateEditor(rendered.host, newestWords);

    await act(async () => {
      await emit("tauri://close-requested");
    });
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);

    // The capture write is deferred and still pending; the window must wait.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.windowCloseCount(), 0);

    await act(async () => {
      slowWrite.resolve(successfulSnapshotWrite(slowWrite.args));
      await slowWrite.promise;
    });

    await waitFor(() => assert.equal(rendered.windowCloseCount(), 1));
    assert.ok(rendered.snapshotWrites().some((write) => (
      write.document.kind === "draft"
      && write.content === newestWords
      && write.preservePrevious === true
    )));

    // Model the close-requested event that Tauri emits after appWindow.close().
    // With no newer editor, the programmatic close may now destroy the window.
    await act(async () => {
      await emit("tauri://close-requested");
    });
    await waitFor(() => assert.equal(rendered.windowDestroyCount(), 1));
  } finally {
    await rendered.cleanup();
  }
});

test("the restore list is not populated before queued snapshot writes land", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const localWords = `${rendered.diskContent()}\n\nLocal words behind the slow capture.`;
    updateEditor(rendered.host, localWords);
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.content === localWords));
    });

    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const conflictDialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /File changed/);
      return candidate;
    });
    const slowCapture = deferred();
    rendered.deferNextSnapshotWrite(slowCapture);
    clickButton(rendered.host, "Reload", conflictDialog);
    await waitFor(() => assert.ok(slowCapture.args));
    assert.equal(slowCapture.args.preservePrevious, true);
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));

    const restoreButton = rendered.host.querySelector('button[aria-label="Restore snapshot"]');
    assert.ok(restoreButton);
    flushSync(() => restoreButton.click());
    await waitFor(() => {
      assert.match(rendered.host.querySelector('[role="dialog"]').textContent, /Loading snapshots/);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      rendered.host.querySelector('[role="dialog"]').textContent,
      /Loading snapshots/,
      "the list must wait for the pending capture",
    );
    assert.equal(
      rendered.documentSnapshotListCount(),
      0,
      "the backend list call must wait for the pending capture",
    );

    await act(async () => {
      slowCapture.resolve(successfulSnapshotWrite(slowCapture.args));
      await slowCapture.promise;
    });
    await waitFor(() => assert.equal(rendered.documentSnapshotListCount(), 1));
    await waitFor(() => {
      assert.match(
        rendered.host.querySelector('[role="dialog"]').textContent,
        /No snapshots have been captured/,
      );
    });
  } finally {
    await rendered.cleanup();
  }
});

test("the discard capture flushes typing that was never published", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Published base words");
    await waitForEditorPublication();

    dispatchShortcut("e");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    // Newer typing that never reaches a publication cycle before Discard.
    const unpublishedWords = "Published base words, plus an unpublished tail";
    updateEditor(rendered.host, unpublishedWords);
    clickButton(rendered.host, "Discard", dialog);

    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => (
        write.document.kind === "draft"
        && write.content === unpublishedWords
        && write.preservePrevious === true
      )));
    });
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
  } finally {
    await rendered.cleanup();
  }
});

test("a repeated native close during the snapshot drain cannot destroy the window", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "First draft words");
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.document.kind === "draft"));
    });

    const slowCapture = deferred();
    rendered.deferNextSnapshotWrite(slowCapture);
    const newestWords = "First draft words, plus the words at risk";
    updateEditor(rendered.host, newestWords);

    await act(async () => {
      await emit("tauri://close-requested");
    });
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);
    await waitFor(() => assert.ok(slowCapture.args));

    // Editing has ended and the capture is still pending. A second native
    // close must be held, not treated as a clean-window close.
    await act(async () => {
      await emit("tauri://close-requested");
    });
    assert.equal(rendered.windowDestroyCount(), 0);
    assert.equal(rendered.windowCloseCount(), 0);

    await act(async () => {
      slowCapture.resolve(successfulSnapshotWrite(slowCapture.args));
      await slowCapture.promise;
    });

    await waitFor(() => assert.equal(rendered.windowCloseCount(), 1));
    assert.equal(rendered.windowDestroyCount(), 0);
    assert.ok(rendered.snapshotWrites().some((write) => (
      write.document.kind === "draft"
      && write.content === newestWords
      && write.preservePrevious === true
    )));
  } finally {
    await rendered.cleanup();
  }
});

test("a dirty session begun during the close drain aborts the scheduled close", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Draft words before the close");
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.document.kind === "draft"));
    });

    const slowCapture = deferred();
    rendered.deferNextSnapshotWrite(slowCapture);
    await act(async () => {
      await emit("tauri://close-requested");
    });
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);
    await waitFor(() => assert.ok(slowCapture.args));

    // The user changes their mind while the capture drains: a new dirty
    // session must survive the stale close continuation.
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const secondThoughts = "Second thoughts typed during the drain";
    updateEditor(rendered.host, secondThoughts);
    await waitForEditorPublication();

    await act(async () => {
      slowCapture.resolve(successfulSnapshotWrite(slowCapture.args));
      await slowCapture.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(rendered.windowCloseCount(), 0);
    assert.equal(rendered.windowDestroyCount(), 0);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), secondThoughts);
  } finally {
    await rendered.cleanup();
  }
});

test("a session begun during the programmatic-close handoff prevents destruction", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Draft words before the close handoff");
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.document.kind === "draft"));
    });

    const slowCapture = deferred();
    rendered.deferNextSnapshotWrite(slowCapture);
    await act(async () => {
      await emit("tauri://close-requested");
    });
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);
    await waitFor(() => assert.ok(slowCapture.args));

    await act(async () => {
      slowCapture.resolve(successfulSnapshotWrite(slowCapture.args));
      await slowCapture.promise;
    });
    await waitFor(() => assert.equal(rendered.windowCloseCount(), 1));

    // Tauri has accepted appWindow.close(), but its resulting close-requested
    // callback has not reached the WebView yet. A new session in this handoff
    // window must still cancel destruction.
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const handoffWords = "Words typed after close IPC but before its callback";
    updateEditor(rendered.host, handoffWords);

    await act(async () => {
      await emit("tauri://close-requested");
    });

    assert.equal(rendered.windowDestroyCount(), 0);
    assert.equal(rendered.windowCloseCount(), 1);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), handoffWords);
  } finally {
    await rendered.cleanup();
  }
});

test("a failed capture at the close boundary creates one warning and requests one close", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Draft words that will fail to capture");
    await waitForEditorPublication();
    await waitFor(() => {
      assert.ok(rendered.snapshotWrites().some((write) => write.document.kind === "draft"));
    });

    await act(async () => {
      await emit("tauri://close-requested");
    });
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      assert.match(candidate.textContent, /Unsaved changes/);
      return candidate;
    });
    rendered.failNextSnapshotWrite(new Error("app-data unavailable"));
    clickButton(rendered.host, "Discard", dialog);

    await waitFor(() => assert.equal(rendered.windowCloseCount(), 1));
    assert.equal(rendered.windowDestroyCount(), 0);
    await waitFor(() => {
      assert.match(rendered.host.textContent, /Couldn't snapshot the discarded text/);
    });
    const attemptedCaptures = rendered.snapshotWrites().filter((write) => (
      write.document.kind === "draft" && write.preservePrevious === true
    ));
    assert.equal(attemptedCaptures.length, 1);
  } finally {
    await rendered.cleanup();
  }
});

const paletteWorkspaceFiles = ["Alpha.md", "Beta.md"].map((name) => ({
  path: `/tmp/${name}`, relPath: name, name, mtimeMs: 1, size: 10,
}));

test("palette result buttons keep native activation after Tab focus and ArrowDown", async () => {
  const rendered = await renderContinuityApp({ workspaceFiles: paletteWorkspaceFiles });
  try {
    dispatchShortcut("k");
    await waitFor(() => assert.equal(rendered.host.querySelectorAll('.command-palette-shell li button').length, 2));
    const rows = rendered.host.querySelectorAll('.command-palette-shell li button');
    const second = rows[1];
    flushSync(() => second.focus()); // Native Tab traversal is checked in the packaged app.
    assert.ok(second.classList.contains("bg-bg-tertiary"));
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
      assert.equal(dispatchElementKey(second, key).defaultPrevented, false, key);
      assert.ok(document.activeElement === second);
      assert.ok(second.classList.contains("bg-bg-tertiary"));
    }
    assert.equal(rendered.host.querySelectorAll('.command-palette-shell').length, 1,
      "App must not activate its selected hit from a result-button keydown");
    const before = rendered.openedPaths().length;
    // happy-dom does not synthesize native Enter/Space clicks; exercise the allowed click path.
    flushSync(() => second.click());
    await waitFor(() => assert.equal(rendered.openedPaths().length, before + 1));
    assert.equal(rendered.openedPaths().at(-1), "/tmp/Beta.md");
  } finally { await rendered.cleanup(); }
});

test("palette input retains arrow selection and Enter activation", async () => {
  const rendered = await renderContinuityApp({ workspaceFiles: paletteWorkspaceFiles });
  try {
    dispatchShortcut("k");
    await waitFor(() => assert.equal(rendered.host.querySelectorAll('.command-palette-shell li button').length, 2));
    const input = rendered.host.querySelector('.command-palette-shell input');
    assert.equal(dispatchElementKey(input, "ArrowDown").defaultPrevented, true);
    assert.ok(document.activeElement === input);
    assert.ok(rendered.host.querySelectorAll('.command-palette-shell li button')[1].classList.contains("bg-bg-tertiary"));
    assert.equal(dispatchElementKey(input, "Enter").defaultPrevented, true);
    await waitFor(() => assert.equal(rendered.openedPaths().at(-1), "/tmp/Beta.md"));
  } finally { await rendered.cleanup(); }
});

test("App preserves shortcuts under Cmd+K and dismisses one dialog per Escape", async () => {
  const rendered = await renderEditorApp({ startNew: false });
  try {
    const opener = rendered.host.querySelector("button");
    opener.focus();
    dispatchWindowKey("?");
    const close = rendered.host.querySelector('[role="dialog"] button');
    assert.ok(document.activeElement === close);
    dispatchShortcut("k");
    assert.equal(rendered.host.querySelectorAll('[role="dialog"]').length, 2);
    dispatchElementKey(document.activeElement, "Escape");
    assert.equal(rendered.host.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(document.activeElement === close);
    dispatchElementKey(close, "Escape");
    assert.equal(rendered.host.querySelectorAll('[role="dialog"]').length, 0);
    assert.ok(document.activeElement === opener);
  } finally { await rendered.cleanup(); }
});
