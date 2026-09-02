const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const {
  useDocumentReconciliation,
} = require("../.tmp/workspace-tests/src/hooks/useDocumentReconciliation.js");

const revision = { mtimeMs: 1, size: 8, contentHash: "original" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function snapshot(overrides = {}) {
  return {
    documentId: "/tmp/document.md",
    filePath: "/tmp/document.md",
    sessionId: 1,
    mode: "reader",
    content: "Original",
    dirty: false,
    expectedRevision: null,
    publishedRevision: revision,
    ownershipToken: "1:0:0",
    userOpenInFlight: false,
    guardedActionInFlight: false,
    ...overrides,
  };
}

function available(content = "Original", nextRevision = revision) {
  return {
    status: "available",
    documentId: "/tmp/document.md",
    document: {
      canonicalPath: "/tmp/document.md",
      name: "document.md",
      content,
      revision: nextRevision,
    },
  };
}

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

function renderReconciliationHook(initialState = snapshot(), initiallyPresenting = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const apiRef = { current: null };
  const stateRef = { current: initialState };
  const probes = [];
  const applied = [];
  let presentationActive = initiallyPresenting;

  function Probe() {
    apiRef.current = useDocumentReconciliation({
      presentationActive,
      getSnapshot: () => stateRef.current,
      probe: (captured) => {
        const operation = deferred();
        probes.push({ captured, ...operation });
        return operation.promise;
      },
      applyDecision: (decision, signal) => applied.push({ decision, signal }),
    });
    return null;
  }

  function render() {
    flushSync(() => root.render(React.createElement(Probe)));
  }
  render();

  return {
    api() {
      assert.ok(apiRef.current);
      return apiRef.current;
    },
    probes,
    applied,
    setState(state) {
      stateRef.current = state;
    },
    setPresentationActive(active) {
      presentationActive = active;
      render();
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

async function resolveProbe(operation, result) {
  await act(async () => {
    operation.resolve(result);
    await operation.promise;
  });
}

test("focus during an in-flight probe and repeated focus/resume signals coalesce", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const focus = rendered.api().requestReconciliation("focus");
    const repeatedFocus = rendered.api().requestReconciliation("focus");
    const resume = rendered.api().requestReconciliation("resume");

    assert.equal(rendered.probes.length, 1);
    assert.equal(repeatedFocus, focus);
    assert.equal(resume, focus);
    await resolveProbe(rendered.probes[0], available());
    assert.deepEqual(await focus, { kind: "no-change" });
    assert.deepEqual(rendered.applied, [{
      decision: { kind: "no-change" },
      signal: "focus",
    }]);
  } finally {
    rendered.cleanup();
  }
});

test("a user open that starts during a probe wins without publication", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const request = rendered.api().requestReconciliation("focus");
    rendered.setState(snapshot({
      ownershipToken: "2:0:0",
      userOpenInFlight: true,
    }));
    await resolveProbe(rendered.probes[0], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));

    assert.deepEqual(await request, { kind: "stale-noop", reason: "user-action" });
    assert.deepEqual(rendered.applied, []);
  } finally {
    rendered.cleanup();
  }
});

test("a queued old-document watcher cannot spill into the document opened by the user", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const active = rendered.api().requestReconciliation("focus");
    const watcher = rendered.api().requestReconciliation("watcher");
    rendered.setState(snapshot({
      documentId: "/tmp/new.md",
      filePath: "/tmp/new.md",
      ownershipToken: "2:1:0",
    }));

    await resolveProbe(rendered.probes[0], available());
    assert.deepEqual(
      await active,
      { kind: "stale-noop", reason: "document-changed" },
    );
    assert.deepEqual(
      await watcher,
      { kind: "stale-noop", reason: "superseded" },
    );
    assert.equal(rendered.probes.length, 1);
    assert.deepEqual(rendered.applied, []);
  } finally {
    rendered.cleanup();
  }
});

