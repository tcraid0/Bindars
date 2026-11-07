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
    assert.equal(document.activeElement.getAttribute("aria-label"), "Open third, /");
    view.render({ openingPath: null });
    assertFocusReveal(remove("third"));
    click(remove("third"));
    assert.equal(document.activeElement.getAttribute("aria-label"), "Open second, /");
    assertFocusReveal(remove("second"));
    click(remove("second"));
    assert.equal(document.activeElement.getAttribute("aria-label"), "Recent files");
    assert.equal(view.host.querySelectorAll("button").length, 0);
    assert.match(document.activeElement.textContent, /Documents you open will appear here\./);
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
    assert.equal(buttonWithText(view.host, "Add note").classList.contains("opacity-0"), false);
    assertFocusReveal(view.host.querySelector('[aria-label="Edit note"]'));
    assertFocusReveal(removeButtons()[1]);
    click(removeButtons()[1]);
    assert.match(document.activeElement.textContent, /third/);
    assertFocusReveal(removeButtons()[1]);
    click(removeButtons()[1]);
    assert.match(document.activeElement.textContent, /first/);
    assertFocusReveal(removeButtons()[0]);
    click(removeButtons()[0]);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Close highlights & notes");
    assert.equal(view.host.querySelector('[aria-label="Export highlights & notes as Markdown"]').disabled, true);
    assert.match(view.host.textContent, /No highlights or notes yet/);
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
    const close = view.host.querySelector('[aria-label="Close highlights & notes"]');
    focus(close);
    assert.ok(document.activeElement === close);
    assert.ok(view.host.querySelector("textarea") === null);
    assert.deepEqual(updates, [["first", { note: undefined }], ["second", { note: "Existing note" }]]);
  } finally { view.cleanup(); }
});

test("unresolved highlights remain editable and missing bookmarks can be removed independently", async () => {
  await installDom();
  const removed = [];
  const view = renderComponent(Annotations, {
    locations: { first: "uncertain", second: "missing", third: "located" },
    bookmarks: [{ id: "orphan", headingId: "gone", headingText: "Deleted heading", createdAt: 1 }],
    onRemoveBookmark: (id) => removed.push(id),
  });
  try {
    assert.match(view.host.textContent, /Location uncertain/);
    assert.match(view.host.textContent, /Location unavailable/);
    assert.equal(view.host.querySelectorAll('[aria-label="Remove highlight"]').length, 3);
    click(view.host.querySelector('[aria-label="Edit note"]'));
    assert.equal(document.activeElement.tagName, "TEXTAREA");
    pressKey("Escape");
    click(view.host.querySelector('[aria-label="Remove bookmark"]'));
    assert.deepEqual(removed, ["orphan"]);
  } finally { view.cleanup(); }
});

