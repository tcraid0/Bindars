const test = require("node:test");
const assert = require("node:assert/strict");

const {
  boundOperation,
} = require("../.tmp/workspace-tests/src/lib/bounded-operation.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("bounded operations announce slow work and cancel exactly once", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const native = deferred();
  let slowCount = 0;
  const operation = boundOperation(native.promise, {
    slowAfterMs: 2_000,
    timeoutMs: 30_000,
    onSlow() { slowCount += 1; },
  });

  context.mock.timers.tick(1_999);
  assert.equal(slowCount, 0);
  context.mock.timers.tick(1);
  assert.equal(slowCount, 1);

  operation.cancel();
  operation.cancel();
  assert.deepEqual(await operation.result, {
    status: "cancelled",
    reason: "cancelled",
  });

  native.reject(new Error("late native failure"));
  await Promise.resolve();
  context.mock.timers.tick(30_000);
  assert.equal(slowCount, 1);
});

test("bounded operations time out without consuming a late native result", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const native = deferred();
  const operation = boundOperation(native.promise, { timeoutMs: 10_000 });

  context.mock.timers.tick(10_000);
  assert.deepEqual(await operation.result, { status: "timed-out" });

  native.resolve("late bytes");
  await Promise.resolve();
  assert.deepEqual(await operation.result, { status: "timed-out" });
});

test("bounded operations preserve native fulfillment and rejection", async () => {
  assert.deepEqual(
    await boundOperation(Promise.resolve("bytes"), { timeoutMs: 30_000 }).result,
    { status: "fulfilled", value: "bytes" },
  );

  const failure = new Error("read failed");
  assert.deepEqual(
    await boundOperation(Promise.reject(failure), { timeoutMs: 30_000 }).result,
    { status: "rejected", reason: failure },
  );
});
