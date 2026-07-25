const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canEnterEditMode,
  canEnterPresentationMode,
  canToggleEditMode,
} = require("../.tmp/workspace-tests/src/lib/app-flow.js");

test("loading blocks entering edit mode but still allows exiting edit mode", () => {
  assert.equal(canEnterEditMode({ documentOpen: true, editing: false, loading: true }), false);
  assert.equal(canToggleEditMode({ documentOpen: true, editing: false, loading: true }), false);
  assert.equal(canToggleEditMode({ documentOpen: true, editing: true, loading: true }), true);
});

test("edit mode can only be entered for an open non-loading document", () => {
  assert.equal(canEnterEditMode({ documentOpen: false, editing: false, loading: false }), false);
  assert.equal(canEnterEditMode({ documentOpen: true, editing: true, loading: false }), false);
  assert.equal(canEnterEditMode({ documentOpen: true, editing: false, loading: false }), true);
});

test("loading blocks presentation entry", () => {
  assert.equal(
    canEnterPresentationMode({
      documentOpen: true,
      editing: false,
      loading: true,
      focusMode: false,
      fileType: "markdown",
    }),
    false,
  );
});

test("presentation requires a markdown document outside edit and focus modes", () => {
  assert.equal(
    canEnterPresentationMode({
      documentOpen: true,
      editing: false,
      loading: false,
      focusMode: false,
      fileType: "markdown",
    }),
    true,
  );
  assert.equal(
    canEnterPresentationMode({
      documentOpen: true,
      editing: false,
      loading: false,
      focusMode: false,
      fileType: "fountain",
    }),
    false,
  );
  assert.equal(
    canEnterPresentationMode({
      documentOpen: true,
      editing: false,
      loading: false,
      focusMode: true,
      fileType: "markdown",
    }),
    false,
  );
});
