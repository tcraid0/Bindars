const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppView } = require("./_helpers/render-app.cjs");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { mockWindows, clearMocks } = require("@tauri-apps/api/mocks");
const { emit, TauriEvent } = require("@tauri-apps/api/event");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");
const { renderComponent, pressKey } = require("./_helpers/component-view.cjs");
const { withShortcutPlatform } = require("./_helpers/shortcut-platform.cjs");
const { findEditorView } = require("./_helpers/codemirror.cjs");
const { SearchBar } = require("../.tmp/workspace-tests/src/components/SearchBar.js");
const { SHORTCUT_SECTIONS, formatShortcutLabel } = require("../.tmp/workspace-tests/src/lib/shortcut-labels.js");

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

test("Find closes for another path with identical text, including an empty query", async t => {
  const view = await reader(t);
  for (const text of ["alpha", ""]) {
    view.main.focus(); pressKey("f", { ctrlKey: true }); query(view.field(), text);
    await view.open(`/tmp/other-${text}.md`);
    await waitFor(() => assert.ok(!view.field(), "Find should be closed"));
    assert.ok(document.activeElement === view.main);
    await waitFor(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]').disabled, false));
    pressKey("f", { ctrlKey: true }); assert.equal(view.field().value, "");
  }
});

test("Find closes on external edits, transferring focus only from Find", async t => {
  const view = await reader(t);
  for (const inFind of [true, false]) {
    view.main.focus(); pressKey("f", { ctrlKey: true }); query(view.field(), "alpha");
    const outside = view.host.querySelector('[aria-label="Edit mode"]');
    if (!inFind) outside.focus();
    await view.reload(`# Find fixture\n\nalpha new ${inFind}`);
    await waitFor(() => assert.ok(!view.field(), "Find should be closed"));
    assert.ok(document.activeElement === (inFind ? view.main : outside));
  }
});

test("a cancelled open and a query without matches keep Find and its query", async t => {
  const view = await reader(t);
  pressKey("f", { ctrlKey: true }); query(view.field(), "no matches here");
  await waitFor(() => assert.match(view.host.textContent, /No results/));
  pressKey("o", { ctrlKey: true });
  await waitFor(() => assert.ok(view.calls.includes("plugin:dialog|open")));
  await waitFor(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]').disabled, false));
  assert.equal(view.field().value, "no matches here");
});

test("drops explain unsupported-only payloads once and keep mixed and empty behavior", async t => {
  const view = await reader(t);
  const drop = paths => act(async () => emit(TauriEvent.DRAG_DROP, { paths, position: { x: 0, y: 0 } }));
  await drop([]);
  await act(async () => emit(TauriEvent.DRAG_LEAVE));
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 0);
  await drop(["/tmp/probe.pdf", "/tmp/image.png", "/tmp/folder"]);
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 1);
  assert.match(view.host.querySelector('[role="alert"]').textContent, /Only .md, .markdown, or .fountain files can be opened\./);
  assert.deepEqual(view.openedPaths, ["/tmp/find.md"]);
  flushSync(() => view.host.querySelector('[aria-label="Dismiss notification"]').click());
  await drop(["/tmp/probe.pdf", "/tmp/other.md", "/tmp/second.md", "/tmp/image.png"]);
  await waitFor(() => assert.match(view.host.textContent, /other.md/));
  assert.deepEqual(view.openedPaths, ["/tmp/find.md", "/tmp/other.md"]);
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 0);
  await drop(["/tmp/folder.md"]);
  await waitFor(() => assert.ok(view.openedPaths.includes("/tmp/folder.md")));
});

function select(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
}

test("Find hides the reading hint in place without dismissing it", async t => {
  const view = await reader(t);
  const hint = view.host.querySelector(".hint-bar");
  assert.ok(hint); assert.equal(hint.classList.contains("invisible"), false);
  pressKey("f", { ctrlKey: true });
  assert.ok(view.host.querySelector(".hint-bar") === hint);
  assert.ok(hint.classList.contains("invisible"));
  pressKey("Escape");
  assert.ok(view.host.querySelector(".hint-bar") === hint);
  assert.equal(hint.classList.contains("invisible"), false);
  assert.notEqual(window.localStorage.getItem("bindars-reading-hint-dismissed"), "true");
});

