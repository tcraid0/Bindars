const test = require("node:test");
const { act } = require("react");
const assert = require("node:assert/strict");
const { mockIPC, clearMocks } = require("@tauri-apps/api/mocks");
const { renderComponent } = require("./_helpers/component-view.cjs");
const { useSteadyRecentOrder } = require("../.tmp/workspace-tests/src/hooks/useSteadyRecentOrder.js");

const files = names => Object.freeze(names.map(name => Object.freeze({
  path: `/tmp/${name}.md`, name, openedAt: 1, lastHeadingId: null,
})));

function mount(t, names, visible = true) {
  let shown;
  const calls = [];
  mockIPC((cmd, args) => { calls.push([cmd, args]); });
  function Probe({ recent, intent }) {
    shown = useSteadyRecentOrder(recent, intent);
    return null;
  }
  let view;
  act(() => { view = renderComponent(Probe, { recent: files(names), intent: visible }); });
  t.after(() => {
    act(() => view.cleanup());
    assert.deepEqual(calls, [], "display ordering must never read or write the store");
    clearMocks();
  });
  return { ...view, render: updates => act(() => view.render(updates)), names: () => shown.map(file => file.name), shown: () => shown };
}

test("StrictMode keeps reopened rows in place and uses their latest metadata", t => {
  const view = mount(t, ["A", "B", "C"]);
  const recent = files(["C", "A", "B"]);
  view.render({ recent });
  assert.deepEqual(view.names(), ["A", "B", "C"]);
  assert.equal(view.shown()[2], recent[0]);
  assert.deepEqual(recent.map(file => file.name), ["C", "A", "B"]);
});

test("new documents enter first, removals leave in place, and Save As enters as a new path", t => {
  const view = mount(t, ["A", "B", "C", "draft"]);
  view.render({ recent: files(["C", "A", "B", "draft"]) });
  view.render({ recent: files(["E", "D", "C", "A", "B", "draft"]) });
  assert.deepEqual(view.names(), ["E", "D", "A", "B", "C", "draft"]);
  view.render({ recent: files(["saved", "E", "D", "C", "B"]) });
  assert.deepEqual(view.names(), ["saved", "E", "D", "B", "C"]);
});

test("the 26th entry evicts the saved oldest without moving surviving rows", t => {
  const names = Array.from({ length: 25 }, (_, index) => String(index));
  const view = mount(t, names);
  view.render({ recent: files(["24", ...names.slice(0, 24)]) });
  view.render({ recent: files(["new", "24", ...names.slice(0, 23)]) });
  assert.deepEqual(view.names(), ["new", ...names.slice(0, 23), "24"]);
});

test("showing the sidebar resets to saved order, including a simultaneous history change", t => {
  const view = mount(t, ["A", "B", "C"]);
  view.render({ recent: files(["C", "A", "B"]) });
  view.render({ intent: false });
  view.render({ intent: true, recent: files(["B", "C", "A"]) });
  assert.deepEqual(view.names(), ["B", "C", "A"]);
});

test("history loaded after mount seeds both initially hidden and visible sidebars", t => {
  for (const intent of [false, true]) {
    const view = mount(t, [], intent);
    view.render({ recent: files(["B", "A"]) });
    assert.deepEqual(view.names(), ["B", "A"]);
  }
});
