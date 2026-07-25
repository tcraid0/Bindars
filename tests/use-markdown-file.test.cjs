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

function startOpen(rendered, path = "/tmp/Slow.md") {
  let openPromise;
  flushSync(() => {
    openPromise = rendered.api().openFilePathWithStatus(path, "user");
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
    assert.equal(rendered.api().userOpenInFlight, false);
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
      contentChanged: true,
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

test("reconciliation compares accepted bytes live while still publishing newer metadata", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    flushSync(() => rendered.api().adoptSavedFile({
      content: "Same bytes",
      canonicalPath: "/canonical/Draft.md",
      name: "Draft.md",
      revision: { mtimeMs: 1, size: 10, contentHash: "old" },
    }));

    let reconcilePromise;
    flushSync(() => {
      reconcilePromise = rendered.api().openFilePathWithStatus("/canonical/Draft.md", "reconcile");
    });
    assert.equal(rendered.api().loading, false);
    assert.equal(rendered.api().userOpenInFlight, false);
    assert.equal(rendered.api().openingPath, null);

    const newerRevision = { mtimeMs: 2, size: 10, contentHash: "new" };
    let result;
    await act(async () => {
      opens[0].resolve({
        content: "Same bytes",
        canonicalPath: "/normalized/Draft.md",
        name: "Draft.md",
        revision: newerRevision,
      });
      result = await reconcilePromise;
    });

    assert.deepEqual(result, {
      status: "opened",
      canonicalPath: "/normalized/Draft.md",
      contentChanged: false,
    });
    assert.equal(rendered.api().content, "Same bytes");
    assert.equal(rendered.api().filePath, "/normalized/Draft.md");
    assert.deepEqual(rendered.api().fileRevision, newerRevision);
  } finally {
    rendered.cleanup();
  }
});

test("superseded reconciliation publishes neither content nor a change result", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    flushSync(() => rendered.api().adoptSavedFile({
      content: "Current bytes",
      canonicalPath: "/canonical/Draft.md",
      name: "Draft.md",
      revision: savedRevision,
    }));
    let reconcilePromise;
    flushSync(() => {
      reconcilePromise = rendered.api().openFilePathWithStatus("/canonical/Draft.md", "reconcile");
    });
    flushSync(() => rendered.api().supersedePendingOpen());

    let result;
    await act(async () => {
      opens[0].resolve({
        content: "Stale external bytes",
        canonicalPath: "/canonical/Draft.md",
        name: "Draft.md",
        revision: { mtimeMs: 3, size: 20, contentHash: "stale" },
      });
      result = await reconcilePromise;
    });

    assert.deepEqual(result, { status: "superseded" });
    assert.equal(rendered.api().content, "Current bytes");
    assert.deepEqual(rendered.api().fileRevision, savedRevision);
  } finally {
    rendered.cleanup();
  }
});

test("a superseded visible request releases only the loading state it owns", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    let watcherPromise;
    let reconcilePromise;
    flushSync(() => {
      watcherPromise = rendered.api().openFilePathWithStatus("/tmp/watched.md", "watcher");
    });
    assert.equal(rendered.api().loading, true);

    flushSync(() => {
      reconcilePromise = rendered.api().openFilePathWithStatus("/tmp/watched.md", "reconcile");
    });
    assert.equal(rendered.api().loading, true);

    let reconcileResult;
    await act(async () => {
      opens[1].resolve({
        content: "Reconciled",
        canonicalPath: "/tmp/watched.md",
        name: "watched.md",
        revision: savedRevision,
      });
      reconcileResult = await reconcilePromise;
    });
    assert.equal(reconcileResult.status, "opened");
    assert.equal(rendered.api().loading, true);

    let watcherResult;
    await act(async () => {
      opens[0].resolve({
        content: "Stale watcher",
        canonicalPath: "/tmp/watched.md",
        name: "watched.md",
        revision: savedRevision,
      });
      watcherResult = await watcherPromise;
    });
    assert.deepEqual(watcherResult, { status: "superseded" });
    assert.equal(rendered.api().loading, false);
    assert.equal(rendered.api().content, "Reconciled");
  } finally {
    rendered.cleanup();
  }
});

test("a newer visible request retains loading ownership when an older request settles", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    let firstPromise;
    let secondPromise;
    flushSync(() => {
      firstPromise = rendered.api().openFilePathWithStatus("/tmp/first.md", "watcher");
      secondPromise = rendered.api().openFilePathWithStatus("/tmp/second.md", "watcher");
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

test("user ownership blocks watcher and reconciliation requests", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  try {
    const userPromise = startOpen(rendered, "/tmp/user.md");
    assert.deepEqual(
      await rendered.api().openFilePathWithStatus("/tmp/user.md", "watcher"),
      { status: "superseded" },
    );
    assert.deepEqual(
      await rendered.api().openFilePathWithStatus("/tmp/user.md", "reconcile"),
      { status: "superseded" },
    );
    assert.equal(opens.length, 1);

    await act(async () => {
      opens[0].resolve({
        content: "User",
        canonicalPath: "/tmp/user.md",
        name: "user.md",
        revision: savedRevision,
      });
      assert.equal((await userPromise).status, "opened");
    });
  } finally {
    rendered.cleanup();
  }
});

test("unmount supersedes pending user and reconciliation completions", async () => {
  await installDom();
  const opens = mockPendingOpens();
  const rendered = renderUseMarkdownFile();

  let userPromise;
  flushSync(() => {
    userPromise = rendered.api().openFilePathWithStatus("/tmp/user.md", "user");
  });
  rendered.cleanup();
  opens[0].resolve({
    content: "Late user",
    canonicalPath: "/tmp/user.md",
    name: "user.md",
    revision: savedRevision,
  });
  assert.deepEqual(await userPromise, { status: "superseded" });

  const nextOpens = mockPendingOpens();
  const next = renderUseMarkdownFile();
  let reconcilePromise;
  flushSync(() => {
    reconcilePromise = next.api().openFilePathWithStatus("/tmp/reconcile.md", "reconcile");
  });
  next.cleanup();
  nextOpens[0].resolve({
    content: "Late reconcile",
    canonicalPath: "/tmp/reconcile.md",
    name: "reconcile.md",
    revision: savedRevision,
  });
  assert.deepEqual(await reconcilePromise, { status: "superseded" });
});