test("a newer edit session and explicit supersession reject late probe results", async () => {
  await installDom();
  const rendered = renderReconciliationHook(snapshot({
    mode: "editor",
    expectedRevision: revision,
  }));
  try {
    let request = rendered.api().requestReconciliation("focus");
    rendered.setState(snapshot({
      mode: "editor",
      expectedRevision: revision,
      sessionId: 2,
    }));
    await resolveProbe(rendered.probes[0], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.deepEqual(await request, { kind: "stale-noop", reason: "session-changed" });

    rendered.setState(snapshot());
    request = rendered.api().requestReconciliation("resume");
    rendered.api().supersedeReconciliation();
    await resolveProbe(rendered.probes[1], available());
    assert.deepEqual(await request, { kind: "stale-noop", reason: "superseded" });
    assert.deepEqual(rendered.applied, []);
  } finally {
    rendered.cleanup();
  }
});

test("supersession detaches the stale probe so a new session can probe immediately", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const staleRequest = rendered.api().requestReconciliation("focus");
    rendered.api().supersedeReconciliation();
    const currentRequest = rendered.api().requestReconciliation("resume");
    assert.equal(rendered.probes.length, 2);

    await resolveProbe(rendered.probes[1], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.equal((await currentRequest).kind, "reload-reader");

    await resolveProbe(rendered.probes[0], available());
    assert.deepEqual(await staleRequest, { kind: "stale-noop", reason: "superseded" });
    assert.deepEqual(rendered.applied.map(({ signal }) => signal), ["resume"]);
  } finally {
    rendered.cleanup();
  }
});

test("repeated watcher signals during an active read schedule one trailing probe", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const first = rendered.api().requestReconciliation("focus");
    const watcher = rendered.api().requestReconciliation("watcher");
    const repeatedWatcher = rendered.api().requestReconciliation("watcher");
    const drop = rendered.api().requestReconciliation("watcher-drop-fallback");
    assert.notEqual(watcher, first);
    assert.equal(rendered.probes.length, 1);

    await resolveProbe(rendered.probes[0], available());
    await waitFor(() => assert.equal(rendered.probes.length, 2));
    await resolveProbe(rendered.probes[1], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.equal((await watcher).kind, "reload-reader");
    assert.equal((await repeatedWatcher).kind, "reload-reader");
    assert.equal((await drop).kind, "reload-reader");

    assert.deepEqual(rendered.applied.map(({ signal, decision }) => ({
      signal,
      kind: decision.kind,
    })), [
      { signal: "focus", kind: "no-change" },
      { signal: "watcher-drop-fallback", kind: "reload-reader" },
    ]);
  } finally {
    rendered.cleanup();
  }
});

test("editor-exit remains the trailing owner when watcher work is already active", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    rendered.api().requestReconciliation("watcher");
    const editorExit = rendered.api().requestReconciliation("editor-exit");
    rendered.api().requestReconciliation("watcher");

    await resolveProbe(rendered.probes[0], available());
    await waitFor(() => assert.equal(rendered.probes.length, 2));
    await resolveProbe(rendered.probes[1], available());
    assert.deepEqual(await editorExit, { kind: "no-change" });

    assert.deepEqual(rendered.applied.map(({ signal }) => signal), [
      "watcher",
      "editor-exit",
    ]);
  } finally {
    rendered.cleanup();
  }
});

test("guarded actions defer reconciliation and cancellation resumes it for the same document", async () => {
  await installDom();
  const rendered = renderReconciliationHook(snapshot({
    ownershipToken: "1:1:0",
    guardedActionInFlight: true,
  }));
  try {
    assert.deepEqual(
      await rendered.api().requestReconciliation("watcher"),
      { kind: "deferred" },
    );
    assert.equal(rendered.probes.length, 0);

    rendered.setState(snapshot({ ownershipToken: "1:1:0" }));
    rendered.api().resumeDeferredReconciliation();
    await waitFor(() => assert.equal(rendered.probes.length, 1));
    await resolveProbe(rendered.probes[0], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.deepEqual(rendered.applied.map(({ signal, decision }) => ({
      signal,
      kind: decision.kind,
    })), [{ signal: "watcher", kind: "reload-reader" }]);
  } finally {
    rendered.cleanup();
  }
});

test("a guard that starts during a probe defers its signal until the guard finishes", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const first = rendered.api().requestReconciliation("watcher");
    rendered.setState(snapshot({
      ownershipToken: "1:1:0",
      guardedActionInFlight: true,
    }));
    await resolveProbe(rendered.probes[0], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.deepEqual(await first, { kind: "stale-noop", reason: "user-action" });
    assert.deepEqual(rendered.applied, []);

    rendered.setState(snapshot({ ownershipToken: "1:1:0" }));
    rendered.api().resumeDeferredReconciliation();
    await waitFor(() => assert.equal(rendered.probes.length, 2));
    await resolveProbe(rendered.probes[1], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.deepEqual(rendered.applied.map(({ signal, decision }) => ({
      signal,
      kind: decision.kind,
    })), [{ signal: "watcher", kind: "reload-reader" }]);
  } finally {
    rendered.cleanup();
  }
});

test("a dirty-to-clean transition during a probe receives one bounded clean-state retry", async () => {
  await installDom();
  const rendered = renderReconciliationHook(snapshot({
    mode: "editor",
    content: "Local words",
    dirty: true,
    expectedRevision: revision,
  }));
  try {
    const request = rendered.api().requestReconciliation("focus");
    rendered.setState(snapshot({
      mode: "editor",
      content: "Original",
      expectedRevision: revision,
    }));
    const external = available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    });
    await resolveProbe(rendered.probes[0], external);
    assert.deepEqual(
      await request,
      { kind: "stale-noop", reason: "clean-editor-changed" },
    );
    await waitFor(() => assert.equal(rendered.probes.length, 2));
    assert.equal(rendered.probes[1].captured.dirty, false);
    assert.equal(rendered.probes[1].captured.content, "Original");

    await resolveProbe(rendered.probes[1], external);
    assert.deepEqual(rendered.applied.map(({ signal, decision }) => ({
      signal,
      kind: decision.kind,
    })), [{ signal: "focus", kind: "refresh-clean-editor" }]);
    assert.equal(rendered.probes.length, 2);
  } finally {
    rendered.cleanup();
  }
});

