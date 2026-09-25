const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  usePersistenceCoordinator,
} = require("../.tmp/workspace-tests/src/hooks/usePersistenceCoordinator.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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
    apiRef.current = usePersistenceCoordinator(props);
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
    },
  };
}

test("external-change protection pauses both timed and boundary autosaves", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCount = 0;
  let buffer = "protected local words";
  const baseProps = {
    autosaveActive: false,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, bufferVersion: buffer });

  try {
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(saveCount, 0);
    assert.equal(await rendered.api().flushAutosave(), null);

    buffer = "protected local words plus more";
    rendered.rerender({ ...baseProps, bufferVersion: buffer });
    context.mock.timers.tick(AUTOSAVE_MAX_INTERVAL_MS);
    await flushPromises();
    assert.equal(saveCount, 0);
    assert.equal(await rendered.api().flushAutosave(), null);
  } finally {
    rendered.cleanup();
  }
});

test("autosave debounces from the latest buffer", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const operations = [];
  let buffer = "first words";
  const baseProps = {
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
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
    assert.deepEqual(operations, ["save:latest idle words"]);
  } finally {
    rendered.cleanup();
  }
});

test("draft autosave skips a cleared buffer and saves new words after the idle delay", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const operations = [];
  let buffer = "draft words";
  let dirty = true;
  const baseProps = {
    autosaveActive: true,
    sessionKey: 1,
    documentIdentity: "new",
    captureBuffer: () => ({ content: buffer, dirty }),
    onAutosave: async () => {
      operations.push(`save:${buffer}`);
      return "saved";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, dirty, bufferVersion: buffer });

  try {
    await flushPromises();
    context.mock.timers.tick(AUTOSAVE_IDLE_MS - 1);
    buffer = "";
    dirty = false;
    rendered.rerender({ ...baseProps, dirty, bufferVersion: buffer });
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.ok(!operations.some((operation) => operation.startsWith("save:")));
    assert.equal(await rendered.api().flushAutosave(), null);

    buffer = "new draft words";
    dirty = true;
    rendered.rerender({ ...baseProps, dirty, bufferVersion: buffer });
    context.mock.timers.tick(AUTOSAVE_IDLE_MS - 1);
    await flushPromises();
    assert.ok(!operations.some((operation) => operation.startsWith("save:")));
    context.mock.timers.tick(1);
    await flushPromises();
    assert.deepEqual(operations, ["save:new draft words"]);
  } finally {
    rendered.cleanup();
  }
});

test("flushAutosave saves a draft before the idle delay only when a writer is available", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCount = 0;
  const baseProps = {
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "new",
    bufferVersion: "draft boundary words",
    captureBuffer: () => ({ content: "draft boundary words", dirty: true }),
  };
  const rendered = renderCoordinator(baseProps);

  try {
    assert.equal(await rendered.api().flushAutosave(), null);
    rendered.rerender({
      ...baseProps,
      onAutosave: async () => {
        saveCount += 1;
        return "saved";
      },
    });
    assert.equal(await rendered.api().flushAutosave(), "saved");
    assert.equal(saveCount, 1);
    context.mock.timers.tick(AUTOSAVE_IDLE_MS * 2);
    await flushPromises();
    assert.equal(saveCount, 1, "the boundary flush cancels the draft's pending timer");
  } finally {
    rendered.cleanup();
  }
});

test("continuous buffer publications autosave the latest words every ten seconds", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const saves = [];
  let buffer = "words at 0 seconds";
  const baseProps = {
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutosave: async () => {
      saves.push({ time: Date.now(), content: buffer });
      return "saved";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, bufferVersion: buffer });

  try {
    await flushPromises();
    for (let second = 1; second <= 20; second += 1) {
      context.mock.timers.tick(1_000);
      await flushPromises();
      assert.equal(saves.length, Math.floor(second / 10));
      buffer = `words at ${second} seconds`;
      rendered.rerender({ ...baseProps, bufferVersion: buffer });
    }

    assert.deepEqual(saves, [
      { time: AUTOSAVE_MAX_INTERVAL_MS, content: "words at 9 seconds" },
      { time: AUTOSAVE_MAX_INTERVAL_MS * 2, content: "words at 19 seconds" },
    ]);
  } finally {
    rendered.cleanup();
  }
});

