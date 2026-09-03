const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideDocumentReconciliation,
  reconciliationProbeFailure,
  sameFileRevision,
} = require("../.tmp/workspace-tests/src/lib/document-reconciliation.js");

const originalRevision = { mtimeMs: 1, size: 8, contentHash: "original" };
const touchedRevision = { mtimeMs: 2, size: 8, contentHash: "original" };
const changedRevision = { mtimeMs: 3, size: 16, contentHash: "external" };

function snapshot(overrides = {}) {
  return {
    documentId: "/tmp/document.md",
    filePath: "/tmp/document.md",
    sessionId: 1,
    mode: "reader",
    content: "Original",
    dirty: false,
    expectedRevision: null,
    publishedRevision: originalRevision,
    ownershipToken: "1:0:0",
    userOpenInFlight: false,
    guardedActionInFlight: false,
    ...overrides,
  };
}

function editorSnapshot(overrides = {}) {
  return snapshot({
    mode: "editor",
    expectedRevision: originalRevision,
    ...overrides,
  });
}

function available(content = "Original", revision = originalRevision, documentId = "/tmp/document.md") {
  return {
    status: "available",
    documentId,
    document: {
      canonicalPath: documentId,
      name: "document.md",
      content,
      revision,
    },
  };
}

function decide(captured, probe, current = captured, superseded = false) {
  return decideDocumentReconciliation({ captured, current, probe, superseded });
}

test("unchanged bytes and revision require no publication", () => {
  const state = snapshot();
  assert.deepEqual(decide(state, available()), { kind: "no-change" });
  assert.equal(sameFileRevision(originalRevision, { ...originalRevision }), true);
  assert.equal(sameFileRevision(originalRevision, touchedRevision), false);
});

test("equal bytes with newer metadata refresh reader and clean-editor revisions", () => {
  const reader = snapshot();
  assert.deepEqual(decide(reader, available("Original", touchedRevision)), {
    kind: "refresh-equal-revision",
    mode: "reader",
    dirty: false,
    sessionId: 1,
    capturedContent: "Original",
    capturedExpectedRevision: null,
    revision: touchedRevision,
  });

  const editor = editorSnapshot();
  assert.deepEqual(decide(editor, available("Original", touchedRevision)), {
    kind: "refresh-equal-revision",
    mode: "editor",
    dirty: false,
    sessionId: 1,
    capturedContent: "Original",
    capturedExpectedRevision: originalRevision,
    revision: touchedRevision,
  });
});

test("changed bytes reload a reader and refresh only a still-clean editor", () => {
  const reader = snapshot();
  assert.equal(decide(reader, available("External words", changedRevision)).kind, "reload-reader");

  const editor = editorSnapshot();
  const editorDecision = decide(editor, available("External words", changedRevision));
  assert.equal(editorDecision.kind, "refresh-clean-editor");
  assert.equal(editorDecision.capturedContent, "Original");
  assert.deepEqual(editorDecision.capturedExpectedRevision, originalRevision);

  const changedCleanEditor = editorSnapshot({ content: "A newer clean baseline" });
  assert.deepEqual(
    decide(editor, available("External words", changedRevision), changedCleanEditor),
    { kind: "stale-noop", reason: "clean-editor-changed" },
  );
});

test("dirty editor compares disk bytes with its saved revision instead of its live buffer", () => {
  const dirty = editorSnapshot({ content: "Local unsaved words", dirty: true });

  assert.deepEqual(decide(dirty, available("Original", originalRevision)), {
    kind: "no-change",
  });
  assert.deepEqual(decide(dirty, available("Original", touchedRevision)), {
    kind: "refresh-equal-revision",
    mode: "editor",
    dirty: true,
    sessionId: 1,
    capturedContent: "Local unsaved words",
    capturedExpectedRevision: originalRevision,
    revision: touchedRevision,
  });
  assert.deepEqual(decide(dirty, available("External words", changedRevision)), {
    kind: "protect-dirty-editor",
    sessionId: 1,
  });
  assert.deepEqual(decide(dirty, available("Local unsaved words", changedRevision)), {
    kind: "protect-dirty-editor",
    sessionId: 1,
  });
  assert.deepEqual(decide(
    editorSnapshot({ content: "Local unsaved words", dirty: true, expectedRevision: null }),
    available("Original", originalRevision),
  ), {
    kind: "protect-dirty-editor",
    sessionId: 1,
  });
});

