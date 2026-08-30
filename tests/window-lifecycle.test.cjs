const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { installDom } = require("./_helpers/dom.cjs");
const { findEditorView, replaceEditorDocument } = require("./_helpers/codemirror.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");

const DOC_PATH = "/tmp/lifecycle.md";
const DOC_NAME = "lifecycle.md";
const DOC_CONTENT = "# Lifecycle\n\nOpening words.\n\n## Deeper\n\nClosing words.\n";

let flushSync;

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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

function loadApp() {
  const Module = require("node:module");
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
  return new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

function dispatchShortcut(key, options = {}) {
  const event = keyboardEvent(key, { ctrlKey: true, ...options });
  flushSync(() => window.dispatchEvent(event));
  return event;
}

function dispatchWindowKey(key, options = {}) {
  const event = keyboardEvent(key, options);
  flushSync(() => window.dispatchEvent(event));
  return event;
}

async function cancelDialog(host) {
  dispatchWindowKey("Escape");
  await waitFor(() => noDialog(host));
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

async function requestClose() {
  await act(async () => {
    await emit("tauri://close-requested");
  });
}

async function requestQuit() {
  await act(async () => {
    await emit("bindars://quit-requested");
  });
}

async function renderLifecycleApp({ platform = "mac" } = {}) {
  await installDom();
  ({ flushSync } = require("react-dom"));
  window.localStorage.clear();
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
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // The App freezes its window close policy from the call-time platform
  // detector, so the navigator must report the platform under test before
  // the first render.
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  assert.ok(originalNavigator);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value: platform === "mac"
      ? { platform: "MacIntel" }
      : { platform: "X11; Darwin arm64" },
  });

  mockWindows("main");
  let diskContent = DOC_CONTENT;
  let revisionNumber = 1;
  let failedWritesRemaining = 0;
  let conflictNextWrite = false;
  let deferredOpen = null;
  let deferredWrite = null;
  let deferredSnapshotWrite = null;
  let failedHidesRemaining = 0;
  let failedExitsRemaining = 0;
  const operationLog = [];
  const openedPaths = [];
  const fileWrites = [];
  const nativeOpen = createNativeOpenIpc();

  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [[], true];
        if (args.key === "hasSeenWelcome") return [true, true];
        if (args.key === `annotations:${DOC_PATH}`) {
          return [{ highlights: [], bookmarks: [], version: 2 }, true];
        }
        return [null, false];
      case "plugin:store|set":
        return null;
      case "plugin:window|set_title":
        return null;
      case "plugin:window|hide":
        if (failedHidesRemaining > 0) {
          failedHidesRemaining -= 1;
          throw new Error("window hide failed");
        }
        operationLog.push("hide");
        return null;
      case "plugin:window|close":
        operationLog.push("close");
        return null;
      case "plugin:window|destroy":
        operationLog.push("destroy");
        return null;
      case "exit_after_guarded_quit":
        if (failedExitsRemaining > 0) {
          failedExitsRemaining -= 1;
          throw new Error("guarded exit failed");
        }
        operationLog.push("exit");
        return null;
      case "open_markdown_file": {
        openedPaths.push(args.path);
        operationLog.push("open");
        if (deferredOpen) {
          const operation = deferredOpen;
          deferredOpen = null;
          operation.args = args;
          return operation.promise;
        }
        return {
          canonicalPath: args.path,
          name: args.path.split("/").at(-1),
          content: diskContent,
          revision: { mtimeMs: revisionNumber, size: diskContent.length, contentHash: `r${revisionNumber}` },
        };
      }
      case "write_markdown_file_if_unmodified": {
        fileWrites.push(args);
        operationLog.push("file-write");
        if (deferredWrite) {
          const operation = deferredWrite;
          deferredWrite = null;
          operation.args = args;
          return operation.promise;
        }
        if (failedWritesRemaining > 0) {
          failedWritesRemaining -= 1;
          throw new Error("disk unavailable");
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
      }
      case "write_document_snapshot": {
        operationLog.push("snapshot-start");
        const finish = () => {
          operationLog.push("snapshot-finish");
          return successfulSnapshotWrite(args);
        };
        if (deferredSnapshotWrite) {
          const pending = deferredSnapshotWrite;
          deferredSnapshotWrite = null;
          pending.args = args;
          return pending.promise.then(finish);
        }
        return finish();
      }
      case "watch_file":
      case "unwatch_file":
        return null;
      case "retire_snapshot_draft":
        return null;
      case "list_snapshot_drafts":
        return { drafts: [], skippedCount: 0 };
      case "list_document_snapshots":
        return [];
      case "read_document_snapshot":
        throw new Error(`Missing snapshot fixture: ${args.snapshotId}`);
      case "plugin:dialog|save":
        return "/tmp/Save As.md";
      case "plugin:dialog|open":
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

  async function openLifecycleDocument() {
    nativeOpen.setPendingPath(DOC_PATH);
    await act(async () => {
      await emit("bindars://native-open-available");
    });
    await waitFor(() => assert.ok(host.textContent.includes(DOC_NAME)));
  }

  async function enterEditingWithDirtyText(text) {
    dispatchShortcut("e");
    await waitFor(() => assert.ok(host.querySelector(".cm-editor")));
    updateEditor(host, text);
  }

  async function requestNativeOpen(path = DOC_PATH) {
    nativeOpen.setPendingPath(path);
    await act(async () => {
      await emit("bindars://native-open-available");
    });
  }

  return {
    host,
    operationLog: () => [...operationLog],
    openedPaths: () => [...openedPaths],
    fileWrites: () => [...fileWrites],
    diskContent: () => diskContent,
    hideCount: () => operationLog.filter((entry) => entry === "hide").length,
    closeCount: () => operationLog.filter((entry) => entry === "close").length,
    destroyCount: () => operationLog.filter((entry) => entry === "destroy").length,
    exitCalls: () => operationLog.filter((entry) => entry === "exit"),
    failNextWrite(times = 1) { failedWritesRemaining += times; },
    failNextHide(times = 1) { failedHidesRemaining += times; },
    failNextExit(times = 1) { failedExitsRemaining += times; },
    conflictNextWrite() { conflictNextWrite = true; },
    deferNextOpen(operation) { deferredOpen = operation; },
    deferNextWrite(operation) { deferredWrite = operation; },
    deferNextSnapshotWrite(operation) { deferredSnapshotWrite = operation; },
    openLifecycleDocument,
    enterEditingWithDirtyText,
    requestNativeOpen,
    requestClose,
    requestQuit,
    async cleanup() {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      host.remove();
      window.matchMedia = originalMatchMedia;
      globalThis.IntersectionObserver = originalIntersectionObserver;
      Object.defineProperty(globalThis, "navigator", originalNavigator);
      clearMocks();
    },
  };
}

function confirmDialog(host) {
  const dialog = host.querySelector('[role="dialog"]');
  assert.ok(dialog, "expected an open dialog");
  return dialog;
}

function noDialog(host) {
  assert.ok(!host.querySelector('[role="dialog"]'), "expected no open dialog");
}

// --- macOS close behavior ---

test("macOS dirty close with a healthy disk flushes the boundary autosave and hides without a dialog", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nAutosaved before close.`);

    await rendered.requestClose();

    // The boundary autosave satisfies the dirty guard without a dialog,
    // preserving the pre-P0.3 close behavior on top of hide-on-close.
    await waitFor(() => assert.equal(rendered.hideCount(), 1));
    assert.equal(rendered.fileWrites().length, 1);
    assert.equal(rendered.fileWrites()[0].content, `${DOC_CONTENT}\n\nAutosaved before close.`);
    assert.equal(rendered.destroyCount(), 0);
    assert.equal(rendered.exitCalls().length, 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS dirty close Save resolves the dialog and then hides once", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nSaved before close.`);
    rendered.failNextWrite(); // the boundary autosave fails and raises the dialog

    await rendered.requestClose();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));

    await waitFor(() => assert.equal(rendered.hideCount(), 1));
    assert.equal(rendered.fileWrites().length, 2);
    assert.equal(rendered.fileWrites()[1].content, `${DOC_CONTENT}\n\nSaved before close.`);
    assert.equal(rendered.destroyCount(), 0);
    assert.equal(rendered.exitCalls().length, 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS dirty close Discard captures the discarded buffer and hides only after the snapshot finishes", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nDiscarded words.`);
    rendered.failNextWrite(); // the boundary autosave fails and raises the dialog
    await rendered.requestClose();
    confirmDialog(rendered.host);

    // Arming after the dialog opens keeps the deferred slot for the discard
    // capture itself instead of the automatic snapshot that precedes the flush.
    const discardSnapshot = deferred();
    rendered.deferNextSnapshotWrite(discardSnapshot);
    clickButton(rendered.host, "Discard");

    await waitFor(() => assert.equal(rendered.operationLog().filter((entry) => entry === "snapshot-start").length, 1));
    assert.equal(rendered.hideCount(), 0, "hide must wait for the queued discard snapshot");

    await act(async () => {
      discardSnapshot.resolve();
      await discardSnapshot.promise.then(() => undefined, () => undefined);
    });
    await waitFor(() => assert.equal(rendered.hideCount(), 1));

    const log = rendered.operationLog();
    assert.ok(
      log.indexOf("snapshot-finish") < log.indexOf("hide"),
      "the snapshot must reach the backend before the window hides",
    );
    assert.equal(rendered.destroyCount(), 0);
    assert.equal(rendered.exitCalls().length, 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS dirty close Cancel keeps the document and editor intact for another attempt", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nKept words.`);
    rendered.failNextWrite();

    await rendered.requestClose();
    confirmDialog(rendered.host);
    await cancelDialog(rendered.host);

    assert.equal(rendered.hideCount(), 0);
    assert.equal(findEditorView(rendered.host).state.sliceDoc(), `${DOC_CONTENT}\n\nKept words.`);

    // The paused autosave keeps the document dirty, so another close runs the
    // guard again; the raised dialog Save succeeds on the healthy disk.
    await rendered.requestClose();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    await waitFor(() => assert.equal(rendered.hideCount(), 1));
    assert.equal(rendered.exitCalls().length, 0);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS dirty close with a failed Save leaves the app and document intact", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nRecoverable words.`);

    // The boundary autosave and the explicit Save both fail.
    rendered.failNextWrite(2);
    await rendered.requestClose();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));

    await waitFor(() => noDialog(rendered.host));
    assert.equal(rendered.hideCount(), 0, "a failed Save must not hide the window");
    assert.equal(
      findEditorView(rendered.host).state.sliceDoc(),
      `${DOC_CONTENT}\n\nRecoverable words.`,
    );

    // The paused autosave raises the dialog again without a write; a retry
    // Save on the healthy disk completes the close.
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await rendered.requestClose();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));
    await waitFor(() => assert.equal(rendered.hideCount(), 1));
  } finally {
    await rendered.cleanup();
  }
});

