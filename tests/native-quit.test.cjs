const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { installDom } = require("./_helpers/dom.cjs");

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

test("useNativeQuit forwards native quit requests and stops after unmount", async () => {
  await installDom();
  mockIPC(() => {
    throw new Error("Unexpected IPC command");
  }, { shouldMockEvents: true });
  const { useNativeQuit } = require("../.tmp/workspace-tests/src/hooks/useNativeQuit.js");
  const requested = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    useNativeQuit({ onQuitRequested: () => requested.push(Date.now()) });
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(requested.length, 0);

    await act(async () => {
      await emit("bindars://quit-requested");
    });
    assert.equal(requested.length, 1);

    await act(async () => root.unmount());
    await act(async () => {
      await emit("bindars://quit-requested");
    });
    assert.equal(requested.length, 1, "requests after unmount must be ignored");
  } finally {
    host.remove();
    clearMocks();
  }
});

test("a failing listener registration only logs; the app keeps running", async () => {
  await installDom();
  mockIPC((command) => {
    if (command === "plugin:event|listen") {
      throw new Error("event registration failed");
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });
  const { useNativeQuit } = require("../.tmp/workspace-tests/src/hooks/useNativeQuit.js");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  const requested = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    useNativeQuit({ onQuitRequested: () => requested.push(Date.now()) });
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await waitFor(() => assert.ok(
      warnings.some((entry) => String(entry[0]).includes("Failed to attach the quit-request listener")),
    ));
    assert.equal(requested.length, 0);
  } finally {
    console.warn = originalWarn;
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});

test("a failing quit callback is contained and later requests still dispatch", async () => {
  await installDom();
  mockIPC(() => {
    throw new Error("Unexpected IPC command");
  }, { shouldMockEvents: true });
  const { useNativeQuit } = require("../.tmp/workspace-tests/src/hooks/useNativeQuit.js");
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  let requests = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  function Probe() {
    useNativeQuit({
      onQuitRequested: () => {
        requests += 1;
        if (requests === 1) throw new Error("quit dispatch failed");
      },
    });
    return null;
  }

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await act(async () => {
      await emit("bindars://quit-requested");
      await emit("bindars://quit-requested");
    });

    assert.equal(requests, 2);
    assert.ok(
      errors.some((entry) => String(entry[0]).includes("Failed to dispatch a quit request")),
    );
  } finally {
    console.error = originalError;
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  }
});
