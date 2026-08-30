const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OPENABLE_FILE_EXTENSIONS,
  OPENABLE_FILE_TYPES_DESCRIPTION,
  isOpenableDocumentExtension,
  isOpenableDocumentPath,
  replaceOpenableDocumentExtension,
} = require("../.tmp/workspace-tests/src/lib/openable-files.js");

test("the shared openable-file policy accepts every supported extension case-insensitively", () => {
  assert.deepEqual(OPENABLE_FILE_EXTENSIONS, ["md", "markdown", "fountain"]);
  assert.equal(OPENABLE_FILE_TYPES_DESCRIPTION, ".md, .markdown, or .fountain");
  assert.equal(isOpenableDocumentExtension("MD"), true);
  assert.equal(isOpenableDocumentExtension(".fountain"), true);
  assert.equal(isOpenableDocumentPath("/tmp/Notes.MD"), true);
  assert.equal(isOpenableDocumentPath("C:\\Writing\\Draft.MARKDOWN"), true);
  assert.equal(isOpenableDocumentPath("/tmp/Script.FOUNTAIN"), true);
  assert.equal(replaceOpenableDocumentExtension("Draft.MARKDOWN", ".html"), "Draft.html");
});

test("the shared openable-file policy rejects unsupported and suffix-like paths", () => {
  assert.equal(isOpenableDocumentPath("/tmp/notes.txt"), false);
  assert.equal(isOpenableDocumentPath("/tmp/notes.md.backup"), false);
  assert.equal(isOpenableDocumentPath("/tmp/notes"), false);
  assert.equal(isOpenableDocumentExtension("txt"), false);
});
