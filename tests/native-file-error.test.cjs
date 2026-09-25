const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appErrorFromNative,
  normalizeFileError,
} = require("../.tmp/workspace-tests/src/lib/native-file-error.js");

test("typed native errors expose safe display text without diagnostic detail", () => {
  const error = {
    category: "permissionDenied",
    operation: "openDocument",
    message: "Bindars does not have permission to open the document.",
    detail: "/private/path.md: raw OS detail",
  };

  assert.deepEqual(appErrorFromNative(error, "fallback"), {
    category: "permission-denied",
    message: "Bindars does not have permission to open the document.",
  });
  assert.doesNotMatch(normalizeFileError(error, "fallback").message, /raw OS detail/);
});

test("untyped legacy errors retain their useful message", () => {
  assert.deepEqual(appErrorFromNative(new Error("Disk full"), "fallback"), {
    category: "generic",
    message: "Disk full",
  });
});
