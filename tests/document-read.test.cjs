const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDocumentReadCoordinator,
  DOCUMENT_OPEN_SLOW_MS,
  DOCUMENT_OPEN_TIMEOUT_MS,
  DOCUMENT_RECONCILIATION_TIMEOUT_MS,
} = require("../.tmp/workspace-tests/src/lib/document-read.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("document read timing is a central provisional policy", () => {
  assert.equal(DOCUMENT_OPEN_SLOW_MS, 2_000);
  assert.equal(DOCUMENT_OPEN_TIMEOUT_MS, 30_000);
  assert.equal(DOCUMENT_RECONCILIATION_TIMEOUT_MS, 10_000);
});

test("one unresolved native read gates only the same normalized requested path", async () => {
  const nativeReads = [];
  const coordinator = createDocumentReadCoordinator((path) => {
    const operation = deferred();
    nativeReads.push({ path, ...operation });
    return operation.promise;
  });

  const first = coordinator.begin("/Volumes/Cloud/Folder/../Draft.md");
  const samePath = coordinator.begin("/Volumes/Cloud/Draft.md");
  const unrelated = coordinator.begin("/tmp/Healthy.md");

  assert.equal(first.status, "started");
  assert.equal(samePath.status, "pending");
  assert.equal(samePath.result, first.result);
  assert.equal(unrelated.status, "started");
  assert.deepEqual(nativeReads.map(({ path }) => path), [
    "/Volumes/Cloud/Folder/../Draft.md",
    "/tmp/Healthy.md",
  ]);

  nativeReads[1].resolve({ healthy: true });
  await unrelated.released;
  assert.equal(coordinator.begin("/Volumes/Cloud/Draft.md").status, "pending");

  nativeReads[0].resolve({ late: true });
  await samePath.released;
  assert.equal(coordinator.begin("/Volumes/Cloud/Draft.md").status, "started");
  nativeReads[2].resolve({ retry: true });
});

test("a rejected native read also releases its path gate", async () => {
  const reads = [];
  const coordinator = createDocumentReadCoordinator(() => {
    const operation = deferred();
    reads.push(operation);
    return operation.promise;
  });

  const first = coordinator.begin("/tmp/Retry.md");
  assert.equal(coordinator.begin("/tmp/Retry.md").status, "pending");
  reads[0].reject(new Error("volume disconnected"));
  await first.released;

  assert.equal(coordinator.begin("/tmp/Retry.md").status, "started");
  reads[1].resolve({ retry: true });
});
