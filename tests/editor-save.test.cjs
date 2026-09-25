const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideSaveContinuation,
  isSuccessfulSave,
  actionableSaveError,
  saveErrorBlocksCurrentPath,
  normalizeDocumentSavePath,
} = require("../.tmp/workspace-tests/src/lib/editor-save.js");

test("navigation continues only when the saved snapshot is still current", () => {
  assert.equal(decideSaveContinuation("saved"), "continue");
  assert.equal(decideSaveContinuation("saved-with-newer-edits"), "reconfirm");
  assert.equal(decideSaveContinuation("conflict"), "stop");
  assert.equal(decideSaveContinuation("cancelled"), "stop");
  assert.equal(decideSaveContinuation("error"), "stop");
  assert.equal(decideSaveContinuation("noop"), "stop");
  assert.equal(decideSaveContinuation("stale"), "stop");
  assert.equal(decideSaveContinuation("saved-with-recovery"), "stop");
});

test("both clean and superseded snapshots count as successful disk writes", () => {
  assert.equal(isSuccessfulSave("saved"), true);
  assert.equal(isSuccessfulSave("saved-with-newer-edits"), true);
  assert.equal(isSuccessfulSave("conflict"), false);
  assert.equal(isSuccessfulSave("cancelled"), false);
  assert.equal(isSuccessfulSave("error"), false);
  assert.equal(isSuccessfulSave("saved-with-recovery"), false);
});

test("document save path accepts supported POSIX extensions", () => {
  assert.deepEqual(normalizeDocumentSavePath("/tmp/draft.md"), {
    status: "valid",
    path: "/tmp/draft.md",
    appendedExtension: false,
  });
  assert.deepEqual(normalizeDocumentSavePath("/tmp/draft.markdown"), {
    status: "valid",
    path: "/tmp/draft.markdown",
    appendedExtension: false,
  });
  assert.deepEqual(normalizeDocumentSavePath("/tmp/script.fountain"), {
    status: "valid",
    path: "/tmp/script.fountain",
    appendedExtension: false,
  });
});

test("markdown save path preserves uppercase Windows extensions", () => {
  assert.deepEqual(normalizeDocumentSavePath("C:\\Notes\\Draft.MD"), {
    status: "valid",
    path: "C:\\Notes\\Draft.MD",
    appendedExtension: false,
  });
});

test("markdown save path handles UNC paths by inspecting the final component", () => {
  assert.deepEqual(normalizeDocumentSavePath("\\\\server\\share.with.dot\\Draft.markdown"), {
    status: "valid",
    path: "\\\\server\\share.with.dot\\Draft.markdown",
    appendedExtension: false,
  });
});

test("a name with no extension is saved as markdown", () => {
  assert.deepEqual(normalizeDocumentSavePath("/tmp/notes.archive/draft"), {
    status: "valid",
    path: "/tmp/notes.archive/draft.md",
    appendedExtension: true,
  });
  assert.deepEqual(normalizeDocumentSavePath("C:\\Notes\\Draft"), {
    status: "valid",
    path: "C:\\Notes\\Draft.md",
    appendedExtension: true,
  });
  assert.deepEqual(normalizeDocumentSavePath("\\\\server\\share\\Draft"), {
    status: "valid",
    path: "\\\\server\\share\\Draft.md",
    appendedExtension: true,
  });
});

test("markdown save path rejects unsupported extensions", () => {
  assert.deepEqual(normalizeDocumentSavePath("/tmp/draft.txt"), {
    status: "error",
    message: "File name must end in .md, .markdown, or .fountain.",
  });
});

test("markdown save path rejects trailing separators", () => {
  assert.equal(normalizeDocumentSavePath("/tmp/notes/").status, "error");
  assert.equal(normalizeDocumentSavePath("C:\\Notes\\").status, "error");
  assert.equal(normalizeDocumentSavePath("/tmp/   ").status, "error");
});

test("markdown save path treats a bare dotfile as a name with no extension", () => {
  assert.deepEqual(normalizeDocumentSavePath("/tmp/.draft"), {
    status: "valid",
    path: "/tmp/.draft.md",
    appendedExtension: true,
  });
  assert.deepEqual(normalizeDocumentSavePath("/tmp/.draft.md"), {
    status: "valid",
    path: "/tmp/.draft.md",
    appendedExtension: false,
  });
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

test("a missing document offers Save As instead of claiming it was deleted", () => {
  assert.deepEqual(actionableSaveError({
    category: "notFound", operation: "resolveDocument", message: "File not found", detail: "ENOENT",
  }), { message: "This file is no longer available.", recovery: "save-as" });
});

test("an incomplete write keeps its native warning and offers Save As", () => {
  const message = "A new file may be incomplete. Your current text is still in the editor.";
  for (const detail of ["EACCES", "EROFS", "ENOENT", "ETIMEDOUT", "ENOSPC"]) {
    assert.deepEqual(actionableSaveError({
      category: "incompleteWrite", operation: "saveDocument", message, detail,
    }), { message, recovery: "save-as" });
  }
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

test("a folder change blocks another save of the same pathname", () => {
  const error = {
    category: "invalidInput",
    operation: "inspectWriteTarget",
    message: "The folder moved during saving.",
    detail: "destination-changed",
  };
  assert.equal(saveErrorBlocksCurrentPath(error), true);
  assert.equal(saveErrorBlocksCurrentPath({ ...error, detail: "a symlink was rejected" }), false);
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
