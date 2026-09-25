const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { act } = React;
const { undo } = require("@codemirror/commands");
const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
const { emit, TauriEvent } = require("@tauri-apps/api/event");
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
const realSetTimeout = setTimeout;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const DRAFT_PATH = "/tmp/Documents/Bindars Drafts/Untitled 2.md";

function successfulDraftWrite(content) {
  return {
    conflict: false, canonicalPath: DRAFT_PATH, name: "Untitled 2.md",
    currentRevision: { mtimeMs: 2, size: content.length, contentHash: "created-draft" },
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
        await new Promise((resolve) => realSetTimeout(resolve, 0));
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

async function pauseDraftAutosave(rendered) {
  // These guard tests need a failed automatic save before exercising the
  // existing Save/Discard/Cancel boundary.
  rendered.failNextDraftCreate(new Error("Draft creation unavailable for this guard test"));
  dispatchShortcut("e");
  await waitFor(() => assert.ok(rendered.host.querySelector('[role="dialog"]')));
  dispatchWindowKey("Escape");
  await waitFor(() => assert.ok(!rendered.host.querySelector('[role="dialog"]')));
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
    if (request.endsWith("welcome.md?raw")) return "# Welcome fixture\n\nSave with {{shortcut:saveFile}}.";
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
  waitUntilReady = true,
  strictMode = false,
  withActivity = false,
  themeGet,
  themeLocal,
  themeLocalLegacy,
  createDraft = (args) => successfulDraftWrite(args.content),
  deleteDraft = (args) => args.path !== args.savedPath,
  loadAnnotations = () => null,
  saveDialogPath = "/tmp/recovered-r7.md",
  savedCanonicalPath = saveDialogPath,
  saveDialog = () => saveDialogPath,
} = {}) {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
  const fileWrites = [];
  const draftCreates = [];
  const draftDeletes = [];
  const saveDialogs = [];
  const windowTitles = [];
  const operationLog = [];
  let fileWriteError = null;
  let windowCloseCount = 0;
  let guardedExitCount = 0;
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "load_annotations":
        return loadAnnotations(args);
      case "save_annotations":
      case "plugin:store|save":
        return null;
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "theme" && themeGet !== undefined) {
          return themeGet;
        }
        if (args.key === "recent-files") return [{ version: 1, files: [] }, true];
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
        windowTitles.push(args.value);
        return null;
      case "plugin:window|close":
        windowCloseCount += 1;
        return null;
      case "exit_after_guarded_quit":
        guardedExitCount += 1;
        return null;
      case "create_draft_document":
        draftCreates.push(args);
        return createDraft(args);
      case "is_draft_document":
        return args.path === DRAFT_PATH;
      case "delete_draft_document":
        draftDeletes.push(args);
        operationLog.push("delete");
        return deleteDraft(args);
      case "plugin:dialog|save":
        saveDialogs.push(args);
        return saveDialog();
      case "write_markdown_file_if_unmodified": {
        fileWrites.push(args);
        operationLog.push("write");
        if (fileWriteError) {
          const error = fileWriteError;
          fileWriteError = null;
          throw error;
        }
        const path = args.force ? savedCanonicalPath : args.path;
        return { conflict: false, canonicalPath: path, name: path.split("/").at(-1),
          currentRevision: { mtimeMs: 3, size: args.content.length, contentHash: "saved-file" } };
      }
      case "authorize_document_images":
      case "watch_file":
      case "unwatch_file":
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

  const app = React.createElement(App);
  const renderedApp = onRender
    ? React.createElement(React.Profiler, { id: "App", onRender }, app)
    : app;
  const render = (activityMode = "visible") => {
    const appContent = withActivity
      ? React.createElement(React.Activity, { mode: activityMode }, renderedApp)
      : renderedApp;
    const content = React.createElement(ToastProvider, null, appContent);
    root.render(strictMode ? React.createElement(React.StrictMode, null, content) : content);
  };
  flushSync(() => render());
  if (waitUntilReady) await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));
  if (startNew) {
    dispatchShortcut("n");
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));
    // The editor can mount before the admitted New action releases its guard.
    await waitFor(() => assert.equal(host.querySelector('[aria-label="Read mode"]')?.disabled, false));
  }

  return {
    host,
    storeWrites,
    fileWrites,
    draftCreates,
    draftDeletes,
    saveDialogs,
    windowTitles,
    operationLog,
    setActivityMode(mode) { flushSync(() => render(mode)); },
    failNextFileWrite(error) { fileWriteError = error; },
    windowCloseCount: () => windowCloseCount,
    guardedExitCount: () => guardedExitCount,
    async cleanup() {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      host.remove();
      window.localStorage.removeItem("bindars-theme");
      window.localStorage.removeItem("markdown-reader-theme");
      window.matchMedia = originalMatchMedia;
      globalThis.IntersectionObserver = originalIntersectionObserver;
      clearMocks();
    },
  };
}

test("new document autosave creates a draft, keeps typing intact, and uses its revision next", async (context) => {
  const creation = deferred();
  const rendered = await renderEditorApp({ createDraft: () => creation.promise });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    const initial = "# New draft\n\nBefore autosave.";
    const view = updateEditor(rendered.host, initial);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2499));
    assert.deepEqual(rendered.draftCreates, []);
    await act(async () => context.mock.timers.tick(1));
    assert.deepEqual(rendered.draftCreates, [{ content: initial }]);
    assert.deepEqual(rendered.saveDialogs, []);

    const newer = `${initial}\nTyped while the draft write waits.`;
    updateEditor(rendered.host, newer);
    view.dispatch({ selection: { anchor: 4, head: 12 } });
    view.focus();
    await act(async () => creation.resolve(successfulDraftWrite(initial)));
    await waitFor(() => assert.match(rendered.windowTitles.at(-1), /Untitled 2\.md/));
    assert.ok(findEditorView(rendered.host) === view, "draft adoption keeps the editor mounted");
    assert.equal(view.state.sliceDoc(), newer);
    assert.equal(view.state.selection.main.anchor, 4);
    assert.equal(view.state.selection.main.head, 12);
    assert.ok(document.activeElement === view.contentDOM, "draft adoption keeps editor focus");
    assert.ok(rendered.storeWrites.some((write) => write.key === "recent-files"
      && write.value.files.some((file) => file.path === DRAFT_PATH)));

    await act(async () => context.mock.timers.tick(2500));
    assert.equal(rendered.fileWrites.length, 1);
    assert.equal(rendered.fileWrites[0].path, DRAFT_PATH);
    assert.equal(rendered.fileWrites[0].content, newer);
    assert.deepEqual(rendered.fileWrites[0].expectedRevision, successfulDraftWrite(initial).currentRevision);
    assert.equal(rendered.fileWrites[0].force, false);
    assert.equal(rendered.draftCreates.length, 1);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    creation.resolve(successfulDraftWrite(""));
    context.mock.timers.reset();
    await rendered.cleanup();
  }
});

test("new document emptied before autosave creates no draft file", async (context) => {
  const rendered = await renderEditorApp();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    updateEditor(rendered.host, "Temporary words");
    await act(async () => context.mock.timers.tick(200));
    updateEditor(rendered.host, "");
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    assert.deepEqual(rendered.draftCreates, []);
    assert.deepEqual(rendered.fileWrites, []);
    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));
  } finally {
    context.mock.timers.reset();
    await rendered.cleanup();
  }
});

for (const boundary of ["close", "quit"]) {
  test(`new document ${boundary} creates its draft before the idle delay without a dialog`, async () => {
    const rendered = await renderEditorApp();
    try {
      const content = `Pending ${boundary} words not yet published`;
      updateEditor(rendered.host, content);
      await act(async () => emit(boundary === "close" ? "tauri://close-requested" : "bindars://quit-requested"));
      await waitFor(() => assert.equal(boundary === "close" ? rendered.windowCloseCount() : rendered.guardedExitCount(), 1));
      assert.deepEqual(rendered.draftCreates, [{ content }]);
      assert.deepEqual(rendered.saveDialogs, []);
      assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    } finally { await rendered.cleanup(); }
  });
}

for (const [cause, error] of [
  ["draft folder unavailable", new Error("Draft folder unavailable")],
  ["annotation lookup failed", {
    category: "unknown",
    operation: "accessRecoveryData",
    message: "Couldn't access annotation storage. Existing data was preserved.",
    detail: "Couldn't read annotations.json: Permission denied",
  }],
]) {
  test(`failed draft autosave (${cause}) pauses once and manual Save still opens Save As`, async (context) => {
    const rendered = await renderEditorApp({ createDraft: () => { throw error; } });
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    try {
      const content = "Keep this draft after a failed autosave";
      updateEditor(rendered.host, content);
      await act(async () => context.mock.timers.tick(200));
      await act(async () => context.mock.timers.tick(2500));
      assert.equal(rendered.draftCreates.length, 1);
      assert.match(rendered.host.textContent, /Autosave is paused/);
      updateEditor(rendered.host, `${content}\nMore typing after failure`);
      await act(async () => context.mock.timers.tick(200));
      await act(async () => context.mock.timers.tick(300_000));
      assert.equal(rendered.draftCreates.length, 1);
      assert.deepEqual(rendered.saveDialogs, []);
      dispatchShortcut("s");
      await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
      assert.equal(rendered.saveDialogs.length, 1);
      assert.equal(rendered.fileWrites[0].content, `${content}\nMore typing after failure`);
      assert.deepEqual(rendered.draftDeletes, []);
    } finally {
      context.mock.timers.reset();
      await rendered.cleanup();
    }
  });
}

test("manual Save waiting on the first draft autosave moves the adopted draft", async (context) => {
  const creation = deferred();
  const dialog = deferred();
  const loads = [];
  const rendered = await renderEditorApp({
    createDraft: () => creation.promise,
    saveDialog: () => dialog.promise,
    loadAnnotations: (args) => { loads.push(args.path); return null; },
  });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    const content = "Save while the first draft is still being created";
    updateEditor(rendered.host, content);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    assert.equal(rendered.draftCreates.length, 1);
    dispatchShortcut("s");
    assert.deepEqual(rendered.saveDialogs, []);
    await act(async () => creation.resolve(successfulDraftWrite(content)));
    await waitFor(() => assert.equal(rendered.saveDialogs.length, 1));
    // A person choosing a location gives the new draft's empty record time to load.
    await waitFor(() => assert.deepEqual(loads, [DRAFT_PATH]));
    await act(async () => new Promise(setImmediate));
    await act(async () => dialog.resolve("/tmp/recovered-r7.md"));
    await waitFor(() => assert.deepEqual(rendered.draftDeletes, [{ path: DRAFT_PATH, savedPath: "/tmp/recovered-r7.md" }]));
    assert.equal(rendered.saveDialogs.length, 1);
    assert.equal(rendered.fileWrites.length, 1);
    assert.equal(rendered.fileWrites[0].content, content);
    assert.equal(rendered.fileWrites[0].path, "/tmp/recovered-r7.md");
    assert.deepEqual(rendered.operationLog, ["write", "delete"]);
  } finally {
    creation.resolve(successfulDraftWrite(""));
    dialog.resolve(null);
    context.mock.timers.reset();
    await rendered.cleanup();
  }
});

test("manual Save waits for a reopened draft's pending classification", async () => {
  const classification = deferred();
  const rendered = await renderContinuityApp({
    requestedPath: DRAFT_PATH,
    checkDraft: () => classification.promise,
  });
  try {
    assert.deepEqual(rendered.draftChecks(), [DRAFT_PATH]);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    await waitFor(() => assert.ok(rendered.draftChecks().length > 0));
    const content = findEditorView(rendered.host).state.sliceDoc();
    dispatchShortcut("s");
    dispatchShortcut("s");
    await act(async () => Promise.resolve());
    assert.deepEqual(rendered.saveDialogs(), []);
    assert.deepEqual(rendered.fileWrites(), []);
    await act(async () => classification.resolve(true));
    await waitFor(() => assert.deepEqual(rendered.draftDeletes(), [{ path: DRAFT_PATH, savedPath: "/tmp/virtual-continuity.md" }]));
    assert.equal(rendered.saveDialogs().length, 1);
    assert.deepEqual(rendered.draftChecks(), [DRAFT_PATH, "/tmp/virtual-continuity.md"], "Save reuses the existing draft classification");
    assert.equal(rendered.fileWrites()[0].content, content);
    assert.equal(rendered.fileWrites()[0].path, "/tmp/virtual-continuity.md");
  } finally {
    classification.resolve(true);
    await rendered.cleanup();
  }
});

for (const classificationFails of [false, true]) {
  test(`ordinary Save neither reclassifies nor deletes its file when draft lookup ${classificationFails ? "rejects" : "returns false"}`, async () => {
    const rendered = await renderContinuityApp({
      checkDraft: () => classificationFails ? Promise.reject(new Error("Draft lookup unavailable")) : false,
    });
    try {
      await waitFor(() => assert.deepEqual(rendered.draftChecks(), ["/tmp/continuity.md"]));
      dispatchShortcut("e");
      await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
      for (const content of ["First ordinary save", "Second ordinary save"]) {
        updateEditor(rendered.host, content);
        dispatchShortcut("s");
        await waitFor(() => assert.equal(rendered.diskContent(), content));
      }
      assert.deepEqual(rendered.draftChecks(), ["/tmp/continuity.md"]);
      assert.deepEqual(rendered.draftDeletes(), []);
      assert.deepEqual(rendered.saveDialogs(), []);
      assert.equal(rendered.fileWrites().length, 2);
      assert.ok(rendered.fileWrites().every((write) => write.path === "/tmp/continuity.md" && write.force === false));
      assert.equal(rendered.host.querySelectorAll('[role="status"] [role="alert"]').length, 0);
    } finally { await rendered.cleanup(); }
  });
}

test("a stale Save As dialog leaves the draft intact when a newer session starts", async () => {
  const dialog = deferred();
  const rendered = await renderEditorApp({ saveDialog: () => dialog.promise });
  try {
    updateEditor(rendered.host, "Old draft retained after switching sessions");
    dispatchShortcut("e");
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.saveDialogs.length, 1));
    dispatchShortcut("n");
    await waitFor(() => assert.equal(findEditorView(rendered.host).state.sliceDoc(), ""));
    updateEditor(rendered.host, "New session words must not be saved by the old dialog");
    await act(async () => dialog.resolve("/tmp/stale-save-as.md"));
    assert.deepEqual(rendered.fileWrites, []);
    assert.deepEqual(rendered.draftDeletes, []);
    const recent = rendered.storeWrites.filter((write) => write.key === "recent-files").at(-1);
    assert.deepEqual(recent.value.files.map((file) => file.path), [DRAFT_PATH]);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), "New session words must not be saved by the old dialog");
    assert.match(rendered.windowTitles.at(-1), /Untitled\.md/);
    assert.equal(rendered.host.querySelectorAll('[role="status"] [role="alert"]').length, 0);
  } finally {
    dialog.resolve(null);
    await rendered.cleanup();
  }
});

for (const sameSession of [false, true]) {
  test(`a completed draft deletion cannot clear a ${sameSession ? "same" : "newer"} session's later autosave failure`, async (context) => {
    const deletion = deferred();
    let creationCount = 0;
    const rendered = await renderEditorApp({
      createDraft: (args) => {
        if (++creationCount === 1) return successfulDraftWrite(args.content);
        throw new Error("New session draft creation unavailable");
      },
      deleteDraft: () => deletion.promise,
    });
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    try {
      updateEditor(rendered.host, "First draft to move");
      dispatchShortcut("e");
      await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
      dispatchShortcut("e");
      await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
      dispatchShortcut("s");
      await waitFor(() => assert.deepEqual(rendered.draftDeletes, [{ path: DRAFT_PATH, savedPath: "/tmp/recovered-r7.md" }]));

      if (sameSession) {
        rendered.failNextFileWrite(new Error("Later autosave unavailable"));
      } else {
        dispatchShortcut("n");
        await waitFor(() => assert.equal(findEditorView(rendered.host).state.sliceDoc(), ""));
      }
      updateEditor(rendered.host, "Later text must stay protected by its warning");
      await act(async () => context.mock.timers.tick(200));
      await act(async () => context.mock.timers.tick(2500));
      assert.equal(sameSession ? rendered.fileWrites.length : rendered.draftCreates.length, 2);
      assert.match(rendered.host.textContent, /Autosave is paused/);
      await act(async () => deletion.resolve(true));
      assert.match(rendered.host.textContent, /Autosave is paused/);
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), "Later text must stay protected by its warning");
      assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
    } finally {
      deletion.resolve(true);
      context.mock.timers.reset();
      await rendered.cleanup();
    }
  });
}

