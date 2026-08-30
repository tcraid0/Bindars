const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canEnterEditMode,
  canEnterPresentationMode,
  canToggleEditMode,
  decideNativeCloseRequest,
  windowClosePolicy,
} = require("../.tmp/workspace-tests/src/lib/app-flow.js");

const IDLE_CLOSE_STATE = {
  closePolicy: "native",
  programmaticCloseInFlight: false,
  closeDrainPending: false,
  actionAdmissionInFlight: false,
};

test("the close policy hides on macOS and destroys elsewhere", () => {
  assert.equal(windowClosePolicy("macos"), "hide");
  assert.equal(windowClosePolicy("windows-linux"), "native");
});

test("a programmatic close completes its own handshake first", () => {
  assert.equal(
    decideNativeCloseRequest({ ...IDLE_CLOSE_STATE, programmaticCloseInFlight: true }),
    "complete-programmatic-close",
  );
  // The handshake outranks even the macOS hide policy.
  assert.equal(
    decideNativeCloseRequest({
      ...IDLE_CLOSE_STATE,
      closePolicy: "hide",
      programmaticCloseInFlight: true,
    }),
    "complete-programmatic-close",
  );
});

test("repeat close requests while a close drains or an action owns the guard are swallowed", () => {
  assert.equal(decideNativeCloseRequest({ ...IDLE_CLOSE_STATE, closeDrainPending: true }), "prevent-silently");
  assert.equal(
    decideNativeCloseRequest({ ...IDLE_CLOSE_STATE, actionAdmissionInFlight: true }),
    "prevent-silently",
  );
  assert.equal(
    decideNativeCloseRequest({
      ...IDLE_CLOSE_STATE,
      closePolicy: "hide",
      actionAdmissionInFlight: true,
    }),
    "prevent-silently",
  );
});

test("macOS close requests are always guarded; other platforms allow native close when idle", () => {
  assert.equal(decideNativeCloseRequest({ ...IDLE_CLOSE_STATE, closePolicy: "hide" }), "prevent-and-guard");
  assert.equal(decideNativeCloseRequest(IDLE_CLOSE_STATE), "allow-native-close");
});

test("loading blocks entering edit mode but still allows exiting edit mode", () => {
  assert.equal(canEnterEditMode({ documentOpen: true, editing: false, loading: true, documentTransitionInFlight: false }), false);
  assert.equal(canToggleEditMode({ documentOpen: true, editing: false, loading: true, documentTransitionInFlight: false }), false);
  assert.equal(canToggleEditMode({ documentOpen: true, editing: true, loading: true, documentTransitionInFlight: false }), true);
});

test("edit mode can only be entered for an open non-loading document", () => {
  assert.equal(canEnterEditMode({ documentOpen: false, editing: false, loading: false, documentTransitionInFlight: false }), false);
  assert.equal(canEnterEditMode({ documentOpen: true, editing: true, loading: false, documentTransitionInFlight: false }), false);
  assert.equal(canEnterEditMode({ documentOpen: true, editing: false, loading: false, documentTransitionInFlight: false }), true);
});

test("an admitted document transition blocks edit entry and exit", () => {
  const transitioning = {
    documentOpen: true,
    loading: false,
    documentTransitionInFlight: true,
  };
  assert.equal(canEnterEditMode({ ...transitioning, editing: false }), false);
  assert.equal(canToggleEditMode({ ...transitioning, editing: false }), false);
  assert.equal(canToggleEditMode({ ...transitioning, editing: true }), false);
});

test("loading blocks presentation entry", () => {
  assert.equal(
    canEnterPresentationMode({
      documentOpen: true,
      editing: false,
      loading: true,
      actionAdmissionInFlight: false,
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
      actionAdmissionInFlight: false,
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
      actionAdmissionInFlight: false,
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
      actionAdmissionInFlight: false,
      focusMode: true,
      fileType: "markdown",
    }),
    false,
  );
});

test("an admitted document transition blocks presentation entry", () => {
  assert.equal(
    canEnterPresentationMode({
      documentOpen: true,
      editing: false,
      loading: false,
      actionAdmissionInFlight: true,
      focusMode: false,
      fileType: "markdown",
    }),
    false,
  );
});
