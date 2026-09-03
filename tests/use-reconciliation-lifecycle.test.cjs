const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { installDom } = require("./_helpers/dom.cjs");

const {
  APP_RESUMED_EVENT,
  useReconciliationLifecycle,
} = require("../.tmp/workspace-tests/src/hooks/useReconciliationLifecycle.js");

async function renderLifecycleHook() {
  await installDom();
  mockWindows("main");
  mockIPC(() => null, { shouldMockEvents: true });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const signals = [];

  function Probe() {
    useReconciliationLifecycle({
      onSignal: (signal) => signals.push(signal),
    });
    return null;
  }

  flushSync(() => root.render(React.createElement(Probe)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    signals,
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
      clearMocks();
    },
  };
}

test("positive focus and native resume dispatch lifecycle reconciliation signals", async () => {
  const rendered = await renderLifecycleHook();
  try {
    await act(async () => {
      await emit("tauri://blur");
      await emit("tauri://focus");
      await emit(APP_RESUMED_EVENT);
    });

    assert.deepEqual(rendered.signals, ["focus", "resume"]);
  } finally {
    rendered.cleanup();
  }
});
