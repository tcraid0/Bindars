const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");
const { flushSync } = require("./_helpers/react.cjs");
const { renderComponent, click, focus } = require("./_helpers/component-view.cjs");
const {
  buildAnnotationMarkdown, readHighlightPlaces,
} = require("../.tmp/workspace-tests/src/lib/annotation-export.js");
const { COPY_FAILED_MESSAGE } = require("../.tmp/workspace-tests/src/lib/clipboard.js");
const { AnnotationsPanel } = require("../.tmp/workspace-tests/src/components/AnnotationsPanel.js");

const headings = [
  { id: "intro", text: "Introduction", level: 1 },
  { id: "later", text: "Later", level: 2 },
];

const bookmarks = [
  { id: "b1", headingId: "intro", headingText: "Introduction", createdAt: 1 },
  { id: "b2", headingId: "later", headingText: "Line\nbreak heading", createdAt: 2 },
];

const highlights = [
  {
    id: "h1",
    prefix: "",
    exact: "First quote",
    suffix: "",
    color: "yellow",
    createdAt: 1,
    nearestHeadingId: "intro",
    note: "Keep this",
  },
  {
    id: "h2",
    prefix: "",
    exact: "Orphan quote",
    suffix: "",
    color: "blue",
    createdAt: 2,
    nearestHeadingId: "missing",
  },
  {
    id: "h3",
    prefix: "",
    exact: "Multi\nline\nexact",
    suffix: "",
    color: "green",
    createdAt: 3,
    nearestHeadingId: null,
    note: "  first line\n\nsecond line  ",
  },
];

const exportInput = { fileName: "notes.md", highlights, bookmarks, headings, places: [] };

function ExportPanel(overrides = {}) {
  return React.createElement(AnnotationsPanel, {
    visible: true,
    annotationStatus: "ready",
    annotationsReady: true,
    loadError: null,
    saveError: null,
    canRetrySave: false,
    highlights,
    bookmarks,
    onRetryLoad() {},
    onRetrySave() {},
    onRemoveHighlight() {},
    onUpdateHighlight() {},
    onClickHighlight() {},
    onClickBookmark() {},
    onClose() {},
    fileName: "notes.md",
    headings,
    ...overrides,
  });
}

function exportButton(host) {
  return host.querySelector('[aria-label="Export highlights & notes as Markdown"]');
}

function copyButton(host) {
  return host.querySelector('[aria-label="Copy highlights & notes"]');
}

function stubClipboard(t, writeText) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else delete navigator.clipboard;
  });
}

function toastMessages(host) {
  return [...host.querySelectorAll('[role="status"] span, [role="alert"] span')].map(
    (node) => node.textContent,
  );
}

