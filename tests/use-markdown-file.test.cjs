const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

const {
  useMarkdownFile,
} = require("../.tmp/workspace-tests/src/hooks/useMarkdownFile.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderUseMarkdownFile() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const apiRef = { current: null };

  function Probe() {
    apiRef.current = useMarkdownFile();
    return null;
  }

  flushSync(() => root.render(React.createElement(Probe)));

  return {
    api() {
      assert.ok(apiRef.current, "expected useMarkdownFile to render");
      return apiRef.current;
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
      clearMocks();
    },
  };
}

function mockPendingOpens() {
  const opens = [];
  mockIPC((cmd, args) => {
    if (cmd !== "open_markdown_file") {
      throw new Error(`Unexpected IPC command: ${cmd}`);
    }
    const open = deferred();
    opens.push({ args, ...open });
    return open.promise;
  });
  return opens;
}

function startOpen(rendered, path = "/tmp/Slow.md", retryAction) {
  let openPromise;
  flushSync(() => {
    openPromise = rendered.api().openFilePathWithStatus(path, retryAction);
  });
  return openPromise;
}

const savedRevision = { mtimeMs: 2, size: 5, contentHash: "saved" };

test("virtual content supersedes a slow successful open", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const openPromise = startOpen(rendered);
    flushSync(() => rendered.api().setVirtualContent("", "Untitled.md"));

    let result;
    await act(async () => {
      opens[0].resolve({
        content: "Slow content",
        canonicalPath: "/tmp/Slow.md",
        name: "Slow.md",
        revision: savedRevision,
      });
      result = await openPromise;
    });

    assert.deepEqual(result, { status: "superseded" });
    assert.equal(rendered.api().content, "");
    assert.equal(rendered.api().filePath, null);
    assert.equal(rendered.api().fileName, "Untitled.md");
    assert.equal(rendered.api().loading, false);
  } finally {
    rendered.cleanup();
  }
});

test("virtual content suppresses a slow open failure", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const openPromise = startOpen(rendered);
    flushSync(() => rendered.api().setVirtualContent("New draft", "Untitled.md"));

    let result;
    await act(async () => {
      opens[0].reject(new Error("Slow open failed"));
      result = await openPromise;
    });

    assert.deepEqual(result, { status: "superseded" });
    assert.equal(rendered.api().content, "New draft");
    assert.equal(rendered.api().error, null);
  } finally {
    rendered.cleanup();
  }
});

test("typed open errors expose safe copy without native diagnostic detail", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const openPromise = startOpen(rendered, "/private/Denied.md");
    let result;
    await act(async () => {
      opens[0].reject({
        category: "permissionDenied",
        operation: "resolveDocument",
        message: "Bindars does not have permission to locate the document.",
        detail: "/private/Denied.md: raw OS error",
      });
      result = await openPromise;
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(rendered.api().error, {
      category: "permission-denied",
      message: "Bindars does not have permission to locate the document.",
    });
    assert.doesNotMatch(rendered.api().error.message, /raw OS error|bindars-error/);
  } finally {
    rendered.cleanup();
  }
});

test("saved-file adoption supersedes a slow open and publishes the supplied revision", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const openPromise = startOpen(rendered);
    flushSync(() => {
      rendered.api().adoptSavedFile({
        content: "Saved snapshot",
        canonicalPath: "/canonical/New.md",
        name: "New.md",
        revision: savedRevision,
      });
    });

    let result;
    await act(async () => {
      opens[0].resolve({
        content: "Slow content",
        canonicalPath: "/tmp/Slow.md",
        name: "Slow.md",
        revision: { mtimeMs: 1, size: 12, contentHash: "slow" },
      });
      result = await openPromise;
    });

    assert.deepEqual(result, { status: "superseded" });
    assert.equal(rendered.api().content, "Saved snapshot");
    assert.equal(rendered.api().filePath, "/canonical/New.md");
    assert.equal(rendered.api().fileName, "New.md");
    assert.deepEqual(rendered.api().fileRevision, savedRevision);
    assert.equal(rendered.api().openingPath, null);
  } finally {
    rendered.cleanup();
  }
});

