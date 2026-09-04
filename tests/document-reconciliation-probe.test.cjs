const test = require("node:test");
const assert = require("node:assert/strict");

const {
  probeDocumentForReconciliation,
} = require("../.tmp/workspace-tests/src/lib/document-reconciliation-probe.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function startedRead(operation) {
  return {
    status: "started",
    result: operation.promise,
    released: operation.promise.then(() => {}, () => {}),
  };
}

test("reconciliation deadlines become direct timeout-unavailable results", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const native = deferred();
  const probe = probeDocumentForReconciliation(
    "/Volumes/Cloud/Draft.md",
    () => startedRead(native),
    10_000,
  );

  context.mock.timers.tick(10_000);
  assert.deepEqual(await probe, {
    status: "unavailable",
    reason: "timeout",
    error: {
      category: "resource-unavailable",
      message: "Checking this file timed out. The current document remains open; try again when the file is available. If the request never finishes, quit and reopen Bindars.",
    },
  });

  native.reject(new Error("late missing-looking diagnostic: no such file"));
  await Promise.resolve();
  assert.equal((await probe).reason, "timeout");
});

test("same-path saturation is unavailable without starting or joining a read", async () => {
  const released = Promise.resolve();
  let beginCount = 0;
  const result = await probeDocumentForReconciliation("/tmp/Pending.md", () => {
    beginCount += 1;
    return { status: "pending", released };
  });

  assert.equal(beginCount, 1);
  assert.deepEqual(result, {
    status: "unavailable",
    reason: "unavailable",
    error: {
      category: "resource-unavailable",
      message: "macOS is still waiting on an earlier request for this file. The current document remains open. If the request never finishes, quit and reopen Bindars.",
    },
  });
});

test("reconciliation preserves successful reads and safely normalizes native failures", async () => {
  const document = {
    content: "# Ready",
    canonicalPath: "/tmp/Ready.md",
    name: "Ready.md",
    revision: { mtimeMs: 1, size: 7, contentHash: "ready" },
  };
  const success = deferred();
  success.resolve(document);
  assert.deepEqual(
    await probeDocumentForReconciliation("/tmp/Ready.md", () => startedRead(success)),
    { status: "available", documentId: "/tmp/Ready.md", document },
  );

  const failure = deferred();
  failure.reject({
    category: "resourceUnavailable",
    operation: "readDocument",
    message: "The provider is offline.",
    detail: "private native detail",
  });
  assert.deepEqual(
    await probeDocumentForReconciliation("/tmp/Offline.md", () => startedRead(failure)),
    {
      status: "unavailable",
      reason: "unavailable",
      error: { category: "resource-unavailable", message: "The provider is offline." },
    },
  );
});