test("macOS dirty close conflict resolves through Overwrite and then hides once", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nOverwrite words.`);
    rendered.conflictNextWrite();

    await rendered.requestClose();
    const dialog = confirmDialog(rendered.host);
    assert.match(dialog.textContent, /File changed on disk/);
    clickButton(rendered.host, "Overwrite", dialog);

    await waitFor(() => assert.equal(rendered.hideCount(), 1));
    assert.equal(rendered.fileWrites().length, 2, "the retried overwrite write must complete");
    assert.equal(rendered.fileWrites()[1].force, true);
    assert.equal(rendered.destroyCount(), 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("repeated macOS close requests during the guard resolve to a single hide", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nOnly one hide.`);

    const pendingWrite = deferred();
    rendered.deferNextWrite(pendingWrite);
    await rendered.requestClose();

    // The boundary autosave write is in flight; repeated native close
    // requests must not stack a second guard or hide behind it.
    await rendered.requestClose();
    await rendered.requestClose();
    await waitFor(() => assert.equal(rendered.fileWrites().length, 1));

    await act(async () => {
      pendingWrite.resolve({
        conflict: false,
        canonicalPath: DOC_PATH,
        name: DOC_NAME,
        currentRevision: { mtimeMs: 99, size: 0, contentHash: "r99" },
      });
      await pendingWrite.promise.then(() => undefined, () => undefined);
    });
    await waitFor(() => assert.equal(rendered.hideCount(), 1));
    assert.equal(rendered.destroyCount(), 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("a newly entered edit session cancels a stale macOS close continuation", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nStale close.`);
    rendered.failNextWrite();
    await rendered.requestClose();
    confirmDialog(rendered.host);

    const discardSnapshot = deferred();
    rendered.deferNextSnapshotWrite(discardSnapshot);
    clickButton(rendered.host, "Discard");
    await waitFor(() => assert.equal(rendered.operationLog().filter((entry) => entry === "snapshot-start").length, 1));

    // During the snapshot drain the user re-enters edit mode; the stale
    // close continuation must yield to the new session instead of hiding it.
    dispatchShortcut("e");
    await waitFor(() => assert.ok(rendered.host.querySelector(".cm-editor")));

    await act(async () => {
      discardSnapshot.resolve();
      await discardSnapshot.promise.then(() => undefined, () => undefined);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(rendered.hideCount(), 0, "a stale close must not hide a newly active edit session");
    assert.ok(rendered.host.querySelector(".cm-editor"));
  } finally {
    await rendered.cleanup();
  }
});

test("a macOS close request while an unsaved-changes dialog is already open is swallowed", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nDialog words.`);
    rendered.failNextWrite();

    // A native open of another file raises the existing Save/Discard/Cancel dialog.
    await rendered.requestNativeOpen("/tmp/other.md");
    const dialog = confirmDialog(rendered.host);

    await rendered.requestClose();
    assert.equal(rendered.hideCount(), 0);
    assert.ok(
      !rendered.openedPaths().includes("/tmp/other.md"),
      "the pending open must still own the guard",
    );
    const dialogsAfterClose = rendered.host.querySelectorAll('[role="dialog"]');
    assert.equal(dialogsAfterClose.length, 1, "no second dialog may stack");

    await cancelDialog(rendered.host);
    assert.equal(rendered.hideCount(), 0);
  } finally {
    await rendered.cleanup();
  }
});

