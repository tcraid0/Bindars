const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isDocumentOpen,
  shouldCloseDocumentAfterOpenFailure,
} = require("../.tmp/workspace-tests/src/lib/document-state.js");

test("empty string is an open document", () => {
  assert.equal(isDocumentOpen(""), true);
});

test("null means no document is open", () => {
  assert.equal(isDocumentOpen(null), false);
});

test("only not-found open failures close the current document", () => {
  assert.equal(
    shouldCloseDocumentAfterOpenFailure({ message: "File not found: /tmp/a.md", category: "not-found" }),
    true,
  );
  assert.equal(
    shouldCloseDocumentAfterOpenFailure({ message: "Permission denied", category: "generic" }),
    false,
  );
  assert.equal(
    shouldCloseDocumentAfterOpenFailure({ message: "File must be valid UTF-8 text.", category: "utf8" }),
    false,
  );
});
