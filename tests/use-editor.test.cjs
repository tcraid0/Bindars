const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

const {
  useEditor,
} = require("../.tmp/workspace-tests/src/hooks/useEditor.js");

const originalRevision = { mtimeMs: 1, size: 5, contentHash: "before" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderUseEditor(flushPendingBuffer) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const apiRef = { current: null };

  function Probe() {
    apiRef.current = useEditor(flushPendingBuffer);
    return null;
  }

  flushSync(() => {
    root.render(React.createElement(Probe));
  });

  return {
    api() {
      assert.ok(apiRef.current, "expected useEditor to render");
      return apiRef.current;
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
      clearMocks();
    },
  };
}

function renderUseEditorWithSurface(initialContent) {
  let rendered;
  let liveContent = initialContent;
  let pending = false;
  let flushCount = 0;
  rendered = renderUseEditor(() => {
    flushCount += 1;
    if (!pending) return null;
    pending = false;
    return rendered.api().updateBuffer(liveContent);
  });

  return {
    ...rendered,
    setLiveContent(content) {
      liveContent = content;
      pending = true;
    },
    flushCount() {
      return flushCount;
    },
  };
}

function enterEditMode(rendered, content, revision = originalRevision) {
  flushSync(() => {
    rendered.api().enterEditMode(content, revision);
  });
}

function updateBuffer(rendered, content) {
  flushSync(() => {
    rendered.api().updateBuffer(content);
  });
}

function startSave(rendered, path = "/tmp/draft.md", options) {
  let savePromise;
  flushSync(() => {
    savePromise = rendered.api().save(path, options);
  });
  return savePromise;
}

function startSaveAs(rendered, defaultPath = "Untitled.md") {
  let savePromise;
  flushSync(() => {
    savePromise = rendered.api().saveAs(defaultPath);
  });
  return savePromise;
}

async function settleSave(write, savePromise, result) {
  let saveResult;
  await act(async () => {
    write.resolve(result);
    saveResult = await savePromise;
  });
  return saveResult;
}

async function rejectSave(write, savePromise, error) {
  let saveResult;
  await act(async () => {
    write.reject(error);
    saveResult = await savePromise;
  });
  return saveResult;
}

function mockPendingWrites() {
  const writes = [];
  mockIPC((cmd, args) => {
    const write = deferred();
    writes.push({ cmd, args, ...write });
    return write.promise;
  });
  return writes;
}

function mockPendingSaveAsTransactions() {
  const dialogs = [];
  const writes = [];
  mockIPC((cmd, args) => {
    const operation = deferred();
    if (cmd === "plugin:dialog|save") {
      dialogs.push({ cmd, args, ...operation });
      return operation.promise;
    }
    if (cmd === "write_markdown_file_if_unmodified") {
      writes.push({ cmd, args, ...operation });
      return operation.promise;
    }
    throw new Error(`Unexpected IPC command: ${cmd}`);
  });
  return { dialogs, writes };
}

function successfulWrite(revision, path = "/tmp/Untitled.md") {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return {
    conflict: false,
    currentRevision: revision,
    canonicalPath: path,
    name: path.slice(separatorIndex + 1),
  };
}

function conflictingWrite(revision, path = "/tmp/draft.md") {
  return { ...successfulWrite(revision, path), conflict: true };
}

