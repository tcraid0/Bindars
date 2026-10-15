const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { mockIPC, clearMocks } = require("@tauri-apps/api/mocks");
const store = require("../.tmp/workspace-tests/src/lib/store.js");
const {
  useInterfaceZoom,
  nextZoom,
} = require("../.tmp/workspace-tests/src/hooks/useInterfaceZoom.js");
test("interface zoom steps reach 200 percent and clamp supported limits", () => {
  let zoom = 1;
  for (let i = 0; i < 5; i++) zoom = nextZoom(zoom, 1);
  assert.equal(zoom, 2);
  assert.equal(nextZoom(3, 1), 3);
  assert.equal(nextZoom(0.75, -1), 0.75);
});
test("zoom shortcuts work inside dialogs and editors and reset only interface zoom", async (t) => {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  const writes = [],
    factors = [];
  t.mock.method(store, "storeGet", async () => 1.5);
  t.mock.method(store, "storeSet", async (key, value) => {
    writes.push([key, value]);
    return true;
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  mockIPC((command, args) => {
    if (command === "set_interface_zoom") factors.push(args.factor);
    return 1;
  });
  t.after(clearMocks);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let api;
  function Probe() {
    api = useInterfaceZoom();
    return React.createElement(
      "div",
      { role: "dialog" },
      React.createElement("textarea"),
    );
  }
  await act(async () => root.render(React.createElement(Probe)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const editor = host.querySelector("textarea");
  editor.focus();
  let bubbled = 0;
  editor.addEventListener("keydown", () => bubbled++);
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "+",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(api.zoom, 1.75);
  assert.equal(bubbled, 0);
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "0",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(api.zoom, 1);
  assert.deepEqual(
    writes.map(([key]) => key),
    ["interface-zoom", "interface-zoom"],
  );
  assert.deepEqual(factors, [1.5, 1.75, 1]);
  for (const [platform, modifiers, expected] of [
    ["MacIntel", { ctrlKey: true }, 1],
    ["MacIntel", { metaKey: true }, 1.1],
    ["Linux x86_64", { metaKey: true }, 1.1],
    ["Linux x86_64", { ctrlKey: true }, 1.25],
  ]) {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true, ...modifiers })));
    assert.equal(api.zoom, expected);
  }
});