test("close and unmount make late probe results no-ops", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  const closeRequest = rendered.api().requestReconciliation("focus");
  rendered.setState(null);
  await resolveProbe(rendered.probes[0], available());
  assert.deepEqual(await closeRequest, { kind: "stale-noop", reason: "no-document" });

  rendered.setState(snapshot());
  const unmountRequest = rendered.api().requestReconciliation("resume");
  const lateProbe = rendered.probes[1];
  rendered.cleanup();
  lateProbe.resolve(available());
  assert.deepEqual(await unmountRequest, { kind: "stale-noop", reason: "superseded" });
  assert.deepEqual(rendered.applied, []);
});

test("presentation defers one reconciliation until the presentation ends", async () => {
  await installDom();
  const rendered = renderReconciliationHook(snapshot(), true);
  try {
    assert.deepEqual(await rendered.api().requestReconciliation("focus"), { kind: "deferred" });
    assert.deepEqual(await rendered.api().requestReconciliation("resume"), { kind: "deferred" });
    assert.equal(rendered.probes.length, 0);

    rendered.setPresentationActive(false);
    await waitFor(() => assert.equal(rendered.probes.length, 1));
    await resolveProbe(rendered.probes[0], available());
    assert.deepEqual(rendered.applied, [{
      decision: { kind: "no-change" },
      signal: "resume",
    }]);
  } finally {
    rendered.cleanup();
  }
});

test("presentation beginning during a probe defers its result instead of publishing", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const inFlight = rendered.api().requestReconciliation("focus");
    rendered.setPresentationActive(true);
    await resolveProbe(rendered.probes[0], available("External", {
      mtimeMs: 2,
      size: 8,
      contentHash: "external",
    }));
    assert.deepEqual(await inFlight, { kind: "stale-noop", reason: "superseded" });
    assert.deepEqual(rendered.applied, []);

    rendered.setPresentationActive(false);
    await waitFor(() => assert.equal(rendered.probes.length, 2));
    await resolveProbe(rendered.probes[1], available());
    assert.deepEqual(rendered.applied, [{
      decision: { kind: "no-change" },
      signal: "focus",
    }]);
  } finally {
    rendered.cleanup();
  }
});

test("watcher setup and drop fallbacks use the same reconciliation authority", async () => {
  await installDom();
  const rendered = renderReconciliationHook();
  try {
    const setup = rendered.api().requestReconciliation("watcher-setup-fallback");
    await resolveProbe(rendered.probes[0], available());
    assert.deepEqual(await setup, { kind: "no-change" });

    const drop = rendered.api().requestReconciliation("watcher-drop-fallback");
    await resolveProbe(rendered.probes[1], available());
    assert.deepEqual(await drop, { kind: "no-change" });
    assert.deepEqual(rendered.applied.map(({ signal }) => signal), [
      "watcher-setup-fallback",
      "watcher-drop-fallback",
    ]);
  } finally {
    rendered.cleanup();
  }
});