test("flushAndReadBuffer publishes and returns the exact pending editor buffer", async () => {
  await installDom();
  const rendered = renderUseEditorWithSurface("Draft");

  try {
    enterEditMode(rendered, "Draft");
    rendered.setLiveContent("Draft with unpublished words");

    let captured;
    flushSync(() => {
      captured = rendered.api().flushAndReadBuffer();
    });

    assert.equal(captured, "Draft with unpublished words");
    assert.equal(rendered.api().buffer, "Draft with unpublished words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.flushCount(), 1);
    assert.deepEqual(rendered.api().captureSnapshotBuffer(), {
      content: "Draft with unpublished words",
      dirty: true,
    });
    assert.equal(rendered.flushCount(), 2);
  } finally {
    rendered.cleanup();
  }
});

async function resolveDialog(dialog, selectedPath) {
  await act(async () => {
    dialog.resolve(selectedPath);
    await Promise.resolve();
  });
}

test("useEditor preserves in-flight typing and saves it with the returned revision next", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    const firstSavedRevision = { mtimeMs: 2, size: 17, contentHash: "first-save" };
    const secondSavedRevision = { mtimeMs: 3, size: 27, contentHash: "second-save" };

    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Draft before save");
    const firstSave = startSave(rendered);

    assert.equal(rendered.api().saving, true);
    assert.deepEqual(await rendered.api().save("/tmp/draft.md"), { status: "noop" });
    assert.equal(writes.length, 1);

    updateBuffer(rendered, "Draft before save\nNew words");
    assert.equal(writes[0].cmd, "write_markdown_file_if_unmodified");
    assert.equal(writes[0].args.content, "Draft before save");
    assert.deepEqual(writes[0].args.expectedRevision, originalRevision);

    const firstResult = await settleSave(
      writes[0],
      firstSave,
      successfulWrite(firstSavedRevision, "/tmp/draft.md"),
    );
    assert.deepEqual(firstResult, {
      status: "saved-with-newer-edits",
      file: {
        canonicalPath: "/tmp/draft.md",
        name: "draft.md",
        content: "Draft before save",
        revision: firstSavedRevision,
      },
    });
    assert.equal(rendered.api().saving, false);
    assert.equal(rendered.api().buffer, "Draft before save\nNew words");
    assert.equal(rendered.api().dirty, true);

    const secondSave = startSave(rendered);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].args.content, "Draft before save\nNew words");
    assert.deepEqual(writes[1].args.expectedRevision, firstSavedRevision);
    const secondResult = await settleSave(
      writes[1],
      secondSave,
      successfulWrite(secondSavedRevision, "/tmp/draft.md"),
    );
    assert.equal(secondResult.status, "saved");
    assert.equal(secondResult.file.content, "Draft before save\nNew words");
    assert.deepEqual(secondResult.file.revision, secondSavedRevision);
    assert.equal(rendered.api().dirty, false);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor is clean when in-flight edits return to the saved snapshot", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Snapshot");
    const savePromise = startSave(rendered);
    updateBuffer(rendered, "Temporary words");
    updateBuffer(rendered, "Snapshot");

    assert.equal(
      (await settleSave(
        writes[0],
        savePromise,
        successfulWrite(
          { mtimeMs: 2, size: 8, contentHash: "snapshot" },
          "/tmp/draft.md",
        ),
      )).status,
      "saved",
    );
    assert.equal(rendered.api().buffer, "Snapshot");
    assert.equal(rendered.api().dirty, false);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor preserves newer typing when a save conflicts", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Snapshot");
    const savePromise = startSave(rendered);
    updateBuffer(rendered, "Snapshot with newer words");

    assert.equal(
      (await settleSave(
        writes[0],
        savePromise,
        conflictingWrite(
          { mtimeMs: 2, size: 10, contentHash: "external" },
          "/tmp/draft.md",
        ),
      )).status,
      "conflict",
    );
    assert.equal(rendered.api().saving, false);
    assert.equal(rendered.api().buffer, "Snapshot with newer words");
    assert.equal(rendered.api().dirty, true);
    assert.match(rendered.api().saveError, /changed outside Bindars/);
  } finally {
    rendered.cleanup();
  }
});

test("quiet autosave conflict returns status without publishing the manual-save banner", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Autosave words");
    const savePromise = startSave(rendered, "/tmp/draft.md", { quiet: true });

    const result = await settleSave(
      writes[0],
      savePromise,
      conflictingWrite(
        { mtimeMs: 2, size: 8, contentHash: "external" },
        "/tmp/draft.md",
      ),
    );

    assert.equal(result.status, "conflict");
    assert.equal(rendered.api().saveError, null);
    assert.equal(rendered.api().dirty, true);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor preserves newer typing when a save fails", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Snapshot");
    const savePromise = startSave(rendered);
    updateBuffer(rendered, "Snapshot with newer words");

    assert.equal((await rejectSave(writes[0], savePromise, new Error("Disk full"))).status, "error");
    assert.equal(rendered.api().saving, false);
    assert.equal(rendered.api().buffer, "Snapshot with newer words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().saveError, "Disk full");
  } finally {
    rendered.cleanup();
  }
});

