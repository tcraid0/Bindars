const test = require("node:test");
const assert = require("node:assert/strict");

const {
  queueAnnotationPersist,
} = require("../.tmp/workspace-tests/src/lib/annotation-persistence.js");

test("annotation persist queue recovers after a failed write", async () => {
  const errors = [];
  const writes = [];
  let queue = Promise.resolve();

  const firstQueue = queueAnnotationPersist(
    queue,
    async () => {
      writes.push("first");
      throw new Error("store unavailable");
    },
    (err) => errors.push(err.message),
  );
  const firstResult = await firstQueue;
  queue = firstQueue.then(() => undefined);

  const secondQueue = queueAnnotationPersist(
    queue,
    async () => {
      writes.push("second");
      return true;
    },
    (err) => errors.push(err.message),
  );
  const secondResult = await secondQueue;

  assert.equal(firstResult, false);
  assert.equal(secondResult, true);
  assert.deepEqual(writes, ["first", "second"]);
  assert.deepEqual(errors, ["store unavailable"]);
});

test("annotation persist queue reports false write results and keeps running", async () => {
  const errors = [];
  const writes = [];
  let queue = Promise.resolve();

  const firstQueue = queueAnnotationPersist(
    queue,
    async () => {
      writes.push("failed");
      return false;
    },
    (err) => errors.push(err.message),
  );
  const firstResult = await firstQueue;
  queue = firstQueue.then(() => undefined);

  const secondQueue = queueAnnotationPersist(
    queue,
    async () => {
      writes.push("saved");
      return true;
    },
    (err) => errors.push(err.message),
  );
  const secondResult = await secondQueue;

  assert.equal(firstResult, false);
  assert.equal(secondResult, true);
  assert.deepEqual(writes, ["failed", "saved"]);
  assert.deepEqual(errors, ["Annotation save failed."]);
});

test("annotation persist queue runs next write after an already rejected queue", async () => {
  const errors = [];
  const writes = [];

  const queue = queueAnnotationPersist(
    Promise.reject(new Error("previous failure")),
    async () => {
      writes.push("next");
      return true;
    },
    (err) => errors.push(err.message),
  );

  await queue;

  assert.deepEqual(writes, ["next"]);
  assert.deepEqual(errors, ["previous failure"]);
});

test("annotation persist queue calls success callback after a saved write", async () => {
  const events = [];

  const result = await queueAnnotationPersist(
    Promise.resolve(),
    async () => true,
    (err) => events.push(`error:${err.message}`),
    () => events.push("success"),
  );

  assert.equal(result, true);
  assert.deepEqual(events, ["success"]);
});
