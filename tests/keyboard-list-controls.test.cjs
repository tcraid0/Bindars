const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { installDom } = require("./_helpers/dom.cjs");
const { renderComponent, buttonWithText, click, focus, pressKey } = require("./_helpers/component-view.cjs");
const { RecentFiles } = require("../.tmp/workspace-tests/src/components/RecentFiles.js");
const { TableOfContents } = require("../.tmp/workspace-tests/src/components/TableOfContents.js");
const { AnnotationsPanel } = require("../.tmp/workspace-tests/src/components/AnnotationsPanel.js");

const recentFiles = ["first", "second", "third"].map((name) => ({ name, path: `/${name}.md`, openedAt: 1 }));
const highlights = ["first", "second", "third"].map((id) => ({ id, exact: id, color: "yellow", note: id === "second" ? "Existing note" : undefined }));

function Annotations({ onUpdate = () => {}, ...overrides }) {
  const [items, setItems] = React.useState(highlights);
  return React.createElement(AnnotationsPanel, {
    visible: true, annotationStatus: "ready", annotationsReady: true,
    highlights: items, bookmarks: [], headings: [],
    onRemoveHighlight: (id) => setItems((prev) => prev.filter((item) => item.id !== id)),
    onUpdateHighlight: (id, update) => {
      onUpdate(id, update);
      setItems((prev) => prev.map((item) => item.id === id ? { ...item, ...update } : item));
    },
    ...overrides,
  });
}

function Recents(props) {
  const [files, setFiles] = React.useState(recentFiles);
  return React.createElement(RecentFiles, {
    files, currentFilePath: null, openingPath: null,
    onRemove: (path) => setFiles((prev) => prev.filter((file) => file.path !== path)),
    ...props,
  });
}

function assertFocusReveal(button) {
  focus(button);
  assert.ok(document.activeElement === button);
  assert.equal(button.classList.contains("focus-visible:opacity-100"), true);
  // The production stylesheet supplies the outline; real visibility needs packaged QA.
}

test("recent removals reveal on focus, skip disabled rows, and preserve focus through the empty state", async () => {
  await installDom();
  const view = renderComponent(Recents, { openingPath: "/second.md" });
  try {
    const remove = (name) => view.host.querySelector(`[aria-label="Remove ${name} from recent files"]`);
    assert.equal(remove("second").disabled, true);
    click(remove("second"));
    assert.ok(remove("second"));
    assertFocusReveal(remove("first"));
    click(remove("first"));
    assert.equal(document.activeElement.getAttribute("aria-label"), "Open third");
    view.render({ openingPath: null });
    assertFocusReveal(remove("third"));
    click(remove("third"));
    assert.equal(document.activeElement.getAttribute("aria-label"), "Open second");
    assertFocusReveal(remove("second"));
    click(remove("second"));
    assert.equal(document.activeElement.getAttribute("aria-label"), "Recent files");
    assert.equal(view.host.querySelectorAll("button").length, 0);
    assert.match(document.activeElement.textContent, /No recent files/);
  } finally { view.cleanup(); }
});

test("pointer removals do not steal focus from another control", async () => {
  await installDom();
  const view = renderComponent(Recents);
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    focus(outside);
    click(view.host.querySelector('[aria-label="Remove first from recent files"]'));
    assert.ok(document.activeElement === outside);
  } finally { outside.remove(); view.cleanup(); }
});