test("equal-byte reconciliation refreshes the conditional-save revision", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    const touchedRevision = { mtimeMs: 2, size: 5, contentHash: "before" };
    enterEditMode(rendered, "Draft");
    const captured = rendered.api().getReconciliationState();
    let refreshed;
    flushSync(() => {
      refreshed = rendered.api().refreshCleanExpectedRevision(
        captured.sessionId,
        captured.content,
        captured.expectedRevision,
        touchedRevision,
      );
    });
    assert.equal(refreshed, true);

    updateBuffer(rendered, "Draft with local words");
    const savePromise = startSave(rendered);
    assert.deepEqual(writes[0].args.expectedRevision, touchedRevision);
    await settleSave(
      writes[0],
      savePromise,
      successfulWrite({ mtimeMs: 3, size: 22, contentHash: "saved" }, "/tmp/draft.md"),
    );
  } finally {
    rendered.cleanup();
  }
});

test("dirty equal-byte reconciliation refreshes only the expected revision", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    const touchedRevision = { mtimeMs: 2, size: 5, contentHash: "before" };
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Draft with local words");
    const captured = rendered.api().getReconciliationState();
    updateBuffer(rendered, "Draft with still newer local words");

    let refreshed;
    flushSync(() => {
      refreshed = rendered.api().refreshDirtyExpectedRevision(
        captured.sessionId,
        captured.expectedRevision,
        touchedRevision,
      );
    });
    assert.equal(refreshed, true);
    assert.equal(rendered.api().buffer, "Draft with still newer local words");
    assert.equal(rendered.api().dirty, true);

    const savePromise = startSave(rendered);
    assert.deepEqual(writes[0].args.expectedRevision, touchedRevision);
    await settleSave(
      writes[0],
      savePromise,
      successfulWrite({ mtimeMs: 3, size: 34, contentHash: "saved" }, "/tmp/draft.md"),
    );
  } finally {
    rendered.cleanup();
  }
});

test("clean-editor reconciliation refreshes baseline, buffer, and expected revision atomically", async () => {
  await installDom();
  const rendered = renderUseEditor();

  try {
    const externalRevision = { mtimeMs: 2, size: 14, contentHash: "external" };
    enterEditMode(rendered, "Draft");
    const captured = rendered.api().getReconciliationState();
    const adoptions = [];
    let refreshed;
    flushSync(() => {
      refreshed = rendered.api().refreshCleanBuffer(
        captured.sessionId,
        captured.content,
        captured.expectedRevision,
        "External words",
        externalRevision,
        (capturedDocument, externalDocument) => {
          adoptions.push({ capturedDocument, externalDocument });
          return true;
        },
      );
    });

    assert.equal(refreshed, true);
    assert.equal(rendered.api().buffer, "External words");
    assert.equal(rendered.api().dirty, false);
    assert.deepEqual(adoptions, [{
      capturedDocument: "Draft",
      externalDocument: "External words",
    }]);
    assert.deepEqual(rendered.api().getReconciliationState(), {
      sessionId: captured.sessionId,
      content: "External words",
      dirty: false,
      expectedRevision: externalRevision,
    });
  } finally {
    rendered.cleanup();
  }
});

test("clean-editor reconciliation refuses a changed session or buffer", async () => {
  await installDom();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    const captured = rendered.api().getReconciliationState();
    updateBuffer(rendered, "Local words");
    assert.equal(rendered.api().refreshCleanBuffer(
      captured.sessionId,
      captured.content,
      captured.expectedRevision,
      "External words",
      { mtimeMs: 2, size: 14, contentHash: "external" },
      () => {
        throw new Error("stale clean state must not reach the surface");
      },
    ), false);
    assert.equal(rendered.api().buffer, "Local words");
    assert.equal(rendered.api().dirty, true);

    enterEditMode(rendered, "New session");
    assert.equal(rendered.api().refreshCleanExpectedRevision(
      captured.sessionId,
      captured.content,
      captured.expectedRevision,
      { mtimeMs: 3, size: 11, contentHash: "new" },
    ), false);
    assert.equal(rendered.api().buffer, "New session");
  } finally {
    rendered.cleanup();
  }
});

test("clean-editor reconciliation retains newer surface typing when atomic adoption fails", async () => {
  await installDom();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    const captured = rendered.api().getReconciliationState();
    let refreshed;
    flushSync(() => {
      refreshed = rendered.api().refreshCleanBuffer(
        captured.sessionId,
        captured.content,
        captured.expectedRevision,
        "External words",
        { mtimeMs: 2, size: 14, contentHash: "external" },
        () => {
          rendered.api().updateBuffer("Newer surface typing");
          return false;
        },
      );
    });

    assert.equal(refreshed, false);
    assert.equal(rendered.api().buffer, "Newer surface typing");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().externalChange, "changed");
    assert.match(rendered.api().saveError, /buffer is preserved and autosave is paused/);
    assert.deepEqual(rendered.api().getReconciliationState().expectedRevision, originalRevision);
  } finally {
    rendered.cleanup();
  }
});

