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
const {
  markdownFormattingEnabled,
} = require("../.tmp/workspace-tests/src/components/markdown-decorations.js");

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
  mockWindows("main");
  const storeWrites = [];
  const snapshotWrites = [];
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
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
      case "get_cli_file_path":
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
  }, { shouldMockEvents: true });

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
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [[], true];
        if (args.key === "hasSeenWelcome") return welcomeRead.promise;
        return [null, false];
      case "plugin:store|set":
        return null;
      case "get_cli_file_path":
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
  }, { shouldMockEvents: true });

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
  mockIPC((cmd, args = {}) => {
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
      case "get_cli_file_path":
        return null;
      case "plugin:dialog|save":
        saveDialogCount += 1;
        return null;
      case "write_document_snapshot":
        return successfulSnapshotWrite(args);
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }, { shouldMockEvents: true });

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
  mockIPC((cmd, args = {}) => {
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
      case "get_cli_file_path":
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
  }, { shouldMockEvents: true });

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
  restoreHeadingId,
  storedHighlights = [],
  snapshotEntries = [],
  snapshotContents = {},
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
  let diskContent = [
    "# First",
    "",
    "Opening words.",
    "",
    "## Second",
    "",
    "Closing words.",
  ].join("\n");
  let conflictNextWrite = false;
  let deferredOpen = null;
  let deferredWrite = null;
  let deferredWatch = null;
  let deferredUnwatch = null;
  let deferredSnapshotWrite = null;
  let deferredSnapshotRead = null;
  let openDialogPath = null;
  const operationLog = [];
  const snapshotOperationLog = [];
  const snapshotWrites = [];
  const retiredDrafts = [];
  const fileWrites = [];
  let windowCloseCount = 0;
  let windowDestroyCount = 0;
  let documentSnapshotListCount = 0;
  let snapshotWriteError = null;
  let revisionNumber = 1;
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [[], true];
        if (args.key === `annotations:${canonicalPath}`) {
          return [{ highlights: storedHighlights, bookmarks: [], version: 2 }, true];
        }
        if (args.key === "session" && restoreHeadingId !== undefined) {
          return [{ filePath: requestedPath, headingId: restoreHeadingId }, true];
        }
        return [null, false];
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
        if (deferredWatch) {
          const operation = deferredWatch;
          deferredWatch = null;
          return operation.promise;
        }
        return null;
      case "get_cli_file_path":
        return restoreHeadingId === undefined ? requestedPath : null;
      case "open_markdown_file":
        operationLog.push("open");
        if (deferredOpen) {
          const operation = deferredOpen;
          deferredOpen = null;
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
        return "/tmp/virtual-continuity.md";
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
  }, { shouldMockEvents: true });

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
  await waitFor(() => assert.ok(host.querySelector("#second")));
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
    deferNextWrite(operation) { deferredWrite = operation; },
    deferNextWatch(operation) { deferredWatch = operation; },
    deferNextUnwatch(operation) { deferredUnwatch = operation; },
    deferNextSnapshotWrite(operation) { deferredSnapshotWrite = operation; },
    deferNextSnapshotRead(operation) { deferredSnapshotRead = operation; },
    setOpenDialogPath(path) { openDialogPath = path; },
    clearOperationLog() { operationLog.length = 0; },
    operationLog: () => [...operationLog],
    clearSnapshotOperationLog() { snapshotOperationLog.length = 0; },
    snapshotOperationLog: () => snapshotOperationLog.map((operation) => ({ ...operation })),
    snapshotWrites: () => [...snapshotWrites],
    retiredDrafts: () => [...retiredDrafts],
    fileWrites: () => [...fileWrites],
    windowCloseCount: () => windowCloseCount,
    windowDestroyCount: () => windowDestroyCount,
    documentSnapshotListCount: () => documentSnapshotListCount,
    failNextSnapshotWrite(error) { snapshotWriteError = error; },
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
    updateEditor(rendered.host, `${baseline}\n\nWords that trigger the conflict.`);
    await waitForEditorPublication();
    await waitFor(() => assert.ok(rendered.snapshotWrites().length > 0));

    rendered.conflictNextWrite();
    dispatchShortcut("s");
    const firstConflictDialog = await waitFor(() => {
      const dialog = rendered.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.match(dialog.textContent, /File changed/);
      return dialog;
    });
    clickButton(rendered.host, "Cancel", firstConflictDialog);
    await waitFor(() => {
      assert.ok(!rendered.host.querySelector('[role="dialog"]'));
      assert.ok(rendered.host.querySelector('[aria-label*="Autosave is paused"]'));
    });

    updateEditor(rendered.host, baseline);
    await waitForEditorPublication();
    rendered.clearSnapshotOperationLog();
    rendered.deferNextSnapshotWrite(queuedSnapshot);
    const discardedWords = `${baseline}\n\nNew words that will be discarded.`;
    updateEditor(rendered.host, discardedWords);
    await waitForEditorPublication();
    await waitFor(() => assert.ok(queuedSnapshot.args));
    assert.equal(queuedSnapshot.args.preservePrevious, false);

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

test("not-found reconciliation closes the document while unreadable reconciliation preserves it", async () => {
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
      reconciliation.reject(new Error("File not found: /tmp/continuity.md"));
      try { await reconciliation.promise; } catch { /* expected */ }
    });
    await waitFor(() => assert.ok(rendered.host.querySelector(".empty-state-content")));
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