for (const result of ["move", "cancel", "same canonical path", "delete failure"]) {
  test(`manual Save on a clean draft handles ${result}`, async () => {
    const rendered = await renderEditorApp({
      saveDialogPath: result === "cancel" ? null : result === "same canonical path" ? "/tmp/draft-alias.md" : "/tmp/Chosen draft.md",
      savedCanonicalPath: result === "same canonical path" ? DRAFT_PATH : "/tmp/Chosen draft.md",
      deleteDraft: result === "delete failure" ? () => { throw new Error("Synthetic draft cleanup failure"); } : undefined,
    });
    try {
      const content = "# Draft ready for a permanent home";
      updateEditor(rendered.host, content);
      // The mode boundary flushes the draft immediately; return to its now-clean editor.
      dispatchShortcut("e");
      await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
      assert.equal(rendered.draftCreates.length, 1);
      dispatchShortcut("e");
      await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
      const view = findEditorView(rendered.host);
      assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
      await waitFor(() => {
        const saveButton = Array.from(rendered.host.querySelectorAll("button"))
          .find((button) => button.textContent.trim() === "Save");
        assert.ok(saveButton);
        assert.equal(saveButton.disabled, false, "a clean draft still needs its Save As action");
        assert.match(saveButton.title, /^Save to choose a filename and location/);
      });
      assert.ok(!rendered.host.querySelector('[aria-label="Not saved yet"]'));
      const recentBeforeSave = rendered.storeWrites.filter((write) => write.key === "recent-files").at(-1).value;
      clickButton(rendered.host, "Save");
      await waitFor(() => assert.equal(rendered.saveDialogs.length, 1));
      if (result === "cancel") {
        assert.deepEqual(rendered.fileWrites, []);
        assert.deepEqual(rendered.draftDeletes, []);
        assert.deepEqual(rendered.operationLog, []);
        assert.deepEqual(rendered.storeWrites.filter((write) => write.key === "recent-files").at(-1).value, recentBeforeSave);
        assert.match(rendered.windowTitles.at(-1), /Untitled 2\.md/);
      } else {
        await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
        assert.equal(rendered.fileWrites[0].content, content);
        assert.equal(rendered.fileWrites[0].force, true);
        const savedPath = result === "same canonical path" ? DRAFT_PATH : "/tmp/Chosen draft.md";
        await waitFor(() => assert.deepEqual(rendered.draftDeletes, [{ path: DRAFT_PATH, savedPath }]));
        assert.deepEqual(rendered.operationLog, ["write", "delete"]);
        if (result === "same canonical path") {
          assert.deepEqual(rendered.storeWrites.filter((write) => write.key === "recent-files").at(-1).value.files.map((file) => file.path), [DRAFT_PATH]);
        } else {
          await waitFor(() => {
            const recent = rendered.storeWrites.filter((write) => write.key === "recent-files").at(-1);
            const expected = result === "delete failure" ? ["/tmp/Chosen draft.md", DRAFT_PATH] : ["/tmp/Chosen draft.md"];
            assert.deepEqual(recent.value.files.map((file) => file.path), expected);
          });
          assert.match(rendered.windowTitles.at(-1), /Chosen draft\.md/);
        }
        assert.equal(rendered.host.querySelectorAll('[role="status"] [role="alert"]').length, 0, "draft cleanup must not show an error toast");
      }
      assert.ok(findEditorView(rendered.host) === view, "saving a draft keeps the editor mounted");
      assert.equal(view.state.sliceDoc(), content);
    } finally { await rendered.cleanup(); }
  });
}

const DRAFT_NOTES = {
  highlights: [{ id: "h", prefix: "", exact: "Draft passage", suffix: "", color: "yellow", note: "Keep with the draft", createdAt: 1, nearestHeadingId: null }],
  bookmarks: [],
};

for (const load of ["annotated", "pending", "failed"]) {
  test(`Save elsewhere keeps a draft whose annotations are ${load}`, async () => {
    const pending = deferred();
    const loads = [];
    const rendered = await renderEditorApp({
      saveDialogPath: "/tmp/Chosen draft.md",
      loadAnnotations: (args) => {
        loads.push(args.path);
        if (load === "annotated") return structuredClone(DRAFT_NOTES);
        if (load === "pending") return pending.promise;
        throw new Error("Synthetic annotation load failure");
      },
    });
    try {
      updateEditor(rendered.host, "# Draft passage\n\nDraft passage");
      dispatchShortcut("e");
      await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
      await waitFor(() => assert.deepEqual(loads, [DRAFT_PATH]));
      await act(async () => new Promise(setImmediate));
      dispatchShortcut("e");
      await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
      clickButton(rendered.host, "Save");
      await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
      const message = load === "annotated"
        ? /Your highlights, notes, and bookmarks remain in the kept draft Untitled 2\.md\./
        : /Bindars kept the draft Untitled 2\.md because it couldn't confirm whether it has highlights, notes, or bookmarks\./;
      await waitFor(() => assert.match(rendered.host.textContent, message));
      if (load === "pending") await act(async () => pending.resolve(null));
      await act(async () => new Promise(setImmediate));
      assert.deepEqual(rendered.draftDeletes, []);
      await waitFor(() => {
        const recent = rendered.storeWrites.filter((write) => write.key === "recent-files").at(-1);
        assert.deepEqual(recent.value.files.map((file) => file.path), ["/tmp/Chosen draft.md", DRAFT_PATH]);
      });
      assert.match(rendered.windowTitles.at(-1), /Chosen draft\.md/);
    } finally {
      pending.resolve(null);
      await rendered.cleanup();
    }
  });
}

async function waitUntilDraftSaveChoosesLocation(host) {
  await waitFor(() => {
    const saveButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent.trim() === "Save");
    assert.ok(saveButton);
    assert.match(saveButton.title, /^Save to choose a filename and location/);
  });
}

test("cancelling Save on a draft rearms autosave without another keystroke", async (context) => {
  const rendered = await renderEditorApp({ saveDialog: () => null });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    updateEditor(rendered.host, "Draft text");
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    await waitFor(() => assert.equal(rendered.draftCreates.length, 1));
    await waitUntilDraftSaveChoosesLocation(rendered.host);

    updateEditor(rendered.host, "Draft text plus");
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(1000));
    assert.equal(rendered.fileWrites.length, 0);

    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.saveDialogs.length, 1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => context.mock.timers.tick(5 * 60 * 1000));
    await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
    assert.equal(rendered.fileWrites[0].content, "Draft text plus");
    assert.equal(rendered.draftDeletes.length, 0);
    assert.doesNotMatch(rendered.host.textContent, /Autosave is paused/);
  } finally {
    context.mock.timers.reset();
    await rendered.cleanup();
  }
});

test("a rejected draft name keeps autosave running", async (context) => {
  const rendered = await renderEditorApp({ saveDialog: () => "/tmp/Chapter.txt" });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    updateEditor(rendered.host, "Draft text");
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    await waitFor(() => assert.equal(rendered.draftCreates.length, 1));
    await waitUntilDraftSaveChoosesLocation(rendered.host);

    updateEditor(rendered.host, "Draft text plus");
    await act(async () => context.mock.timers.tick(200));
    dispatchShortcut("s");
    await waitFor(() => assert.match(rendered.host.textContent, /must end in/));
    assert.equal(rendered.fileWrites.length, 0);
    assert.doesNotMatch(rendered.host.textContent, /Autosave is paused/);

    await act(async () => context.mock.timers.tick(5 * 60 * 1000));
    await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
    assert.equal(rendered.fileWrites[0].path, DRAFT_PATH);
    assert.equal(rendered.fileWrites[0].content, "Draft text plus");
    assert.equal(rendered.draftDeletes.length, 0);
    assert.doesNotMatch(rendered.host.textContent, /Autosave is paused/);
  } finally {
    context.mock.timers.reset();
    await rendered.cleanup();
  }
});

test("Save As on a draft error removes the draft after the new file is written", async () => {
  let dialogs = 0;
  const rendered = await renderEditorApp({
    savedCanonicalPath: "/tmp/Chosen draft.md",
    saveDialog: () => {
      dialogs += 1;
      return dialogs === 1 ? "/tmp/Chapter.txt" : "/tmp/Chosen draft.md";
    },
  });
  try {
    updateEditor(rendered.host, "Draft text");
    dispatchShortcut("e");
    await waitFor(() => assert.equal(rendered.draftCreates.length, 1));
    dispatchShortcut("e");
    await waitUntilDraftSaveChoosesLocation(rendered.host);
    updateEditor(rendered.host, "Draft text plus");
    await waitForEditorPublication();
    dispatchShortcut("s");
    await waitFor(() => assert.match(rendered.host.textContent, /must end in/));
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.deepEqual(rendered.draftDeletes, [{
      path: DRAFT_PATH,
      savedPath: "/tmp/Chosen draft.md",
    }]));
    const chosenWrite = rendered.fileWrites.find((write) => write.path === "/tmp/Chosen draft.md");
    assert.ok(chosenWrite);
    assert.equal(chosenWrite.force, true);
    assert.equal(chosenWrite.content, "Draft text plus");
  } finally {
    await rendered.cleanup();
  }
});

test("a bare Save As name is created as markdown and does not overwrite that file", async () => {
  const rendered = await renderEditorApp({
    saveDialog: () => "/tmp/Chapter",
  });
  try {
    updateEditor(rendered.host, "Draft text");
    dispatchShortcut("e");
    await waitFor(() => assert.equal(rendered.draftCreates.length, 1));
    dispatchShortcut("e");
    await waitUntilDraftSaveChoosesLocation(rendered.host);
    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
    assert.equal(rendered.fileWrites[0].path, "/tmp/Chapter.md");
    assert.equal(rendered.fileWrites[0].createNew, true);
    assert.equal(rendered.fileWrites[0].force, false);
  } finally {
    await rendered.cleanup();
  }
});

test("App cycles every theme from focused CodeMirror without disturbing editor state", async () => {
  const rendered = await renderEditorApp();

  try {
    const documentText = "# Theme draft\n\nUnicode: café — 你好 👋\n";
    const view = updateEditor(rendered.host, documentText);
    await waitForEditorPublication();
    view.dispatch({ selection: { anchor: 2, head: 24 } });
    view.focus();

    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));
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

    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));
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
    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));

    const cleanThemeChange = dispatchEditorKey(rendered.host, "t", {
      ctrlKey: true,
      shiftKey: true,
    });
    assert.equal(cleanThemeChange.defaultPrevented, true);
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    await waitForEditorPublication();
    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));

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
    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));

    await waitForEditorPublication();
    assert.equal(
      rendered.host.querySelectorAll('[aria-label="Not saved yet"]').length,
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
      rendered.host.querySelectorAll('[aria-label="Not saved yet"]').length,
      1,
    );
  } finally {
    await rendered.cleanup();
  }
});

test("search-panel Escape closes only the panel before closed-panel Escape guards exit", async () => {
  const rendered = await renderEditorApp({ createDraft: () => { throw new Error("Draft creation unavailable for this guard test"); } });

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
    assert.equal(window.localStorage.getItem("bindars-markdown-formatting-enabled"), null);
    assert.deepEqual(rendered.storeWrites.filter(write => write.key === "markdown-formatting-enabled"), []);

    dispatchEditorKey(rendered.host, "m", { ctrlKey: true, altKey: true });
    assert.equal(view.state.field(markdownFormattingEnabled), false);
    assert.equal(window.localStorage.getItem("bindars-markdown-formatting-enabled"), "false");
    await waitFor(() => assert.ok(warnings.some(args => String(args[0]).includes('Failed to set "markdown-formatting-enabled"'))));
    assert.deepEqual(rendered.storeWrites.filter(write => write.key === "markdown-formatting-enabled").map(write => write.value), [false]);
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

test("App routes Ctrl+N through guarded New behavior without welcome publication", async () => {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  mockWindows("main");
  const welcomeReads = [];
  const writes = [];
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "load_annotations":
        return null;
      case "save_annotations":
      case "plugin:store|save":
        return null;
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [{ version: 1, files: [] }, true];
        if (args.key === "hasSeenWelcome") { welcomeReads.push(args.key); return [false, true]; }
        return [null, false];
      case "plugin:store|set":
        return null;
      case "plugin:window|set_title":
        return null;
      case "create_draft_document":
        throw new Error("Draft creation unavailable for this manual guard test");
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
      case "is_draft_document":
        return false;
      case "delete_draft_document":
        throw new Error("Unexpected draft cleanup in an ordinary Save fixture");
      case "authorize_document_images":
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
    await waitFor(() => assert.equal(host.querySelector('[aria-label="Read mode"]')?.disabled, false));
    assert.deepEqual(welcomeReads, []);

    let view = findEditorView(host);
    assert.equal(view.state.sliceDoc(), "");
    assert.ok(document.activeElement === view.contentDOM);
    assert.match(host.textContent, /Untitled\.md/);
    assert.doesNotMatch(host.textContent, /Welcome fixture/);

    assert.equal(dispatchShortcut("e").defaultPrevented, true);
    await waitFor(() => assert.ok(!host.querySelector(".cm-editor")));
    dispatchShortcut("n", { metaKey: true, ctrlKey: false });
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));
    await waitFor(() => assert.equal(host.querySelector('[aria-label="Read mode"]')?.disabled, false));

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
    assert.ok(host.querySelector('[aria-label="Not saved yet"]'));
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
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "load_annotations":
        return null;
      case "save_annotations":
      case "plugin:store|save":
        return null;
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [{ version: 1, files: [] }, true];
        return [null, false];
      case "plugin:store|set":
      case "plugin:window|set_title":
        return null;
      case "create_draft_document":
        throw new Error("Draft creation unavailable for this manual guard test");
      case "plugin:dialog|save":
        saveDialogCount += 1;
        return null;
      case "is_draft_document":
        return false;
      case "delete_draft_document":
        throw new Error("Unexpected draft cleanup in an ordinary Save fixture");
      case "authorize_document_images":
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

    await waitFor(() => assert.equal(host.querySelector('[aria-label="Read mode"]')?.disabled, false));
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
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "load_annotations":
        return null;
      case "save_annotations":
      case "plugin:store|save":
        return null;
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [{ version: 1, files: [] }, true];
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
      case "create_draft_document":
        return successfulDraftWrite(args.content);
      case "is_draft_document":
        return false;
      case "delete_draft_document":
        throw new Error("Unexpected draft cleanup in an ordinary Save fixture");
      case "authorize_document_images":
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
  annotationWrite = null,
  initialOpenOperation = null,
  initialSessionOperation = null,
  bootstrapRead = null,
  sidebarRead = null,
  freshStorage = false,
  workspaceFiles = [],
  workspaceContent = null,
  storedReaderSettings = null,
  themeRead = null,
  settingsRead = null,
  recentStorage = null,
  sampleFlow = null,
  checkDraft = (args) => args.path === DRAFT_PATH,
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
  let fileWriteError = null;
  let draftCreateError = null;
  let openDialogPath = null;
  let saveDialogPath = "/tmp/virtual-continuity.md";
  const annotationWrites = [];
  const operationLog = [];
  const openedPaths = [];
  const fileWrites = [];
  const draftCreates = [];
  const draftChecks = [];
  const draftDeletes = [];
  const saveDialogs = [];
  let windowCloseCount = 0;
  let windowDestroyCount = 0;
  let guardedExitCount = 0;
  let revisionNumber = 1;
  const nativeOpen = createNativeOpenIpc(initialNativePath === undefined
    ? (restoreHeadingId === undefined ? requestedPath : null)
    : initialNativePath);
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "initialize_annotation_storage":
        return bootstrapRead ?? { settingsReady: true, settingsError: null };
      case "load_annotations":
        return annotationWrites.findLast(write => write.path === args.path)?.annotations
          ?? (args.path === canonicalPath ? { highlights: storedHighlights, bookmarks: [], version: 2 } : null);
      case "save_annotations":
        annotationWrites.push(structuredClone(args));
        return annotationWrite ? annotationWrite(args) : null;
      case "plugin:store|save":
        if (recentStorage) recentStorage.durable = structuredClone(recentStorage.value);
        return null;
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "sidebar-visible" && sidebarRead) return sidebarRead;
        if (sampleFlow) sampleFlow.reads.push(args.key);
        if (sampleFlow && args.key === "hasSeenWelcome") return [sampleFlow.seen, true];
        if (recentStorage && args.key === "config-version") return [recentStorage.version ?? 3, true];
        if (args.key === "recent-files") {
          if (!recentStorage) return [{ version: 1, files: [] }, true];
          recentStorage.reads = (recentStorage.reads ?? 0) + 1;
          return recentStorage.read ? recentStorage.read() : [structuredClone(recentStorage.value), true];
        }
        if (args.key === "theme" && themeRead) return themeRead;
        if (args.key === "reader-settings" && settingsRead) return settingsRead;
        if (args.key === "reader-settings" && storedReaderSettings) return [storedReaderSettings, true];
        if (args.key === "workspace:root" && workspaceFiles.length) return ["/tmp", true];
        if (args.key === `annotations:${canonicalPath}`) {
          return [{ highlights: storedHighlights, bookmarks: [], version: 2 }, true];
        }
        if (args.key === "session" && initialSessionOperation) {
          initialSessionOperation.args = args;
          return initialSessionOperation.promise;
        }
        if (args.key === "session" && restoreHeadingId !== undefined) {
          return [{ filePath: requestedPath, headingId: restoreHeadingId }, true];
        }
        return [null, false];
      case "list_workspace_markdown_files":
        return { files: workspaceFiles, skippedCount: 0, limitHit: false };
      case "read_markdown_file":
        return workspaceContent ?? `# ${workspaceFiles.find((file) => file.path === args.path).name}`;
      case "plugin:store|set":
        if (recentStorage) {
          recentStorage.writes.push(structuredClone(args));
          if (args.key === "recent-files") {
            if (recentStorage.writeError) throw recentStorage.writeError;
            recentStorage.value = structuredClone(args.value);
          }
        }
        return null;
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
      case "exit_after_guarded_quit":
        guardedExitCount += 1;
        return null;
      case "plugin:dialog|open":
        if (deferredOpenDialog) {
          const operation = deferredOpenDialog;
          deferredOpenDialog = null;
          operation.args = args;
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
      case "create_draft_document":
        draftCreates.push(args);
        if (draftCreateError) {
          const error = draftCreateError;
          draftCreateError = null;
          throw error;
        }
        return successfulDraftWrite(args.content);
      case "is_draft_document":
        draftChecks.push(args.path);
        return checkDraft(args);
      case "delete_draft_document":
        draftDeletes.push(args);
        assert.equal(args.path, DRAFT_PATH, "only Drafts-folder files can be deleted");
        return args.path !== args.savedPath;
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
      case "plugin:path|resolve_directory":
        if (sampleFlow) {
          sampleFlow.directories.push(args.directory);
          if (sampleFlow.directory) return sampleFlow.directory(args.directory);
        }
        return args.directory === 6 ? '/tmp/Documents' : '/tmp/Home';
      case "plugin:dialog|save":
        saveDialogs.push(args);
        if (sampleFlow) {
          sampleFlow.dialogs.push(args);
          return sampleFlow.dialog ? sampleFlow.dialog(args) : saveDialogPath;
        }
        return saveDialogPath;
      case "export_markdown_file":
        if (!sampleFlow) throw new Error('Unexpected sample export');
        sampleFlow.exports.push(args);
        if (sampleFlow.write) return sampleFlow.write(args);
        diskContent = args.content;
        return null;
      case "authorize_document_images":
        return null;
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }), { shouldMockEvents: true });

  if (freshStorage) {
    for (const key of Object.keys(require.cache)) {
      if (key.includes("/.tmp/workspace-tests/src/")) delete require.cache[key];
    }
  }
  if (recentStorage) {
    for (const name of ['App', 'hooks/useRecentFiles', 'lib/recent-files']) {
      delete require.cache[require.resolve(`../.tmp/workspace-tests/src/${name}.js`)];
    }
  }
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
  if (readySelector) {
    await waitFor(() => assert.ok(host.querySelector(readySelector)));
    positionReaderAtFirst();
  }

  return {
    host,
    annotationWrites,
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
    setOpenDialogPath(path) { openDialogPath = path; },
    setSaveDialogPath(path) { saveDialogPath = path; },
    failNextFileWrite(error) { fileWriteError = error; },
    failNextDraftCreate(error) { draftCreateError = error; },
    setPendingNativeOpenPath(path) { nativeOpen.setPendingPath(path); },
    clearOperationLog() { operationLog.length = 0; },
    operationLog: () => [...operationLog],
    openedPaths: () => [...openedPaths],
    clearOpenedPaths() { openedPaths.length = 0; },
    fileWrites: () => [...fileWrites],
    draftCreates: () => [...draftCreates],
    draftChecks: () => [...draftChecks],
    draftDeletes: () => [...draftDeletes],
    saveDialogs: () => [...saveDialogs],
    windowCloseCount: () => windowCloseCount,
    windowDestroyCount: () => windowDestroyCount,
    guardedExitCount: () => guardedExitCount,
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

test("Read mode retains the save guard after reader settings close", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const words = "These current unsaved edits must survive.";
    updateEditor(rendered.host, words);
    const trigger = rendered.host.querySelector('[aria-label="Toggle reader settings"]');
    flushSync(() => trigger.click());
    flushSync(() => rendered.host.querySelector('[aria-label="Close reader settings"]').click());
    rendered.failNextFileWrite(new Error("Synthetic save failure"));
    clickButton(rendered.host, "Read");
    await waitFor(() => assert.match(rendered.host.querySelector('[aria-modal="true"]').textContent, /Unsaved changes/));
    dispatchWindowKey("Escape");
    await waitFor(() => assert.ok(!rendered.host.querySelector('[aria-modal="true"]')));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), words);
    assert.notEqual(rendered.diskContent(), words);
    assert.equal(rendered.fileWrites().length, 1, "only the failed guarded save was attempted");
  } finally { await rendered.cleanup(); }
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