test("reconciliation adoption defensively clears an active open", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const openPromise = startOpen(rendered, "/tmp/Slow-user-open.md");
    flushSync(() => rendered.api().adoptReconciledDocument({
      content: "Reconciled content",
      canonicalPath: "/tmp/Current.md",
      name: "Current.md",
      revision: savedRevision,
    }));

    assert.deepEqual(await openPromise, { status: "superseded" });
    assert.equal(rendered.api().loading, false);
    assert.equal(rendered.api().openingPath, null);
    assert.equal(rendered.api().content, "Reconciled content");

    opens[0].resolve({
      content: "Late user content",
      canonicalPath: "/tmp/Slow-user-open.md",
      name: "Slow-user-open.md",
      revision: savedRevision,
    });
    await opens[0].promise;
    assert.equal(rendered.api().content, "Reconciled content");
  } finally {
    rendered.cleanup();
  }
});

test("normal open and saved-file adoption publish the same document fields", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const openedFile = {
    content: "Opened content",
    canonicalPath: "/canonical/Opened.md",
    name: "Opened.md",
    revision: savedRevision,
  };

  try {
    const openPromise = startOpen(rendered, "/tmp/Opened.md");
    let openResult;
    await act(async () => {
      opens[0].resolve(openedFile);
      openResult = await openPromise;
    });
    assert.deepEqual(openResult, {
      status: "opened",
      canonicalPath: "/canonical/Opened.md",
    });
    const openedState = {
      content: rendered.api().content,
      filePath: rendered.api().filePath,
      fileName: rendered.api().fileName,
      fileRevision: rendered.api().fileRevision,
    };

    flushSync(() => rendered.api().setVirtualContent("Temporary", "Untitled.md"));
    flushSync(() => rendered.api().adoptSavedFile(openedFile));

    assert.deepEqual(
      {
        content: rendered.api().content,
        filePath: rendered.api().filePath,
        fileName: rendered.api().fileName,
        fileRevision: rendered.api().fileRevision,
      },
      openedState,
    );
  } finally {
    rendered.cleanup();
  }
});

test("a newer user request retains loading ownership when an older request settles", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    let firstPromise;
    let secondPromise;
    flushSync(() => {
      firstPromise = rendered.api().openFilePathWithStatus("/tmp/first.md");
      secondPromise = rendered.api().openFilePathWithStatus("/tmp/second.md");
    });

    await act(async () => {
      opens[0].resolve({
        content: "First",
        canonicalPath: "/tmp/first.md",
        name: "first.md",
        revision: savedRevision,
      });
      assert.deepEqual(await firstPromise, { status: "superseded" });
    });
    assert.equal(rendered.api().loading, true);

    await act(async () => {
      opens[1].resolve({
        content: "Second",
        canonicalPath: "/tmp/second.md",
        name: "second.md",
        revision: savedRevision,
      });
      assert.equal((await secondPromise).status, "opened");
    });
    assert.equal(rendered.api().loading, false);
  } finally {
    rendered.cleanup();
  }
});

test("a newer same-path request takes over the live native read", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const firstPath = "/tmp/Folder/../Shared.md";
  const secondPath = "/tmp/Shared.md";

  try {
    const firstPromise = startOpen(
      rendered,
      firstPath,
      { kind: "restore-session", path: firstPath, headingId: "saved-heading" },
    );
    const secondPromise = startOpen(
      rendered,
      secondPath,
      { kind: "open-recent", path: secondPath },
    );

    await act(async () => {
      assert.deepEqual(await firstPromise, { status: "superseded" });
    });
    assert.equal(opens.length, 1, "the replacement must reuse the active native read");
    assert.equal(rendered.api().loading, true);
    assert.equal(rendered.api().error, null);

    let secondResult;
    await act(async () => {
      opens[0].resolve({
        content: "Shared content",
        canonicalPath: secondPath,
        name: "Shared.md",
        revision: savedRevision,
      });
      secondResult = await secondPromise;
    });
    assert.deepEqual(secondResult, { status: "opened", canonicalPath: secondPath });
    assert.equal(rendered.api().content, "Shared content");
    assert.equal(rendered.api().loading, false);
    assert.equal(rendered.api().error, null);
  } finally {
    rendered.cleanup();
  }
});

test("unmount supersedes a pending user completion", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  let userPromise;
  flushSync(() => {
    userPromise = rendered.api().openFilePathWithStatus("/tmp/user.md");
  });
  rendered.cleanup();
  opens[0].resolve({
    content: "Late user",
    canonicalPath: "/tmp/user.md",
    name: "user.md",
    revision: savedRevision,
  });
  assert.deepEqual(await userPromise, { status: "superseded" });
});