test("dirty external-change protection retains exact words and an existing save problem", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Exact local words");
    const failedSave = startSave(rendered);
    await rejectSave(writes[0], failedSave, new Error("Disk full"));
    const captured = rendered.api().getReconciliationState();

    flushSync(() => {
      rendered.api().protectFromExternalChange(captured.sessionId, "changed");
    });
    assert.equal(rendered.api().buffer, "Exact local words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().externalChange, "changed");
    assert.equal(rendered.api().saveError, "Disk full");

    updateBuffer(rendered, "Exact local words plus more");
    assert.equal(rendered.api().buffer, "Exact local words plus more");
    assert.equal(rendered.api().externalChange, "changed");
    assert.equal(rendered.api().saveError, "Disk full");
  } finally {
    rendered.cleanup();
  }
});

test("an unresolved external change stays recovery-required after undoing to the old baseline", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Local words");
    const captured = rendered.api().getReconciliationState();
    flushSync(() => {
      rendered.api().protectFromExternalChange(captured.sessionId, "changed");
      rendered.api().updateBuffer("Draft");
    });

    assert.equal(rendered.api().buffer, "Draft");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().externalChange, "changed");
    assert.deepEqual(rendered.api().captureSnapshotBuffer(), {
      content: "Draft",
      dirty: true,
    });

    const conflictedSave = startSave(rendered);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args.content, "Draft");
    assert.deepEqual(writes[0].args.expectedRevision, originalRevision);
    assert.equal((await settleSave(
      writes[0],
      conflictedSave,
      conflictingWrite({ mtimeMs: 2, size: 14, contentHash: "external" }),
    )).status, "conflict");
    assert.equal(rendered.api().dirty, true);

    const overwrite = startSave(rendered, "/tmp/draft.md", { force: true });
    assert.equal((await settleSave(
      writes[1],
      overwrite,
      successfulWrite({ mtimeMs: 3, size: 5, contentHash: "saved" }, "/tmp/draft.md"),
    )).status, "saved");
    assert.equal(rendered.api().dirty, false);
    assert.equal(rendered.api().externalChange, null);
  } finally {
    rendered.cleanup();
  }
});

test("confirmed deletion preserves even a clean editor buffer for later recovery", async () => {
  await installDom();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Recoverable words");
    const captured = rendered.api().getReconciliationState();
    flushSync(() => {
      rendered.api().protectFromExternalChange(captured.sessionId, "deleted");
    });

    assert.equal(rendered.api().buffer, "Recoverable words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().externalChange, "deleted");
    assert.match(rendered.api().saveError, /deleted outside Bindars/);
    assert.deepEqual(rendered.api().captureSnapshotBuffer(), {
      content: "Recoverable words",
      dirty: true,
    });
  } finally {
    rendered.cleanup();
  }
});

test("conditional save retries one equal-content metadata conflict", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    const touchedRevision = { mtimeMs: 2, size: 5, contentHash: "before" };
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Local words");
    const savePromise = startSave(rendered);

    await act(async () => {
      writes[0].resolve(conflictingWrite(touchedRevision));
      await Promise.resolve();
    });
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].args.expectedRevision, touchedRevision);

    const result = await settleSave(
      writes[1],
      savePromise,
      successfulWrite({ mtimeMs: 3, size: 11, contentHash: "saved" }, "/tmp/draft.md"),
    );
    assert.equal(result.status, "saved");
    assert.equal(rendered.api().saveError, null);
  } finally {
    rendered.cleanup();
  }
});