test("typing during a clean-editor probe changes the outcome to dirty protection", () => {
  const captured = editorSnapshot();
  const current = editorSnapshot({ content: "Original plus local typing", dirty: true });

  assert.deepEqual(decide(captured, available("External words", changedRevision), current), {
    kind: "protect-dirty-editor",
    sessionId: 1,
  });
});

test("confirmed deletion retains reader and editor recovery state", () => {
  const error = { category: "not-found", message: "File not found" };
  const deleted = { status: "deleted", error };

  assert.deepEqual(decide(snapshot(), deleted), {
    kind: "recover-deleted",
    mode: "reader",
    sessionId: 1,
    dirty: false,
    error,
  });
  assert.deepEqual(decide(editorSnapshot({ dirty: true }), deleted), {
    kind: "recover-deleted",
    mode: "editor",
    sessionId: 1,
    dirty: true,
    error,
  });

  const captured = editorSnapshot();
  const newerCleanBaseline = editorSnapshot({
    content: "Newer saved words",
    expectedRevision: changedRevision,
    publishedRevision: changedRevision,
  });
  assert.deepEqual(decide(captured, deleted, newerCleanBaseline), {
    kind: "stale-noop",
    reason: "clean-editor-changed",
  });
});

test("unavailable and timeout probes are recoverable and never become deletion", () => {
  const unavailableError = { category: "resource-unavailable", message: "Provider unavailable" };
  const timeoutError = { category: "generic", message: "File check timed out" };
  const timeout = { status: "unavailable", reason: "timeout", error: timeoutError };

  assert.deepEqual(reconciliationProbeFailure(unavailableError), {
    status: "unavailable",
    reason: "unavailable",
    error: unavailableError,
  });
  assert.deepEqual(reconciliationProbeFailure(timeoutError), {
    status: "unavailable",
    reason: "unavailable",
    error: timeoutError,
  });
  assert.equal(decide(snapshot(), reconciliationProbeFailure(unavailableError)).kind, "recover-unavailable");
  assert.deepEqual(decide(snapshot(), timeout), {
    kind: "recover-unavailable",
    reason: "timeout",
    error: timeoutError,
  });
});

test("an ambiguous not-found probe remains unavailable until deletion is explicitly confirmed", () => {
  const notFound = { category: "not-found", message: "File not found" };
  const permission = { category: "permission-denied", message: "Permission denied" };

  assert.deepEqual(reconciliationProbeFailure(notFound), {
    status: "unavailable",
    reason: "unavailable",
    error: notFound,
  });
  assert.equal(reconciliationProbeFailure(permission).status, "unavailable");
});

test("user actions, newer sessions, close ownership, and explicit supersession are stale no-ops", () => {
  const captured = snapshot();
  const probe = available("External words", changedRevision);

  assert.deepEqual(decide(captured, probe, snapshot({ userOpenInFlight: true })), {
    kind: "stale-noop",
    reason: "user-action",
  });
  assert.deepEqual(decide(captured, probe, snapshot({ sessionId: 2 })), {
    kind: "stale-noop",
    reason: "session-changed",
  });
  assert.deepEqual(decide(captured, probe, snapshot({ ownershipToken: "2:0:0" })), {
    kind: "stale-noop",
    reason: "ownership-changed",
  });
  assert.deepEqual(decide(captured, probe, captured, true), {
    kind: "stale-noop",
    reason: "superseded",
  });
});

test("a probe for another canonical document is a stale no-op", () => {
  const state = snapshot();
  assert.deepEqual(
    decide(state, available("Other", changedRevision, "/tmp/other.md")),
    { kind: "stale-noop", reason: "probe-document-changed" },
  );
});