test("an unfinished note commits to its originating document when the panel is replaced", async () => {
  await installDom();
  const updates = [];
  function DocumentPanel({ path }) {
    return React.createElement(Annotations, { key: path,
      onUpdate: (id, value) => updates.push({ path, id, value }) });
  }
  const view = renderComponent(DocumentPanel, { path: "/a.md" });
  try {
    click(view.host.querySelector('[aria-label="Edit note"]'));
    const input = document.activeElement;
    const { flushSync } = require("./_helpers/react.cjs");
    flushSync(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(input, "Unfinished A note");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(input.value, "Unfinished A note");
    view.render({ path: "/b.md" });
    assert.deepEqual(updates, [{ path: "/a.md", id: "second", value: { note: "Unfinished A note" } }]);
    assert.ok(!view.host.querySelector("textarea"));
  } finally { view.cleanup(); }
});

for (const welcome of [false, true]) {
  test(`unavailable Recent preserves focus and Retry returns it to the row (welcome=${welcome})`, async () => {
    await installDom();
    const opened = [];
    let retries = 0;
    const view = renderComponent(Recents, { welcome, onOpen: path => opened.push(path), onRetry() {
      retries += 1;
      assert.ok(document.activeElement === row, "handoff precedes disabling or removing Retry");
      view.render({ openingPath: "/first.md" });
    } });
    const row = view.host.querySelector('[aria-label^="Open first"]');
    try {
      focus(row);
      click(row);
      view.render({ recovery: { path: "/first.md", error: { category: "not-found" }, retryDisabled: false } });
      assert.equal(row.disabled, false, "native disabled loses focus in WebKit");
      assert.equal(row.getAttribute("aria-disabled"), "true");
      assert.equal(row.tabIndex, -1);
      assert.ok(document.activeElement === row);
      click(row);
      assert.deepEqual(opened, ["/first.md"], "the unavailable row cannot bypass Retry");
      const retry = view.host.querySelector('[aria-label="Retry opening first"]');
      focus(retry);
      click(retry);
      assert.equal(retries, 1);
      assert.ok(document.activeElement === row);
      click(row);
      assert.deepEqual(opened, ["/first.md"]);
      view.render({ recovery: null, openingPath: null, currentFilePath: "/first.md" });
      assert.ok(document.activeElement === row);
      assert.equal(row.tabIndex, 0);
      assert.equal(row.hasAttribute("aria-disabled"), false);
      assert.ok(view.host.querySelector('[aria-label="Retry opening first"]') === null);
    } finally { view.cleanup(); }
  });

  test(`opening a Recent row stays focusable and ignores repeated activation (welcome=${welcome})`, async () => {
    await installDom();
    const opened = [];
    const view = renderComponent(Recents, { welcome, onOpen: path => opened.push(path) });
    const row = view.host.querySelector('[aria-label^="Open first"]');
    try {
      focus(row);
      click(row);
      view.render({ openingPath: "/first.md" });
      assert.equal(row.disabled, false, "native disabled makes WebKit drop focus");
      assert.equal(row.getAttribute("aria-disabled"), "true");
      assert.equal(row.getAttribute("aria-busy"), "true");
      assert.match(row.textContent, /Opening…/);
      click(row);
      assert.deepEqual(opened, ["/first.md"]);
      view.render({ openingPath: null, currentFilePath: "/first.md" });
      assert.equal(row.hasAttribute("aria-disabled"), false);
      assert.equal(row.getAttribute("aria-current"), "page");
      assert.ok(document.activeElement === row);
      click(row);
      assert.deepEqual(opened, ["/first.md", "/first.md"]);
    } finally { view.cleanup(); }
  });
}

test('note disclosure follows measured overflow, stays read-only, and remeasures width and content', async t => {
  await installDom();
  const observers = new Set();
  const originalObserver = window.ResizeObserver;
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(element) { this.element = element; }
    disconnect() { observers.delete(this); }
  };
  // DOM tests exercise the measurement contract; the browser check verifies real clipping.
  const proto = window.HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  const client = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  let overflows = new Set(['Long first', 'Long second']);
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return overflows.has(this.textContent) ? 96 : 32; } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('line-clamp-3') ? 48 : 96; } });
  t.after(() => {
    window.ResizeObserver = originalObserver;
    if (scroll) Object.defineProperty(proto, 'scrollHeight', scroll); else delete proto.scrollHeight;
    if (client) Object.defineProperty(proto, 'clientHeight', client); else delete proto.clientHeight;
  });
  const items = ['Short', 'Long first', 'Long second'].map((note, i) => ({ id: String(i), exact: `Passage ${i}`, color: 'yellow', note }));
  const updates = [], jumps = [];
  const view = renderComponent(AnnotationsPanel, { visible: true, filePath: '/a.md', fileName: 'a.md',
    annotationStatus: 'ready', annotationsReady: true, highlights: items, bookmarks: [], headings: [],
    onUpdateHighlight: (...args) => updates.push(args), onClickHighlight: id => jumps.push(id) });
  t.after(view.cleanup);
  const rows = () => [...view.host.querySelectorAll('li')];
  const disclosure = row => row.querySelector('[aria-expanded]');
  assert.equal(disclosure(rows()[0]), null);
  assert.equal(disclosure(rows()[1]).textContent, 'Read more');
  focus(disclosure(rows()[1]));
  click(disclosure(rows()[1]));
  click(disclosure(rows()[2]));
  assert.equal(disclosure(rows()[1]).getAttribute('aria-expanded'), 'true');
  assert.equal(disclosure(rows()[2]).getAttribute('aria-expanded'), 'true');
  assert.equal(disclosure(rows()[1]).textContent, 'Show less');
  assert.deepEqual(updates, []);
  assert.deepEqual(jumps, []);
  assert.ok(document.activeElement === disclosure(rows()[1]));
  view.render({ mutationsDisabled: true });
  assert.equal(rows()[1].querySelector('[aria-label="Edit note"]').disabled, true);
  assert.equal(disclosure(rows()[1]).disabled, false);
  click(disclosure(rows()[1]));
  assert.equal(disclosure(rows()[1]).getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure(rows()[2]).getAttribute('aria-expanded'), 'true');
  overflows = new Set();
  const { flushSync } = require('./_helpers/react.cjs');
  flushSync(() => observers.forEach(observer => observer.callback()));
  assert.equal(disclosure(rows()[1]), null, 'a wider unclipped preview no longer needs Read more');
  assert.equal(document.activeElement.textContent, 'Long first', 'focus stays on the note when its disclosure disappears');
  assert.equal(disclosure(rows()[2]).textContent, 'Show less', 'expanded state never auto-collapses');
  overflows = new Set(['Changed note']);
  view.render({ highlights: items.map((item, i) => i === 1 ? { ...item, note: 'Changed note' } : item), mutationsDisabled: false });
  assert.equal(disclosure(rows()[1]).textContent, 'Read more');
  click(disclosure(rows()[1]));
  click(rows()[1].querySelector('[aria-label="Edit note"]'));
  assert.equal(document.activeElement.value, 'Changed note');
  flushSync(() => observers.forEach(observer => observer.callback()));
  assert.equal(document.activeElement.tagName, 'TEXTAREA');
  pressKey('Escape');
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Edit note');
  assert.deepEqual(updates, []);
  view.render({ filePath: '/b.md' });
  assert.equal(disclosure(rows()[2]), null, 'expansion never leaks to the same annotation id in another document');
  click(rows()[2].querySelector('button'));
  assert.deepEqual(jumps, ['2'], 'the quotation retains its independent jump action');
});