test("read-only save failure exposes a working Save As recovery", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Original");
    updateBuffer(rendered, "Edited words");
    const failedSave = startSave(rendered, "/tmp/Original.fountain");
    const failure = await rejectSave(operations.writes[0], failedSave, {
      category: "readOnly",
      operation: "saveDocument",
      message: "This file is read-only and was not changed.",
      detail: "/tmp/Original.fountain has mode 0444",
    });

    assert.deepEqual(failure, { status: "error" });
    assert.equal(rendered.api().saveError, "This file is read-only and was not changed.");
    assert.equal(rendered.api().saveErrorRecovery, "save-as");
    assert.equal(rendered.api().dirty, true);

    const cancelledRecovery = startSaveAs(rendered, "Original.fountain");
    assert.deepEqual(operations.dialogs[0].args.options.filters, [{
      name: "Bindars document",
      extensions: ["md", "markdown", "fountain"],
    }]);
    await resolveDialog(operations.dialogs[0], null);
    assert.deepEqual(await cancelledRecovery, { status: "cancelled" });
    assert.equal(rendered.api().saveError, "This file is read-only and was not changed.");
    assert.equal(rendered.api().saveErrorRecovery, "save-as");

    const recovery = startSaveAs(rendered, "Original.fountain");
    await resolveDialog(operations.dialogs[1], "/tmp/Writable Copy.fountain");
    const result = await settleSave(
      operations.writes[1],
      recovery,
      successfulWrite(
        { mtimeMs: 2, size: 12, contentHash: "copy" },
        "/tmp/Writable Copy.fountain",
      ),
    );

    assert.equal(result.status, "saved");
    assert.equal(result.file.canonicalPath, "/tmp/Writable Copy.fountain");
    assert.equal(rendered.api().saveError, null);
    assert.equal(rendered.api().saveErrorRecovery, null);
    assert.equal(rendered.api().dirty, false);
  } finally {
    rendered.cleanup();
  }
});

test("quiet autosave failure returns status without publishing the manual-save banner", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    updateBuffer(rendered, "Autosave words");
    const savePromise = startSave(rendered, "/tmp/draft.md", { quiet: true });

    const result = await rejectSave(writes[0], savePromise, new Error("disk full"));

    assert.equal(result.status, "error");
    assert.equal(rendered.api().saveError, null);
    assert.equal(rendered.api().dirty, true);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor ignores an old save completion after a new edit session starts", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditor();

  try {
    const secondRevision = { mtimeMs: 20, size: 8, contentHash: "second" };
    const secondSavedRevision = { mtimeMs: 21, size: 8, contentHash: "second-saved" };

    enterEditMode(rendered, "First file");
    updateBuffer(rendered, "First file changed");
    const oldSave = startSave(rendered, "/tmp/first.md");

    flushSync(() => rendered.api().exitEditMode());
    enterEditMode(rendered, "Second file", secondRevision);
    const secondSave = startSave(rendered, "/tmp/second.md");
    assert.equal(writes.length, 2, "the new session should not be blocked by the old save");

    assert.equal(
      (await settleSave(
        writes[0],
        oldSave,
        successfulWrite(
          { mtimeMs: 2, size: 18, contentHash: "first-saved" },
          "/tmp/first.md",
        ),
      )).status,
      "stale",
    );
    assert.equal(rendered.api().buffer, "Second file");
    assert.equal(rendered.api().dirty, false);
    assert.equal(rendered.api().saving, true);

    assert.equal(
      (await settleSave(
        writes[1],
        secondSave,
        successfulWrite(secondSavedRevision, "/tmp/second.md"),
      )).status,
      "saved",
    );

    updateBuffer(rendered, "Second file changed");
    const followUpSave = startSave(rendered, "/tmp/second.md");
    assert.deepEqual(writes[2].args.expectedRevision, secondSavedRevision);
    await settleSave(
      writes[2],
      followUpSave,
      successfulWrite(
        { mtimeMs: 22, size: 19, contentHash: "second-follow-up" },
        "/tmp/second.md",
      ),
    );
  } finally {
    rendered.cleanup();
  }
});

test("useEditor acquires the duplicate guard before opening save-as", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft", null);
    const firstSaveAs = startSaveAs(rendered);

    assert.equal(rendered.api().saving, true);
    assert.equal(operations.dialogs.length, 1);
    assert.deepEqual(await rendered.api().save("/tmp/duplicate.md", { force: true }), { status: "noop" });
    assert.deepEqual(await rendered.api().saveAs("Duplicate.md"), { status: "noop" });
    assert.equal(operations.dialogs.length, 1);
    assert.equal(operations.writes.length, 0);

    let result;
    await act(async () => {
      operations.dialogs[0].resolve(null);
      result = await firstSaveAs;
    });
    assert.deepEqual(result, { status: "cancelled" });
  } finally {
    rendered.cleanup();
  }
});