function query(input, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

test("reader Find refocuses and selects its query without resetting the current match", async t => {
  const view = await reader(t);
  pressKey("f", { ctrlKey: true });
  query(view.field(), "alpha");
  await waitFor(() => assert.match(view.host.textContent, /1 of 3/));
  pressKey("g", { ctrlKey: true });
  assert.match(view.host.textContent, /2 of 3/);
  view.main.focus();
  pressKey("f", { ctrlKey: true });
  assert.ok(document.activeElement === view.field());
  assert.equal(view.field().selectionStart, 0);
  assert.equal(view.field().selectionEnd, 5);
  assert.match(view.host.textContent, /2 of 3/);
});

test("reader Find seeds only short single-line document selections without math", async t => {
  const view = await reader(t);
  const sample = document.createElement("p"); view.main.append(sample);
  for (const [html, expected] of [
    ["  beta  ", "beta"], ["x".repeat(100), "x".repeat(100)],
    ["x".repeat(101), "keep"], ["first\nsecond", "keep"], ["   ", "keep"],
    ['before <span class="katex"><span>x</span></span> after', "keep"],
  ]) {
    view.main.focus(); pressKey("f", { ctrlKey: true }); query(view.field(), "keep");
    sample.innerHTML = html; select(sample); view.main.focus();
    pressKey("f", { ctrlKey: true }); assert.equal(view.field().value, expected, html);
    window.getSelection().removeAllRanges();
  }
  query(view.field(), "keep");
  sample.innerHTML = '<span class="katex"><span>x</span></span>';
  select(sample.querySelector("span span").firstChild); view.main.focus();
  pressKey("f", { ctrlKey: true }); assert.equal(view.field().value, "keep", "partial math");
  const outside = document.createElement("p"); outside.textContent = "outside"; view.host.append(outside);
  select(outside); view.main.focus(); pressKey("f", { ctrlKey: true });
  assert.equal(view.field().value, "keep");
  window.getSelection().removeAllRanges(); view.main.focus(); pressKey("f", { ctrlKey: true });
  assert.equal(view.field().value, "keep");
  sample.remove(); outside.remove();
});

for (const [platform, modifier, other] of [["MacIntel", "metaKey", "ctrlKey"], ["Linux x86_64", "ctrlKey", "metaKey"]]) {
  test(`${platform}: Find next/previous wraps from field and document without moving focus`, async t => {
    const view = await reader(t);
    const key = (value, extra = {}) => withShortcutPlatform(platform, () => pressKey(value, { [modifier]: true, ...extra }));
    key("g"); assert.ok(view.field());
    query(view.field(), "alpha");
    await waitFor(() => assert.match(view.host.textContent, /1 of 3/));
    for (const target of [view.field(), view.main]) {
      target.focus();
      key("g", { shiftKey: true }); assert.match(view.host.textContent, /3 of 3/);
      assert.ok(document.activeElement === target);
      key("g"); assert.match(view.host.textContent, /1 of 3/);
      assert.ok(document.activeElement === target);
      assert.equal(withShortcutPlatform(platform, () => pressKey("g", { [other]: true })).defaultPrevented, false);
    }
    const note = document.createElement("textarea"); view.host.append(note); note.focus();
    assert.equal(key("g").defaultPrevented, false); assert.match(view.host.textContent, /1 of 3/);
    note.remove(); view.main.focus(); pressKey("Escape"); assert.ok(!view.field(), "Find should be closed");
    key("g"); assert.equal(view.field().value, "");
  });
}

test("macOS Control text keys are not app actions in fields or at an editor line end", async t => {
  const view = await reader(t);
  pressKey("f", { ctrlKey: true });
  const note = document.createElement("textarea"); view.host.append(note);
  for (const target of [view.field(), note]) {
    target.focus();
    for (const key of ["a", "e", "k", "n", "o", "f", "b", "p"]) {
      assert.equal(withShortcutPlatform("MacIntel", () => pressKey(key, { ctrlKey: true })).defaultPrevented, false, key);
      assert.ok(document.activeElement === target);
    }
  }
  note.remove(); view.main.focus(); pressKey("e", { ctrlKey: true });
  await waitFor(() => assert.ok(view.host.querySelector(".cm-editor")));
  const editor = findEditorView(view.host);
  editor.dispatch({ selection: { anchor: editor.state.doc.length } }); editor.focus();
  withShortcutPlatform("MacIntel", () => pressKey("e", { ctrlKey: true }));
  assert.ok(view.host.querySelector(".cm-editor"));
  assert.ok(!view.calls.includes("create_draft_document"));
  assert.ok(!view.calls.includes("plugin:dialog|open"));
});

test("CodeMirror keeps Find, next/previous and Escape ownership in Edit mode", async t => {
  const view = await reader(t);
  pressKey("e", { ctrlKey: true });
  await waitFor(() => assert.ok(view.host.querySelector(".cm-editor")));
  const editor = findEditorView(view.host); editor.focus();
  pressKey("f", { ctrlKey: true });
  const input = view.host.querySelector('.cm-search input[name="search"]'); assert.ok(input);
  query(input, "alpha");
  flushSync(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  pressKey("g", { ctrlKey: true });
  assert.equal(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to), "alpha");
  assert.ok(!view.field(), "Find should be closed");
  pressKey("Escape");
  assert.ok(!view.host.querySelector(".cm-search")); assert.ok(view.host.querySelector(".cm-editor"));
  // Even when a toolbar control has focus, the app must not open reader Find for Mod-G.
  view.main.focus(); assert.equal(pressKey("g", { ctrlKey: true }).defaultPrevented, false);
});

test("SearchBar focus requests preserve the query and match; IME keeps ownership", () => {
  let next = 0;
  const view = renderComponent(SearchBar, { visible: true, focusRequest: 1, query: "alpha", matchCount: 3,
    currentIndex: 1, onQueryChange() {}, onNext() { next++; }, onPrevious() {}, onClose() {} });
  try {
    const input = view.host.querySelector("input"); input.blur();
    view.render({ focusRequest: 2 }); assert.ok(document.activeElement === input);
    assert.equal(input.selectionEnd, 5); assert.match(view.host.textContent, /2 of 3/);
    assert.equal(pressKey("g", { ctrlKey: true, isComposing: true }).defaultPrevented, false);
    assert.equal(next, 0);
  } finally { view.cleanup(); }
});

test("shortcuts list Find next and previous with platform labels", () => {
  const entries = SHORTCUT_SECTIONS.flatMap(section => section.shortcuts);
  assert.ok(entries.some(entry => entry.id === "findNext" && entry.label === "Find next"));
  assert.ok(entries.some(entry => entry.id === "findPrevious" && entry.label === "Find previous"));
  assert.equal(formatShortcutLabel("findNext", "macos"), "⌘G");
  assert.equal(formatShortcutLabel("findPrevious", "macos"), "⇧⌘G");
  assert.equal(formatShortcutLabel("findPrevious", "windows-linux"), "Ctrl+Shift+G");
});

for (const [platform, modifier] of [["MacIntel", "metaKey"], ["Linux x86_64", "ctrlKey"]]) {
  test(`${platform}: Notes requires Shift and primary; plain primary-M remains native`, async t => {
    const view = await reader(t);
    const key = extra => withShortcutPlatform(platform, () => pressKey("m", { [modifier]: true, ...extra }));
    assert.equal(key({}).defaultPrevented, false);
    assert.ok(!view.host.querySelector('[data-reader-panel="notes"]'));
    assert.equal(key({ shiftKey: true, altKey: true }).defaultPrevented, false);
    assert.ok(!view.host.querySelector('[data-reader-panel="notes"]'));
    assert.equal(key({ shiftKey: true }).defaultPrevented, true);
    assert.ok(view.host.querySelector('[data-reader-panel="notes"]'));
  });
}

const menu = action => act(async () => emit("bindars://menu-action", { action }));
test("menu Find routes to the current reader or editor and next/previous keep their search", async t => {
  const view = await reader(t);
  await menu("find"); query(view.field(), "alpha");
  await waitFor(() => assert.match(view.host.textContent, /1 of 3/));
  await menu("find-next"); assert.match(view.host.textContent, /2 of 3/);
  await menu("find-previous"); assert.match(view.host.textContent, /1 of 3/);
  view.main.focus(); pressKey("e", { ctrlKey: true });
  await waitFor(() => assert.ok(view.host.querySelector(".cm-editor")));
  await menu("find");
  const field = view.host.querySelector('.cm-search input[name="search"]'); assert.ok(field);
  query(field, "alpha"); flushSync(() => field.dispatchEvent(new Event("change", { bubbles: true })));
  await menu("find-next");
  const editor = findEditorView(view.host); const first = editor.state.selection.main.from;
  await menu("find-next"); assert.ok(editor.state.selection.main.from > first);
  await menu("find-previous"); assert.equal(editor.state.selection.main.from, first);
  assert.ok(!view.field());
});

test("menu Help and Search open their dialogs, Mac question-mark stays native, and teardown detaches", async t => {
  const events = require("@tauri-apps/api/event");
  const listen = events.listen; let attached = 0; let detached = 0;
  t.mock.method(events, "listen", (name, ...args) => {
    const subscription = listen(name, ...args);
    if (name !== "bindars://menu-action") return subscription;
    attached++;
    return subscription.then(unlisten => () => { detached++; return unlisten(); });
  });
  const view = await reader(t);
  assert.equal(withShortcutPlatform("MacIntel", () => pressKey("?", { metaKey: true })).defaultPrevented, false);
  await menu("show-shortcuts"); assert.match(document.querySelector('[role="dialog"]').textContent, /Keyboard Shortcuts/);
  pressKey("Escape");
  await menu("search-documents"); assert.ok(document.querySelector(".command-palette-shell"));
  pressKey("Escape");
  await view.cleanup();
  assert.ok(attached > 0); assert.equal(detached, attached);
  assert.ok(!document.querySelector('[role="dialog"]'));
});
