const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

const {
  AUTOMATIC_SNAPSHOT_RETRY_BASE_MS,
  AUTOMATIC_SNAPSHOT_RETRY_MAX_MS,
  AUTOSAVE_IDLE_MS,
  SNAPSHOT_INTERVAL_MS,
  usePersistenceCoordinator,
} = require("../.tmp/workspace-tests/src/hooks/usePersistenceCoordinator.js");
const {
  createDraftSnapshotId,
} = require("../.tmp/workspace-tests/src/lib/snapshots.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const fileDocument = {
  kind: "file",
  path: "/tmp/draft.md",
  name: "draft.md",
};

function successfulSnapshotResult(args) {
  return {
    snapshot: { id: "saved.md", createdAtMs: 1, size: args.content.length },
    merged: false,
    unchanged: false,
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderCoordinator(initialProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const apiRef = { current: null };
  let props = initialProps;

  function Probe() {
    const {
      active,
      snapshotActive = active,
      autosaveActive = active,
      ...coordinatorProps
    } = props;
    apiRef.current = usePersistenceCoordinator({
      ...coordinatorProps,
      snapshotActive,
      autosaveActive,
    });
    return null;
  }

  function render() {
    flushSync(() => root.render(React.createElement(Probe)));
  }

  render();
  return {
    api() {
      assert.ok(apiRef.current, "expected coordinator API");
      return apiRef.current;
    },
    rerender(nextProps) {
      props = nextProps;
      render();
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
      clearMocks();
    },
  };
}

test("automatic snapshots capture the first dirty buffer and each dirty interval", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval"] });
  const writes = [];
  let buffer = "first edit";
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    writes.push(args);
    return {
      snapshot: { id: `${writes.length}.md`, createdAtMs: writes.length, size: args.content.length },
      merged: false,
      unchanged: false,
    };
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: buffer, dirty: true }),
  });

  try {
    await flushPromises();
    assert.deepEqual(writes, [{
      document: fileDocument,
      content: "first edit",
      preservePrevious: false,
    }]);

    rendered.rerender({
      active: true,
      dirty: true,
      sessionKey: 1,
      document: { ...fileDocument },
      captureBuffer: () => ({ content: buffer, dirty: true }),
    });
    await flushPromises();
    assert.equal(writes.length, 1, "an equivalent document object must not restart the timer");

    buffer = "words after ten seconds";
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.deepEqual(writes[1], {
      document: fileDocument,
      content: "words after ten seconds",
      preservePrevious: true,
    });
  } finally {
    rendered.cleanup();
  }
});

test("external-change protection pauses autosave without pausing recovery snapshots", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const writes = [];
  let saveCount = 0;
  let buffer = "protected local words";
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    writes.push(args);
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    snapshotActive: true,
    autosaveActive: false,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    bufferVersion: buffer,
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  });

  try {
    await flushPromises();
    assert.equal(writes.length, 1);

    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(saveCount, 0);
    assert.equal(await rendered.api().flushAutosave(), null);

    buffer = "protected local words plus more";
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].content, buffer);
    assert.equal(writes[1].preservePrevious, true);
  } finally {
    rendered.cleanup();
  }
});

test("the interval flush catches continuous typing before React has published dirty state", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval"] });
  const writes = [];
  let captured = { content: "clean baseline", dirty: false };
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    writes.push(args);
    return {
      snapshot: { id: "continuous.md", createdAtMs: 1, size: args.content.length },
      merged: false,
      unchanged: false,
    };
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: false,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => captured,
  });

  try {
    await flushPromises();
    assert.equal(writes.length, 0);

    captured = { content: "continuously typed words", dirty: true };
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].content, "continuously typed words");
    assert.equal(writes[0].preservePrevious, true);

    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.equal(writes.length, 1, "unchanged dirty content should not enqueue again");
  } finally {
    rendered.cleanup();
  }
});