test("useEditor captures the save-as snapshot after the dialog and preserves later typing", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    const savedRevision = { mtimeMs: 2, size: 25, contentHash: "saved-snapshot" };
    enterEditMode(rendered, "Draft", null);
    const savePromise = startSaveAs(rendered);
    updateBuffer(rendered, "Typing while dialog waits");

    await resolveDialog(operations.dialogs[0], "/tmp/New draft.md");
    assert.equal(operations.writes.length, 1);
    assert.equal(operations.writes[0].args.content, "Typing while dialog waits");
    assert.equal(operations.writes[0].args.expectedRevision, null);
    assert.equal(operations.writes[0].args.force, true);

    updateBuffer(rendered, "Typing while write waits");
    const result = await settleSave(
      operations.writes[0],
      savePromise,
      successfulWrite(savedRevision, "/tmp/New draft.md"),
    );

    assert.equal(result.status, "saved-with-newer-edits");
    assert.equal(result.file.content, "Typing while dialog waits");
    assert.equal(rendered.api().buffer, "Typing while write waits");
    assert.equal(rendered.api().dirty, true);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor save-as cancellation preserves a dirty buffer without an error", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft", null);
    updateBuffer(rendered, "Unsaved words");
    const savePromise = startSaveAs(rendered);

    let result;
    await act(async () => {
      operations.dialogs[0].resolve(null);
      result = await savePromise;
    });

    assert.deepEqual(result, { status: "cancelled" });
    assert.equal(rendered.api().saving, false);
    assert.equal(rendered.api().buffer, "Unsaved words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().saveError, null);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor exposes save dialog failures without losing text", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft", null);
    updateBuffer(rendered, "Unsaved words");
    const savePromise = startSaveAs(rendered);
    const result = await rejectSave(
      operations.dialogs[0],
      savePromise,
      new Error("Dialog unavailable"),
    );

    assert.deepEqual(result, { status: "error" });
    assert.equal(rendered.api().saving, false);
    assert.equal(rendered.api().buffer, "Unsaved words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().saveError, "Dialog unavailable");
  } finally {
    rendered.cleanup();
  }
});

test("useEditor exposes save-as write failures without losing newer text", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft", null);
    updateBuffer(rendered, "Snapshot");
    const savePromise = startSaveAs(rendered);
    await resolveDialog(operations.dialogs[0], "/tmp/Draft.md");
    updateBuffer(rendered, "Newer words");

    const result = await rejectSave(
      operations.writes[0],
      savePromise,
      new Error("Disk full"),
    );

    assert.deepEqual(result, { status: "error" });
    assert.equal(rendered.api().buffer, "Newer words");
    assert.equal(rendered.api().dirty, true);
    assert.equal(rendered.api().saveError, "Disk full");
  } finally {
    rendered.cleanup();
  }
});

test("useEditor uses the save-as revision for the next regular save", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    const saveAsRevision = { mtimeMs: 2, size: 5, contentHash: "save-as" };
    const regularRevision = { mtimeMs: 3, size: 12, contentHash: "regular" };
    enterEditMode(rendered, "", null);
    updateBuffer(rendered, "Draft");
    const saveAsPromise = startSaveAs(rendered);
    await resolveDialog(operations.dialogs[0], "/tmp/Draft.md");
    assert.equal(
      (await settleSave(
        operations.writes[0],
        saveAsPromise,
        successfulWrite(saveAsRevision, "/tmp/Draft.md"),
      )).status,
      "saved",
    );

    updateBuffer(rendered, "Draft again");
    const regularSave = startSave(rendered, "/tmp/Draft.md");
    assert.deepEqual(operations.writes[1].args.expectedRevision, saveAsRevision);
    assert.equal(
      (await settleSave(
        operations.writes[1],
        regularSave,
        successfulWrite(regularRevision, "/tmp/Draft.md"),
      )).status,
      "saved",
    );
  } finally {
    rendered.cleanup();
  }
});

test("useEditor rejects unsupported save-as extensions before writing", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft", null);
    const savePromise = startSaveAs(rendered);

    let result;
    await act(async () => {
      operations.dialogs[0].resolve("/tmp/Draft.txt");
      result = await savePromise;
    });

    assert.deepEqual(result, { status: "error" });
    assert.equal(operations.writes.length, 0);
    assert.match(rendered.api().saveError, /\.md, \.markdown, or \.fountain/);
    assert.equal(rendered.api().saveErrorRecovery, "save-as");
  } finally {
    rendered.cleanup();
  }
});