test("slow opens expose cancellation and gate only that path until native settlement", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const retryAction = { kind: "open-file-path", path: "/tmp/Stalled.md" };

  try {
    flushSync(() => rendered.api().setVirtualContent("Keep this document", "Current.md"));
    const openPromise = startOpen(rendered, retryAction.path, retryAction);
    await act(async () => {
      context.mock.timers.tick(2_000);
      await Promise.resolve();
    });
    assert.equal(rendered.api().openingSlow, true);

    let result;
    await act(async () => {
      rendered.api().cancelPendingOpen();
      result = await openPromise;
    });
    assert.deepEqual(result, { status: "cancelled" });
    assert.equal(rendered.api().loading, false);
    assert.equal(rendered.api().content, "Keep this document");

    await act(async () => {
      result = await startOpen(rendered, retryAction.path, retryAction);
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "resource-unavailable");
    assert.equal(rendered.api().documentError.retryAvailability, "native-pending");
    assert.equal(opens.length, 1, "same-path attempts must not start another native read");

    await act(async () => {
      opens[0].resolve({
        content: "Late stale content",
        canonicalPath: retryAction.path,
        name: "Stalled.md",
        revision: savedRevision,
      });
      await opens[0].promise;
      await Promise.resolve();
    });
    assert.equal(rendered.api().content, "Keep this document");
    assert.equal(rendered.api().documentError.retryAvailability, "ready");
    assert.match(rendered.api().error.message, /Retry is now available/);
    assert.equal(opens.length, 1, "native settlement must never auto-retry");

    const retryPromise = startOpen(rendered, retryAction.path, retryAction);
    await act(async () => {
      opens[1].resolve({
        content: "Explicit retry content",
        canonicalPath: retryAction.path,
        name: "Stalled.md",
        revision: savedRevision,
      });
      result = await retryPromise;
    });
    assert.equal(result.status, "opened");
    assert.equal(rendered.api().content, "Explicit retry content");
  } finally {
    rendered.cleanup();
  }
});

test("a canceled stalled read does not globally block an unrelated healthy path", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const stalledPromise = startOpen(rendered, "/Volumes/Offline/Stalled.md");
    let stalledResult;
    await act(async () => {
      rendered.api().cancelPendingOpen();
      stalledResult = await stalledPromise;
    });
    assert.deepEqual(stalledResult, { status: "cancelled" });

    const healthyPromise = startOpen(rendered, "/tmp/Healthy.md");
    let healthyResult;
    await act(async () => {
      opens[1].resolve({
        content: "Healthy content",
        canonicalPath: "/tmp/Healthy.md",
        name: "Healthy.md",
        revision: savedRevision,
      });
      healthyResult = await healthyPromise;
    });
    assert.equal(healthyResult.status, "opened");
    assert.equal(rendered.api().content, "Healthy content");

    await act(async () => {
      opens[0].resolve({
        content: "Late stalled content",
        canonicalPath: "/Volumes/Offline/Stalled.md",
        name: "Stalled.md",
        revision: savedRevision,
      });
      await opens[0].promise;
    });
    assert.equal(rendered.api().content, "Healthy content");
  } finally {
    rendered.cleanup();
  }
});

test("open deadlines publish a direct unavailable error and preserve the current document", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const retryAction = { kind: "open-recent", path: "/Volumes/Cloud/Timed.md" };

  try {
    flushSync(() => rendered.api().setVirtualContent("Preserved bytes", "Current.md"));
    const openPromise = startOpen(rendered, retryAction.path, retryAction);
    let result;
    await act(async () => {
      context.mock.timers.tick(30_000);
      result = await openPromise;
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, {
      category: "resource-unavailable",
      message: "Opening this file timed out. Your current document remains open. Retry will become available when macOS finishes the storage request; if it never does, quit and reopen Bindars.",
    });
    assert.equal(rendered.api().content, "Preserved bytes");
    assert.equal(rendered.api().loading, false);
    assert.deepEqual(rendered.api().documentError.retryAction, retryAction);
    assert.equal(rendered.api().documentError.retryAvailability, "native-pending");

    await act(async () => {
      opens[0].resolve({
        content: "Too late",
        canonicalPath: retryAction.path,
        name: "Timed.md",
        revision: savedRevision,
      });
      await opens[0].promise;
      await Promise.resolve();
    });
    assert.equal(rendered.api().content, "Preserved bytes");
    assert.equal(rendered.api().documentError.retryAvailability, "ready");
    assert.match(rendered.api().error.message, /Retry is now available/);
  } finally {
    rendered.cleanup();
  }
});