async function flushAction() {
  await React.act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test("annotation text follows painted passages and lists bookmarks last in heading order", () => {
  const markdown = buildAnnotationMarkdown({
    ...exportInput,
    highlights: [{ ...highlights[0], originalExcerpt: "Old excerpt" }, ...highlights.slice(1)],
    bookmarks: [bookmarks[1], bookmarks[0]],
    places: [
      { id: "h3", headingId: "intro" },
      { id: "h1", headingId: "intro" },
      { id: "h2", headingId: "later" },
    ],
  });

  assert.equal(markdown, [
    "Highlights and notes from notes.md",
    "## Introduction",
    "> Multi\n> line\n> exact",
    "first line\n\nsecond line",
    "> First quote",
    "Keep this",
    "## Later",
    "> Orphan quote",
    "## Bookmarks",
    "- Introduction\n- Line break heading\n",
  ].join("\n\n"));
});

test("annotation text supports bookmarks-only output", () => {
  const markdown = buildAnnotationMarkdown({
    ...exportInput, fileName: "script.fountain", highlights: [],
  });

  assert.equal(markdown, "Highlights and notes from script.fountain\n\n## Bookmarks\n\n- Introduction\n- Line break heading\n");
});

test("a passage with an unknown heading remains in place without a section label", () => {
  const markdown = buildAnnotationMarkdown({
    ...exportInput,
    highlights: [highlights[1]],
    bookmarks: [],
    places: [{ id: "h2", headingId: "missing" }],
  });

  assert.equal(markdown, "Highlights and notes from notes.md\n\n> Orphan quote\n");
});

test("a passage before the first heading has no section label", () => {
  const markdown = buildAnnotationMarkdown({
    ...exportInput,
    highlights: [highlights[1], highlights[0]],
    bookmarks: [],
    places: [{ id: "h2", headingId: null }, { id: "h1", headingId: "intro" }],
  });

  assert.equal(markdown, "Highlights and notes from notes.md\n\n> Orphan quote\n\n## Introduction\n\n> First quote\n\nKeep this\n");
});

test("unplaced passages follow the located sections in stored order", () => {
  const markdown = buildAnnotationMarkdown({
    ...exportInput, bookmarks: [], places: [{ id: "h3", headingId: "later" }],
  });

  assert.equal(markdown, [
    "Highlights and notes from notes.md",
    "## Later",
    "> Multi\n> line\n> exact",
    "first line\n\nsecond line",
    "## Location unavailable",
    "> First quote",
    "Keep this",
    "> Orphan quote\n",
  ].join("\n\n"));
});

test("annotation export sends the chosen destination and formatted Markdown", async (t) => {
  await installDom();
  const writes = [];
  const dialogs = [];
  mockIPC((command, args = {}) => {
    writes.push({ command, args });
  });
  t.mock.method(require("@tauri-apps/plugin-dialog"), "save", async (options) => {
    dialogs.push(options);
    return "/tmp/notes-annotations.md";
  });
  const view = renderComponent(ExportPanel);
  try {
    click(exportButton(view.host));
    await flushAction();
    assert.deepEqual(dialogs, [{
      defaultPath: "notes-highlights-and-notes.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].command, "export_markdown_file");
    assert.equal(writes[0].args.path, "/tmp/notes-annotations.md");
    assert.equal(
      writes[0].args.content,
      buildAnnotationMarkdown(exportInput),
    );
    assert.deepEqual(toastMessages(view.host), ["Highlights and notes exported"]);
    assert.equal(exportButton(view.host).disabled, false);
  } finally {
    view.cleanup();
    clearMocks();
  }
});

test("cancelled annotation export does not write and leaves the control usable", async (t) => {
  await installDom();
  const writes = [];
  mockIPC((command, args = {}) => {
    writes.push({ command, args });
  });
  t.mock.method(require("@tauri-apps/plugin-dialog"), "save", async () => null);
  const view = renderComponent(ExportPanel);
  try {
    const button = exportButton(view.host);
    focus(button);
    click(button);
    await flushAction();
    assert.deepEqual(writes, []);
    assert.deepEqual(toastMessages(view.host), []);
    assert.equal(exportButton(view.host).disabled, false);
    assert.ok(view.host.querySelector("aside"));
    focus(exportButton(view.host));
    assert.ok(document.activeElement === exportButton(view.host));
  } finally {
    view.cleanup();
    clearMocks();
  }
});

test("a failed annotation write can be retried with feedback and usable controls", async (t) => {
  await installDom();
  const nativeMessage = "Bindars could not carry this file's access permissions and attributes over to the new version, so the file was left unchanged. Save to a different file instead.";
  const writes = [];
  mockIPC((command, args = {}) => {
    writes.push({ command, args });
    if (writes.length === 1) {
      // A native refusal carries its own explanation; the toast must keep it.
      throw {
        category: "unknown",
        operation: "preservePermissions",
        message: nativeMessage,
        detail: "fcopyfile: EACCES",
      };
    }
  });
  t.mock.method(require("@tauri-apps/plugin-dialog"), "save", async () => "/tmp/notes-annotations.md");
  const view = renderComponent(ExportPanel);
  try {
    click(exportButton(view.host));
    await flushAction();
    assert.equal(writes.length, 1);
    assert.deepEqual(toastMessages(view.host), [nativeMessage]);
    assert.ok(view.host.querySelector('[role="alert"]'));
    assert.equal(exportButton(view.host).disabled, false);

    click(exportButton(view.host));
    await flushAction();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].command, "export_markdown_file");
    assert.equal(writes[1].args.path, "/tmp/notes-annotations.md");
    assert.equal(
      writes[1].args.content,
      buildAnnotationMarkdown(exportInput),
    );
    assert.ok(toastMessages(view.host).includes("Highlights and notes exported"));
    assert.equal(exportButton(view.host).disabled, false);
    focus(exportButton(view.host));
    assert.ok(document.activeElement === exportButton(view.host));
  } finally {
    view.cleanup();
    clearMocks();
  }
});

test("annotation text keeps punctuation and note lines and collapses repeated blank quote lines", () => {
  const markdown = buildAnnotationMarkdown({
    ...exportInput,
    highlights: [{
      ...highlights[0],
      exact: " v1.7.1 - fix (now).\r\n\r\n\r\nKeep * _ | here.  ",
      note: " First line\nSecond line\n\nLast line. ",
    }],
    bookmarks: [],
    places: [{ id: "h1", headingId: "intro" }],
  });

  assert.equal(markdown, [
    "Highlights and notes from notes.md",
    "## Introduction",
    "> v1.7.1 - fix (now).\n>\n> Keep * _ | here.",
    "First line\nSecond line\n\nLast line.\n",
  ].join("\n\n"));
});

const guardedLines = [
  "# x", "###", "> x", "```", "~~~", "---", "===", "--", "[1]: u", "<div>",
  "***", "___", "* * *", "- - -", '<p class="x"',
];

test("annotation passages and notes guard Markdown block starts and HTML tags", () => {
  for (const [line, expected] of [
    ...guardedLines.map(line => [line, `\\${line}`]),
    ...["#tag", "- item", "* item", "1. item", "a < b", "a<b", "x < y > z"].map(line => [line, line]),
    ["text <div>", "text \\<div>"],
    ["vector<int> and <!-- c -->", "vector\\<int> and \\<!-- c -->"],
  ]) {
    const markdown = buildAnnotationMarkdown({
      ...exportInput,
      highlights: [{ ...highlights[0], exact: line, note: line }],
      bookmarks: [],
      places: [{ id: "h1", headingId: "intro" }],
    });
    assert.equal(markdown, `Highlights and notes from notes.md\n\n## Introduction\n\n> ${expected}\n\n${expected}\n`, line);
  }
});

test("Markdown renders annotation sections and passages without extra block structure", async () => {
  const { renderToStaticMarkup } = require("react-dom/server");
  const { default: Markdown } = await import("react-markdown");
  const { default: gfm } = await import("remark-gfm");
  const hostile = guardedLines.join("\n\n");
  const markdown = buildAnnotationMarkdown({
    ...exportInput,
    fileName: "notes<tag>.md",
    headings: [{ ...headings[0], text: "Intro <tag>" }, headings[1]],
    highlights: [{ ...highlights[0], exact: hostile, note: hostile }, highlights[1]],
    bookmarks: [{ ...bookmarks[0], headingText: "Bookmark <tag>" }],
    places: [{ id: "h1", headingId: "intro" }, { id: "h2", headingId: "later" }],
  });
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [gfm] }, markdown));

  assert.deepEqual([...host.querySelectorAll("h2")].map(node => node.textContent), ["Intro <tag>", "Later", "Bookmarks"]);
  assert.equal(host.querySelectorAll("blockquote").length, 2);
  assert.equal(host.querySelectorAll("h1, hr, pre, div, tag").length, 0);
  assert.ok(host.textContent.includes("notes<tag>.md"));
  assert.ok(host.textContent.includes("Bookmark <tag>"));
  assert.ok(host.textContent.includes("[1]: u"));
  assert.ok(host.textContent.includes("<div>"));
});