// All documents, IPC, and print invocations in these regressions are in memory.
async function renderPrintApp(t, options) {
  const preparation = require("../.tmp/workspace-tests/src/lib/print-export.js");
  const pending = [];
  t.mock.method(preparation, "preparePrintDocument", ({ root }) => {
    const operation = deferred();
    pending.push({ ...operation, root });
    return operation.promise;
  });
  const rendered = await renderContinuityApp(options);
  const originalPrint = window.print;
  const print = t.mock.fn(() => {});
  window.print = print;
  t.after(async () => {
    if (rendered.host.isConnected) await rendered.cleanup();
    window.print = originalPrint;
  });
  return { ...rendered, pending, print };
}

test("print admits one preparation and restores the reader after the dialog", async (t) => {
  const view = await renderPrintApp(t);
  view.print.mock.mockImplementation(() => window.dispatchEvent(new window.Event("beforeprint")));
  await act(async () => {
    dispatchShortcut("p");
    dispatchShortcut("p");
  });
  assert.equal(view.pending.length, 1);
  assert.match(view.host.querySelector(".print-status").textContent, /Preparing print/);
  assert.ok(view.host.querySelector(".markdown-body"));
  assert.equal(view.print.mock.callCount(), 0);

  await act(async () => view.pending[0].resolve());
  assert.equal(view.print.mock.callCount(), 1);
  assert.match(view.host.querySelector(".print-status").textContent, /Print dialog requested/);
  await act(async () => {
    dispatchShortcut("p");
    window.dispatchEvent(new window.Event("afterprint"));
  });
  assert.equal(view.pending.length, 1);
  assert.equal(document.body.hasAttribute("data-printing"), false);
  assert.ok(view.host.querySelector(".print-status") === null);
  assert.ok(view.host.querySelector('[aria-label="Export options"]'));
  assert.equal(view.diskContent(), "# First\n\nOpening words.\n\n## Second\n\nClosing words.");
});

test("a browser-initiated print supersedes pending preparation without a second invocation", async (t) => {
  const view = await renderPrintApp(t);
  await act(async () => dispatchShortcut("p"));
  await act(async () => window.dispatchEvent(new window.Event("beforeprint")));
  await act(async () => view.pending[0].resolve());
  assert.equal(view.print.mock.callCount(), 0);
  await act(async () => window.dispatchEvent(new window.Event("afterprint")));
  assert.equal(document.body.hasAttribute("data-printing"), false);
});

for (const change of ["document", "content", "editor", "unmount"]) {
  test(`pending print cannot continue after a ${change} change`, async (t) => {
    const view = await renderPrintApp(t);
    await act(async () => dispatchShortcut("p"));
    if (change === "document" || change === "content") {
      view.setDiskContent("# Replacement document");
      view.setPendingNativeOpenPath(change === "document" ? "/tmp/replacement.md" : "/tmp/continuity.md");
      await act(async () => emit("bindars://native-open-available"));
      await waitFor(() => assert.ok(view.host.querySelector("#replacement-document")));
    } else if (change === "editor") {
      await act(async () => dispatchShortcut("e"));
      await waitFor(() => assert.ok(view.host.querySelector(".cm-editor")));
    } else {
      await view.cleanup();
    }
    await act(async () => view.pending[0].resolve());
    assert.equal(view.print.mock.callCount(), 0);
    assert.equal(document.body.hasAttribute("data-printing"), false);
  });
}

for (const completion of ["resolve", "reject"]) {
  test(`canceled print's late ${completion} cannot invoke print or clear a newer session`, async (t) => {
    const view = await renderPrintApp(t);
    await act(async () => dispatchShortcut("p"));
    await act(async () => clickButton(view.host, "Cancel", view.host.querySelector(".print-status")));
    assert.ok(document.activeElement === view.host.querySelector("main"));
    assert.equal(document.body.hasAttribute("data-printing"), false);
    await act(async () => dispatchShortcut("p"));
    assert.equal(view.pending.length, 2);
    await act(async () => view.pending[0][completion](new Error("Old preparation failed")));
    assert.equal(view.print.mock.callCount(), 0);
    assert.equal(document.body.hasAttribute("data-printing"), true);
    assert.doesNotMatch(view.host.textContent, /Couldn't print document/);
    await act(async () => view.pending[1].resolve());
    assert.equal(view.print.mock.callCount(), 1);
  });
}

for (const failure of ["preparation", "native invocation"]) {
  test(`print ${failure} failure is announced, restores the reader, and permits retry`, async (t) => {
    const view = await renderPrintApp(t);
    if (failure === "native invocation") {
      // Matches macOS Tauri's promise-returning window.print bridge.
      view.print.mock.mockImplementation(() => {
        window.dispatchEvent(new window.Event("beforeprint"));
        return Promise.reject(new Error("Print IPC rejected"));
      });
    }
    await act(async () => dispatchShortcut("p"));
    await act(async () => {
      if (failure === "preparation") view.pending[0].reject(new Error("Preparation failed"));
      else view.pending[0].resolve();
    });
    assert.equal(document.body.hasAttribute("data-printing"), false);
    assert.ok(view.host.querySelector('[aria-label="Export options"]'));
    assert.match(view.host.textContent, /Couldn't print document/);
    view.print.mock.mockImplementation(() => {});
    await act(async () => dispatchShortcut("p"));
    await act(async () => view.pending[1].resolve());
    assert.equal(view.print.mock.callCount(), failure === "preparation" ? 1 : 2);
  });
}

test("print fallback invalidates preparation so a late completion cannot print", async (t) => {
  const preparation = require("../.tmp/workspace-tests/src/lib/print-export.js");
  let timeoutCleanup;
  t.mock.method(preparation, "createPrintCleanupController", (cleanup) => {
    timeoutCleanup = cleanup;
    return { arm() {}, disarm() {} };
  });
  const view = await renderPrintApp(t);
  await act(async () => dispatchShortcut("p"));
  await act(async () => timeoutCleanup());
  await act(async () => view.pending[0].resolve());
  assert.equal(view.print.mock.callCount(), 0);
  assert.equal(document.body.hasAttribute("data-printing"), false);
});

test("obsolete print settings do not affect Markdown or Fountain printing", async (t) => {
  const view = await renderPrintApp(t, {
    storedReaderSettings: { printWithTheme: true, printLayout: "book" },
  });
  for (const path of ["/tmp/continuity.md", "/tmp/screenplay.fountain"]) {
    if (path.endsWith(".fountain")) {
      view.setDiskContent("Title: Script\n\nINT. ROOM - DAY\n\nA quiet room.");
      view.setPendingNativeOpenPath(path);
      await act(async () => emit("bindars://native-open-available"));
      await waitFor(() => assert.ok(view.host.querySelector(".fountain-body")));
    }
    await act(async () => dispatchShortcut("p"));
    assert.equal(document.body.getAttribute("data-printing"), "true");
    assert.equal(document.body.hasAttribute("data-print-themed"), false);
    assert.equal(document.body.hasAttribute("data-print-layout"), false);
    await act(async () => view.pending.at(-1).resolve());
    await act(async () => window.dispatchEvent(new window.Event("afterprint")));
  }
  assert.equal(view.print.mock.callCount(), 2);
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

test("Fountain parser exceptions show a notice while editing stays available", async () => {
  await installDom();
  const fountain = require("../.tmp/workspace-tests/src/lib/fountain.js");
  const { FOUNTAIN_PARSE_FAILED_MESSAGE } = require(
    "../.tmp/workspace-tests/src/lib/document-processing.js"
  );

  const initialContent = "INT. ROOM - DAY\n\nBOB\nHi.";
  const originalParse = fountain.parseFountain;
  fountain.parseFountain = (text, ...rest) => {
    if (text === initialContent) throw new TypeError("synthetic parser failure");
    return originalParse(text, ...rest);
  };

  let rendered = null;
  try {
    rendered = await renderContinuityApp({
      requestedPath: "/tmp/continuity.fountain",
      initialContent,
      readySelector: '[role="alert"]',
    });
    const notice = rendered.host.querySelector('main [role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent, /Screenplay could not be displayed/);
    assert.ok(notice.textContent.includes(`${FOUNTAIN_PARSE_FAILED_MESSAGE} (synthetic parser failure)`));
    assert.ok(!rendered.host.querySelector(".fountain-scene-heading"));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), initialContent);
  } finally {
    fountain.parseFountain = originalParse;
    if (rendered) await rendered.cleanup();
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

test("a manual Save that waited on an autosave is dropped once the editor session has changed", async () => {
  // The wait can outlast the session: undo to clean, open another file from
  // Finder, start editing it. The old closure's file path must never receive
  // the new document's text.
  const rendered = await renderContinuityApp();
  const oldWrite = deferred();
  try {
    const initial = rendered.diskContent();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, `${initial}\nOld session autosave contents`);
    rendered.deferNextWrite(oldWrite);
    await waitForEditorPublication();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2650)));
    await waitFor(() => assert.ok(oldWrite.args));

    dispatchShortcut("s");
    updateEditor(rendered.host, initial);
    rendered.setPendingNativeOpenPath("/tmp/second-copy.md");
    await act(async () => emit("bindars://native-open-available"));
    await waitFor(() => assert.match(rendered.host.textContent, /second-copy\.md/));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const newWords = "New document words which must never reach continuity.md";
    updateEditor(rendered.host, newWords);

    await act(async () => oldWrite.reject(new Error("Temporary old-file save error")));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.equal(rendered.fileWrites().length, 1);
    assert.equal(rendered.fileWrites()[0].path, "/tmp/continuity.md");
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), newWords);
    assert.match(rendered.host.textContent, /second-copy\.md/);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    oldWrite.resolve({ conflict: false, canonicalPath: "/tmp/continuity.md", name: "continuity.md", currentRevision: { mtimeMs: 2, size: 0, contentHash: "r2" } });
    await rendered.cleanup();
  }
});

test("a manual Save waiting on autosave is dropped after re-entering Edit on the same file", async (context) => {
  const rendered = await renderContinuityApp();
  const oldWrite = deferred();
  try {
    const initial = rendered.diskContent();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const oldEditor = updateEditor(rendered.host, `${initial}\nOld session autosave contents`);
    rendered.deferNextWrite(oldWrite);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    assert.ok(oldWrite.args);
    context.mock.timers.reset();

    dispatchShortcut("s");
    // Return to clean so Edit can be left while Save still awaits the old
    // autosave. Re-entering this same path defeats the separate path guard.
    updateEditor(rendered.host, initial);
    dispatchShortcut("e");
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.ok(findEditorView(rendered.host) !== oldEditor);
    const newWords = `${initial}\nNew session words which Save must leave unsaved`;
    updateEditor(rendered.host, newWords);

    await act(async () => oldWrite.reject(new Error("Temporary old-session save error")));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.equal(rendered.fileWrites().length, 1, "the stale Save must not write the new session");
    assert.equal(rendered.fileWrites()[0].path, "/tmp/continuity.md");
    assert.equal(rendered.diskContent(), initial);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), newWords);
    assert.match(rendered.host.textContent, /continuity\.md/);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
  } finally {
    oldWrite.resolve({ conflict: false, canonicalPath: "/tmp/continuity.md", name: "continuity.md", currentRevision: { mtimeMs: 2, size: 0, contentHash: "r2" } });
    context.mock.timers.reset();
    await rendered.cleanup();
  }
});