test("timeout copy does not promise a Retry action when none was supplied", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const path = "/Volumes/Cloud/No-action.md";

  try {
    const openPromise = startOpen(rendered, path);
    let result;
    await act(async () => {
      context.mock.timers.tick(30_000);
      result = await openPromise;
    });

    assert.equal(result.status, "failed");
    assert.match(result.error.message, /Try opening the file again/);
    assert.doesNotMatch(result.error.message, /Retry will become available/);
    assert.equal(rendered.api().documentError.retryAction, null);
    assert.equal(rendered.api().documentError.retryAvailability, null);
  } finally {
    opens[0].resolve({
      content: "Late content",
      canonicalPath: path,
      name: "No-action.md",
      revision: savedRevision,
    });
    await opens[0].promise;
    rendered.cleanup();
  }
});

test("reconciliation cannot erase a Retry-bearing open error", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const retryAction = { kind: "open-recent", path: "/Volumes/Cloud/Next.md" };

  try {
    flushSync(() => rendered.api().setVirtualContent("Current bytes", "Current.md"));
    const openPromise = startOpen(rendered, retryAction.path, retryAction);
    await act(async () => {
      opens[0].reject({
        category: "resourceUnavailable",
        operation: "readDocument",
        message: "The next file is temporarily unavailable.",
        detail: "provider offline",
      });
      await openPromise;
    });

    const ownedOpenError = rendered.api().documentError;
    assert.equal(ownedOpenError.source, "open");
    assert.deepEqual(ownedOpenError.retryAction, retryAction);

    flushSync(() => rendered.api().reportReconciliationError({
      category: "resource-unavailable",
      message: "The current file is also unavailable.",
    }));
    assert.equal(rendered.api().documentError.ownerToken, ownedOpenError.ownerToken);

    flushSync(() => rendered.api().adoptReconciledDocument({
      content: "Externally refreshed bytes",
      canonicalPath: "/tmp/Current.md",
      name: "Current.md",
      revision: { mtimeMs: 3, size: 26, contentHash: "refreshed" },
    }));
    assert.equal(rendered.api().content, "Externally refreshed bytes");
    assert.equal(rendered.api().documentError.ownerToken, ownedOpenError.ownerToken);
    assert.deepEqual(rendered.api().documentError.retryAction, retryAction);

    flushSync(() => rendered.api().refreshReconciledRevision({
      mtimeMs: 4,
      size: 26,
      contentHash: "same-bytes",
    }));
    flushSync(() => rendered.api().clearReconciliationError());
    assert.equal(rendered.api().documentError.ownerToken, ownedOpenError.ownerToken);
  } finally {
    rendered.cleanup();
  }
});

test("reconciliation still replaces non-retry open errors", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const openPromise = startOpen(rendered, "/tmp/Ordinary-failure.md");
    await act(async () => {
      opens[0].reject(new Error("Ordinary open failure"));
      await openPromise;
    });
    assert.equal(rendered.api().documentError.source, "open");
    assert.equal(rendered.api().documentError.retryAction, null);

    flushSync(() => rendered.api().reportReconciliationError({
      category: "resource-unavailable",
      message: "The current file is unavailable.",
    }));
    assert.equal(rendered.api().documentError.source, "reconciliation");
    assert.equal(rendered.api().error.message, "The current file is unavailable.");

    flushSync(() => rendered.api().clearReconciliationError());
    assert.equal(rendered.api().documentError, null);
  } finally {
    rendered.cleanup();
  }
});

test("a superseded restore cannot dismiss a newer owned error", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();
  const newerAction = { kind: "open-file-path", path: "/tmp/Newer.md" };

  try {
    const restorePromise = startOpen(
      rendered,
      "/tmp/Stored.md",
      { kind: "restore-session", path: "/tmp/Stored.md", headingId: "saved" },
    );
    const newerPromise = startOpen(rendered, newerAction.path, newerAction);
    let restoreResult;
    let newerResult;
    await act(async () => {
      opens[1].reject({
        category: "resourceUnavailable",
        operation: "readDocument",
        message: "The newer file is temporarily unavailable.",
        detail: "provider offline",
      });
      restoreResult = await restorePromise;
      newerResult = await newerPromise;
    });

    assert.deepEqual(restoreResult, { status: "superseded" });
    assert.equal(newerResult.status, "failed");
    assert.equal(rendered.api().error.message, "The newer file is temporarily unavailable.");
    assert.deepEqual(rendered.api().documentError.retryAction, newerAction);

    await act(async () => {
      opens[0].resolve({
        content: "Late stored session",
        canonicalPath: "/tmp/Stored.md",
        name: "Stored.md",
        revision: savedRevision,
      });
      await opens[0].promise;
    });
    assert.equal(rendered.api().error.message, "The newer file is temporarily unavailable.");
  } finally {
    rendered.cleanup();
  }
});
