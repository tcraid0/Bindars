const test = require("node:test");
const assert = require("node:assert/strict");

const { isDocumentOpen } = require("../.tmp/workspace-tests/src/lib/document-state.js");

test("empty string is an open document", () => {
  assert.equal(isDocumentOpen(""), true);
});

test("null means no document is open", () => {
  assert.equal(isDocumentOpen(null), false);
});