test("a manual Save still completes after waiting on an autosave in the same session", async () => {
  const rendered = await renderContinuityApp();
  const autosaveWrite = deferred();
  try {
    const initial = rendered.diskContent();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, `${initial}\nAutosaved words`);
    rendered.deferNextWrite(autosaveWrite);
    await waitForEditorPublication();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2650)));
    await waitFor(() => assert.ok(autosaveWrite.args));

    const newerWords = `${initial}\nAutosaved words\nTyped while saving`;
    updateEditor(rendered.host, newerWords);
    dispatchShortcut("s");
    await act(async () => autosaveWrite.reject(new Error("Temporary save error")));
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    assert.equal(rendered.fileWrites()[1].path, "/tmp/continuity.md");
    assert.equal(rendered.fileWrites()[1].content, newerWords);
    await waitFor(() => assert.equal(rendered.diskContent(), newerWords));
  } finally {
    autosaveWrite.resolve({ conflict: false, canonicalPath: "/tmp/continuity.md", name: "continuity.md", currentRevision: { mtimeMs: 2, size: 0, contentHash: "r2" } });
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

test("a newer Finder request wins over delayed startup settings", async (context) => {
  for (const readState of ["pending", "completed", "failed"]) {
    await context.test(readState, async () => {
      const settings = deferred();
      const finderRead = deferred();
      const finderPath = "/tmp/newer-finder.md";
      const rendered = await renderContinuityApp({
        requestedPath: finderPath,
        initialNativePath: null,
        initialSessionOperation: settings,
        initialOpenOperation: finderRead,
        readySelector: null,
      });
      try {
        await waitFor(() => assert.ok(settings.args));
        assert.ok(!rendered.host.querySelector("header, .cm-editor"));
        rendered.setPendingNativeOpenPath(finderPath);
        await act(async () => {
          await emit("bindars://native-open-available");
        });
        await waitFor(() => assert.equal(finderRead.args?.path, finderPath));
        if (readState !== "pending") {
          await act(async () => {
            if (readState === "failed") finderRead.reject(new Error("File read failed"));
            else finderRead.resolve(rendered.openResult());
            try { await finderRead.promise; } catch { /* expected read failure */ }
          });
        }

        await act(async () => {
          settings.resolve([{ filePath: "/tmp/older-session.md", headingId: "old-heading" }, true]);
          await settings.promise;
        });
        await waitFor(() => assert.ok(rendered.host.querySelector("main")));
        assert.deepEqual(rendered.openedPaths(), [finderPath], "newer intent must prevent the older restoration read from starting");
        if (readState === "pending") {
          await act(async () => {
            finderRead.resolve(rendered.openResult());
            await finderRead.promise;
          });
        }
        if (readState !== "failed") {
          await waitFor(() => assert.match(rendered.host.textContent, /newer-finder\.md/));
        }
        assert.doesNotMatch(rendered.host.textContent, /older-session\.md/);
      } finally {
        settings.resolve([null, false]);
        finderRead.resolve(rendered.openResult());
        await rendered.cleanup();
      }
    });
  }
});

test("cancelling a newer file-open dialog does not revive delayed startup restoration", async () => {
  const settings = deferred();
  const openDialog = deferred();
  const rendered = await renderContinuityApp({
    initialNativePath: null,
    initialSessionOperation: settings,
    readySelector: null,
  });
  try {
    await waitFor(() => assert.ok(settings.args));
    rendered.deferNextOpenDialog(openDialog);
    dispatchShortcut("o");
    await waitFor(() => assert.ok(openDialog.args));
    await act(async () => {
      openDialog.resolve(null);
      await openDialog.promise;
    });
    await act(async () => {
      settings.resolve([{ filePath: "/tmp/older-session.md", headingId: null }, true]);
      await settings.promise;
    });
    await waitFor(() => assert.ok(rendered.host.querySelector("main")));
    assert.deepEqual(rendered.openedPaths(), []);
  } finally {
    openDialog.resolve(null);
    settings.resolve([null, false]);
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

test("Edit stays disabled and Ctrl+E cannot mount an editor while an admitted open is pending", async () => {
  const rendered = await renderContinuityApp();
  const pendingOpen = deferred();
  const content = "# Opened after waiting\n";
  const openedFile = {
    canonicalPath: "/tmp/pending-edit.md",
    name: "pending-edit.md",
    content,
    revision: { mtimeMs: 2, size: content.length, contentHash: "pending-edit" },
  };
  try {
    rendered.deferNextOpen(pendingOpen);
    rendered.setPendingNativeOpenPath(openedFile.canonicalPath);
    await act(async () => emit("bindars://native-open-available"));
    await waitFor(() => assert.equal(pendingOpen.args?.path, openedFile.canonicalPath));

    const editButton = rendered.host.querySelector('button[aria-label="Edit mode"]');
    assert.ok(editButton);
    assert.equal(editButton.disabled, true);
    dispatchShortcut("e");
    await act(async () => Promise.resolve());
    assert.ok(!rendered.host.querySelector(".cm-editor"));

    await act(async () => {
      pendingOpen.resolve(openedFile);
      await pendingOpen.promise;
    });
    await waitFor(() => assert.match(rendered.host.textContent, /pending-edit\.md/));
    await waitFor(() => assert.equal(
      rendered.host.querySelector('button[aria-label="Edit mode"]')?.disabled,
      false,
    ));
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), content);
  } finally {
    pendingOpen.resolve(openedFile);
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
      rendered.host.querySelector('button[aria-label="Edit mode"]')?.disabled,
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
    assert.match(rendered.host.textContent, /Automatic file watching is unavailable/);
    rendered.clearOperationLog();
    await act(async () => { await emit(TauriEvent.WINDOW_FOCUS, true); await waitForReconciliationWindow(); });
    await waitFor(() => assert.ok(rendered.operationLog().includes("watch")));
    await waitFor(() => assert.doesNotMatch(rendered.host.textContent, /Automatic file watching is unavailable/));

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
    await waitFor(() => assert.equal(rendered.host.querySelector('[aria-label="Read mode"]')?.disabled, false));
    const view = updateEditor(rendered.host, "# Virtual\n\n## Kept\nSaved after adoption.");
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 3 } });
    rendered.failNextDraftCreate(new Error("Draft creation unavailable for this Save As test"));
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

test("a link to a footnote in another file scrolls to that footnote after opening", async () => {
  // Cross-file anchors used to go through the heading lookup only, so a
  // footnote or any other non-heading fragment reported "not found".
  const rendered = await renderContinuityApp({
    initialContent: [
      "# First",
      "",
      "[Note](other.md#user-content-fn-1)",
      "",
      "## Second",
      "",
      "Text[^1]",
      "",
      "[^1]: The note",
    ].join("\n"),
  });
  try {
    const link = rendered.host.querySelector('a[href="other.md#user-content-fn-1"]');
    assert.ok(link);
    flushSync(() => {
      link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => assert.match(rendered.host.textContent, /other\.md/));
    await waitFor(() => assert.equal(rendered.scrolledIds.at(-1), "user-content-fn-1"));
    assert.doesNotMatch(rendered.host.textContent, /was not found|not found/);
  } finally {
    await rendered.cleanup();
  }
});

test("cross-file and restored fragments preserve Unicode and percent-labelled footnotes", async () => {
  for (const fragment of ["user-content-fn-caf%C3%A9", "user-content-fn-%61", "user-content-fn-a", "caf%C3%A9"]) {
    const expectedId = fragment === "caf%C3%A9" ? "café" : fragment;
    const rendered = await renderContinuityApp({
      initialContent: `# Café\n\n[Next](other.md#${fragment})\n\nText[^café] [^%61] [^a]\n\n[^café]: Unicode\n\n[^%61]: Percent\n\n[^a]: Plain`,
      readySelector: "#café",
      restoreHeadingId: fragment,
    });
    try {
      await waitFor(() => assert.equal(rendered.scrolledIds.at(-1), expectedId));
      const link = rendered.host.querySelector('a[href^="other.md#"]');
      assert.ok(link);
      const count = rendered.scrolledIds.length;
      flushSync(() => link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
      await waitFor(() => assert.match(rendered.host.textContent, /other\.md/));
      await waitFor(() => assert.ok(rendered.scrolledIds.length > count));
      assert.equal(rendered.scrolledIds.at(-1), expectedId);
      assert.doesNotMatch(rendered.host.textContent, /was not found|not found/);
    } finally {
      await rendered.cleanup();
    }
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

test("a repeated native close during autosave cannot destroy the window", async () => {
  const rendered = await renderContinuityApp();
  const write = deferred();
  const newestWords = `${rendered.diskContent()}\n\nThe words at risk during close.`;
  const saved = {
    conflict: false,
    canonicalPath: "/tmp/continuity.md",
    name: "continuity.md",
    currentRevision: { mtimeMs: 2, size: newestWords.length, contentHash: "r2" },
  };
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    rendered.deferNextWrite(write);
    updateEditor(rendered.host, newestWords);

    await act(async () => {
      await emit("tauri://close-requested");
    });
    await waitFor(() => assert.ok(write.args));
    assert.equal(write.args.path, "/tmp/continuity.md");
    assert.equal(write.args.content, newestWords);
    assert.ok(rendered.host.querySelector(".cm-editor"));
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));

    // The admitted close still owns the pending autosave. A repeated native
    // request must remain prevented while those words are being written.
    await act(async () => {
      await emit("tauri://close-requested");
    });
    assert.equal(rendered.windowDestroyCount(), 0);
    assert.equal(rendered.windowCloseCount(), 0);

    await act(async () => {
      rendered.setDiskContent(newestWords);
      write.resolve(saved);
      await write.promise;
    });

    await waitFor(() => assert.equal(rendered.windowCloseCount(), 1));
    assert.equal(rendered.windowDestroyCount(), 0);
    assert.equal(rendered.fileWrites().length, 1);
    assert.ok(!rendered.host.querySelector(".cm-editor"));
  } finally {
    write.resolve(saved);
    await rendered.cleanup();
  }
});

test("a dirty session begun while annotations save aborts the scheduled close", async () => {
  const annotationSave = deferred();
  const rendered = await renderContinuityApp({ annotationWrite: () => annotationSave.promise });
  try {
    await selectReaderParagraph(rendered);
    flushSync(() => rendered.host.querySelector('[aria-label="Highlight Green"]').click());
    await waitFor(() => assert.equal(rendered.annotationWrites.length, 1));

    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const closingWords = `${rendered.diskContent()}\n\nWords saved before the close.`;
    updateEditor(rendered.host, closingWords);
    await act(async () => {
      await emit("tauri://close-requested");
    });
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    assert.equal(rendered.fileWrites()[0].content, closingWords);
    assert.equal(rendered.windowCloseCount(), 0);
    assert.equal(rendered.windowDestroyCount(), 0);

    // A pending autosave keeps the original editor active. Hold annotations
    // instead so a new session can begin after that editor exits, before close.
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const secondThoughts = "Second thoughts typed while annotations save";
    updateEditor(rendered.host, secondThoughts);
    await waitForEditorPublication();

    await act(async () => {
      annotationSave.resolve(null);
      await annotationSave.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(rendered.windowCloseCount(), 0);
    assert.equal(rendered.windowDestroyCount(), 0);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), secondThoughts);
  } finally {
    annotationSave.resolve(null);
    window.getSelection().removeAllRanges();
    await rendered.cleanup();
  }
});

test("a session begun during the programmatic-close handoff prevents destruction", async () => {
  const rendered = await renderContinuityApp();
  const write = deferred();
  const closingWords = `${rendered.diskContent()}\n\nWords saved before the close handoff.`;
  const saved = {
    conflict: false,
    canonicalPath: "/tmp/continuity.md",
    name: "continuity.md",
    currentRevision: { mtimeMs: 2, size: closingWords.length, contentHash: "r2" },
  };
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    rendered.deferNextWrite(write);
    updateEditor(rendered.host, closingWords);
    await act(async () => {
      await emit("tauri://close-requested");
    });
    await waitFor(() => assert.ok(write.args));
    assert.equal(write.args.path, "/tmp/continuity.md");
    assert.equal(write.args.content, closingWords);
    assert.equal(rendered.windowCloseCount(), 0);

    await act(async () => {
      rendered.setDiskContent(closingWords);
      write.resolve(saved);
      await write.promise;
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
    write.resolve(saved);
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

async function renderNativePrintApp(t, options) {
  const invocation = require("../.tmp/workspace-tests/src/lib/print-invocation.js");
  const operation = deferred();
  t.mock.method(invocation, "hasNativePrintCompletion", () => true);
  const invoke = t.mock.method(invocation, "invokePrint", () => operation.promise);
  await installDom();
  const originalMatchMedia = window.matchMedia.bind(window);
  const media = new window.EventTarget();
  media.matches = false;
  t.mock.method(window, "matchMedia", (query) => query === "print" ? media : originalMatchMedia(query));
  const view = await renderPrintApp(t, options);
  t.after(async () => {
    media.matches = false;
    await act(async () => {
      operation.resolve();
      window.dispatchEvent(new window.Event("afterprint"));
    });
  });
  return { ...view, operation, invoke, media };
}

for (const browserEvents of [true, false]) {
  test(`native printing waits for both completion and media exit (browser events: ${browserEvents})`, async (t) => {
    const helpers = require("../.tmp/workspace-tests/src/lib/print-export.js");
    const factory = helpers.createPrintCleanupController;
    let checkpoint;
    t.mock.method(helpers, "createPrintCleanupController", (cleanup) => factory(cleanup, 30_000,
      (callback) => { checkpoint = callback; return 1; }, () => {}));
    const view = await renderNativePrintApp(t);
    await act(async () => dispatchShortcut("p"));
    await act(async () => view.pending[0].resolve());
    assert.equal(view.invoke.mock.callCount(), 1);
    await act(async () => checkpoint());
    assert.ok(view.host.querySelector("header") === null, "false media while IPC is pending is not completion");
    view.media.matches = true;
    if (browserEvents) await act(async () => window.dispatchEvent(new window.Event("beforeprint")));
    await act(async () => {
      checkpoint(); checkpoint();
      window.dispatchEvent(new window.Event("afterprint"));
      window.dispatchEvent(new window.Event("focus"));
      dispatchShortcut("p");
    });
    assert.ok(view.host.querySelector("header") === null);
    assert.equal(view.invoke.mock.callCount(), 1);
    await act(async () => view.operation.resolve());
    assert.ok(view.host.querySelector("header") === null, "native completion must not override active print media");
    view.media.matches = false;
    await act(async () => {
      if (browserEvents) view.media.dispatchEvent(new window.Event("change"));
      else checkpoint();
    });
    assert.ok(view.host.querySelector("header"));
    assert.equal(document.body.hasAttribute("data-printing"), false);
  });
}

test("native setup errors recover without browser events and allow retry", async (t) => {
  const view = await renderNativePrintApp(t);
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[0].resolve());
  await act(async () => view.operation.reject(new Error("No native window")));
  assert.ok(view.host.querySelector("header"));
  assert.match(view.host.textContent, /Couldn't print document/);
  view.invoke.mock.mockImplementation(() => Promise.resolve());
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[1].resolve());
  assert.equal(view.invoke.mock.callCount(), 2);
  assert.ok(view.host.querySelector("header"));
});

test("print protects the reader from shortcuts, native opens, close and watcher reloads", async (t) => {
  const view = await renderNativePrintApp(t);
  const original = view.host.querySelector("article").textContent;
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[0].resolve());
  await act(async () => {
    dispatchShortcut("e"); dispatchShortcut("n");
    dispatchShortcut("t", { shiftKey: true });
    dispatchWindowKey("F5");
    view.setPendingNativeOpenPath("/tmp/other.md");
    await emit("bindars://native-open-available");
    await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
    view.setDiskContent("# Changed during printing");
    await emit("file-changed", { path: "/tmp/continuity.md" });
    await waitForReconciliationWindow();
  });
  assert.ok(view.host.querySelector("header") === null);
  assert.ok(view.host.querySelector(".cm-editor") === null);
  assert.ok(view.host.querySelector(".presentation-overlay") === null);
  assert.equal(view.host.querySelector("article").textContent, original);
  assert.equal(view.windowCloseCount(), 0);
  assert.equal(view.windowDestroyCount(), 0);
  assert.match(view.host.textContent, /Close the print dialog/);
  await act(async () => view.operation.resolve());
  await waitFor(() => assert.ok(view.host.querySelector("#changed-during-printing")));
  assert.ok(view.host.querySelector("header"));
});

test("a native quit request still exits through the guard while a print is invoked", async (t) => {
  const view = await renderNativePrintApp(t);
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[0].resolve());
  assert.ok(view.host.querySelector("header") === null);
  await act(async () => emit("bindars://quit-requested"));
  await waitFor(() => assert.equal(view.guardedExitCount(), 1));
  assert.equal(view.windowDestroyCount(), 0);
  assert.doesNotMatch(view.host.textContent, /Try quitting again/);
  // The mocked exit does not terminate, so the print session itself is untouched.
  assert.ok(view.host.querySelector("header") === null);
  assert.equal(document.body.getAttribute("data-printing"), "true");
});

test("an already running watcher probe cannot replace the printed reader", async (t) => {
  const view = await renderNativePrintApp(t);
  const probe = deferred();
  view.deferNextOpen(probe);
  await act(async () => {
    await emit("file-changed", { path: "/tmp/continuity.md" });
    await waitForReconciliationWindow();
  });
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[0].resolve());
  view.setDiskContent("# Delayed reload");
  await act(async () => probe.resolve(view.openResult("# Delayed reload", 2)));
  assert.ok(view.host.querySelector("#first"));
  assert.ok(view.host.querySelector("header") === null);
  await act(async () => view.operation.resolve());
  await waitFor(() => assert.ok(view.host.querySelector("#delayed-reload")));
});

test("late theme and settings hydration wait until printing ends", async (t) => {
  const theme = deferred();
  const settings = deferred();
  const view = await renderNativePrintApp(t, { themeRead: theme.promise, settingsRead: settings.promise });
  const originalTheme = document.documentElement.getAttribute("data-theme");
  const originalStyle = view.host.querySelector("main").getAttribute("style");
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[0].resolve());
  await act(async () => {
    theme.resolve(["dark", true]);
    settings.resolve([{ fontSize: 24 }, true]);
  });
  assert.equal(document.documentElement.getAttribute("data-theme"), originalTheme);
  assert.equal(view.host.querySelector("main").getAttribute("style"), originalStyle);
  assert.ok(view.host.querySelector("header") === null);
  await act(async () => view.operation.resolve());
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  assert.ok(view.host.querySelector("header"));
});

test("unmount does not release native ownership before operation and media end", async (t) => {
  const view = await renderNativePrintApp(t);
  await act(async () => dispatchShortcut("p"));
  await act(async () => view.pending[0].resolve());
  view.media.matches = true;
  await view.cleanup();
  assert.equal(document.body.getAttribute("data-printing"), "true");
  await act(async () => view.operation.resolve());
  assert.equal(document.body.getAttribute("data-printing"), "true");
  view.media.matches = false;
  await act(async () => view.media.dispatchEvent(new window.Event("change")));
  assert.equal(document.body.hasAttribute("data-printing"), false);
});

function setPaletteQuery(input, value) {
  const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps$'));
  flushSync(() => input[propsKey].onChange({ target: { value } }));
}

async function waitForPaletteSearch() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
}

test('typing a new palette query and immediately pressing Enter never opens the previous result', async () => {
  const view = await renderContinuityApp({ workspaceFiles: paletteWorkspaceFiles });
  try {
    dispatchShortcut('k');
    await waitFor(() => assert.equal(view.host.querySelectorAll('.command-palette-shell li button').length, 2));
    const input = view.host.querySelector('.command-palette-shell input');
    setPaletteQuery(input, 'Alpha');
    await waitForPaletteSearch();
    const before = view.openedPaths().length;
    setPaletteQuery(input, 'Beta');
    dispatchElementKey(input, 'Enter');
    assert.equal(view.openedPaths().length, before);
    assert.equal(view.host.querySelectorAll('.command-palette-shell li button').length, 0);
    await waitForPaletteSearch();
    dispatchElementKey(input, 'Enter');
    await waitFor(() => assert.equal(view.openedPaths().at(-1), '/tmp/Beta.md'));
  } finally { await view.cleanup(); }
});

for (const [indexedHeading, currentHeading, missing] of [
  ['Old', 'New', true], ['Current', 'Current', false],
]) {
  test(`same-file palette heading ${missing ? 'reports a missing target' : 'scrolls without reading again'}`, async () => {
    const view = await renderContinuityApp({
      requestedPath: '/tmp/Alpha.md', initialContent: `# ${currentHeading}`,
      readySelector: `#${currentHeading.toLowerCase()}`, workspaceFiles: [paletteWorkspaceFiles[0]],
      workspaceContent: `# ${indexedHeading}`,
    });
    try {
      dispatchShortcut('k');
      await waitFor(() => assert.equal(view.host.querySelectorAll('.command-palette-shell li button').length, 1));
      setPaletteQuery(view.host.querySelector('.command-palette-shell input'), indexedHeading);
      await waitForPaletteSearch();
      const row = [...view.host.querySelectorAll('.command-palette-shell li button')].find(node => node.textContent.includes('Heading'));
      assert.ok(row);
      const before = view.openedPaths().length;
      view.scrolledIds.length = 0;
      flushSync(() => row.click());
      if (missing) await waitFor(() => assert.match(view.host.textContent, /not found in this document/));
      else await waitFor(() => assert.ok(view.scrolledIds.includes(currentHeading.toLowerCase())));
      assert.equal(view.openedPaths().length, before);
      assert.ok(!view.host.querySelector('.command-palette-shell'));
    } finally { await view.cleanup(); }
  });
}

test('cross-file workspace heading opens the requested document and scrolls its rendered heading', async () => {
  const content = '# snake_case\n\n## Second heading\n\nBody text';
  const view = await renderContinuityApp({
    initialContent: content, readySelector: '#snake_case',
    workspaceFiles: [paletteWorkspaceFiles[0]], workspaceContent: content,
  });
  try {
    dispatchShortcut('k');
    await waitFor(() => assert.equal(view.host.querySelectorAll('.command-palette-shell li button').length, 1));
    setPaletteQuery(view.host.querySelector('.command-palette-shell input'), 'Second heading');
    await waitForPaletteSearch();
    const row = [...view.host.querySelectorAll('.command-palette-shell li button')].find(node => node.textContent.includes('Heading'));
    assert.ok(row);
    view.scrolledIds.length = 0;
    flushSync(() => row.click());
    await waitFor(() => assert.equal(view.openedPaths().at(-1), '/tmp/Alpha.md'));
    await waitFor(() => assert.ok(view.scrolledIds.includes('second-heading')));
    assert.doesNotMatch(view.host.textContent, /not found/);
  } finally { await view.cleanup(); }
});

test('a deleted workspace result preserves the current document and reports the open failure', async () => {
  const view = await renderContinuityApp({ workspaceFiles: [paletteWorkspaceFiles[0]] });
  try {
    dispatchShortcut('k');
    await waitFor(() => assert.equal(view.host.querySelectorAll('.command-palette-shell li button').length, 1));
    const pending = deferred();
    view.deferNextOpen(pending);
    flushSync(() => view.host.querySelector('.command-palette-shell li button').click());
    await waitFor(() => assert.ok(pending.args));
    await act(async () => pending.reject({
      category: 'notFound', operation: 'resolveDocument',
      message: 'The selected document no longer exists.', detail: 'deleted fixture',
    }));
    await waitFor(() => assert.match(view.host.textContent, /no longer exists/));
    assert.ok(view.host.querySelector('#second'));
  } finally { await view.cleanup(); }
});

test("save-and-exit with an unmoved caret preserves the original reader offset", async () => {
  const rendered = await renderContinuityApp();
  try {
    rendered.positionReaderAtFirst();
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const view = findEditorView(rendered.host);
    assert.equal(view.state.selection.main.head, 2);
    flushSync(() => view.dispatch({ changes: { from: 2, to: 7, insert: "Intro" } }));
    assert.equal(view.state.selection.main.head, 2, "caret stays at the initial target");
    const reconciliation = deferred();
    rendered.deferNextOpen(reconciliation);
    dispatchEditorKey(rendered.host, "Escape");
    await waitFor(() => assert.ok(rendered.host.querySelector("article")));
    assert.match(rendered.host.querySelector("h1").textContent, /Intro/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(rendered.readerScrollTop(), 0);
    reconciliation.resolve(rendered.openResult(rendered.diskContent(), rendered.revision()));
  } finally {
    await rendered.cleanup();
  }
});

for (const format of ['legacy array', 'versioned']) {
for (const startup of ['native', 'session', 'A then B', 'legacy migration']) {
  if (format === 'versioned' && startup === 'legacy migration') continue;
  test(`recent startup preservation: ${startup} (${format}) waits for history and records the current document`, async () => {
    const held = deferred();
    const old = { path: '/tmp/old.md', name: 'old.md', openedAt: 1, lastHeadingId: startup === 'legacy migration' ? 'user-content-intro' : 'intro' };
    const stored = format === 'versioned' ? { version: 1, files: [old] } : [old];
    let released = false;
    const history = { version: startup === 'legacy migration' ? 2 : 3, value: stored, writes: [], read: () => released ? [structuredClone(history.value), true] : held.promise };
    const rendered = await renderContinuityApp({
      requestedPath: '/tmp/new.md',
      ...(startup === 'session' ? { restoreHeadingId: 'second' } : {}),
      recentStorage: history, readySelector: null,
    });
    try {
      await waitFor(() => assert.ok(rendered.openedPaths().includes('/tmp/new.md')));
      // Let document publication finish while the history read remains held.
      await act(async () => { await new Promise(setImmediate); });
      if (startup === 'A then B') {
        rendered.setPendingNativeOpenPath('/tmp/newer.md');
        await act(async () => { await emit('bindars://native-open-available'); });
        await waitFor(() => assert.ok(rendered.openedPaths().includes('/tmp/newer.md')));
        await act(async () => { await new Promise(setImmediate); });
      }
      assert.deepEqual(history.writes.filter(w => w.key === 'recent-files'), []);
      assert.deepEqual(history.value, stored);
      released = true;
      await act(async () => { held.resolve([stored, true]); });
      const current = startup === 'A then B' ? '/tmp/newer.md' : '/tmp/new.md';
      await waitFor(() => assert.deepEqual(history.durable.files.map(f => f.path), [current, '/tmp/old.md']));
      assert.equal(history.durable.files[1].lastHeadingId, 'intro');
      assert.ok(rendered.host.querySelector('article'));
      assert.ok(history.writes.filter(w => w.key === 'recent-files').every(w => !w.value.files.some(f => f.path === '/tmp/new.md') || startup !== 'A then B'));
    } finally { await rendered.cleanup(); }
  });
}
}
for (const failure of ['history read', 'conversion write', 'unknown format']) {
  test(`recent startup preservation: ${failure} leaves an available app without first-run inference`, async () => {
    const original = failure === 'unknown format' ? { future: [] } : [{ path: '/tmp/old.md', name: 'old.md', openedAt: 1, lastHeadingId: 'user-content-intro' }];
    const history = { version: failure === 'conversion write' ? 2 : 3, value: original, durable: structuredClone(original), writes: [],
      writeError: failure === 'conversion write' ? Error('conversion write rejected') : null, read: () => {
      if (failure === 'history read') throw Error('history unavailable');
      return [original, true];
    } };
    const expectedWrites = failure === 'conversion write'
      ? [{ key: 'recent-files', value: { version: 1, files: [{ ...original[0], lastHeadingId: 'intro' }] } }]
      : [];
    const rendered = await renderContinuityApp({ initialNativePath: null, recentStorage: history, readySelector: null });
    try {
      await waitFor(() => assert.ok(rendered.host.querySelector('.empty-state-content')));
      assert.match(rendered.host.textContent, /Recent history is unavailable/);
      assert.doesNotMatch(rendered.host.textContent, /Welcome fixture|No recent files/);
      assert.deepEqual(history.writes.filter(w => ['recent-files', 'hasSeenWelcome'].includes(w.key)).map(({ key, value }) => ({ key, value })), expectedWrites);
      assert.deepEqual(history.durable, original);
      rendered.setPendingNativeOpenPath('/tmp/readable.md');
      await act(async () => { await emit('bindars://native-open-available'); });
      await waitFor(() => assert.ok(rendered.host.querySelector('article')));
      dispatchShortcut('b');
      await waitFor(() => assert.ok(rendered.host.querySelector('aside')));
      assert.match(rendered.host.querySelector('aside').textContent, /Recent history is unavailable/);
      assert.deepEqual(history.value, original);
      assert.deepEqual(history.writes.filter(w => ['recent-files', 'hasSeenWelcome'].includes(w.key)).map(({ key, value }) => ({ key, value })), expectedWrites);
      assert.deepEqual(history.durable, original);
    } finally { await rendered.cleanup(); }
  });
}

test('recent startup preservation: verified absent history stays on EmptyState without welcome writes', async () => {
  const history = { version: 3, value: null, writes: [] };
  const rendered = await renderContinuityApp({ initialNativePath: null, recentStorage: history, readySelector: null });
  try {
    await waitFor(() => assert.ok(rendered.host.querySelector('.empty-state-content')));
    assert.doesNotMatch(rendered.host.textContent, /Welcome fixture/);
    assert.ok(!history.writes.some(w => w.key === 'hasSeenWelcome'));
    assert.deepEqual(history.writes.filter(w => w.key === 'recent-files'), []);
  } finally { await rendered.cleanup(); }
});

const keyboardSlides = '# First\n\n[**Jump**](#first)\n\n```text\ncopy me\n```\n\n---\n\n# Second\n\nMore words.\n\n---\n\n# Third\n\nLast words.';

async function renderKeyboardPresentation(t) {
  const originalMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = window.matchMedia.bind(window);
  t.after(() => { globalThis.matchMedia = originalMatchMedia; });
  return renderContinuityApp({ initialContent: keyboardSlides, readySelector: '#first' });
}

for (const key of ['Enter', ' ']) {
  test(`presentation key ownership: Exit retains ${JSON.stringify(key)} activation, including nested targets`, async (t) => {
    const rendered = await renderKeyboardPresentation(t);
    try {
      dispatchWindowKey('F5');
      const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
      const exit = rendered.host.querySelector('button[title^="Exit presentation"]');
      const child = document.createElement('span'); child.textContent = 'nested'; exit.append(child);
      exit.focus();
      for (const target of [exit, child]) {
        assert.equal(dispatchElementKey(target, key).defaultPrevented, false);
        assert.ok(overlay.querySelector('#first'));
      }
      // happy-dom does not synthesize key-to-click; verify the retained native
      // default separately from the real Exit callback. Native activation is R9.
      flushSync(() => exit.click());
      assert.ok(!rendered.host.querySelector('.presentation-overlay'));
    } finally { await rendered.cleanup(); }
  });
}

test('presentation key ownership: links and copy buttons retain activation without advancing slides', async (t) => {
  const rendered = await renderKeyboardPresentation(t);
  try {
    dispatchWindowKey('F5');
    const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
    const link = overlay.querySelector('a[href="#first"]');
    link.focus();
    for (const target of [link, link.querySelector('strong')]) {
      assert.equal(dispatchElementKey(target, 'Enter').defaultPrevented, false);
      assert.ok(overlay.querySelector('#first'));
    }
    rendered.scrolledIds.length = 0;
    flushSync(() => link.click());
    assert.deepEqual(rendered.scrolledIds, ['first']);
    assert.ok(overlay.querySelector('#first'));
    const copy = overlay.querySelector('button');
    assert.ok(copy);
    for (const key of ['Enter', ' ']) {
      copy.focus();
      assert.equal(dispatchElementKey(copy, key).defaultPrevented, false);
      assert.ok(overlay.querySelector('#first'));
    }
  } finally { await rendered.cleanup(); }
});

test('presentation key ownership: editable controls retain navigation keys and Escape still exits', async (t) => {
  const rendered = await renderKeyboardPresentation(t);
  try {
    dispatchWindowKey('F5');
    const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
    // Renderer policy does not normally emit editable slide controls. Exercise
    // the actual App event boundary with synthetic descendants for that contract.
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const control = document.createElement(tag);
      let target = control;
      if (tag === 'div') {
        control.contentEditable = 'true';
        target = document.createElement('span'); control.append(target);
      }
      overlay.append(control); control.focus();
      for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Backspace']) {
        assert.equal(dispatchElementKey(target, key).defaultPrevented, false, `${tag} owns ${key}`);
        assert.ok(overlay.querySelector('#first'));
      }
      control.remove();
    }
    assert.equal(dispatchElementKey(overlay, 'Escape').defaultPrevented, true);
    assert.ok(!rendered.host.querySelector('.presentation-overlay'));
  } finally { await rendered.cleanup(); }
});

test('presentation key ownership: background navigation, bounds and IME protection remain intact', async (t) => {
  const rendered = await renderKeyboardPresentation(t);
  try {
    dispatchWindowKey('F5');
    const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const key of ['Escape', 'Enter', ' ', 'ArrowRight', 'End']) {
        assert.equal(dispatchElementKey(overlay, key, composition).defaultPrevented, false);
        assert.ok(overlay.querySelector('#first'));
      }
    }
    // Code/pre are pointer-selection exemptions, not keyboard controls.
    const code = overlay.querySelector('code');
    assert.equal(dispatchElementKey(code, 'Enter').defaultPrevented, true);
    assert.ok(overlay.querySelector('#second'));
    for (const [key, heading] of [
      ['Home', 'first'], ['ArrowLeft', 'first'], ['Backspace', 'first'],
      ['ArrowDown', 'second'], ['ArrowRight', 'third'], ['Enter', 'third'],
      ['ArrowUp', 'second'], [' ', 'third'], ['Home', 'first'], ['End', 'third'],
    ]) {
      assert.equal(dispatchElementKey(overlay, key).defaultPrevented, true);
      assert.ok(overlay.querySelector(`#${heading}`), `${key} selects ${heading}`);
    }
    dispatchElementKey(overlay, 'Escape');
    assert.ok(!rendered.host.querySelector('.presentation-overlay'));
  } finally { await rendered.cleanup(); }
});

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`App IME ownership: ${Object.keys(composition)[0]} preserves Quick switcher and document search`, async () => {
    const rendered = await renderContinuityApp();
    try {
      dispatchShortcut('k');
      const palette = await waitFor(() => rendered.host.querySelector('[role="dialog"] input') || assert.fail('missing switcher'));
      assert.equal(dispatchElementKey(palette, 'Escape', composition).defaultPrevented, false);
      assert.ok(palette.isConnected);
      dispatchElementKey(palette, 'Escape');
      assert.ok(!rendered.host.querySelector('[role="dialog"]'));
      dispatchShortcut('f');
      const search = await waitFor(() => rendered.host.querySelector('input[aria-label="Search in document"]') || assert.fail('missing search'));
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      flushSync(() => { setValue.call(search, 'words'); search.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
      await waitFor(() => assert.match(rendered.host.querySelector('.search-bar').textContent, /1 of 2/));
      for (const [key, shiftKey] of [['Enter', false], ['Enter', true], ['Escape', false]]) {
        assert.equal(dispatchElementKey(search, key, { ...composition, shiftKey }).defaultPrevented, false);
        assert.ok(search.isConnected);
        assert.match(rendered.host.querySelector('.search-bar').textContent, /1 of 2/);
      }
      dispatchElementKey(search, 'Enter');
      assert.match(rendered.host.querySelector('.search-bar').textContent, /2 of 2/);
      dispatchElementKey(search, 'Enter', { shiftKey: true });
      assert.match(rendered.host.querySelector('.search-bar').textContent, /1 of 2/);
      dispatchElementKey(search, 'Escape');
      assert.ok(!rendered.host.querySelector('.search-bar'));
    } finally { await rendered.cleanup(); }
  });
}

