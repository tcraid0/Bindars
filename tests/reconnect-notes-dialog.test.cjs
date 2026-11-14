const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { mockIPC, clearMocks } = require("@tauri-apps/api/mocks");
const storage = require("../.tmp/workspace-tests/src/lib/annotation-storage.js");
const {
  ReconnectNotesDialog,
} = require("../.tmp/workspace-tests/src/components/ReconnectNotesDialog.js");
const {
  ToastProvider,
} = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
const {
  DEFAULT_READER_SETTINGS: settings,
} = require("../.tmp/workspace-tests/src/lib/reader-settings.js");
const original = {
  version: 3,
  highlights: [
    {
      id: "located",
      exact: "Preserved quotation.",
      prefix: "Old title\n",
      suffix: "",
      note: "Important note",
      color: "green",
    },
    {
      id: "missing",
      exact: "Deleted quotation.",
      prefix: "",
      suffix: "",
      note: "Keep unresolved",
    },
  ],
  bookmarks: [
    { id: "bookmark", headingId: "old-title", headingText: "Old title" },
  ],
  extra: { preserved: true },
};
async function mount(t, { occupied = false, destinationRecord = occupied ? original : null, fail = false, sourcePath = "/old.md", records = "ok" } = {}) {
  const calls = [];
  let closed = 0,
    opened = null;
  t.mock.method(storage, "loadAnnotations", async (path) =>
    structuredClone(path === "/old.md" ? original : destinationRecord),
  );
  mockIPC((command) => {
    if (command === "list_annotation_documents") {
      if (records === "pending") return new Promise(() => {});
      if (records === "fail") throw Error("Couldn't read saved notes.");
      return [{ path: "/old.md", highlights: 2, notes: 2, bookmarks: 1 }];
    }
    if (command === "plugin:dialog|open") return "/new.md";
    if (command === "open_markdown_file")
      return {
        canonicalPath: "/new.md",
        name: "new.md",
        content: "# Old title\n\nPreserved quotation.",
        revision: { size: 34, mtimeMs: 1, hash: "revision" },
      };
    throw Error(command);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(ReconnectNotesDialog, {
          sourcePath,
          settings,
          onClose() {
            closed++;
          },
          onOpen(path) {
            opened = path;
          },
          async onReconnect(...args) {
            calls.push(args);
            if (fail) throw Error("Destination changed. Preview again.");
          },
        }),
      ),
    ),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  });
  const dialog = () => document.querySelector('[role="dialog"]');
  const button = (text) =>
    [...dialog().querySelectorAll("button")].find(
      (button) => button.textContent === text,
    );
  return { dialog, button, calls, closed: () => closed, opened: () => opened, host };
}
async function until(assertion) {
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    try {
      return assertion();
    } catch (error) {
      if (i === 49) throw error;
    }
  }
}
test("reconnection previews legacy uncertain and missing passages, retains all records, and requires an explicit commit", async (t) => {
  const view = await mount(t);
  assert.equal(view.dialog().querySelector("h2").textContent, "Reconnect notes");
  assert.match(view.dialog().textContent, /2 highlights, 2 notes, 1 bookmarks/);
  await act(async () => view.button("Choose destination document…").click());
  await until(() =>
    assert.match(
      view.dialog().textContent,
      /0 highlighted passages located; 1 uncertain; 1 missing/,
    ),
  );
  assert.match(view.dialog().textContent, /1 of 1 bookmark headings found/);
  assert.equal(view.calls.length, 0);
  await act(async () => view.button("Reconnect these notes").click());
  assert.deepEqual(view.calls[0].slice(0, 3), ["/old.md", "/new.md", original]);
  assert.equal(view.calls[0][3].hash, "revision");
  assert.match(view.dialog().textContent, /Notes reconnected/);
  await act(async () => view.button("Open document").click());
  assert.equal(view.closed(), 1);
  assert.equal(view.opened(), "/new.md");
});
test("reconnection refuses an occupied destination before showing a commit action", async (t) => {
  const view = await mount(t, { occupied: true });
  await act(async () => view.button("Choose destination document…").click());
  await until(() =>
    assert.match(
      view.dialog().textContent,
      /already has its own highlights, notes, bookmarks, or other saved data/,
    ),
  );
  assert.equal(view.button("Reconnect these notes"), undefined);
  assert.equal(view.calls.length, 0);
});
for (const [kind, bookmarks] of [["bookmarks only", original.bookmarks], ["an unreadable bookmark", [{ future: true }]]]) {
  test(`reconnection explains a destination containing ${kind}`, async t => {
    const view = await mount(t, { destinationRecord: { version: 3, highlights: [], bookmarks } });
    await act(async () => view.button("Choose destination document…").click());
    await until(() => assert.equal(view.dialog().querySelector('[role="alert"]').textContent,
      "That document already has its own highlights, notes, bookmarks, or other saved data. Choose another document."));
    assert.equal(view.button("Reconnect these notes"), undefined);
    assert.equal(view.calls.length, 0);
  });
}
test("a rejected reconnection stays open and offers another preview without claiming success", async (t) => {
  const view = await mount(t, { fail: true });
  await act(async () => view.button("Choose destination document…").click());
  await until(() => assert.ok(view.button("Reconnect these notes")));
  await act(async () => view.button("Reconnect these notes").click());
  assert.match(view.dialog().textContent, /Destination changed/);
  assert.doesNotMatch(view.dialog().textContent, /Notes reconnected/);
  assert.equal(view.closed(), 0);
  assert.equal(view.button("Choose destination document…").disabled, false);
});

test("a moved file without saved notes says so plainly, without its full path, and choosing its new place opens it", async (t) => {
  const view = await mount(t, { sourcePath: "/Users/reader/Garden/gone.md" });
  await until(() =>
    assert.match(
      view.dialog().textContent,
      /gone\.md has no saved notes\. Choose where it is now to open it\./,
    ),
  );
  const option = [...view.dialog().querySelectorAll("option")].find(
    (node) => node.value === "/Users/reader/Garden/gone.md",
  );
  assert.equal(option.textContent, "gone.md · no saved notes");
  assert.match(view.dialog().textContent, /^Locate File/);
  assert.doesNotMatch(view.dialog().textContent, /Reconnecting moves/);
  await act(async () => view.button("Choose File…").click());
  await until(() => assert.equal(view.opened(), "/new.md"));
  assert.equal(view.closed(), 1);
  assert.equal(view.calls.length, 0);
});

for (const records of ["pending", "fail"]) {
  test(`while saved notes are ${records === "pending" ? "still loading" : "unreadable"}, the dialog never claims there are none`, async (t) => {
    const view = await mount(t, { records });
    await until(() => assert.ok(records === "pending" || /Couldn't read saved notes/.test(view.dialog().textContent)));
    const option = [...view.dialog().querySelectorAll("option")].find((node) => node.value === "/old.md");
    assert.equal(option.textContent, "old.md");
    assert.doesNotMatch(view.dialog().textContent, /no saved notes/);
    assert.match(view.dialog().textContent, /^Reconnect notes/);
    assert.ok(view.button("Choose destination document…"));
  });
}