test("structured automatic snapshot failures use safe messages and retain retry behavior", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  const reported = [];
  const nativeFailure = {
    category: "unknown",
    operation: "accessRecoveryData",
    message: "Bindars could not access recovery data.",
    detail: "/private/recovery/snapshots: permission denied",
  };
  let buffer = "important words";
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    if (attempts.length === 1 || attempts.length === 3) throw nativeFailure;
    return {
      snapshot: { id: "saved.md", createdAtMs: 2, size: args.content.length },
      merged: false,
      unchanged: false,
    };
  });
  const baseProps = {
    active: true,
    dirty: true,
    document: fileDocument,
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutomaticSnapshotError: (message) => reported.push(message),
  };
  const rendered = renderCoordinator({ ...baseProps, sessionKey: 1 });

  try {
    await flushPromises();
    assert.equal(rendered.api().snapshotError, nativeFailure.message);
    assert.deepEqual(reported, [nativeFailure.message]);

    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS - 1);
    await flushPromises();
    assert.equal(attempts.length, 1);

    context.mock.timers.tick(1);
    await flushPromises();
    assert.equal(attempts.length, 2);
    assert.equal(
      attempts[1].preservePrevious,
      true,
      "a retry must preserve the last known-good recovery point",
    );
    assert.equal(rendered.api().snapshotError, null);
    assert.deepEqual(reported, [nativeFailure.message]);

    buffer = "important words after recovery";
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.equal(attempts.length, 3);
    assert.equal(rendered.api().snapshotError, nativeFailure.message);
    assert.deepEqual(reported, [nativeFailure.message]);

    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS - 1);
    await flushPromises();
    assert.equal(attempts.length, 3);
    context.mock.timers.tick(1);
    await flushPromises();
    assert.equal(attempts.length, 4, "a success must reset the next cooldown to 30 seconds");
    assert.equal(rendered.api().snapshotError, null);
  } finally {
    rendered.cleanup();
  }
});

test("automatic snapshot retry protects a clean buffer after autosave", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  const reported = [];
  let captured = { content: "autosaved words", dirty: true };
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    if (attempts.length === 1) throw new Error("storage blocked");
    return successfulSnapshotResult(args);
  });
  const baseProps = {
    active: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => captured,
    onAutomaticSnapshotError: (message) => reported.push(message),
  };
  const rendered = renderCoordinator({ ...baseProps, dirty: true });

  try {
    await flushPromises();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].preservePrevious, false);
    assert.equal(rendered.api().snapshotError, "storage blocked");
    assert.deepEqual(reported, ["storage blocked"]);

    captured = { content: "autosaved words", dirty: false };
    rendered.rerender({ ...baseProps, dirty: false });
    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS - 1);
    await flushPromises();
    assert.equal(attempts.length, 1);

    context.mock.timers.tick(1);
    await flushPromises();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].content, "autosaved words");
    assert.equal(attempts[1].preservePrevious, true);
    assert.equal(rendered.api().snapshotError, null);
    assert.deepEqual(reported, ["storage blocked"]);

    context.mock.timers.tick(
      AUTOMATIC_SNAPSHOT_RETRY_BASE_MS + (SNAPSHOT_INTERVAL_MS * 3),
    );
    await flushPromises();
    assert.equal(
      attempts.length,
      2,
      "a successful clean retry must not start periodic clean snapshots",
    );
  } finally {
    rendered.cleanup();
  }
});