test("useEditor can save an empty virtual document", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    const revision = { mtimeMs: 2, size: 0, contentHash: "empty" };
    enterEditMode(rendered, "", null);
    const savePromise = startSaveAs(rendered);
    await resolveDialog(operations.dialogs[0], "/tmp/Empty.md");

    assert.equal(operations.writes[0].args.content, "");
    const result = await settleSave(
      operations.writes[0],
      savePromise,
      successfulWrite(revision, "/tmp/Empty.md"),
    );
    assert.equal(result.status, "saved");
    assert.equal(rendered.api().dirty, false);
  } finally {
    rendered.cleanup();
  }
});

test("useEditor supersedes save-as while the dialog is pending", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "First", null);
    const oldSave = startSaveAs(rendered, "First.md");
    enterEditMode(rendered, "Second", null);

    let result;
    await act(async () => {
      operations.dialogs[0].resolve("/tmp/First.md");
      result = await oldSave;
    });

    assert.deepEqual(result, { status: "stale" });
    assert.equal(operations.writes.length, 0);
    assert.equal(rendered.api().buffer, "Second");
    assert.equal(rendered.api().saving, false);
  } finally {
    rendered.cleanup();
  }
});

test("a stale save-as write cannot clear a newer session save", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "First", null);
    const oldSave = startSaveAs(rendered, "First.md");
    await resolveDialog(operations.dialogs[0], "/tmp/First.md");

    enterEditMode(rendered, "Second", null);
    const newSave = startSaveAs(rendered, "Second.md");
    assert.equal(operations.dialogs.length, 2);

    const oldResult = await settleSave(
      operations.writes[0],
      oldSave,
      successfulWrite({ mtimeMs: 2, size: 5, contentHash: "first" }, "/tmp/First.md"),
    );
    assert.deepEqual(oldResult, { status: "stale" });
    assert.equal(rendered.api().buffer, "Second");
    assert.equal(rendered.api().saving, true);

    let newResult;
    await act(async () => {
      operations.dialogs[1].resolve(null);
      newResult = await newSave;
    });
    assert.deepEqual(newResult, { status: "cancelled" });
  } finally {
    rendered.cleanup();
  }
});

test("updateBuffer returns its synchronous dirty result, including a return to the snapshot", async () => {
  await installDom();
  const rendered = renderUseEditor();

  try {
    enterEditMode(rendered, "Draft");
    let dirty;
    flushSync(() => {
      dirty = rendered.api().updateBuffer("Changed");
    });
    assert.equal(dirty, true);

    flushSync(() => {
      dirty = rendered.api().updateBuffer("Draft");
    });
    assert.equal(dirty, false);
    assert.equal(rendered.api().dirty, false);
  } finally {
    rendered.cleanup();
  }
});

test("regular save flushes before its snapshot and again before classifying completion", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditorWithSurface("Draft");

  try {
    enterEditMode(rendered, "Draft");
    rendered.setLiveContent("Newest before save");
    const savePromise = startSave(rendered);

    assert.equal(rendered.flushCount(), 1);
    assert.equal(writes[0].args.content, "Newest before save");
    assert.deepEqual(await rendered.api().save("/tmp/duplicate.md"), { status: "noop" });
    assert.equal(rendered.flushCount(), 1, "a duplicate save must not touch the surface");

    rendered.setLiveContent("Newest during write");
    const result = await settleSave(
      writes[0],
      savePromise,
      successfulWrite({ mtimeMs: 2, size: 18, contentHash: "saved" }, "/tmp/draft.md"),
    );
    assert.equal(result.status, "saved-with-newer-edits");
    assert.equal(result.file.content, "Newest before save");
    assert.equal(rendered.flushCount(), 2);
    assert.equal(rendered.api().buffer, "Newest during write");
    assert.equal(rendered.api().dirty, true);
  } finally {
    rendered.cleanup();
  }
});