test("Finder delivery still opens documents after the macOS window hides", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.requestClose();
    await waitFor(() => assert.equal(rendered.hideCount(), 1));

    // The native side reveals the hidden window before this event; the
    // frontend flow is unchanged and must admit the open.
    await rendered.requestNativeOpen("/tmp/hidden-delivery.md");
    await waitFor(() => assert.ok(rendered.openedPaths().includes("/tmp/hidden-delivery.md")));
    await waitFor(() => assert.ok(rendered.host.textContent.includes("hidden-delivery.md")));
  } finally {
    await rendered.cleanup();
  }
});

test("a failed macOS hide reports the problem and leaves close retryable", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    rendered.failNextHide();

    await rendered.requestClose();

    await waitFor(() => assert.match(
      rendered.host.textContent,
      /couldn't close the window/i,
    ));
    assert.equal(rendered.hideCount(), 0);
    assert.equal(rendered.destroyCount(), 0);

    await rendered.requestClose();
    await waitFor(() => assert.equal(rendered.hideCount(), 1));
  } finally {
    await rendered.cleanup();
  }
});

// --- macOS quit behavior ---

test("macOS quit with a clean document exits only through the guarded command", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();

    await rendered.requestQuit();

    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
    assert.equal(rendered.hideCount(), 0);
    assert.equal(rendered.destroyCount(), 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS quit with a dirty document and healthy disk autosaves and exits without a dialog", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nAutosaved before quit.`);

    await rendered.requestQuit();

    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
    assert.equal(rendered.fileWrites().length, 1);
    assert.equal(rendered.fileWrites()[0].content, `${DOC_CONTENT}\n\nAutosaved before quit.`);
    assert.equal(rendered.hideCount(), 0);
    assert.equal(rendered.destroyCount(), 0);
    noDialog(rendered.host);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS quit with a dirty document Saves through the dialog and then exits once", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nSaved before quit.`);
    rendered.failNextWrite(); // the boundary autosave fails and raises the dialog

    await rendered.requestQuit();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));

    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
    assert.equal(rendered.fileWrites().length, 2);
    assert.equal(rendered.fileWrites()[1].content, `${DOC_CONTENT}\n\nSaved before quit.`);
    assert.equal(rendered.hideCount(), 0);
    assert.equal(rendered.destroyCount(), 0);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS quit Cancel keeps the app usable and a later Discard drains snapshots before exiting", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nQuit words.`);
    rendered.failNextWrite();

    await rendered.requestQuit();
    confirmDialog(rendered.host);
    await cancelDialog(rendered.host);
    assert.equal(rendered.exitCalls().length, 0);
    assert.ok(rendered.host.querySelector(".cm-editor"));

    rendered.failNextWrite();
    await rendered.requestQuit();
    confirmDialog(rendered.host);

    const discardSnapshot = deferred();
    rendered.deferNextSnapshotWrite(discardSnapshot);
    clickButton(rendered.host, "Discard");
    await waitFor(() => assert.equal(rendered.operationLog().filter((entry) => entry === "snapshot-start").length, 1));
    assert.equal(rendered.exitCalls().length, 0, "quit must wait for the queued discard snapshot");

    await act(async () => {
      discardSnapshot.resolve();
      await discardSnapshot.promise.then(() => undefined, () => undefined);
    });
    const log = await waitFor(() => {
      assert.equal(rendered.exitCalls().length, 1);
      return rendered.operationLog();
    });
    assert.ok(
      log.indexOf("snapshot-finish") < log.indexOf("exit"),
      "the snapshot must reach the backend before the exit command runs",
    );
  } finally {
    await rendered.cleanup();
  }
});