function trackReaderReturn(rendered) {
  const main = rendered.host.querySelector('main');
  const focus = main.focus.bind(main);
  const calls = [];
  main.focus = (options) => { calls.push({ options, scrollTop: main.scrollTop }); focus(options); };
  return { main, calls };
}

for (const route of ['keyboard', 'toolbar', 'no-anchor', 'focus-mode']) {
  test(`reader focus return: clean ${route} exit restores focus without changing restored position`, async t => {
    if (route === 'no-anchor') {
      const positions = require('../.tmp/workspace-tests/src/lib/editor-position.js');
      t.mock.method(positions, 'captureReaderAnchor', () => null);
    }
    if (route === 'focus-mode') {
      const original = globalThis.matchMedia;
      globalThis.matchMedia = window.matchMedia.bind(window);
      t.after(() => { globalThis.matchMedia = original; });
    }
    const rendered = await renderContinuityApp();
    try {
      const { main, calls } = trackReaderReturn(rendered);
      if (route === 'focus-mode') {
        dispatchWindowKey('f', { ctrlKey: true, shiftKey: true });
        assert.ok(!rendered.host.querySelector('header'), 'focus mode must engage before testing its editor return');
      }
      main.scrollTop = route === 'no-anchor' ? 0 : 350;
      dispatchShortcut('e');
      await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
      if (route === 'toolbar') {
        const toggle = rendered.host.querySelector('[aria-label="Read mode"]');
        toggle.focus(); flushSync(() => toggle.click());
      } else dispatchEditorKey(rendered.host, 'Escape');
      await waitFor(() => assert.ok(rendered.host.querySelector('article')));
      assert.ok(document.activeElement === main);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].options, { preventScroll: true });
      assert.equal(main.scrollTop, calls[0].scrollTop);
    } finally { await rendered.cleanup(); }
  });
}

for (const route of ['saved', 'confirmed-save', 'discard', 'conflict-reload', 'conflict-overwrite', 'failed-exit', 'cancel']) {
  test(`reader focus return: toolbar ${route} honors dialog cleanup and editor ownership`, async () => {
    const rendered = await renderContinuityApp();
    try {
      const { main, calls } = trackReaderReturn(rendered);
      const original = rendered.diskContent();
      dispatchShortcut('e');
      await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
      updateEditor(rendered.host, `${original}\n\nR4 edits.`);
      await waitForEditorPublication();
      if (route.startsWith('conflict-')) rendered.conflictNextWrite();
      else if (route !== 'saved') rendered.failNextFileWrite(new Error('R4 injected save failure'));
      const toggle = rendered.host.querySelector('[aria-label="Read mode"]');
      toggle.focus(); flushSync(() => toggle.click());
      if (route !== 'saved') {
        const dialog = await waitFor(() => rendered.host.querySelector('[role="dialog"]') || assert.fail('missing save decision'));
        assert.equal(calls.length, 0);
        if (route === 'cancel') dispatchElementKey(dialog, 'Escape');
        else {
          if (route === 'failed-exit') rendered.failNextFileWrite(new Error('R4 repeated failure'));
          const choice = { 'confirmed-save': 'Save', 'failed-exit': 'Save', 'conflict-reload': 'Reload', 'conflict-overwrite': 'Overwrite', discard: 'Discard' }[route];
          clickButton(rendered.host, choice, dialog);
        }
      }
      if (route === 'cancel' || route === 'failed-exit') {
        await act(async () => { await Promise.resolve(); });
        assert.ok(rendered.host.querySelector('.cm-editor'));
        assert.match(findEditorView(rendered.host).state.sliceDoc(), /R4 edits/);
        assert.equal(calls.length, 0);
        assert.equal(rendered.diskContent(), original);
      } else {
        await waitFor(() => assert.ok(rendered.host.querySelector('article')));
        assert.ok(document.activeElement === main, 'reader wins after the real DialogFrame opener cleanup');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].options, { preventScroll: true });
        if (['saved', 'confirmed-save', 'conflict-overwrite'].includes(route)) assert.match(rendered.diskContent(), /R4 edits/);
        else assert.equal(rendered.diskContent(), original);
      }
    } finally { await rendered.cleanup(); }
  });
}

