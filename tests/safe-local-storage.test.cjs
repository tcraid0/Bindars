const test = require("node:test");
const assert = require("node:assert/strict");

const {
  trySetLocalStorage,
} = require("../.tmp/workspace-tests/src/lib/safe-local-storage.js");

test("trySetLocalStorage writes when storage is available", () => {
  const calls = [];
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    setItem(key, value) {
      calls.push([key, value]);
    },
  };

  try {
    trySetLocalStorage("session", "{\"filePath\":\"/tmp/a.md\"}");
  } finally {
    globalThis.localStorage = original;
  }

  assert.deepEqual(calls, [["session", "{\"filePath\":\"/tmp/a.md\"}"]]);
});

test("trySetLocalStorage ignores unavailable or throwing storage", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    setItem() {
      throw new Error("quota exceeded");
    },
  };

  try {
    assert.doesNotThrow(() => trySetLocalStorage("session", "{}"));
  } finally {
    globalThis.localStorage = original;
  }
});