test("macOS quit with a failed Save leaves the app usable for another attempt", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nQuit retry words.`);

    rendered.failNextWrite(2);
    await rendered.requestQuit();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));

    await waitFor(() => noDialog(rendered.host));
    assert.equal(rendered.exitCalls().length, 0, "a failed Save must not exit");
    assert.ok(rendered.host.querySelector(".cm-editor"));

    // The paused autosave raises the dialog again without a write; a retry
    // Save on the healthy disk completes the quit.
    await waitFor(() => assert.equal(rendered.fileWrites().length, 2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await rendered.requestQuit();
    clickButton(rendered.host, "Save", confirmDialog(rendered.host));
    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
  } finally {
    await rendered.cleanup();
  }
});

test("a failed guarded exit reports the problem and leaves quit retryable", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    rendered.failNextExit();

    await rendered.requestQuit();

    await waitFor(() => assert.match(
      rendered.host.textContent,
      /couldn't quit bindars/i,
    ));
    assert.equal(rendered.exitCalls().length, 0);

    await rendered.requestQuit();
    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
  } finally {
    await rendered.cleanup();
  }
});

test("macOS quit conflict resolves through Overwrite and then exits", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nQuit overwrite.`);
    rendered.conflictNextWrite();

    await rendered.requestQuit();
    const dialog = confirmDialog(rendered.host);
    assert.match(dialog.textContent, /File changed on disk/);
    clickButton(rendered.host, "Overwrite", dialog);

    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
    assert.equal(rendered.fileWrites()[1].force, true);
    assert.equal(rendered.hideCount(), 0);
  } finally {
    await rendered.cleanup();
  }
});