test("save-as flushes after the dialog and preserves pending write-time content", async () => {
  await installDom();
  const operations = mockPendingSaveAsTransactions();
  const rendered = renderUseEditorWithSurface("Draft");

  try {
    enterEditMode(rendered, "Draft", null);
    const savePromise = startSaveAs(rendered);
    assert.equal(rendered.flushCount(), 0, "save-as must not snapshot before the dialog");

    rendered.setLiveContent("Typed while dialog waits");
    await resolveDialog(operations.dialogs[0], "/tmp/New.md");
    assert.equal(rendered.flushCount(), 1);
    assert.equal(operations.writes[0].args.content, "Typed while dialog waits");

    rendered.setLiveContent("Typed while write waits");
    const result = await settleSave(
      operations.writes[0],
      savePromise,
      successfulWrite(
        { mtimeMs: 2, size: 24, contentHash: "save-as" },
        "/tmp/New.md",
      ),
    );
    assert.equal(result.status, "saved-with-newer-edits");
    assert.equal(rendered.flushCount(), 2);
    assert.equal(rendered.api().buffer, "Typed while write waits");
  } finally {
    rendered.cleanup();
  }
});

test("save-as cancellation and dialog failure publish the latest surface content", async () => {
  await installDom();

  {
    const operations = mockPendingSaveAsTransactions();
    const rendered = renderUseEditorWithSurface("Draft");
    try {
      enterEditMode(rendered, "Draft", null);
      const savePromise = startSaveAs(rendered);
      rendered.setLiveContent("Latest before cancel");

      let result;
      await act(async () => {
        operations.dialogs[0].resolve(null);
        result = await savePromise;
      });
      assert.deepEqual(result, { status: "cancelled" });
      assert.equal(rendered.api().buffer, "Latest before cancel");
      assert.equal(rendered.api().dirty, true);
    } finally {
      rendered.cleanup();
    }
  }

  {
    const operations = mockPendingSaveAsTransactions();
    const rendered = renderUseEditorWithSurface("Draft");
    try {
      enterEditMode(rendered, "Draft", null);
      const savePromise = startSaveAs(rendered);
      rendered.setLiveContent("Latest before dialog error");
      const result = await rejectSave(
        operations.dialogs[0],
        savePromise,
        new Error("Dialog unavailable"),
      );
      assert.deepEqual(result, { status: "error" });
      assert.equal(rendered.api().buffer, "Latest before dialog error");
      assert.equal(rendered.api().dirty, true);
    } finally {
      rendered.cleanup();
    }
  }
});

test("conflict and failure completions publish pending surface content before returning", async () => {
  await installDom();

  {
    const writes = mockPendingWrites();
    const rendered = renderUseEditorWithSurface("Draft");
    try {
      enterEditMode(rendered, "Draft");
      updateBuffer(rendered, "Snapshot");
      const savePromise = startSave(rendered);
      rendered.setLiveContent("Latest before conflict");
      const result = await settleSave(
        writes[0],
        savePromise,
        conflictingWrite({ mtimeMs: 2, size: 8, contentHash: "external" }),
      );
      assert.equal(result.status, "conflict");
      assert.equal(rendered.api().buffer, "Latest before conflict");
    } finally {
      rendered.cleanup();
    }
  }

  {
    const writes = mockPendingWrites();
    const rendered = renderUseEditorWithSurface("Draft");
    try {
      enterEditMode(rendered, "Draft");
      updateBuffer(rendered, "Snapshot");
      const savePromise = startSave(rendered);
      rendered.setLiveContent("Latest before failure");
      assert.equal((await rejectSave(writes[0], savePromise, new Error("Disk full"))).status, "error");
      assert.equal(rendered.api().buffer, "Latest before failure");
    } finally {
      rendered.cleanup();
    }
  }
});

test("a stale completion never flushes the surface belonging to a newer session", async () => {
  await installDom();
  const writes = mockPendingWrites();
  const rendered = renderUseEditorWithSurface("First");

  try {
    enterEditMode(rendered, "First");
    updateBuffer(rendered, "First changed");
    const oldSave = startSave(rendered, "/tmp/first.md");
    assert.equal(rendered.flushCount(), 1);

    enterEditMode(rendered, "Second", { mtimeMs: 10, size: 6, contentHash: "second" });
    rendered.setLiveContent("Second pending");
    const result = await settleSave(
      writes[0],
      oldSave,
      successfulWrite({ mtimeMs: 2, size: 13, contentHash: "first" }, "/tmp/first.md"),
    );
    assert.equal(result.status, "stale");
    assert.equal(rendered.flushCount(), 1);
    assert.equal(rendered.api().buffer, "Second");
  } finally {
    rendered.cleanup();
  }
});