test("failed clean retries keep backing off without repeating the warning toast", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  const reported = [];
  let captured = { content: "autosaved but unprotected", dirty: true };
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    throw new Error(`storage failure ${attempts.length}`);
  });
  const baseProps = {
    active: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => captured,
    onAutomaticSnapshotError: (message) => reported.push(message),
  };
  const rendered = renderCoordinator({ ...baseProps, dirty: true });

  try {
    await flushPromises();
    assert.equal(attempts.length, 1);
    assert.deepEqual(reported, ["storage failure 1"]);

    captured = { content: "autosaved but unprotected", dirty: false };
    rendered.rerender({ ...baseProps, dirty: false });
    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS);
    await flushPromises();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].preservePrevious, true);
    assert.equal(rendered.api().snapshotError, "storage failure 2");
    assert.deepEqual(reported, ["storage failure 1"]);

    context.mock.timers.tick((AUTOMATIC_SNAPSHOT_RETRY_BASE_MS * 2) - 1);
    await flushPromises();
    assert.equal(attempts.length, 2);
    context.mock.timers.tick(1);
    await flushPromises();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2].preservePrevious, true);
    assert.equal(rendered.api().snapshotError, "storage failure 3");
    assert.deepEqual(reported, ["storage failure 1"]);
  } finally {
    rendered.cleanup();
  }
});

test("changing sessions cancels a clean-buffer snapshot retry", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  let captured = { content: "old session words", dirty: true };
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    throw new Error("storage blocked");
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => captured,
  });

  try {
    await flushPromises();
    assert.equal(attempts.length, 1);

    captured = { content: "new clean session", dirty: false };
    rendered.rerender({
      active: true,
      dirty: false,
      sessionKey: 2,
      document: {
        kind: "file",
        path: "/tmp/second-draft.md",
        name: "second-draft.md",
      },
      captureBuffer: () => captured,
    });
    await flushPromises();
    assert.equal(rendered.api().snapshotError, null);

    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS * 2);
    await flushPromises();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].content, "old session words");
  } finally {
    rendered.cleanup();
  }
});

test("a clean snapshot retry waits for persistence to become active again", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  let captured = { content: "clean words behind a dialog", dirty: true };
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    if (attempts.length === 1) throw new Error("storage blocked");
    return successfulSnapshotResult(args);
  });
  const baseProps = {
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => captured,
  };
  const rendered = renderCoordinator({ ...baseProps, active: true, dirty: true });

  try {
    await flushPromises();
    assert.equal(attempts.length, 1);
    assert.equal(rendered.api().snapshotError, "storage blocked");

    captured = { content: "clean words behind a dialog", dirty: false };
    rendered.rerender({ ...baseProps, active: false, dirty: false });
    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS);
    await flushPromises();
    assert.equal(attempts.length, 1);
    assert.equal(rendered.api().snapshotError, "storage blocked");

    rendered.rerender({ ...baseProps, active: true, dirty: false });
    await flushPromises();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].preservePrevious, true);
    assert.equal(rendered.api().snapshotError, null);

    context.mock.timers.tick(
      AUTOMATIC_SNAPSHOT_RETRY_BASE_MS + (SNAPSHOT_INTERVAL_MS * 3),
    );
    await flushPromises();
    assert.equal(
      attempts.length,
      2,
      "reactivation must consume the retry instead of leaving it ready",
    );
  } finally {
    rendered.cleanup();
  }
});