test("painted marks give document order and use the first mark and last visible heading", () => {
  const container = document.createElement("div");
  container.innerHTML = `
    <p><mark data-highlight-id="before">Before any heading</mark></p>
    <h2 id="a">First section</h2>
    <p><mark data-highlight-id="h1">Passage</mark></p>
    <p><mark data-highlight-id="split">First part</mark></p>
    <h2 id="b">Second section</h2>
    <p><mark data-highlight-id="split">Second part</mark></p>
    <h2 id="footnote-label" class="sr-only">Footnotes</h2>
    <p><mark data-highlight-id="footnote">Footnote passage</mark></p>
  `;

  assert.deepEqual(readHighlightPlaces(container), [
    { id: "before", headingId: null },
    { id: "h1", headingId: "a" },
    { id: "split", headingId: "a" },
    { id: "footnote", headingId: "b" },
  ]);
});

test("Copy writes the annotation text during the click and confirms success", async t => {
  await installDom();
  const writes = [];
  stubClipboard(t, async text => { writes.push(text); });
  const places = [{ id: "h1", headingId: "intro" }];
  const view = renderComponent(ExportPanel, { getHighlightPlaces: () => places });
  t.after(view.cleanup);

  click(copyButton(view.host));
  assert.deepEqual(writes, [buildAnnotationMarkdown({ ...exportInput, places })]);
  await flushAction();
  assert.deepEqual(toastMessages(view.host), ["Highlights and notes copied"]);
});

test("Copy reports a rejected clipboard write", async t => {
  await installDom();
  stubClipboard(t, async () => { throw new Error("clipboard blocked"); });
  const view = renderComponent(ExportPanel);
  t.after(view.cleanup);

  click(copyButton(view.host));
  await flushAction();
  assert.equal(view.host.querySelector('[role="alert"]').textContent, COPY_FAILED_MESSAGE);
});

test("Copy writes an unsaved note draft before saving it, and mouse down keeps it open", async t => {
  await installDom();
  const events = [];
  stubClipboard(t, async text => { events.push(["write", text]); });
  const view = renderComponent(ExportPanel, {
    onUpdateHighlight: (id, updates) => events.push(["commit", id, updates]),
  });
  t.after(view.cleanup);

  click(view.host.querySelector('[aria-label="Edit note"]'));
  const textarea = view.host.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setValue.call(textarea, "  Draft note  ");
  flushSync(() => textarea.dispatchEvent(new Event("input", { bubbles: true })));
  assert.deepEqual(events, []);

  const copy = copyButton(view.host);
  const press = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  copy.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);

  click(copy);
  await flushAction();
  assert.deepEqual(events, [
    ["write", buildAnnotationMarkdown({
      ...exportInput, highlights: [{ ...highlights[0], note: "Draft note" }, ...highlights.slice(1)],
    })],
    ["commit", "h1", { note: "Draft note" }],
  ]);
});

test("Copy is disabled with no highlights or bookmarks", async t => {
  await installDom();
  const view = renderComponent(ExportPanel, { highlights: [], bookmarks: [] });
  t.after(view.cleanup);
  assert.equal(copyButton(view.host).disabled, true);
});
