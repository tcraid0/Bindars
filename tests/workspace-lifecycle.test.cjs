const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("./_helpers/react.cjs");
const { createRoot } = require("react-dom/client");
const index = require("../.tmp/workspace-tests/src/lib/workspace-index.js");
const {
  useWorkspaceSearch,
} = require("../.tmp/workspace-tests/src/hooks/useWorkspaceSearch.js");
const {
  CommandPalette,
} = require("../.tmp/workspace-tests/src/components/CommandPalette.js");

const meta = (path) => ({
  path,
  name: path.split("/").at(-1),
  relPath: path.split("/").at(-1),
});
const doc = (path, content = "# Original") =>
  index.buildWorkspaceDoc(meta(path), content);
function mount(t, hook, props, renderContent = () => null) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current;
  function Probe(props) {
    current = hook(props);
    return renderContent(current);
  }
  const render = (props) =>
    flushSync(() => root.render(React.createElement(Probe, props)));
  render(props);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    flushSync(() => root.unmount());
    host.remove();
  };
  t.after(close);
  return {
    get value() {
      return current;
    },
    host,
    render,
    close,
  };
}

test("new queries remove old buttons and selection until settled; reset cancels pending queries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const docs = [doc("/a/alpha.md", "# Alpha"), doc("/a/beta.md", "# Beta")];
  const view = mount(
    t,
    () => useWorkspaceSearch({ docs, recentFiles: [] }),
    {},
    (search) =>
      React.createElement(CommandPalette, {
        visible: true,
        status: "ready",
        ...search,
        onQueryChange: search.setQuery,
        onClose: search.reset,
        onOpenHit() {},
        onHoverIndex: search.setSelectedIndex,
      }),
  );
  flushSync(() => view.value.setQuery("alpha"));
  await act(async () => t.mock.timers.tick(100));
  assert.equal(view.value.selectedHit.path, "/a/alpha.md");
  flushSync(() => view.value.setQuery("beta"));
  assert.equal(view.value.query, "beta");
  assert.equal(view.value.selectedHit, null);
  assert.equal(
    document.querySelectorAll('#dialog-root [role="option"]').length,
    0,
  );
  assert.match(
    document.getElementById("dialog-root").textContent,
    /Updating results/,
  );
  await act(async () => t.mock.timers.tick(100));
  assert.equal(view.value.selectedHit.path, "/a/beta.md");
  flushSync(() => {
    view.value.setQuery("alpha");
    view.value.setQuery("missing");
  });
  flushSync(() => view.value.reset());
  await act(async () => t.mock.timers.tick(100));
  assert.equal(view.value.query, "");
  assert.equal(view.value.results.length, 2);
});

test("incremental indexing cannot starve a search, and a replaced scope cannot publish old results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let docs = Array.from({ length: 24 }, (_, i) =>
    doc(`/a/${i}.md`, "A needle passage"),
  );
  const view = mount(
    t,
    (props) => useWorkspaceSearch({ docs: props.docs, recentFiles: [] }),
    { docs },
  );
  flushSync(() => view.value.setQuery("needle"));
  await act(async () => t.mock.timers.tick(100));
  let sawResultsDuringIndexing = false;
  for (let i = 0; i < 12; i++) {
    docs = docs.map((document) => ({ ...document }));
    view.render({ docs });
    await act(async () => t.mock.timers.tick(0));
    sawResultsDuringIndexing ||= view.value.results.length > 0;
  }
  assert.equal(sawResultsDuringIndexing, true);
  const replacement = [doc("/b/new.md", "A needle at the new location")];
  view.render({ docs: replacement });
  await act(async () => t.mock.timers.tick(100));
  assert.deepEqual(
    view.value.results.map((hit) => hit.path),
    ["/b/new.md"],
  );
});