for (const route of ['Escape', 'button', 'editor']) {
  test(`reader focus return: search ${route} returns only to its intended surface`, async () => {
    const rendered = await renderContinuityApp();
    try {
      const { main, calls } = trackReaderReturn(rendered);
      main.scrollTop = 200;
      dispatchShortcut('f');
      const input = await waitFor(() => rendered.host.querySelector('input[aria-label="Search in document"]') || assert.fail('missing search'));
      if (route === 'editor') dispatchShortcut('e');
      else if (route === 'button') {
        const close = rendered.host.querySelector('[aria-label="Close search"]'); close.focus(); flushSync(() => close.click());
      } else dispatchElementKey(input, 'Escape');
      assert.ok(!rendered.host.querySelector('.search-bar'));
      if (route === 'editor') {
        await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
        assert.ok(findEditorView(rendered.host).hasFocus);
        assert.equal(calls.length, 0);
      } else {
        assert.ok(document.activeElement === main);
        assert.deepEqual(calls, [{ options: { preventScroll: true }, scrollTop: 200 }]);
        assert.equal(main.scrollTop, 200);
      }
    } finally { await rendered.cleanup(); }
  });
}

test('reader focus return: background reconciliation never requests focus', async () => {
  const rendered = await renderContinuityApp();
  try {
    const { calls } = trackReaderReturn(rendered);
    const button = rendered.host.querySelector('[aria-label="Edit mode"]'); button.focus();
    rendered.setDiskContent(`${rendered.diskContent()}\n\nR4 external refresh.`);
    await act(async () => {
      await emit('file-changed', { path: '/tmp/continuity.md' });
      await waitForReconciliationWindow();
    });
    await waitFor(() => assert.match(rendered.host.textContent, /R4 external refresh/));
    assert.equal(calls.length, 0);
    assert.ok(document.activeElement === button);
  } finally { await rendered.cleanup(); }
});

for (const newer of ['editor', 'new-document', 'dialog', 'presentation', 'pending-open']) {
  test(`reader focus return: ${newer} supersedes search dismissal without a delayed return`, async t => {
    const originalMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = window.matchMedia.bind(window);
    t.after(() => { globalThis.matchMedia = originalMatchMedia; });
    const rendered = await renderContinuityApp();
    try {
      const { calls } = trackReaderReturn(rendered);
      dispatchShortcut('f');
      const input = await waitFor(() => rendered.host.querySelector('input[aria-label="Search in document"]') || assert.fail('missing search'));
      const pendingOpen = deferred();
      if (newer === 'pending-open') {
        rendered.setOpenDialogPath('/tmp/r4-newer.md');
        rendered.deferNextOpen(pendingOpen);
      }
      // Both real event handlers run before React commits the return. A new
      // surface or admitted open must own the eventual focus, even if it waits.
      flushSync(() => {
        input.dispatchEvent(keyboardEvent('Escape'));
        const key = { editor: 'e', 'new-document': 'n', dialog: 'k', presentation: 'F5', 'pending-open': 'o' }[newer];
        window.dispatchEvent(keyboardEvent(key, { ctrlKey: key !== 'F5' }));
      });
      await act(async () => { await Promise.resolve(); });
      assert.equal(calls.length, 0);
      if (newer === 'editor' || newer === 'new-document') {
        await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
        assert.ok(findEditorView(rendered.host).hasFocus);
      } else if (newer === 'dialog') {
        const dialog = rendered.host.querySelector('[role="dialog"]');
        assert.ok(dialog && dialog.contains(document.activeElement));
        dispatchElementKey(document.activeElement, 'Escape');
      } else if (newer === 'presentation') {
        assert.ok(rendered.host.querySelector('.presentation-overlay'));
        dispatchWindowKey('Escape');
        assert.equal(calls.length, 1, 'explicit presentation exit now requests its own return');
      } else {
        await act(async () => {
          pendingOpen.resolve({ ...rendered.openResult('# R4 newer document'), canonicalPath: '/tmp/r4-newer.md', name: 'r4-newer.md' });
          await pendingOpen.promise;
        });
        await waitFor(() => assert.match(rendered.host.querySelector('article').textContent, /R4 newer document/));
      }
      await act(async () => { await waitForReconciliationWindow(); });
      assert.equal(calls.length, newer === 'presentation' ? 1 : 0, 'dropped search request cannot revive on a later render');
    } finally { await rendered.cleanup(); }
  });
}

test('reader focus return: print supersedes search dismissal and cannot revive its request', async t => {
  const rendered = await renderNativePrintApp(t);
  const { calls } = trackReaderReturn(rendered);
  const original = rendered.diskContent();
  dispatchShortcut('f');
  const input = await waitFor(() => rendered.host.querySelector('input[aria-label="Search in document"]') || assert.fail('missing search'));
  flushSync(() => {
    input.dispatchEvent(keyboardEvent('Escape'));
    window.dispatchEvent(keyboardEvent('p', { ctrlKey: true }));
  });
  assert.equal(rendered.pending.length, 1);
  assert.match(rendered.host.querySelector('.print-status').textContent, /Preparing print/);
  assert.equal(calls.length, 0, 'print preparation owns input before native invocation');
  await act(async () => rendered.pending[0].resolve());
  assert.equal(rendered.invoke.mock.callCount(), 1);
  assert.equal(calls.length, 0);
  await act(async () => rendered.operation.resolve());
  assert.ok(rendered.host.querySelector('header'));
  assert.equal(calls.length, 0, 'finishing print cannot revive the old search return');
  assert.equal(rendered.diskContent(), original);
});

for (const route of ['clean', 'save-as', 'cancel-save-as']) {
  test(`reader focus return: virtual ${route} handles null identity and adoption`, async () => {
    const rendered = await renderContinuityApp();
    try {
      dispatchShortcut('n');
      await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
      const { main, calls } = trackReaderReturn(rendered);
      if (route !== 'clean') {
        updateEditor(rendered.host, '# R4 virtual\n\nSaved words.');
        await waitForEditorPublication();
      }
      if (route === 'cancel-save-as') rendered.setSaveDialogPath(null);
      if (route !== 'clean') rendered.failNextDraftCreate(new Error('Draft creation unavailable for this Save As test'));
      dispatchEditorKey(rendered.host, 'Escape');
      if (route !== 'clean') {
        const dialog = await waitFor(() => rendered.host.querySelector('[role="dialog"]') || assert.fail('missing save choice'));
        clickButton(rendered.host, 'Save', dialog);
      }
      await act(async () => { await Promise.resolve(); });
      if (route === 'cancel-save-as') {
        assert.ok(rendered.host.querySelector('.cm-editor'));
        assert.match(findEditorView(rendered.host).state.sliceDoc(), /Saved words/);
        assert.equal(rendered.fileWrites().length, 0);
        assert.equal(calls.length, 0);
      } else {
        await waitFor(() => assert.ok(!rendered.host.querySelector('.cm-editor')));
        assert.ok(document.activeElement === main);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].options, { preventScroll: true });
        if (route === 'save-as') assert.match(rendered.fileWrites()[0].content, /Saved words/);
      }
    } finally { await rendered.cleanup(); }
  });
}

for (const retainedSearch of [false, true]) {
  for (const exitBy of ['Escape', 'button']) {
    test(`mode ownership: presentation ${exitBy} returns with retained search ${retainedSearch}`, async t => {
      const rendered = await renderKeyboardPresentation(t);
      try {
        const { main, calls } = trackReaderReturn(rendered);
        const article = main.querySelector('article');
        let searchInput;
        if (retainedSearch) {
          dispatchShortcut('f');
          searchInput = await waitFor(() => main.querySelector('input[aria-label="Search in document"]') || assert.fail('missing search'));
          const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          flushSync(() => { setValue.call(searchInput, 'words'); searchInput.dispatchEvent(new Event('input', { bubbles: true })); });
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
        }
        main.scrollTop = 240;
        dispatchWindowKey('F5');
        const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
        const exit = rendered.host.querySelector('button[title^="Exit presentation"]');
        assert.ok(main.hasAttribute('inert'), 'covered reader and search must be excluded from interaction');
        assert.ok(!main.contains(overlay) && !main.contains(exit));
        assert.ok(!overlay.closest('[inert]') && !exit.closest('[inert]'));
        assert.ok(document.activeElement === overlay);
        assert.ok(main.querySelector('article') === article, 'reader stays mounted');
        if (retainedSearch) assert.ok(searchInput.isConnected && searchInput.value === 'words');
        assert.equal(main.scrollTop, 240);
        if (exitBy === 'button') { exit.focus(); flushSync(() => exit.click()); }
        else dispatchElementKey(overlay, 'Escape');
        assert.ok(!rendered.host.querySelector('.presentation-overlay'));
        assert.ok(!main.hasAttribute('inert'));
        assert.ok(document.activeElement === main);
        assert.equal(main.scrollTop, 240);
        assert.deepEqual(calls, [{ options: { preventScroll: true }, scrollTop: 240 }]);
        if (retainedSearch) assert.ok(searchInput.isConnected && searchInput.value === 'words');
      } finally { await rendered.cleanup(); }
    });
  }
}

test('mode ownership: changing slides preserves Exit focus and fragment links retain focus', async t => {
  const rendered = await renderKeyboardPresentation(t);
  try {
    dispatchWindowKey('F5');
    const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
    const exit = rendered.host.querySelector('button[title^="Exit presentation"]');
    const link = overlay.querySelector('a'); link.focus();
    flushSync(() => link.click());
    assert.ok(document.activeElement === link);
    exit.focus();
    dispatchWindowKey('ArrowRight');
    assert.ok(overlay.querySelector('#second'));
    assert.ok(document.activeElement === exit, 'slide updates must not repeat entry focus');
    dispatchWindowKey('Home');
    assert.ok(overlay.querySelector('#first'));
    assert.ok(document.activeElement === exit);
  } finally { await rendered.cleanup(); }
});

for (const editing of [false, true]) {
  test(`mode ownership: focus-mode Exit returns to the surviving ${editing ? 'editor' : 'reader'}`, async t => {
    const rendered = await renderKeyboardPresentation(t);
    try {
      dispatchWindowKey('f', { ctrlKey: true, shiftKey: true });
      assert.ok(!rendered.host.querySelector('header'));
      if (editing) {
        dispatchShortcut('e');
        await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
        updateEditor(rendered.host, `${keyboardSlides}\n\nR5 unsaved words.`);
      }
      const editor = editing ? findEditorView(rendered.host) : null;
      const { main, calls } = trackReaderReturn(rendered);
      main.scrollTop = 240;
      const exit = rendered.host.querySelector('button[title^="Exit focus mode"]');
      exit.focus(); flushSync(() => exit.click());
      assert.ok(rendered.host.querySelector('header'));
      assert.equal(main.scrollTop, 240);
      if (editing) {
        assert.ok(findEditorView(rendered.host) === editor && editor.hasFocus);
        assert.match(editor.state.sliceDoc(), /R5 unsaved words/);
        assert.equal(calls.length, 0);
        assert.equal(rendered.fileWrites().length, 0);
      } else {
        assert.ok(document.activeElement === main);
        assert.equal(calls.length, 1);
      }
    } finally { await rendered.cleanup(); }
  });
}

test('mode ownership: focus-mode Escape preserves an already focused surviving reader link', async t => {
  const rendered = await renderKeyboardPresentation(t);
  try {
    dispatchWindowKey('f', { ctrlKey: true, shiftKey: true });
    assert.ok(!rendered.host.querySelector('header'));
    const link = rendered.host.querySelector('article a'); link.focus();
    const { calls } = trackReaderReturn(rendered);
    dispatchElementKey(link, 'Escape');
    assert.ok(rendered.host.querySelector('header'));
    assert.ok(document.activeElement === link);
    assert.equal(calls.length, 0);
  } finally { await rendered.cleanup(); }
});

for (const outcome of ['success', 'failure']) {
  test(`mode ownership: cross-file presentation ${outcome} releases inertness without requesting old-reader focus`, async t => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = window.matchMedia.bind(window);
    t.after(() => { globalThis.matchMedia = original; });
    const rendered = await renderContinuityApp({ initialContent: '# First\n\n[Other](other.md)\n\n---\n\n# Second' });
    try {
      const { main, calls } = trackReaderReturn(rendered);
      dispatchWindowKey('F5');
      const overlay = await waitFor(() => rendered.host.querySelector('.presentation-overlay') || assert.fail('missing presentation'));
      const pending = deferred(); rendered.deferNextOpen(pending);
      const link = overlay.querySelector('a'); link.focus(); flushSync(() => link.click());
      await act(async () => {
        if (outcome === 'failure') pending.reject(new Error('R5 injected open failure'));
        else pending.resolve({ ...rendered.openResult('# Other\n\nNew file.'), canonicalPath: '/tmp/other.md', name: 'other.md' });
      });
      await waitFor(() => assert.ok(!rendered.host.querySelector('.presentation-overlay')));
      assert.ok(!main.hasAttribute('inert'));
      assert.equal(calls.length, 0);
      assert.match(main.querySelector('article').textContent, outcome === 'failure' ? /First/ : /New file/);
      if (outcome === 'failure') {
        const readerLink = main.querySelector('article a');
        flushSync(() => readerLink.click());
        await waitFor(() => assert.match(rendered.host.textContent, /other\.md/));
      }
    } finally { await rendered.cleanup(); }
  });
}


test('saving feedback follows an empty draft through Focus mode and saved-file adoption', async () => {
  const rendered = await renderEditorApp();
  try {
    assert.ok(rendered.host.querySelector('[aria-label="Not saved yet"]'));
    assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
    dispatchShortcut('e');
    await waitFor(() => assert.ok(!rendered.host.querySelector('.cm-editor')));
    dispatchShortcut('f', { shiftKey: true });
    await waitFor(() => assert.ok(rendered.host.querySelector('.focus-bar')));
    dispatchShortcut('e');
    await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
    assert.ok(rendered.host.querySelector('.focus-bar [aria-label="Not saved yet"]'));
    clickButton(rendered.host, 'Exit');
    await waitFor(() => assert.ok(rendered.host.querySelector('header')));
    dispatchShortcut('s');
    await waitFor(() => assert.equal(rendered.fileWrites.length, 1));
    await waitFor(() => assert.ok(!rendered.host.querySelector('[aria-label="Not saved yet"]')));
    assert.equal(rendered.fileWrites[0].content, '');
    assert.equal(rendered.fileWrites[0].path, '/tmp/recovered-r7.md');
    assert.ok(rendered.host.querySelector('[aria-label="Saved"]'));
  } finally { await rendered.cleanup(); }
});

function sampleFixture(overrides = {}) {
  return { reads: [], directories: [], dialogs: [], exports: [], ...overrides };
}

for (const seen of [undefined, false, true]) {
  test(`sample entrance ignores historical welcome preference ${seen}`, async () => {
    const flow = sampleFixture({ seen });
    const history = { version: 3, value: { version: 1, files: [] }, writes: [] };
    const rendered = await renderContinuityApp({ initialNativePath: null, readySelector: '.empty-state-content', sampleFlow: flow, recentStorage: history });
    try {
      assert.ok([...rendered.host.querySelectorAll('button')].some(b => b.textContent === 'Try an example'));
      assert.equal(flow.reads.includes('hasSeenWelcome'), false);
      assert.deepEqual(flow.dialogs, []);
      assert.deepEqual(flow.exports, []);
      assert.ok(!rendered.host.querySelector('article'));
      rendered.setSaveDialogPath(null);
      clickButton(rendered.host, 'Try an example');
      await waitFor(() => assert.equal(flow.dialogs.length, 1));
      await waitFor(() => assert.equal([...rendered.host.querySelectorAll('button')].find(b => b.textContent === 'Try an example').disabled, false));
      assert.equal(flow.dialogs[0].options.defaultPath, '/tmp/Documents/Welcome to Bindars.md');
      assert.deepEqual(flow.exports, []);
      assert.deepEqual(history.writes.filter(w => /sample|welcome/i.test(w.key)), []);
    } finally { await rendered.cleanup(); }
  });
}

for (const [name, directory, expected] of [
  ['documents failure', (n) => { if (n === 6) throw Error('unavailable'); return '/tmp/Home/'; }, '/tmp/Home/Welcome to Bindars.md'],
  ['empty documents', (n) => n === 6 ? '' : '/tmp/Home', '/tmp/Home/Welcome to Bindars.md'],
  ['unusable directories', () => 'relative', 'Welcome to Bindars.md'],
  ['all directories unavailable', () => { throw Error('unavailable'); }, 'Welcome to Bindars.md'],
]) {
  test(`sample Save destination fallback: ${name}`, async () => {
    const flow = sampleFixture({ directory, dialog: () => null });
    const rendered = await renderContinuityApp({ initialNativePath: null, readySelector: '.empty-state-content', sampleFlow: flow });
    try {
      clickButton(rendered.host, 'Try an example');
      await waitFor(() => assert.equal(flow.dialogs.length, 1));
      assert.equal(flow.dialogs[0].options.defaultPath, expected);
      assert.deepEqual(flow.directories, [6, 21]);
      assert.deepEqual(flow.exports, []);
    } finally { await rendered.cleanup(); }
  });
}