test("repeated automatic snapshot failures double cooldowns and cap at five minutes", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let attemptCount = 0;
  let reportCount = 0;
  mockIPC((command) => {
    assert.equal(command, "write_document_snapshot");
    attemptCount += 1;
    throw new Error(`failure ${attemptCount}`);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "retry these words", dirty: true }),
    onAutomaticSnapshotError: () => { reportCount += 1; },
  });

  try {
    await flushPromises();
    assert.equal(attemptCount, 1);

    for (const delay of [
      AUTOMATIC_SNAPSHOT_RETRY_BASE_MS,
      AUTOMATIC_SNAPSHOT_RETRY_BASE_MS * 2,
      AUTOMATIC_SNAPSHOT_RETRY_BASE_MS * 4,
      AUTOMATIC_SNAPSHOT_RETRY_BASE_MS * 8,
      AUTOMATIC_SNAPSHOT_RETRY_MAX_MS,
      AUTOMATIC_SNAPSHOT_RETRY_MAX_MS,
    ]) {
      context.mock.timers.tick(delay - 1);
      await flushPromises();
      const beforeRetry = attemptCount;
      context.mock.timers.tick(1);
      await flushPromises();
      assert.equal(attemptCount, beforeRetry + 1);
    }
    assert.equal(reportCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("an automatic snapshot queued behind a failure waits for the new cooldown", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const firstWrite = deferred();
  const attempts = [];
  let buffer = "first queued words";
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    if (attempts.length === 1) return firstWrite.promise;
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: buffer, dirty: true }),
  });

  try {
    await flushPromises();
    assert.equal(attempts.length, 1);

    buffer = "newer words queued behind the failure";
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.equal(attempts.length, 1, "the newer request should still be queued");

    firstWrite.reject(new Error("disk busy"));
    await flushPromises();
    assert.equal(
      attempts.length,
      1,
      "queued automatic work must not bypass the cooldown started by the first failure",
    );

    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS - 1);
    await flushPromises();
    assert.equal(attempts.length, 1);
    context.mock.timers.tick(1);
    await flushPromises();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].content, "newer words queued behind the failure");
  } finally {
    rendered.cleanup();
  }
});

test("automatic snapshot cooldowns and warnings are isolated by edit session", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  const reported = [];
  let buffer = "session one words";
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    if (attempts.length <= 2) throw new Error(`failure ${attempts.length}`);
    return successfulSnapshotResult(args);
  });
  const baseProps = {
    active: true,
    dirty: true,
    document: fileDocument,
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutomaticSnapshotError: (message) => reported.push(message),
  };
  const rendered = renderCoordinator({ ...baseProps, sessionKey: 1 });

  try {
    await flushPromises();
    assert.equal(attempts.length, 1);
    assert.deepEqual(reported, ["failure 1"]);

    buffer = "session two words";
    rendered.rerender({ ...baseProps, sessionKey: 2 });
    await flushPromises();
    assert.equal(attempts.length, 2, "the new session must not inherit the old cooldown");
    assert.deepEqual(reported, ["failure 1", "failure 2"]);

    context.mock.timers.tick(AUTOMATIC_SNAPSHOT_RETRY_BASE_MS);
    await flushPromises();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2].content, "session two words");
  } finally {
    rendered.cleanup();
  }
});

test("a successful required snapshot resets the automatic cooldown", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const attempts = [];
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    attempts.push(args);
    if (attempts.length === 1) throw new Error("disk busy");
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "required recovery words", dirty: true }),
  });

  try {
    await flushPromises();
    assert.equal(rendered.api().snapshotError, "disk busy");

    await act(async () => {
      await rendered.api().snapshotNow();
    });
    assert.equal(rendered.api().snapshotError, null);
    assert.equal(attempts.length, 2, "required snapshots must bypass automatic cooldowns");

    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.equal(
      attempts.length,
      3,
      "automatic snapshots must resume immediately after a successful required snapshot",
    );
  } finally {
    rendered.cleanup();
  }
});

test("required snapshot preserves its predecessor and propagates failure", async () => {
  await installDom();
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    assert.equal(args.preservePrevious, true);
    throw new Error("app-data unavailable");
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: false,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "current state", dirty: false }),
  });

  try {
    await assert.rejects(rendered.api().snapshotNow(), /app-data unavailable/);
  } finally {
    rendered.cleanup();
  }
});

test("waiting for the snapshot queue absorbs a prior required-write rejection", async () => {
  await installDom();
  const pending = deferred();
  mockIPC((command) => {
    assert.equal(command, "write_document_snapshot");
    return pending.promise;
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: false,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "current state", dirty: false }),
  });

  try {
    const snapshot = rendered.api().snapshotNow();
    const queueWait = rendered.api().waitForSnapshotQueue();
    pending.reject(new Error("app-data unavailable"));

    await assert.rejects(snapshot, /app-data unavailable/);
    await assert.doesNotReject(queueWait);
  } finally {
    rendered.cleanup();
  }
});

