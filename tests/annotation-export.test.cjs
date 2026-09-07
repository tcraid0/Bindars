const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");
const { renderComponent, click, focus } = require("./_helpers/component-view.cjs");
const {
  buildAnnotationMarkdown,
} = require("../.tmp/workspace-tests/src/lib/annotation-export.js");
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
  return host.querySelector('[aria-label="Export annotations as Markdown"]');
}

function toastMessages(host) {
  return [...host.querySelectorAll('[role="status"] span, [role="alert"] span')].map(
    (node) => node.textContent,
  );
}

async function flushExport() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("buildAnnotationMarkdown includes bookmarks, heading groups, and notes", () => {
  const markdown = buildAnnotationMarkdown("notes.md", highlights, bookmarks, headings);

  assert.match(markdown, /^# Annotations: notes\.md\n/);
  assert.match(markdown, /\*Exported from Bindars on .+\*/);
  assert.match(markdown, /## Bookmarks\n\n- \*\*Introduction\*\*\n- \*\*Line break heading\*\*/);
  assert.match(markdown, /## Highlights\n\n### Introduction\n\n> "First quote"\n>\n> — \*yellow highlight\*\n\n\*\*Note:\*\* Keep this/);
  assert.doesNotMatch(markdown, /### Later/);
  assert.doesNotMatch(markdown, /### missing/);
  assert.match(markdown, /> "Orphan quote"\n>\n> — \*blue highlight\*/);
  assert.match(markdown, /> "Multi line exact"/);
  assert.match(markdown, /\*\*Note:\*\* first line second line/);
  assert.doesNotMatch(markdown, /first line\n/);
});

test("buildAnnotationMarkdown emits bookmarks-only output", () => {
  const markdown = buildAnnotationMarkdown("script.fountain", [], bookmarks, headings);

  assert.match(markdown, /^# Annotations: script\.fountain\n/);
  assert.match(markdown, /## Bookmarks/);
  assert.doesNotMatch(markdown, /## Highlights/);
  assert.doesNotMatch(markdown, /> "/);
});

test("buildAnnotationMarkdown omits unknown heading titles without dropping highlights", () => {
  const markdown = buildAnnotationMarkdown(
    "notes.md",
    [highlights[1]],
    [],
    headings,
  );

  assert.doesNotMatch(markdown, /## Bookmarks/);
  assert.match(markdown, /## Highlights\n\n> "Orphan quote"/);
  assert.doesNotMatch(markdown, /### /);
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
    await flushExport();
    assert.deepEqual(dialogs, [{
      defaultPath: "notes-annotations.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].command, "export_markdown_file");
    assert.equal(writes[0].args.path, "/tmp/notes-annotations.md");
    assert.equal(
      writes[0].args.content,
      buildAnnotationMarkdown("notes.md", highlights, bookmarks, headings),
    );
    assert.deepEqual(toastMessages(view.host), ["Annotations exported"]);
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
    await flushExport();
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
  const writes = [];
  mockIPC((command, args = {}) => {
    writes.push({ command, args });
    if (writes.length === 1) throw new Error("disk full");
  });
  t.mock.method(require("@tauri-apps/plugin-dialog"), "save", async () => "/tmp/notes-annotations.md");
  const view = renderComponent(ExportPanel);
  try {
    click(exportButton(view.host));
    await flushExport();
    assert.equal(writes.length, 1);
    assert.deepEqual(toastMessages(view.host), ["Export failed"]);
    assert.ok(view.host.querySelector('[role="alert"]'));
    assert.equal(exportButton(view.host).disabled, false);

    click(exportButton(view.host));
    await flushExport();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].command, "export_markdown_file");
    assert.equal(writes[1].args.path, "/tmp/notes-annotations.md");
    assert.equal(
      writes[1].args.content,
      buildAnnotationMarkdown("notes.md", highlights, bookmarks, headings),
    );
    assert.ok(toastMessages(view.host).includes("Annotations exported"));
    assert.equal(exportButton(view.host).disabled, false);
    focus(exportButton(view.host));
    assert.ok(document.activeElement === exportButton(view.host));
  } finally {
    view.cleanup();
    clearMocks();
  }
});