test('sample admission owns repeated activation and quit until cancel releases it', async () => {
  const held = deferred();
  const flow = sampleFixture({ dialog: () => held.promise });
  const rendered = await renderContinuityApp({ initialNativePath: null, readySelector: '.empty-state-content', sampleFlow: flow });
  try {
    const button = [...rendered.host.querySelectorAll('button')].find(b => b.textContent === 'Try an example');
    flushSync(() => { button.click(); button.click(); });
    await waitFor(() => assert.equal(flow.dialogs.length, 1));
    await act(async () => emit('bindars://quit-requested'));
    assert.equal(rendered.guardedExitCount(), 0);
    assert.deepEqual(flow.exports, []);
    await act(async () => held.resolve(null));
    await waitFor(() => assert.equal(button.disabled, false));
    assert.ok(rendered.host.querySelector('.empty-state-content'));
    assert.doesNotMatch(rendered.host.textContent, /Couldn't save the example|example was saved/);
    flow.dialog = () => '/tmp/sample.md';
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.ok(rendered.host.querySelector('article')));
    assert.equal(flow.dialogs.length, 2);
    assert.deepEqual(flow.exports, [{ path: '/tmp/sample.md', content: '# Welcome fixture\n\nSave with Ctrl+S.' }]);
    assert.deepEqual(rendered.openedPaths(), ['/tmp/sample.md']);
  } finally { await rendered.cleanup(); }
});

test('sample write failure preserves the entrance and supports a deliberate retry', async () => {
  const flow = sampleFixture({ write: () => { throw { category: 'permissionDenied', operation: 'exportDocument', message: 'Choose a writable folder.', detail: 'fixture' }; } });
  const rendered = await renderContinuityApp({ initialNativePath: null, readySelector: '.empty-state-content', sampleFlow: flow });
  try {
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.match(rendered.host.textContent, /Choose a writable folder/));
    assert.deepEqual(rendered.openedPaths(), []);
    assert.ok(rendered.host.querySelector('.empty-state-content'));
    flow.write = null;
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.ok(rendered.host.querySelector('article')));
    assert.equal(flow.exports.length, 2);
  } finally { await rendered.cleanup(); }
});

test('sample saved but open failed reports the destination and ordinary Open does not export again', async () => {
  const open = deferred();
  const flow = sampleFixture();
  const rendered = await renderContinuityApp({ initialNativePath: null, readySelector: '.empty-state-content', sampleFlow: flow });
  try {
    rendered.setSaveDialogPath('/tmp/saved-sample.md');
    rendered.deferNextOpen(open);
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.ok(open.args));
    await act(async () => open.reject(Error('Synthetic read failure')));
    await waitFor(() => assert.match(rendered.host.textContent, /example was saved to \/tmp\/saved-sample.md, but couldn't be opened/));
    assert.ok(rendered.host.querySelector('.empty-state-content'));
    assert.match(rendered.host.textContent, /Synthetic read failure/);
    rendered.setOpenDialogPath('/tmp/saved-sample.md');
    clickButton(rendered.host, 'Open File');
    await waitFor(() => assert.ok(rendered.host.querySelector('article')));
    assert.equal(flow.exports.length, 1);
    assert.equal(rendered.diskContent(), flow.exports[0].content);
  } finally { await rendered.cleanup(); }
});

test('sample cancel supersedes an in-flight session restore without exporting', async () => {
  const session = deferred();
  const dialog = deferred();
  const flow = sampleFixture({ dialog: () => dialog.promise });
  const rendered = await renderContinuityApp({ initialNativePath: null, restoreHeadingId: 'second', initialOpenOperation: session, readySelector: '.empty-state-content', sampleFlow: flow });
  try {
    await waitFor(() => assert.ok(session.args));
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.equal(flow.dialogs.length, 1));
    await act(async () => dialog.resolve(null));
    await act(async () => session.resolve(rendered.openResult('# Late session')));
    await act(async () => new Promise(setImmediate));
    assert.deepEqual(rendered.openedPaths(), ['/tmp/continuity.md']);
    assert.deepEqual(flow.exports, []);
    assert.ok(rendered.host.querySelector('.empty-state-content'));
  } finally { await rendered.cleanup(); }
});

test('sample cancels an already pending session open before showing its Save dialog', async () => {
  const startup = deferred();
  const dialog = deferred();
  const flow = sampleFixture({ dialog: () => dialog.promise });
  const rendered = await renderContinuityApp({ initialNativePath: null, restoreHeadingId: 'second', initialOpenOperation: startup, readySelector: '.empty-state-content', sampleFlow: flow });
  try {
    await waitFor(() => assert.ok(startup.args));
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.equal(flow.dialogs.length, 1));
    await act(async () => startup.resolve(rendered.openResult('# Stale startup')));
    assert.ok(!rendered.host.querySelector('article'));
    await act(async () => dialog.resolve('/tmp/sample.md'));
    await waitFor(() => assert.match(rendered.host.querySelector('article').textContent, /Welcome fixture/));
    assert.doesNotMatch(rendered.host.textContent, /Stale startup/);
  } finally { await rendered.cleanup(); }
});

test('sample completion after unmount does not open or publish stale feedback', async () => {
  const write = deferred();
  const flow = sampleFixture({ write: () => write.promise });
  const rendered = await renderContinuityApp({ initialNativePath: null, readySelector: '.empty-state-content', sampleFlow: flow });
  clickButton(rendered.host, 'Try an example');
  await waitFor(() => assert.equal(flow.exports.length, 1));
  await rendered.cleanup();
  await act(async () => write.resolve(null));
  assert.deepEqual(rendered.openedPaths(), []);
  assert.doesNotMatch(rendered.host.textContent, /example was saved|Couldn't save/);
});

test('sample keeps the existing native-open busy guard and accepts a later retry', async () => {
  const startup = deferred();
  const flow = sampleFixture();
  const rendered = await renderContinuityApp({ initialNativePath: '/tmp/startup.md', initialOpenOperation: startup, readySelector: '.empty-state-content', sampleFlow: flow });
  try {
    await waitFor(() => assert.ok(startup.args));
    const sample = [...rendered.host.querySelectorAll('button')].find(b => b.textContent === 'Try an example');
    assert.equal(sample.disabled, true);
    flushSync(() => sample.click());
    assert.deepEqual(flow.dialogs, []);
    await act(async () => startup.reject(Error('Synthetic open failure')));
    await waitFor(() => assert.equal(sample.disabled, false));
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.ok(rendered.host.querySelector('article')));
    assert.equal(flow.exports.length, 1);
  } finally { await rendered.cleanup(); }
});

async function selectReaderParagraph(rendered, index = 0) {
  await waitFor(() => assert.ok(rendered.host.querySelectorAll('article p')[index]));
  const range = document.createRange();
  range.selectNodeContents(rendered.host.querySelectorAll('article p')[index]);
  await act(async () => {
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));
  });
  await waitFor(() => assert.ok([...rendered.host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Note')));
}

async function typeHighlightNote(rendered, text) {
  await act(async () => {
    const input = rendered.host.querySelector('textarea[aria-label="Highlight note"]');
    assert.ok(input);
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

for (const focus of [false, true]) {
  test(`App color highlight keeps panel/Focus state; Note opens and focuses exactly one note (Focus=${focus})`, async () => {
    const rendered = await renderContinuityApp();
    try {
      if (focus) dispatchShortcut('f', { shiftKey: true });
      await selectReaderParagraph(rendered);
      flushSync(() => rendered.host.querySelector('[aria-label="Highlight Green"]').click());
      await waitFor(() => assert.ok(rendered.annotationWrites.length));
      assert.equal(rendered.annotationWrites.at(-1).annotations.highlights.length, 1);
      assert.equal(rendered.annotationWrites.at(-1).annotations.highlights[0].color, 'green');
      assert.equal(Boolean(rendered.host.querySelector('.focus-bar')), focus);
      assert.ok(rendered.host.querySelector('textarea') === null);
      assert.ok(rendered.host.querySelector('[aria-label="Close highlights & notes"]') === null);
      await selectReaderParagraph(rendered, 1);
      clickButton(rendered.host, 'Note');
      const input = await waitFor(() => {
        const input = rendered.host.querySelector('textarea[aria-label="Highlight note"]');
        assert.ok(input); assert.ok(document.activeElement === input); return input;
      });
      assert.ok(rendered.host.querySelector('.focus-bar') === null);
      assert.ok(rendered.host.querySelector('[aria-label="Close highlights & notes"]'));
      await waitFor(() => assert.equal(rendered.annotationWrites.at(-1).annotations.highlights.length, 2));
      const noteHighlight = rendered.annotationWrites.at(-1).annotations.highlights[1];
      assert.equal(noteHighlight.color, 'yellow');
      assert.equal(noteHighlight.exact, 'Closing words.');
      await typeHighlightNote(rendered, 'Owned thought');
      dispatchElementKey(input, 'Enter');
      await waitFor(() => assert.equal(rendered.annotationWrites.at(-1).annotations.highlights[1].note, 'Owned thought'));
      assert.equal(rendered.annotationWrites.at(-1).path, '/tmp/continuity.md');
      assert.ok(rendered.host.querySelector('textarea') === null);
    } finally { window.getSelection().removeAllRanges(); await rendered.cleanup(); }
  });
}

for (const next of ['switch', 'quit']) {
  test(`App unfinished intentional Note commits to its original document before ${next}`, async () => {
    const rendered = await renderContinuityApp();
    try {
      await selectReaderParagraph(rendered);
      clickButton(rendered.host, 'Note');
      await waitFor(() => assert.ok(rendered.host.querySelector('textarea')));
      await typeHighlightNote(rendered, 'Unfinished original-document thought');
      if (next === 'switch') {
        rendered.setPendingNativeOpenPath('/tmp/other.md');
        await act(async () => emit('bindars://native-open-available'));
        await waitFor(() => assert.ok(rendered.openedPaths().includes('/tmp/other.md')));
      } else {
        await act(async () => emit('bindars://quit-requested'));
        await waitFor(() => assert.equal(rendered.guardedExitCount(), 1));
      }
      assert.ok(rendered.annotationWrites.some(write => write.path === '/tmp/continuity.md' && write.annotations.highlights[0].note === 'Unfinished original-document thought'));
      assert.equal(rendered.annotationWrites.some(write => write.path === '/tmp/other.md'), false);
    } finally { window.getSelection().removeAllRanges(); await rendered.cleanup(); }
  });
}

test('sample canonical opening supports notes and ordinary reopening preserves edited text and notes', async () => {
  const selectedPath = '/tmp/link-to-sample.md';
  const actualPath = '/tmp/canonical-sample.md';
  const flow = sampleFixture();
  const history = { version: 3, value: { version: 1, files: [] }, writes: [] };
  const rendered = await renderContinuityApp({ initialNativePath: null, requestedPath: selectedPath, canonicalPath: actualPath, readySelector: '.empty-state-content', sampleFlow: flow, recentStorage: history });
  try {
    rendered.setSaveDialogPath(selectedPath);
    clickButton(rendered.host, 'Try an example');
    await waitFor(() => assert.ok(rendered.host.querySelector('article')));
    await waitFor(() => assert.equal(history.value.files[0].path, actualPath));
    await selectReaderParagraph(rendered);
    clickButton(rendered.host, 'Note');
    await waitFor(() => assert.ok(rendered.host.querySelector('textarea')));
    await typeHighlightNote(rendered, 'Keep this sample note');
    dispatchElementKey(rendered.host.querySelector('textarea'), 'Enter');
    await waitFor(() => assert.equal(rendered.annotationWrites.at(-1).annotations.highlights[0].note, 'Keep this sample note'));
    assert.equal(rendered.annotationWrites.at(-1).path, actualPath);
    dispatchShortcut('e');
    await waitFor(() => assert.ok(rendered.host.querySelector('.cm-editor')));
    const edited = '# My saved sample\n\nSave with Ctrl+S.\n\nAdded by the reader.';
    updateEditor(rendered.host, edited);
    dispatchShortcut('s');
    await waitFor(() => assert.equal(rendered.diskContent(), edited));
    dispatchShortcut('n');
    await waitFor(() => assert.equal(findEditorView(rendered.host).state.sliceDoc(), ''));
    rendered.setOpenDialogPath(actualPath);
    dispatchShortcut('o');
    await waitFor(() => assert.match(rendered.host.querySelector('article').textContent, /Added by the reader/));
    assert.equal(flow.exports.length, 1);
    assert.equal(rendered.diskContent(), edited);
    assert.match(rendered.host.textContent, /Keep this sample note/);
    assert.deepEqual(history.writes.filter(w => /sample|welcome/i.test(w.key)), []);
  } finally { window.getSelection().removeAllRanges(); await rendered.cleanup(); }
});

for (const outside of [false, true]) {
  test(`intentional Note checks passage visibility after painting once, without taking note focus (outside=${outside})`, async () => {
    const rendered = await renderContinuityApp();
    const scrolledMarks = [];
    const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('mark[data-highlight-id]')) return { top: outside ? 600 : 100, bottom: outside ? 620 : 120, left: 0, right: 200, width: 200, height: 20 };
      return originalBounds.call(this);
    };
    window.HTMLElement.prototype.scrollIntoView = function (options) {
      if (this.matches('mark[data-highlight-id]')) scrolledMarks.push({ id: this.dataset.highlightId, options });
    };
    try {
      dispatchShortcut('f', { shiftKey: true });
      await selectReaderParagraph(rendered);
      clickButton(rendered.host, 'Note');
      await waitFor(() => assert.ok(rendered.host.querySelector('textarea')));
      await waitFor(() => assert.ok(rendered.host.querySelector('mark[data-highlight-id]')));
      assert.equal(scrolledMarks.length, outside ? 1 : 0);
      assert.ok(document.activeElement === rendered.host.querySelector('textarea'));
      if (outside) assert.equal(scrolledMarks[0].id, rendered.annotationWrites.at(-1).annotations.highlights[0].id);
      rendered.host.querySelector('article').dispatchEvent(new window.Event('bindars:diagram-rendered'));
      await act(async () => new Promise(resolve => requestAnimationFrame(resolve)));
      await act(async () => new Promise(setImmediate));
      assert.equal(scrolledMarks.length, outside ? 1 : 0, 'later paints must not scroll again');
      assert.ok(document.activeElement === rendered.host.querySelector('textarea'));
    } finally { window.getSelection().removeAllRanges(); await rendered.cleanup(); }
  });
}

test("focus during autosave waits for acknowledgment and protects a later outside edit", async (context) => {
  const rendered = await renderContinuityApp();
  const save = deferred();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const savedWords = `${rendered.diskContent()}\nSaved by Bindars`;
    updateEditor(rendered.host, savedWords);
    rendered.deferNextWrite(save);
    await waitForEditorPublication();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2650)));
    assert.equal(save.args.content, savedWords);
    rendered.setDiskContent(savedWords);
    rendered.clearOperationLog();
    updateEditor(rendered.host, `${savedWords}\nNewer typing`);
    await act(async () => { await emit(TauriEvent.WINDOW_FOCUS, true); await emit(APP_RESUMED_EVENT); await waitForReconciliationWindow(); });
    assert.equal(rendered.operationLog().filter(x => x === "open").length, 0);
    assert.doesNotMatch(rendered.host.textContent, /changed outside Bindars/);
    await act(async () => save.resolve({
      conflict: false, canonicalPath: "/tmp/continuity.md", name: "continuity.md",
      currentRevision: rendered.openResult(savedWords).revision,
    }));
    await waitFor(() => assert.equal(rendered.operationLog().filter(x => x === "open").length, 1));
    assert.doesNotMatch(rendered.host.textContent, /changed outside Bindars/);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), `${savedWords}\nNewer typing`);
    assert.equal(rendered.fileWrites().length, 1, "newer typing must remain unsaved for this outside-edit control");
    // An outside write after acknowledgment is still a real conflict.
    const outsideRead = deferred();
    rendered.deferNextOpen(outsideRead);
    await act(async () => { await emit(APP_RESUMED_EVENT); await waitForReconciliationWindow(); });
    await act(async () => outsideRead.resolve(rendered.openResult("Outside after save", rendered.revision() + 1)));
    await waitFor(() => assert.match(rendered.host.textContent, /changed outside Bindars/));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), `${savedWords}\nNewer typing`);
  } finally { context.mock.timers.reset(); await rendered.cleanup(); }
});

test("missing parent on save keeps edits and offers working Save As without a conflict dialog", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const words = `${rendered.diskContent()}\nKeep these edits`;
    updateEditor(rendered.host, words);
    rendered.failNextFileWrite({ category: "notFound", operation: "resolveWriteParent", message: "Missing folder", detail: "ENOENT" });
    dispatchShortcut("s");
    await waitFor(() => assert.match(rendered.host.textContent, /destination folder is no longer available/));
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), words);
    rendered.setSaveDialogPath("/tmp/recovered.md");
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.match(rendered.host.textContent, /recovered.md/));
    assert.equal(rendered.diskContent(), words);
    assert.doesNotMatch(rendered.host.textContent, /destination folder is no longer available/);
  } finally { await rendered.cleanup(); }
});

test("an incomplete Save As preserves the warning, current text and draft until recovery succeeds", async (context) => {
  const rendered = await renderContinuityApp({ requestedPath: DRAFT_PATH });
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    await waitUntilDraftSaveChoosesLocation(rendered.host);
    const words = "Current text must survive a partial destination write";
    updateEditor(rendered.host, words);
    rendered.setSaveDialogPath("/tmp/partial-copy.md");
    rendered.failNextFileWrite({
      category: "incompleteWrite", operation: "saveDocument",
      message: "The destination became read-only. A new file may be incomplete. Your current text is still in the editor. Check the destination and try again, or use Save As.",
      detail: "partial-copy.md: Read-only file system (synthetic post-claim EROFS)",
    });
    dispatchShortcut("s");
    await waitFor(() => assert.match(rendered.host.textContent, /A new file may be incomplete/));
    assert.doesNotMatch(rendered.host.textContent, /was not changed/);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), words);
    assert.deepEqual(rendered.draftDeletes(), []);
    assert.ok(!rendered.draftChecks().includes("/tmp/partial-copy.md"));
    rendered.setSaveDialogPath("/tmp/complete-copy.md");
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.deepEqual(rendered.draftDeletes(), [{ path: DRAFT_PATH, savedPath: "/tmp/complete-copy.md" }]));
    assert.equal(rendered.fileWrites().at(-1).content, words);
    assert.doesNotMatch(rendered.host.textContent, /may be incomplete/);
  } finally { await rendered.cleanup(); }
});