test("macOS quit while another action owns the guard is refused with feedback and stays retryable", async () => {
  const rendered = await renderLifecycleApp({ platform: "mac" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nBusy quit words.`);

    const pendingOpen = deferred();
    rendered.deferNextOpen(pendingOpen);
    await rendered.requestNativeOpen("/tmp/busy-open.md");
    await waitFor(() => assert.ok(rendered.openedPaths().includes("/tmp/busy-open.md")));

    await rendered.requestQuit();
    await waitFor(() => assert.match(
      rendered.host.textContent,
      /finishing another file action/i,
    ));
    assert.equal(rendered.exitCalls().length, 0);
    noDialog(rendered.host);

    await act(async () => {
      pendingOpen.resolve({
        canonicalPath: "/tmp/busy-open.md",
        name: "busy-open.md",
        content: "# Busy open\n",
        revision: { mtimeMs: 5, size: 13, contentHash: "busy" },
      });
      await pendingOpen.promise.then(() => undefined, () => undefined);
    });
    await waitFor(() => assert.ok(rendered.host.textContent.includes("busy-open.md")));

    // Once the previous action finished, quitting works.
    await rendered.requestQuit();
    await waitFor(() => assert.equal(rendered.exitCalls().length, 1));
  } finally {
    await rendered.cleanup();
  }
});

// --- other platforms keep the destroy-on-close behavior ---

test("non-macOS clean close still destroys the window", async () => {
  const rendered = await renderLifecycleApp({ platform: "other" });
  try {
    await rendered.openLifecycleDocument();
    noDialog(rendered.host);

    await rendered.requestClose();

    await waitFor(() => assert.equal(rendered.destroyCount(), 1));
    assert.equal(rendered.hideCount(), 0);
    assert.equal(rendered.exitCalls().length, 0);
  } finally {
    await rendered.cleanup();
  }
});

test("non-macOS dirty close still autosaves and completes the programmatic close handshake", async () => {
  const rendered = await renderLifecycleApp({ platform: "other" });
  try {
    await rendered.openLifecycleDocument();
    await rendered.enterEditingWithDirtyText(`${DOC_CONTENT}\n\nLegacy close.`);

    await rendered.requestClose();
    await waitFor(() => assert.equal(rendered.closeCount(), 1));
    assert.equal(rendered.fileWrites().length, 1);
    assert.equal(rendered.hideCount(), 0);
    noDialog(rendered.host);

    // Tauri answers appWindow.close() with a fresh close-requested event;
    // the guard must let that handshake finish the destroy.
    await rendered.requestClose();
    await waitFor(() => assert.equal(rendered.destroyCount(), 1));
    assert.equal(rendered.exitCalls().length, 0);
  } finally {
    await rendered.cleanup();
  }
});