for (const result of ["noop", "saved-with-newer-edits"]) {
  test(`autosave ${result} starts a fresh window after reaching the maximum interval`, async (context) => {
    await installDom();
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const attempts = [];
    const baseProps = {
      autosaveActive: true,
      dirty: true,
      sessionKey: 1,
      documentIdentity: "/tmp/draft.md",
      captureBuffer: () => ({ content: "still dirty words", dirty: true }),
      onAutosave: async () => {
        attempts.push(Date.now());
        return result;
      },
    };
    const rendered = renderCoordinator({ ...baseProps, bufferVersion: "v0" });

    try {
      for (let second = 1; second < 10; second += 1) {
        context.mock.timers.tick(1_000);
        await flushPromises();
        rendered.rerender({ ...baseProps, bufferVersion: `v${second}` });
      }
      assert.equal(attempts.length, 0);
      context.mock.timers.tick(1_000);
      await flushPromises();
      assert.deepEqual(attempts, [AUTOSAVE_MAX_INTERVAL_MS]);

      for (let elapsed = AUTOSAVE_MAX_INTERVAL_MS; elapsed < 30_000; elapsed += 250) {
        context.mock.timers.tick(250);
        await flushPromises();
      }

      assert.ok(attempts.length > 1, "dirty content should get another autosave attempt");
      assert.ok(attempts.length <= 9, "completed attempts must not cause a zero-delay retry loop");
      for (let index = 1; index < attempts.length; index += 1) {
        assert.ok(attempts[index] - attempts[index - 1] >= AUTOSAVE_IDLE_MS);
      }
    } finally {
      rendered.cleanup();
    }
  });
}

test("changing edit sessions resets the autosave maximum interval", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const saves = [];
  let buffer = "old session words";
  const baseProps = {
    autosaveActive: true,
    dirty: true,
    documentIdentity: "/tmp/draft.md",
    captureBuffer: () => ({ content: buffer, dirty: true }),
    onAutosave: async () => {
      saves.push({ time: Date.now(), content: buffer });
      return "saved";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, sessionKey: 1, bufferVersion: buffer });

  try {
    for (let second = 1; second <= 8; second += 1) {
      context.mock.timers.tick(1_000);
      await flushPromises();
      rendered.rerender({ ...baseProps, sessionKey: 1, bufferVersion: `old-${second}` });
    }

    buffer = "new session words at 8 seconds";
    rendered.rerender({ ...baseProps, sessionKey: 2, bufferVersion: buffer });
    for (let second = 9; second < 18; second += 1) {
      context.mock.timers.tick(1_000);
      await flushPromises();
      buffer = `new session words at ${second} seconds`;
      rendered.rerender({ ...baseProps, sessionKey: 2, bufferVersion: buffer });
      assert.equal(saves.length, 0, "the new session must not inherit the old deadline");
    }
    context.mock.timers.tick(1_000);
    await flushPromises();
    assert.deepEqual(saves, [{ time: 18_000, content: "new session words at 17 seconds" }]);
  } finally {
    rendered.cleanup();
  }
});

for (const [condition, resetProps] of [
  ["clean", { dirty: false }],
  ["paused", { autosaveActive: false }],
  ["unavailable", { onAutosave: undefined }],
]) {
  test(`autosave starts a fresh maximum interval after being ${condition}`, async (context) => {
    await installDom();
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const saves = [];
    const baseProps = {
      autosaveActive: true,
      dirty: true,
      sessionKey: 1,
      documentIdentity: "/tmp/draft.md",
      captureBuffer: () => ({ content: "dirty words", dirty: true }),
      onAutosave: async () => {
        saves.push(Date.now());
        return "saved";
      },
    };
    const rendered = renderCoordinator({ ...baseProps, bufferVersion: "v0" });

    try {
      for (let second = 1; second <= 8; second += 1) {
        context.mock.timers.tick(1_000);
        await flushPromises();
        rendered.rerender({ ...baseProps, bufferVersion: `v${second}` });
      }
      rendered.rerender({ ...baseProps, ...resetProps, bufferVersion: "reset" });
      context.mock.timers.tick(1_000);
      await flushPromises();
      rendered.rerender({ ...baseProps, bufferVersion: "resumed" });

      for (let second = 10; second < 19; second += 1) {
        context.mock.timers.tick(1_000);
        await flushPromises();
        rendered.rerender({ ...baseProps, bufferVersion: `v${second}` });
        assert.equal(saves.length, 0, "autosave must not inherit the prior deadline");
      }
      context.mock.timers.tick(1_000);
      await flushPromises();
      assert.deepEqual(saves, [19_000]);
    } finally {
      rendered.cleanup();
    }
  });
}

