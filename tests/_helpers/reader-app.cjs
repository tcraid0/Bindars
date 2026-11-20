const assert = require("node:assert/strict");
const { act } = require("react");
const { mockWindows, clearMocks } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { createAppView } = require("./render-app.cjs");
const { createNativeOpenIpc } = require("./native-open.cjs");

async function waitFor(assertion) {
  for (let attempt = 0; ; attempt++) {
    try { return assertion(); } catch (error) { if (attempt === 60) throw error; }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

async function reader(t) {
  const calls = [];
  const openedPaths = [];
  let content = "# Find fixture\n\nalpha beta alpha\n\nalpha end";
  const nativeOpen = createNativeOpenIpc("/tmp/find.md");
  mockWindows("main");
  const ipc = nativeOpen.wrap((cmd, args = {}) => {
    calls.push(cmd);
    if (cmd === "initialize_annotation_storage") return { settingsReady: true };
    if (cmd === "get_setting") return args.key === "recent-files" ? { version: 1, files: [] } : null;
    if (cmd === "open_markdown_file") {
      openedPaths.push(args.path);
      return { canonicalPath: args.path, name: args.path.split("/").at(-1), content,
        revision: { mtimeMs: 1, size: content.length, contentHash: content } };
    }
    if (cmd === "is_draft_document") return false;
    if (["load_annotations", "set_setting", "watch_file", "unwatch_file", "authorize_document_images",
      "plugin:window|set_title", "plugin:dialog|open"].includes(cmd)) return null;
    throw new Error(`Unexpected IPC ${cmd}`);
  });
  const view = createAppView({ ipc, strictMode: true });
  view.render();
  t.after(async () => {
    if (view.host.isConnected) await view.cleanup();
    window.getSelection().removeAllRanges();
    clearMocks();
  });
  const main = await waitFor(() => {
    const main = view.host.querySelector("main");
    assert.match(main.textContent, /alpha beta alpha/);
    return main;
  });
  await waitFor(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]').disabled, false));
  main.focus();
  return { ...view, main, calls, openedPaths,
    async open(path) {
      nativeOpen.setPendingPath(path);
      await act(async () => emit("bindars://native-open-available"));
    },
    async reload(text) {
      content = text;
      await act(async () => emit("file-changed", { path: openedPaths.at(-1) }));
    },
    field: () => view.host.querySelector('input[aria-label="Search in document"]') };
}

module.exports = { reader, waitFor };