test("queued snapshots retain the document identity and buffer captured at request time", async () => {
  await installDom();
  const first = deferred();
  const writes = [];
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    writes.push(args);
    if (writes.length === 1) return first.promise;
    return {
      snapshot: { id: "second.md", createdAtMs: 2, size: args.content.length },
      merged: false,
      unchanged: false,
    };
  });
  let buffer = "first document words";
  const rendered = renderCoordinator({
    active: true,
    dirty: false,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: buffer, dirty: true }),
  });

  try {
    const firstRequest = rendered.api().snapshotNow();
    await flushPromises();
    buffer = "second document words";
    const draftDocument = { kind: "draft", id: "draft-2", name: "Untitled.md" };
    rendered.rerender({
      active: true,
      dirty: false,
      sessionKey: 2,
      document: draftDocument,
      captureBuffer: () => ({ content: buffer, dirty: true }),
    });
    const secondRequest = rendered.api().snapshotNow();

    first.resolve({
      snapshot: { id: "first.md", createdAtMs: 1, size: 20 },
      merged: false,
      unchanged: false,
    });
    await firstRequest;
    await secondRequest;

    assert.deepEqual(writes, [
      { document: fileDocument, content: "first document words", preservePrevious: true },
      { document: draftDocument, content: "second document words", preservePrevious: true },
    ]);
  } finally {
    rendered.cleanup();
  }
});

test("a required snapshot can target a newly adopted document before rerender", async () => {
  await installDom();
  const writes = [];
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    writes.push(args);
    return successfulSnapshotResult(args);
  });
  const draftDocument = { kind: "draft", id: "draft-before-save-as", name: "Untitled.md" };
  const adoptedDocument = {
    kind: "file",
    path: "/tmp/adopted.md",
    name: "adopted.md",
  };
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: draftDocument,
    captureBuffer: () => ({ content: "newer words", dirty: true }),
  });

  try {
    await flushPromises();
    writes.length = 0;

    await rendered.api().snapshotNow(adoptedDocument);

    assert.deepEqual(writes, [{
      document: adoptedDocument,
      content: "newer words",
      preservePrevious: true,
    }]);
  } finally {
    rendered.cleanup();
  }
});

test("draft snapshot ids stay inside the Rust identity character contract", () => {
  const id = createDraftSnapshotId();

  assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
});

test("autosave debounces from the latest buffer and snapshots before the real save", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const operations = [];
  let buffer = "first words";
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    operations.push(`snapshot:${args.content}`);
    return successfulSnapshotResult(args);
  });
  const baseProps = {
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutosave: async () => {
      operations.push(`save:${buffer}`);
      return "saved";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, bufferVersion: buffer });

  try {
    await flushPromises();
    context.mock.timers.tick(AUTOSAVE_IDLE_MS - 1);
    await flushPromises();
    assert.ok(!operations.some((operation) => operation.startsWith("save:")));

    buffer = "latest idle words";
    rendered.rerender({ ...baseProps, bufferVersion: buffer });
    context.mock.timers.tick(AUTOSAVE_IDLE_MS - 1);
    await flushPromises();
    assert.ok(!operations.some((operation) => operation.startsWith("save:")));

    context.mock.timers.tick(1);
    await flushPromises();
    assert.deepEqual(operations.slice(-2), [
      "snapshot:latest idle words",
      "save:latest idle words",
    ]);
  } finally {
    rendered.cleanup();
  }
});