test("flushAutosave commits a pending debounce immediately", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCount = 0;
  const rendered = renderCoordinator({
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
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
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCount = 0;
  const rendered = renderCoordinator({
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
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
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let saveCount = 0;
  const baseProps = {
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
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

    for (let second = 1; second <= 300; second += 1) {
      rendered.rerender({ ...baseProps, bufferVersion: `paused-${second}` });
      context.mock.timers.tick(1_000);
      await flushPromises();
    }
    assert.equal(saveCount, 1);
    assert.equal(await rendered.api().flushAutosave(), "conflict");
    assert.equal(saveCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("an autosave error pauses without a retry storm", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let saveCount = 0;
  const baseProps = {
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
    captureBuffer: () => ({ content: "error words", dirty: true }),
    onAutosave: async () => {
      saveCount += 1;
      return "error";
    },
  };
  const rendered = renderCoordinator({ ...baseProps, bufferVersion: "error words" });

  try {
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(rendered.api().autosaveIssue.kind, "error");
    for (let second = 1; second <= 300; second += 1) {
      rendered.rerender({ ...baseProps, bufferVersion: `paused-${second}` });
      context.mock.timers.tick(1_000);
      await flushPromises();
    }
    assert.equal(saveCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("a failed manual save pauses the pending automatic retry", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let saveCount = 0;
  const rendered = renderCoordinator({
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
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

test("autosave checks the captured dirty state before a timer or boundary save", async (context) => {
  await installDom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let capturedDirty = true;
  let saveCount = 0;
  const rendered = renderCoordinator({
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "new",
    captureBuffer: () => ({ content: "", dirty: capturedDirty }),
    onAutosave: async () => {
      saveCount += 1;
      return "saved";
    },
  });

  try {
    capturedDirty = false;
    context.mock.timers.tick(AUTOSAVE_IDLE_MS);
    await flushPromises();
    assert.equal(saveCount, 0, "a stale React dirty flag must not save a clean captured buffer");
    assert.equal(await rendered.api().flushAutosave(), null);
    assert.equal(saveCount, 0);
  } finally {
    rendered.cleanup();
  }
});

test("flush and cancellation join an in-flight autosave even when its callback flushes again", async () => {
  await installDom();
  const pendingSave = deferred();
  let saveCount = 0;
  let reentrantFlush;
  const rendered = renderCoordinator({
    autosaveActive: true,
    dirty: true,
    sessionKey: 1,
    documentIdentity: "/tmp/draft.md",
    captureBuffer: () => ({ content: "words being saved", dirty: true }),
    onAutosave: () => {
      saveCount += 1;
      reentrantFlush = rendered.api().flushAutosave();
      return pendingSave.promise;
    },
  });

  try {
    const firstFlush = rendered.api().flushAutosave();
    const secondFlush = rendered.api().flushAutosave();
    let cancellationFinished = false;
    const cancellation = rendered.api().cancelAutosaveAndWait().then((issue) => {
      cancellationFinished = true;
      return issue;
    });
    await flushPromises();
    assert.equal(saveCount, 1, "all callers must share the same save attempt");
    assert.equal(cancellationFinished, false, "manual saves must wait for the current write");

    pendingSave.resolve("conflict");
    assert.deepEqual(await Promise.all([firstFlush, secondFlush, reentrantFlush]), [
      "conflict", "conflict", "conflict",
    ]);
    assert.equal((await cancellation).kind, "conflict");
    assert.equal(saveCount, 1);
  } finally {
    pendingSave.resolve("conflict");
    rendered.cleanup();
  }
});

for (const result of ["conflict", "error"]) {
  test(`a prior session's late autosave ${result} cannot pause the current session`, async (context) => {
    await installDom();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const pendingSave = deferred();
    let currentSaves = 0;
    const baseProps = {
      autosaveActive: true,
      dirty: true,
      documentIdentity: "/tmp/draft.md",
      captureBuffer: () => ({ content: "current words", dirty: true }),
    };
    const rendered = renderCoordinator({
      ...baseProps,
      sessionKey: 1,
      onAutosave: () => pendingSave.promise,
    });

    try {
      const oldFlush = rendered.api().flushAutosave();
      await flushPromises();
      rendered.rerender({
        ...baseProps,
        sessionKey: 2,
        onAutosave: async () => {
          currentSaves += 1;
          return "saved";
        },
      });
      pendingSave.resolve(result);
      assert.equal(await oldFlush, result);
      await flushPromises();
      assert.equal(rendered.api().autosaveIssue, null);

      context.mock.timers.tick(AUTOSAVE_IDLE_MS);
      await flushPromises();
      assert.equal(currentSaves, 1, "the new session's timer must still save normally");
      assert.equal(rendered.api().autosaveIssue, null);
    } finally {
      pendingSave.resolve(result);
      rendered.cleanup();
    }
  });
}
