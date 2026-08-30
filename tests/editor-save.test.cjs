const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideSaveContinuation,
  isSuccessfulSave,
  isRecoverableDeletedFileSaveError,
  actionableSaveError,
  normalizeMarkdownSavePath,
} = require("../.tmp/workspace-tests/src/lib/editor-save.js");

test("navigation continues only when the saved snapshot is still current", () => {
  assert.equal(decideSaveContinuation("saved"), "continue");
  assert.equal(decideSaveContinuation("saved-with-newer-edits"), "reconfirm");
  assert.equal(decideSaveContinuation("conflict"), "stop");
  assert.equal(decideSaveContinuation("cancelled"), "stop");
  assert.equal(decideSaveContinuation("error"), "stop");
  assert.equal(decideSaveContinuation("noop"), "stop");
  assert.equal(decideSaveContinuation("stale"), "stop");
});

test("both clean and superseded snapshots count as successful disk writes", () => {
  assert.equal(isSuccessfulSave("saved"), true);
  assert.equal(isSuccessfulSave("saved-with-newer-edits"), true);
  assert.equal(isSuccessfulSave("conflict"), false);
  assert.equal(isSuccessfulSave("cancelled"), false);
  assert.equal(isSuccessfulSave("error"), false);
});

test("markdown save path accepts supported POSIX extensions", () => {
  assert.deepEqual(normalizeMarkdownSavePath("/tmp/draft.md"), {
    status: "valid",
    path: "/tmp/draft.md",
  });
  assert.deepEqual(normalizeMarkdownSavePath("/tmp/draft.markdown"), {
    status: "valid",
    path: "/tmp/draft.markdown",
  });
});

test("markdown save path preserves uppercase Windows extensions", () => {
  assert.deepEqual(normalizeMarkdownSavePath("C:\\Notes\\Draft.MD"), {
    status: "valid",
    path: "C:\\Notes\\Draft.MD",
  });
});

test("markdown save path handles UNC paths by inspecting the final component", () => {
  assert.deepEqual(normalizeMarkdownSavePath("\\\\server\\share.with.dot\\Draft.markdown"), {
    status: "valid",
    path: "\\\\server\\share.with.dot\\Draft.markdown",
  });
});

test("a dot in the parent directory does not count as a file extension", () => {
  assert.equal(normalizeMarkdownSavePath("/tmp/notes.archive/draft").status, "error");
});

test("markdown save path rejects extensionless Windows and UNC filenames", () => {
  assert.equal(normalizeMarkdownSavePath("C:\\Notes\\Draft").status, "error");
  assert.equal(normalizeMarkdownSavePath("\\\\server\\share\\Draft").status, "error");
});

test("markdown save path rejects unsupported extensions", () => {
  assert.deepEqual(normalizeMarkdownSavePath("/tmp/draft.txt"), {
    status: "error",
    message: "File name must end in .md or .markdown.",
  });
});

test("markdown save path rejects trailing separators", () => {
  assert.equal(normalizeMarkdownSavePath("/tmp/notes/").status, "error");
  assert.equal(normalizeMarkdownSavePath("C:\\Notes\\").status, "error");
  assert.equal(normalizeMarkdownSavePath("/tmp/   ").status, "error");
});

test("markdown save path treats a bare dotfile as extensionless", () => {
  assert.equal(normalizeMarkdownSavePath("/tmp/.draft").status, "error");
  assert.deepEqual(normalizeMarkdownSavePath("/tmp/.draft.md"), {
    status: "valid",
    path: "/tmp/.draft.md",
  });
});

test("deleted file save errors are recoverable conflicts", () => {
  assert.equal(isRecoverableDeletedFileSaveError("File not found: /tmp/draft.md"), true);
  assert.equal(
    isRecoverableDeletedFileSaveError("Failed to open file: No such file or directory"),
    true,
  );
});

test("non-missing save errors are not recoverable conflicts", () => {
  assert.equal(isRecoverableDeletedFileSaveError("Not a supported file type"), false);
  assert.equal(isRecoverableDeletedFileSaveError("Parent directory does not exist."), false);
  assert.equal(isRecoverableDeletedFileSaveError("Permission denied"), false);
});

test("native save categories produce actionable recovery guidance", () => {
  assert.deepEqual(actionableSaveError({
    category: "readOnly",
    operation: "saveDocument",
    message: "This file is read-only and was not changed.",
    detail: "chmod -w fixture",
  }), {
    message: "This file is read-only and was not changed.",
    recovery: "save-as",
  });
  assert.deepEqual(actionableSaveError({
    category: "permissionDenied",
    operation: "replaceFile",
    message: "Bindars does not have permission to replace the destination file.",
    detail: "EACCES",
  }), {
    message: "Bindars could not save this file because access was denied.",
    recovery: "save-as",
  });
});

test("only missing-document operations become deleted-file conflicts", () => {
  assert.equal(isRecoverableDeletedFileSaveError({
    category: "notFound",
    operation: "resolveDocument",
    message: "File not found",
    detail: "ENOENT",
  }), true);
  assert.equal(isRecoverableDeletedFileSaveError({
    category: "notFound",
    operation: "createTemporaryFile",
    message: "Destination disappeared",
    detail: "ENOENT",
  }), false);
});

test("missing destination folders recommend Save As without claiming document deletion", () => {
  assert.deepEqual(actionableSaveError({
    category: "notFound",
    operation: "resolveWriteParent",
    message: "Bindars could not locate the destination folder.",
    detail: "ENOENT",
  }), {
    message: "The destination folder is no longer available.",
    recovery: "save-as",
  });
});

test("invalid write targets offer another Save As attempt", () => {
  assert.deepEqual(actionableSaveError({
    category: "invalidInput",
    operation: "inspectWriteTarget",
    message: "The selected path is a dangling symbolic link. Choose another Save As location.",
    detail: "/tmp/example.md",
  }), {
    message: "The selected path is a dangling symbolic link. Choose another Save As location.",
    recovery: "save-as",
  });
});