test("a competing version retained by autosave stays visible and stops the next autosave", async (context) => {
  const rendered = await renderContinuityApp();
  const save = deferred();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const local = `${rendered.diskContent()}\nLocal words`;
    updateEditor(rendered.host, local);
    rendered.deferNextWrite(save);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    assert.ok(save.args);
    rendered.setDiskContent(local);
    await act(async () => save.resolve({ conflict: false, canonicalPath: "/tmp/continuity.md", name: "continuity.md",
      currentRevision: rendered.openResult(local).revision, recoveryPath: "/tmp/Bindars recovered outside.md" }));
    assert.match(rendered.host.textContent, /kept another version at \/tmp\/Bindars recovered outside\.md/);
    assert.match(rendered.host.textContent, /still in the editor/);
    assert.doesNotMatch(rendered.host.textContent, /Your edits were written/);
    updateEditor(rendered.host, `${local}\nNewer words`);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(11000));
    assert.equal(rendered.fileWrites().length, 1);
    assert.match(rendered.host.textContent, /kept another version at \/tmp\/Bindars recovered outside\.md/);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), `${local}\nNewer words`);
  } finally { context.mock.timers.reset(); await rendered.cleanup(); }
});

async function retainCompetingVersion(rendered) {
  dispatchShortcut("e");
  await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
  const local = `${rendered.diskContent()}\nLocal words`;
  updateEditor(rendered.host, local);
  const save = deferred();
  rendered.deferNextWrite(save);
  dispatchShortcut("s");
  await waitFor(() => assert.ok(save.args));
  const written = rendered.openResult(local).revision;
  rendered.setDiskContent(local);
  await act(async () => save.resolve({
    conflict: false,
    canonicalPath: "/tmp/continuity.md",
    name: "continuity.md",
    currentRevision: written,
    recoveryPath: "/tmp/Bindars recovered outside.md",
  }));
  await waitFor(() => assert.match(
    rendered.host.textContent,
    /kept another version at \/tmp\/Bindars recovered outside\.md/,
  ));
  return { local, written };
}

for (const route of ["manual Save", "Save As after error"]) {
  test(`${route} retires a written draft with recovery while keeping the pause and newer edits`, async (context) => {
    const rendered = await renderContinuityApp({ requestedPath: DRAFT_PATH });
    const write = deferred();
    try {
      dispatchShortcut("e");
      await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
      await waitUntilDraftSaveChoosesLocation(rendered.host);
      const local = "Draft text being saved";
      const newer = `${local}\nNewer typing during the save`;
      updateEditor(rendered.host, local);
      if (route === "Save As after error") {
        rendered.setSaveDialogPath("/tmp/rejected.txt");
        dispatchShortcut("s");
        await waitFor(() => assert.match(rendered.host.textContent, /must end in/));
        assert.deepEqual(rendered.draftDeletes(), []);
      }
      const selectedPath = "/tmp/draft-with-recovery.md";
      rendered.setSaveDialogPath(selectedPath);
      rendered.deferNextWrite(write);
      if (route === "manual Save") dispatchShortcut("s");
      else clickButton(rendered.host, "Save As…");
      await waitFor(() => assert.ok(write.args));
      assert.equal(write.args.path, selectedPath);
      assert.equal(write.args.content, local);
      assert.deepEqual(rendered.draftDeletes(), [], "retirement must wait for a written destination");
      updateEditor(rendered.host, newer);
      const written = rendered.openResult(local).revision;
      rendered.setDiskContent(local);
      await act(async () => write.resolve({
        conflict: false, canonicalPath: selectedPath, name: "draft-with-recovery.md",
        currentRevision: written, recoveryPath: "/tmp/Bindars recovered competing.md",
      }));
      await waitFor(() => assert.deepEqual(rendered.draftDeletes(), [{ path: DRAFT_PATH, savedPath: selectedPath }]));
      assert.match(rendered.host.textContent, /kept another version at \/tmp\/Bindars recovered competing\.md/);
      assert.ok(rendered.host.querySelector('[aria-label^="Save warning: Autosave is paused"]'));
      assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), newer);

      context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
      const latest = `${newer}\nTyping after retirement`;
      updateEditor(rendered.host, latest);
      await act(async () => context.mock.timers.tick(200));
      await act(async () => context.mock.timers.tick(11000));
      assert.equal(rendered.fileWrites().length, 1, "retiring a draft must not resume autosave");
      assert.ok(rendered.host.querySelector('[aria-label^="Save warning: Autosave is paused"]'));
      assert.match(rendered.host.textContent, /kept another version/);
      dispatchShortcut("e");
      await waitFor(() => assert.ok(rendered.host.querySelector('[role="dialog"]')));
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), latest);
      dispatchWindowKey("Escape");

      dispatchShortcut("s");
      await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
      assert.equal(rendered.fileWrites()[1].path, selectedPath);
      assert.deepEqual(rendered.fileWrites()[1].expectedRevision, written);
      assert.equal(rendered.fileWrites()[1].content, latest);
      assert.equal(rendered.draftDeletes().length, 1);
      await waitFor(() => assert.doesNotMatch(rendered.host.textContent, /kept another version/));
    } finally {
      context.mock.timers.reset();
      await rendered.cleanup();
    }
  });
}

test("the next save after a retained version uses the written revision and destination", async () => {
  const rendered = await renderContinuityApp();
  try {
    const { local, written } = await retainCompetingVersion(rendered);
    updateEditor(rendered.host, `${local}\nNewer words`);
    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    assert.equal(rendered.fileWrites()[1].path, "/tmp/continuity.md");
    assert.equal(rendered.fileWrites()[1].content, `${local}\nNewer words`);
    assert.deepEqual(rendered.fileWrites()[1].expectedRevision, written);
    assert.equal(rendered.fileWrites()[1].force, false);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    await waitFor(() => assert.doesNotMatch(rendered.host.textContent, /kept another version/));
  } finally { await rendered.cleanup(); }
});

test("Save As after a retained version follows the chosen file", async () => {
  const rendered = await renderContinuityApp();
  try {
    const { local } = await retainCompetingVersion(rendered);
    rendered.setSaveDialogPath("/tmp/chosen-recovery.md");
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    assert.equal(rendered.fileWrites()[1].path, "/tmp/chosen-recovery.md");
    assert.equal(rendered.fileWrites()[1].content, local);
    await waitFor(() => assert.match(rendered.host.textContent, /chosen-recovery\.md/));
    assert.doesNotMatch(rendered.host.textContent, /kept another version/);
  } finally { await rendered.cleanup(); }
});

test("cancelling recovery Save As keeps autosave paused until a successful manual save", async (context) => {
  const rendered = await renderContinuityApp();
  try {
    const { local, written } = await retainCompetingVersion(rendered);
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    rendered.setSaveDialogPath(null);
    clickButton(rendered.host, "Save As…");
    await act(async () => { await Promise.resolve(); });
    await act(async () => context.mock.timers.tick(2500));
    assert.equal(rendered.fileWrites().length, 1);
    assert.match(rendered.host.textContent, /kept another version/);

    const newer = `${local}\nNewer words after cancelling`;
    updateEditor(rendered.host, newer);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(11000));
    assert.equal(rendered.fileWrites().length, 1);
    assert.match(rendered.host.textContent, /kept another version/);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), newer);

    dispatchShortcut("s");
    await act(async () => { await Promise.resolve(); });
    assert.equal(rendered.fileWrites().length, 2);
    assert.equal(rendered.fileWrites()[1].path, "/tmp/continuity.md");
    assert.deepEqual(rendered.fileWrites()[1].expectedRevision, written);
    assert.equal(rendered.fileWrites()[1].content, newer);
    assert.doesNotMatch(rendered.host.textContent, /kept another version/);

    updateEditor(rendered.host, `${newer}\nAutosave can resume`);
    await act(async () => context.mock.timers.tick(200));
    await act(async () => context.mock.timers.tick(2500));
    assert.equal(rendered.fileWrites().length, 3);
    assert.equal(rendered.fileWrites()[2].content, `${newer}\nAutosave can resume`);
  } finally { context.mock.timers.reset(); await rendered.cleanup(); }
});

test("a failed Save As keeps the original moved-folder pathname blocked", async () => {
  const rendered = await renderContinuityApp();
  const moved = (name) => ({
    category: "invalidInput", operation: "inspectWriteTarget",
    message: `Folder moved during ${name}`, detail: "destination-changed",
  });
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    updateEditor(rendered.host, "Local text to preserve");
    rendered.failNextFileWrite(moved("original save"));
    dispatchShortcut("s");
    await waitFor(() => assert.match(rendered.host.textContent, /Folder moved during original save/));
    rendered.setSaveDialogPath("/tmp/second-destination.md");
    rendered.failNextFileWrite(moved("second save"));
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.match(rendered.host.textContent, /Folder moved during second save/));
    assert.equal(rendered.fileWrites().length, 2);

    updateEditor(rendered.host, "Local text to preserve plus newer typing");
    dispatchShortcut("s");
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(rendered.fileWrites().map((write) => write.path),
      ["/tmp/continuity.md", "/tmp/second-destination.md"]);
    assert.match(rendered.host.textContent, /Folder moved during original save/);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), "Local text to preserve plus newer typing");

    rendered.setSaveDialogPath("/tmp/third-destination.md");
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.equal(rendered.fileWrites().length, 3));
    await waitFor(() => assert.doesNotMatch(rendered.host.textContent, /Folder moved/));
    updateEditor(rendered.host, "More words at the adopted destination");
    dispatchShortcut("s");
    await waitFor(() => assert.equal(rendered.fileWrites().length, 4));
    assert.equal(rendered.fileWrites()[3].path, "/tmp/third-destination.md");
    assert.equal(rendered.fileWrites()[3].content, "More words at the adopted destination");
  } finally { await rendered.cleanup(); }
});

test("Save As blocks the current pathname even after another destination failed first", async () => {
  const rendered = await renderContinuityApp();
  const moved = (name) => ({
    category: "invalidInput", operation: "inspectWriteTarget",
    message: `Folder moved during ${name}`, detail: "destination-changed",
  });
  try {
    await retainCompetingVersion(rendered);
    rendered.setSaveDialogPath("/tmp/second-destination.md");
    rendered.failNextFileWrite(moved("second destination"));
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.match(rendered.host.textContent, /Folder moved during second destination/));
    rendered.setSaveDialogPath("/tmp/continuity.md");
    rendered.failNextFileWrite(moved("current destination"));
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.match(rendered.host.textContent, /Folder moved during current destination/));
    assert.equal(rendered.fileWrites().length, 3);
    dispatchShortcut("s");
    await act(async () => { await Promise.resolve(); });
    assert.equal(rendered.fileWrites().length, 3);
    assert.match(rendered.host.textContent, /Folder moved during current destination/);
  } finally { await rendered.cleanup(); }
});

test("discard after a retained version leaves the written text and drops newer typing", async () => {
  const rendered = await renderContinuityApp();
  try {
    const { local } = await retainCompetingVersion(rendered);
    updateEditor(rendered.host, `${local}\nNewer words`);
    dispatchShortcut("e");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      return candidate;
    });
    clickButton(rendered.host, "Discard", dialog);
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    await waitFor(() => assert.match(rendered.host.textContent, /Local words/));
    assert.doesNotMatch(rendered.host.textContent, /Newer words/);
  } finally { await rendered.cleanup(); }
});

test("a retained version does not offer Reload until a later conflict, and Reload then uses disk", async () => {
  const rendered = await renderContinuityApp();
  try {
    await retainCompetingVersion(rendered);
    assert.ok(!Array.from(rendered.host.querySelectorAll("button")).some((button) => button.textContent.trim() === "Reload"));
    rendered.setDiskContent("Outside reload words");
    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const dialog = await waitFor(() => {
      const candidate = rendered.host.querySelector('[role="dialog"]');
      assert.ok(candidate);
      return candidate;
    });
    clickButton(rendered.host, "Reload", dialog);
    await waitFor(() => assert.ok(!rendered.host.querySelector(".cm-editor")));
    await waitFor(() => assert.match(rendered.host.textContent, /Outside reload words/));
    assert.doesNotMatch(rendered.host.textContent, /Local words/);
  } finally { await rendered.cleanup(); }
});

test("Command-S does not write a pathname after its folder moved", async () => {
  const rendered = await renderContinuityApp();
  try {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    const words = `${rendered.diskContent()}\nKeep these edits`;
    updateEditor(rendered.host, words);
    rendered.failNextFileWrite({
      category: "invalidInput",
      operation: "inspectWriteTarget",
      message: "The folder moved during saving. The exchanged text went into /tmp/original-folder.",
      detail: "destination-changed",
    });
    dispatchShortcut("s");
    await waitFor(() => assert.match(rendered.host.textContent, /original-folder/));
    assert.equal(rendered.fileWrites().length, 1);
    updateEditor(rendered.host, `${words}\nAnd more`);
    assert.match(rendered.host.textContent, /original-folder/);
    dispatchShortcut("s");
    await act(async () => { await Promise.resolve(); });
    assert.equal(rendered.fileWrites().length, 1);
    assert.ok(!rendered.host.querySelector('[role="dialog"]'));
    rendered.setSaveDialogPath("/tmp/after-move.md");
    clickButton(rendered.host, "Save As…");
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    assert.equal(rendered.fileWrites()[1].path, "/tmp/after-move.md");
    assert.equal(rendered.fileWrites()[1].content, `${words}\nAnd more`);
    await waitFor(() => assert.match(rendered.host.textContent, /after-move\.md/));
    assert.doesNotMatch(rendered.host.textContent, /original-folder/);
  } finally { await rendered.cleanup(); }
});


for (const heldStage of ["history", "session", "bootstrap", "native drain"]) {
  test(`startup deadline exposes working controls with pending ${heldStage}`, async (context) => {
    const restoreLocalStorage = bindAppLocalStorage();
    const held = deferred();
    const oldHistory = { version: 1, files: [{ path: "/tmp/kept.md", name: "kept.md", openedAt: 1, lastHeadingId: "kept-position" }] };
    const history = { value: structuredClone(oldHistory), writes: [],
      read: heldStage === "history" ? () => held.promise : undefined };
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const rendered = await renderContinuityApp({
      initialNativePath: heldStage === "native drain" ? held.promise : null,
      initialSessionOperation: heldStage === "session" ? held : null,
      bootstrapRead: heldStage === "bootstrap" ? held.promise : null,
      recentStorage: history, readySelector: null, freshStorage: true,
    });
    try {
      await act(async () => Promise.resolve());
      assert.ok(!rendered.host.querySelector("header"));
      await act(async () => context.mock.timers.tick(3000));
      await waitFor(() => assert.ok(rendered.host.querySelector("header")));
      if (["history", "bootstrap"].includes(heldStage)) {
        assert.match(rendered.host.textContent, /history.*unavailable/i);
        assert.equal(history.writes.filter(write => write.key === "recent-files").length, 0);
      }
      // Visible controls must work while the operation remains unresolved.
      rendered.setOpenDialogPath("/tmp/user-selected.md");
      clickButton(rendered.host, "Open");
      await waitFor(() => assert.match(rendered.host.textContent, /user-selected\.md/));
      if (["history", "bootstrap"].includes(heldStage)) {
        assert.equal(history.writes.filter(write => write.key === "recent-files").length, 0);
        assert.deepEqual(history.value, oldHistory);
      }
      await act(async () => {
        held.resolve(heldStage === "bootstrap" ? { settingsReady: true, settingsError: null }
          : heldStage === "native drain" ? null
          : heldStage === "history" ? [oldHistory, true]
          : [{ filePath: "/tmp/stale-session.md", headingId: null }, true]);
      });
      await waitFor(() => assert.ok(history.value.files.some(file => file.path === "/tmp/user-selected.md")));
      assert.equal(history.value.files.find(file => file.path === "/tmp/kept.md").lastHeadingId, "kept-position");
      assert.deepEqual(rendered.openedPaths(), ["/tmp/user-selected.md"]);
      clickButton(rendered.host, "New");
      await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
    } finally {
      context.mock.timers.reset();
      held.resolve([null, false]);
      await rendered.cleanup();
      restoreLocalStorage();
    }
  });
}

for (const stored of [false, "true", { unexpected: true }]) {
  test(`sidebar hydration respects user intent and boolean values: ${JSON.stringify(stored)}`, async () => {
    const restoreLocalStorage = bindAppLocalStorage();
    const held = deferred();
    const storage = { value: { version: 1, files: [] }, writes: [] };
    const rendered = await renderContinuityApp({ sidebarRead: held.promise, recentStorage: storage, freshStorage: true });
    try {
      const toggle = rendered.host.querySelector('[aria-label="Toggle sidebar"]');
      assert.ok(!rendered.host.querySelector("aside"));
      if (stored === false) flushSync(() => toggle.click());
      await act(async () => held.resolve([stored, true]));
      assert.equal(Boolean(rendered.host.querySelector("aside")), stored === false);
      if (stored === false) {
        assert.equal(window.localStorage.getItem("bindars-sidebar-visible"), "true");
        assert.equal(storage.writes.findLast(write => write.key === "sidebar-visible").value, true);
      }
    } finally {
      held.resolve([null, false]);
      await rendered.cleanup();
      restoreLocalStorage();
    }
  });
}

test("a malformed saved heading still opens a usable document", async () => {
  const restoreLocalStorage = bindAppLocalStorage();
  const session = deferred();
  session.resolve([{ filePath: "/tmp/continuity.md", headingId: { toString: null } }, true]);
  const rendered = await renderContinuityApp({ initialNativePath: null, initialSessionOperation: session, freshStorage: true });
  try {
    assert.ok(rendered.host.querySelector("#second"));
    clickButton(rendered.host, "New");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));
  } finally {
    await rendered.cleanup();
    restoreLocalStorage();
  }
});
