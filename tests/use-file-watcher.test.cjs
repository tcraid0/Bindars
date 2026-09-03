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
  FILE_WATCHER_UNAVAILABLE_EVENT,
  useFileWatcher,
} = require("../.tmp/workspace-tests/src/hooks/useFileWatcher.js");

const FILE_PATH = "/tmp/watcher.md";

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

async function renderFileWatcher({
  failHealthSubscription = false,
  failWatch = false,
} = {}) {
  await installDom();
  mockWindows("main");
  mockIPC((command, payload) => {
    if (command === "plugin:event|listen") {
      if (failHealthSubscription && payload.event === FILE_WATCHER_UNAVAILABLE_EVENT) {
        throw new Error("watcher health events unavailable");
      }
      return payload.handler;
    }
    if (command === "plugin:event|unlisten") return null;
    if (command === "watch_file" && failWatch) throw new Error("watch unavailable");
    if (command === "watch_file" || command === "unwatch_file") return null;
    throw new Error(`Unexpected IPC command: ${command}`);
  }, { shouldMockEvents: !failHealthSubscription });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settled = [];
  const unavailable = [];

  function Probe() {
    useFileWatcher({
      filePath: FILE_PATH,
      isEditing: false,
      onFileChanged: () => {},
      onWatchSettled: (path) => settled.push(path),
      onWatcherUnavailable: (path, reason) => unavailable.push({ path, reason }),
    });
    return null;
  }

  flushSync(() => root.render(React.createElement(Probe)));

  return {
    settled,
    unavailable,
    async cleanup() {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      host.remove();
      clearMocks();
    },
  };
}

test("watch setup failure settles ownership and requests the setup fallback", async () => {
  const rendered = await renderFileWatcher({ failWatch: true });
  try {
    await waitFor(() => assert.deepEqual(rendered.unavailable, [{
      path: FILE_PATH,
      reason: "setup",
    }]));
    assert.deepEqual(rendered.settled, [FILE_PATH]);
  } finally {
    await rendered.cleanup();
  }
});

test("watcher health subscription failure requests the setup fallback", async () => {
  const rendered = await renderFileWatcher({ failHealthSubscription: true });
  try {
    await waitFor(() => assert.deepEqual(rendered.unavailable, [{
      path: FILE_PATH,
      reason: "setup",
    }]));
    assert.deepEqual(rendered.settled, [FILE_PATH]);
  } finally {
    await rendered.cleanup();
  }
});

test("native watcher health loss requests the drop fallback for its path", async () => {
  const rendered = await renderFileWatcher();
  try {
    await waitFor(() => assert.deepEqual(rendered.settled, [FILE_PATH]));
    await act(async () => {
      await emit(FILE_WATCHER_UNAVAILABLE_EVENT, { path: FILE_PATH });
    });
    assert.deepEqual(rendered.unavailable, [{
      path: FILE_PATH,
      reason: "dropped",
    }]);
  } finally {
    await rendered.cleanup();
  }
});