test("flushAutosave commits a pending debounce immediately", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let saveCount = 0;
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    bufferVersion: "boundary words",
    captureBuffer: () => ({ content: "boundary words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  });

  try {
    await flushPromises();
    assert.equal(await rendered.api().flushAutosave(), "saved");
    assert.equal(saveCount, 1);
    context.mock.timers.tick(AUTOSAVE_IDLE_MS * 2);
    await flushPromises();
    assert.equal(saveCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("cancelAutosaveAndWait clears the debounce before a manual save", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let saveCount = 0;
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    bufferVersion: "manual words",
    captureBuffer: () => ({ content: "manual words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  });

  try {
    await flushPromises();
    assert.equal(await rendered.api().cancelAutosaveAndWait(), null);
    context.mock.timers.tick(AUTOSAVE_IDLE_MS * 2);
    await flushPromises();
    assert.equal(saveCount, 0);
  } finally {
    rendered.cleanup();
  }
});

test("an autosave conflict marks once, pauses timers, and is returned to a boundary", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let saveCount = 0;
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    return successfulSnapshotResult(args);
  });
  const baseProps = {
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "conflicting words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "conflict";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, bufferVersion: "v1" });

  try {
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(saveCount, 1);
    assert.equal(rendered.api().autosaveIssue.kind, "conflict");

    rendered.rerender({ ...baseProps, bufferVersion: "v2" });
    context.mock.timers.tick(AUTOSAVE_IDLE_MS * 3);
    await flushPromises();
    assert.equal(saveCount, 1);
    assert.equal(await rendered.api().flushAutosave(), "conflict");
    assert.equal(saveCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("an autosave error pauses without a retry storm", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let saveCount = 0;
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    bufferVersion: "error words",
    captureBuffer: () => ({ content: "error words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "error";
    },
  });

  try {
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(rendered.api().autosaveIssue.kind, "error");
    context.mock.timers.tick(AUTOSAVE_IDLE_MS * 4);
    await flushPromises();
    assert.equal(saveCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("a failed manual save pauses the pending automatic retry", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let saveCount = 0;
  mockIPC((command, args) => {
    assert.equal(command, "write_document_snapshot");
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    bufferVersion: "manual failure words",
    captureBuffer: () => ({ content: "manual failure words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  });

  try {
    rendered.api().recordSaveResult("error");
    context.mock.timers.tick(AUTOSAVE_IDLE_MS * 2);
    await flushPromises();
    assert.equal(saveCount, 0);
    assert.equal(rendered.api().autosaveIssue.kind, "error");
  } finally {
    rendered.cleanup();
  }
});

test("clearRecoveryHistory waits for an in-flight snapshot write and resets deduplication", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval"] });
  const operations = [];
  const pendingWrite = deferred();
  let writeCount = 0;
  mockIPC((command, args) => {
    if (command === "write_document_snapshot") {
      writeCount += 1;
      operations.push(`write:${args.content}`);
      if (writeCount === 1) return pendingWrite.promise;
      return successfulSnapshotResult(args);
    }
    assert.equal(command, "clear_snapshot_history");
    operations.push("clear");
    return null;
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "same words", dirty: true }),
  });

  try {
    await flushPromises();
    assert.deepEqual(operations, ["write:same words"]);

    const clearRequest = rendered.api().clearRecoveryHistory();
    await flushPromises();
    assert.deepEqual(
      operations,
      ["write:same words"],
      "clear must wait for the in-flight snapshot write",
    );

    pendingWrite.resolve(successfulSnapshotResult({ content: "same words" }));
    await clearRequest;
    assert.deepEqual(operations, ["write:same words", "clear"]);

    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.deepEqual(
      operations,
      ["write:same words", "clear", "write:same words"],
      "unchanged content must be re-protected after clearing",
    );
  } finally {
    rendered.cleanup();
  }
});

test("a snapshot requested during a pending clear waits for the deletion", async () => {
  await installDom();
  const operations = [];
  const pendingClear = deferred();
  mockIPC((command, args) => {
    if (command === "clear_snapshot_history") {
      operations.push("clear:start");
      return pendingClear.promise.then(() => {
        operations.push("clear:finish");
        return null;
      });
    }
    assert.equal(command, "write_document_snapshot");
    operations.push(`write:${args.content}`);
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: false,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "current state", dirty: true }),
  });

  try {
    const clearRequest = rendered.api().clearRecoveryHistory();
    const snapshotRequest = rendered.api().snapshotNow();
    await flushPromises();
    assert.deepEqual(operations, ["clear:start"]);

    pendingClear.resolve();
    await clearRequest;
    await snapshotRequest;
    assert.deepEqual(operations, ["clear:start", "clear:finish", "write:current state"]);
  } finally {
    rendered.cleanup();
  }
});

test("a successful clear cancels an automatic snapshot cooldown", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval"] });
  const operations = [];
  let failNextWrite = true;
  mockIPC((command, args) => {
    if (command === "clear_snapshot_history") {
      operations.push("clear");
      return null;
    }
    assert.equal(command, "write_document_snapshot");
    operations.push(`write:${args.content}`);
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("disk full");
    }
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "paused words", dirty: true }),
  });

  try {
    await flushPromises();
    assert.equal(rendered.api().snapshotError, "disk full");
    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.deepEqual(
      operations,
      ["write:paused words"],
      "the cooldown must block automatic retries before clearing",
    );

    await act(async () => {
      await rendered.api().clearRecoveryHistory();
    });
    assert.equal(rendered.api().snapshotError, null);

    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.deepEqual(operations, ["write:paused words", "clear", "write:paused words"]);
    assert.equal(rendered.api().snapshotError, null);
  } finally {
    rendered.cleanup();
  }
});

test("a failed clear does not bypass the current cooldown or hide the warning", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval"] });
  const operations = [];
  mockIPC((command, args) => {
    if (command === "clear_snapshot_history") {
      operations.push("clear");
      throw new Error("history locked");
    }
    assert.equal(command, "write_document_snapshot");
    operations.push(`write:${args.content}`);
    throw new Error("disk full");
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "still failing", dirty: true }),
  });

  try {
    await flushPromises();
    assert.equal(rendered.api().snapshotError, "disk full");

    await assert.rejects(rendered.api().clearRecoveryHistory(), /history locked/);
    await flushPromises();
    assert.equal(rendered.api().snapshotError, "disk full");

    context.mock.timers.tick(SNAPSHOT_INTERVAL_MS);
    await flushPromises();
    assert.deepEqual(
      operations,
      ["write:still failing", "clear"],
      "a failed clear must not bypass the current retry cooldown",
    );
  } finally {
    rendered.cleanup();
  }
});

test("a failed clear reports the error and leaves the snapshot queue usable", async () => {
  await installDom();
  const operations = [];
  mockIPC((command, args) => {
    if (command === "clear_snapshot_history") {
      operations.push("clear");
      throw new Error("history locked");
    }
    assert.equal(command, "write_document_snapshot");
    operations.push(`write:${args.content}`);
    return successfulSnapshotResult(args);
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: false,
    sessionKey: 1,
    document: fileDocument,
    captureBuffer: () => ({ content: "still protected", dirty: true }),
  });

  try {
    await assert.rejects(rendered.api().clearRecoveryHistory(), /history locked/);
    await rendered.api().snapshotNow();
    assert.deepEqual(operations, ["clear", "write:still protected"]);
  } finally {
    rendered.cleanup();
  }
});

test("snapshot failure never blocks the following autosave", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let snapshotCount = 0;
  let saveCount = 0;
  mockIPC((command) => {
    assert.equal(command, "write_document_snapshot");
    snapshotCount += 1;
    throw new Error("snapshot disk full");
  });
  const rendered = renderCoordinator({
    active: true,
    dirty: true,
    sessionKey: 1,
    document: fileDocument,
    bufferVersion: "save these words",
    captureBuffer: () => ({ content: "save these words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  });

  try {
    await flushPromises();
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(snapshotCount, 1);
    assert.equal(saveCount, 1);
    assert.equal(rendered.api().snapshotError, "snapshot disk full");
    assert.equal(rendered.api().autosaveIssue, null);
  } finally {
    rendered.cleanup();
  }
});