test("TOC bookmark remains visible after removal, and unavailable/empty states have no hidden actions", async () => {
  await installDom();
  function Contents(props) {
    const [bookmarked, setBookmarked] = React.useState(false);
    return React.createElement(TableOfContents, {
      visible: true, headings: [{ id: "one", text: "One", level: 1 }], activeId: null,
      isBookmarked: () => bookmarked, onToggleBookmark: () => setBookmarked((value) => !value),
      ...props,
    });
  }
  const view = renderComponent(Contents);
  try {
    const bookmark = view.host.querySelector('[aria-label="Add bookmark"]');
    assertFocusReveal(bookmark);
    click(bookmark);
    assert.equal(bookmark.getAttribute("aria-label"), "Remove bookmark");
    click(bookmark);
    assertFocusReveal(bookmark);
    view.render({ onToggleBookmark: undefined });
    assert.ok(view.host.querySelector('[aria-label="Add bookmark"]') === null);
    view.render({ headings: [], scenes: [{ id: "scene", label: "Unavailable scene" }] });
    assert.match(view.host.textContent, /No headings/);
    assert.equal(buttonWithText(view.host, "Unavailable scene").disabled, true);
    view.render({ visible: false });
    assert.ok(view.host.querySelector("nav") === null);
  } finally { view.cleanup(); }
});

test("highlight actions reveal on focus and removal moves next, previous, then to Close", async () => {
  await installDom();
  const view = renderComponent(Annotations);
  try {
    const removeButtons = () => [...view.host.querySelectorAll('[aria-label="Remove highlight"]')];
    assertFocusReveal(buttonWithText(view.host, "Add note"));
    assertFocusReveal(view.host.querySelector('[aria-label="Edit note"]'));
    assertFocusReveal(removeButtons()[1]);
    click(removeButtons()[1]);
    assert.match(document.activeElement.textContent, /third/);
    assertFocusReveal(removeButtons()[1]);
    click(removeButtons()[1]);
    assert.match(document.activeElement.textContent, /first/);
    assertFocusReveal(removeButtons()[0]);
    click(removeButtons()[0]);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Close annotations");
    assert.equal(view.host.querySelector('[aria-label="Export annotations as Markdown"]').disabled, true);
    assert.match(view.host.textContent, /No annotations yet/);
  } finally { view.cleanup(); }
});

test("note Escape cancels and Enter saves with focus restored; neither key leaks", async () => {
  await installDom();
  const updates = [];
  const view = renderComponent(Annotations, { onUpdate: (...args) => updates.push(args) });
  let leaked = 0;
  const listener = () => { leaked += 1; };
  window.addEventListener("keydown", listener);
  try {
    const edit = view.host.querySelector('[aria-label="Edit note"]');
    focus(edit);
    click(edit);
    assert.equal(document.activeElement.tagName, "TEXTAREA");
    assert.equal(pressKey("Escape").defaultPrevented, true);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Edit note");
    assert.deepEqual(updates, []);
    click(document.activeElement);
    assert.equal(pressKey("Enter").defaultPrevented, true);
    assert.deepEqual(updates, [["second", { note: "Existing note" }]]);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Edit note");
    assert.equal(leaked, 0);
    click(document.activeElement);
    assert.equal(pressKey("Enter", { shiftKey: true }).defaultPrevented, false);
    assert.equal(pressKey("Enter", { isComposing: true }).defaultPrevented, false);
    assert.equal(pressKey("Escape", { isComposing: true }).defaultPrevented, false);
    assert.equal(document.activeElement.tagName, "TEXTAREA");
  } finally { window.removeEventListener("keydown", listener); view.cleanup(); }
});

test("note blur saves without pulling focus back; empty note returns to Add note", async () => {
  await installDom();
  const updates = [];
  const view = renderComponent(Annotations, { onUpdate: (...args) => updates.push(args) });
  try {
    click(buttonWithText(view.host, "Add note"));
    pressKey("Enter");
    assert.equal(document.activeElement.textContent, "Add note");
    click(view.host.querySelector('[aria-label="Edit note"]'));
    const close = view.host.querySelector('[aria-label="Close annotations"]');
    focus(close);
    assert.ok(document.activeElement === close);
    assert.ok(view.host.querySelector("textarea") === null);
    assert.deepEqual(updates, [["first", { note: undefined }], ["second", { note: "Existing note" }]]);
  } finally { view.cleanup(); }
});
