const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");
const store = require("../.tmp/workspace-tests/src/lib/store.js");
const { usePersistedVisibility } = require("../.tmp/workspace-tests/src/hooks/usePersistedVisibility.js");

async function launch(t, stored) {
  const reads = [], writes = [];
  t.mock.method(store, "storeGet", async (key) => { reads.push(key); return stored; });
  t.mock.method(store, "storeSet", async (key, value) => { writes.push([key, value]); return true; });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const api = {};
  function Probe() {
    [api.visible, api.change] = usePersistedVisibility("bindars-toc-visible", "toc-visible", true);
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { api, reads, writes };
}

test("Contents opens on first run and stays closed on the next launch once closed", async (t) => {
  await installDom();
  const original = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  t.after(() => { globalThis.localStorage = original; });
  window.localStorage.clear();

  const first = await launch(t, null);
  assert.equal(first.api.visible, true);
  await act(async () => first.api.change(false));
  assert.equal(first.api.visible, false);
  assert.equal(window.localStorage.getItem("bindars-toc-visible"), "false");
  assert.deepEqual(first.writes, [["toc-visible", false]]);

  const next = await launch(t, true);
  assert.equal(next.api.visible, false, "the saved choice wins without waiting for the store");
  assert.deepEqual(next.reads, []);

  window.localStorage.clear();
  const backup = await launch(t, false);
  assert.equal(backup.api.visible, false, "the app store restores the choice when localStorage has none");
  assert.deepEqual(backup.reads, ["toc-visible"]);
});
