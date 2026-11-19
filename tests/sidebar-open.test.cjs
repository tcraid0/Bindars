const test = require("node:test");
const assert = require("node:assert/strict");
const { act } = require("react");
const { mockWindows, clearMocks } = require("@tauri-apps/api/mocks");
const { createAppView } = require("./_helpers/render-app.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");
const { findEditorView, replaceEditorDocument } = require("./_helpers/codemirror.cjs");

const [a, b, c, d] = ["/fixture/A.md", "/fixture/B.md", "/fixture/C.md", "/fixture/D.fountain"];
const click = async element => {
  assert.ok(element, "expected a clickable control");
  await act(async () => element.click());
};

async function until(check, timeout = 1000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
  }
}

async function mount(t, tab = "Recent") {
  const readCalls = [];
  const events = [];
  let finishB;
  const pauseB = new Promise(resolve => { finishB = resolve; });
  globalThis.localStorage = window.localStorage;
  localStorage.clear();
  mockWindows("main");
  const native = createNativeOpenIpc(a);
  const files = [a, b, c, d].map(path => {
    const name = path.split("/").at(-1);
    return { path, name, relPath: name, openedAt: 100, mtimeMs: 1, size: 22 };
  });
  const view = createAppView({ ipc: native.wrap(async (cmd, args) => {
    if (cmd === "initialize_annotation_storage") return { settingsReady: true };
    if (cmd === "get_setting") {
      if (args.key === "recent-files") return { version: 1, files };
      if (args.key === "workspace:root") return "/fixture";
      if (args.key.endsWith("hint-dismissed")) return true;
      return null;
    }
    if (cmd === "list_draft_documents" || cmd === "list_workspace_markdown_files") return { files, canonicalRoot: "/fixture", limitHit: false };
    if (cmd === "inspect_document_files") return files;
    if (cmd === "write_markdown_file_if_unmodified") throw new Error("Boundary save failed");
    if (cmd === "authorize_document_images") events.push(["published", args.path]);
    if (cmd === "open_markdown_file") {
      const target = args.path;
      readCalls.push(target);
      events.push(["read", target]);
      if (target === b && await pauseB === "fail") throw new Error("File not found");
      return { canonicalPath: target, name: target.split("/").at(-1), content: "# Fixture\n\nText", revision: { mtimeMs: 1, size: 16, contentHash: target } };
    }
    return null;
  }) });
  t.after(async () => { finishB(); await view.cleanup(); clearMocks(); localStorage.clear(); });
  view.render();
  await until(() => assert.ok(view.host.querySelector("article")));
  if (!view.host.querySelector(".document-sidebar")) await click(view.host.querySelector('header button[aria-label="Sidebar"]'));
  await click(view.host.querySelector(`#navigation-tab-${tab}`));
  const row = target => [...view.host.querySelectorAll("#navigation-view button")].find(btn =>
    btn.getAttribute("aria-label")?.startsWith("Open " + target.split("/").at(-1)) ||
    btn.textContent === target.split("/").at(-1));
  const current = () => view.host.querySelector(".document-header-filename")?.textContent;
  await until(() => assert.ok(row(b) && row(c) && row(d)));
  const button = label => [...view.host.querySelectorAll("button")].find(el => el.textContent.trim() === label);
  return {
    row, current, readCalls, events, host: view.host, button,
    release: (outcome) => act(async () => finishB(outcome)),
    async openB() {
      await click(row(b));
      assert.deepEqual(readCalls, [a, b]);
      assert.equal(current(), "A.md");
    },
  };
}

for (const tab of ["Recent", "Drafts", "Folders"]) {
  test(`${tab} opens the newest click after the admitted read publishes`, async t => {
    const view = await mount(t, tab);
    await view.openB();
    await click(view.row(c));
    await click(view.row(d));
    assert.deepEqual(view.readCalls, [a, b]);
    await view.release();
    await until(() => assert.equal(view.current(), "D.fountain"));
    assert.deepEqual(view.readCalls, [a, b, d]);
    const publishedB = view.events.findIndex(([kind, path]) => kind === "published" && path === b);
    const readD = view.events.findIndex(([kind, path]) => kind === "read" && path === d);
    assert.ok(publishedB >= 0 && publishedB < readD, "B publishes before the D read");
  });
}

test("clicking the opening Recent row clears the remembered click", async t => {
  const view = await mount(t);
  await view.openB();
  await click(view.row(c));
  assert.equal(view.row(b).getAttribute("aria-busy"), "true");
  assert.equal(view.row(b).getAttribute("aria-disabled"), "true");
  await click(view.row(b));
  await view.release();
  assert.equal(view.current(), "B.md");
  assert.deepEqual(view.readCalls, [a, b]);
});

test("clicking the currently shown row returns to it after the first open", async t => {
  const view = await mount(t);
  await view.openB();
  await click(view.row(a));
  await view.release();
  await until(() => assert.deepEqual(view.readCalls, [a, b, a]));
  assert.equal(view.current(), "A.md");
});

test("a failed open still replays the remembered click", async t => {
  const view = await mount(t);
  await view.openB();
  await click(view.row(c));
  await view.release("fail");
  await until(() => assert.equal(view.current(), "C.md"));
  assert.deepEqual(view.readCalls, [a, b, c]);
});

test("slow-open Cancel clears the remembered click and a late result cannot replace a later document", async t => {
  const view = await mount(t);
  await view.openB();
  await click(view.row(c));
  const cancel = await until(() => view.button("Cancel") || assert.fail("Slow-open Cancel did not appear"), 4000);
  await click(cancel);
  await until(() => assert.ok(!view.button("Cancel")));
  assert.deepEqual(view.readCalls, [a, b]);
  assert.equal(view.current(), "A.md");
  await click(view.row(d));
  await until(() => assert.equal(view.current(), "D.fountain"));
  await view.release();
  assert.equal(view.current(), "D.fountain");
  assert.deepEqual(view.readCalls, [a, b, d]);
});

test("clicks during the Save changes dialog do not survive Cancel", async t => {
  const view = await mount(t);
  await click(view.host.querySelector('[aria-label="Edit mode"]'));
  await until(() => assert.ok(view.host.querySelector(".cm-editor")));
  await act(async () => replaceEditorDocument(findEditorView(view.host), "# Changed text"));
  await act(async () => new Promise(resolve => setTimeout(resolve, 240)));
  await click(view.row(b));
  await until(() => {
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog?.textContent ?? "", /Save changes to/);
  });
  await click(view.row(c));
  await click(view.row(d));
  await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await until(() => assert.ok(!document.querySelector('[role="dialog"]')));
  assert.equal(view.current(), "A.md");
  assert.deepEqual(view.readCalls, [a]);
  assert.ok(view.host.querySelector(".cm-editor"));
});
