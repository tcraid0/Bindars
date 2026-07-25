const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { undo } = require("@codemirror/commands");
const { installDom } = require("./_helpers/dom.cjs");
const { findEditorView, replaceEditorDocument } = require("./_helpers/codemirror.cjs");

const baseSettings = {
  contentWidth: 65,
  fontSize: 18,
  lineHeight: 1.6,
  fontFamily: "newsreader",
};

const changedSettings = {
  ...baseSettings,
  contentWidth: 80,
  fontSize: 24,
  lineHeight: 2,
  fontFamily: "opendyslexic",
};

test("MarkdownEditor applies reader typography without replacing its live editing session", async () => {
  await installDom();
  const { MarkdownEditor } = require(
    "../.tmp/workspace-tests/src/components/MarkdownEditor.js"
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let dismissCount = 0;
  const editorRef = React.createRef();
  const publications = [];

  function render(saveError, settings = baseSettings) {
    flushSync(() => {
      root.render(React.createElement(MarkdownEditor, {
        buffer: "Draft",
        fileType: "markdown",
        markdownFormattingEnabled: true,
        settings,
        saveError,
        ref: editorRef,
        onBufferChange(content) {
          publications.push(content);
          return true;
        },
        onDismissSaveError() { dismissCount += 1; },
      }));
    });
  }

  try {
    render(null);
    const view = findEditorView(host);
    const shell = host.firstElementChild;

    assert.equal(shell.style.maxWidth, "65ch");
    assert.equal(shell.style.fontSize, "18px");
    assert.equal(shell.style.lineHeight, "1.6");
    assert.equal(shell.style.fontFamily, "var(--font-reading-newsreader)");
    assert.equal(shell.style.margin, "0px auto");
    assert.equal(shell.style.padding, "48px 24px 80px");

    replaceEditorDocument(view, "Draft changed");
    view.dispatch({ selection: { anchor: 5 } });
    view.focus();

    render("Disk full", changedSettings);
    assert.ok(findEditorView(host) === view);
    assert.equal(view.state.doc.toString(), "Draft changed");
    assert.equal(view.state.selection.main.head, 5);
    assert.ok(document.activeElement === view.contentDOM);
    assert.equal(view.contentDOM.getAttribute("contenteditable"), "true");
    assert.match(host.textContent, /Disk full/);

    assert.equal(shell.style.maxWidth, "80ch");
    assert.equal(shell.style.fontSize, "24px");
    assert.equal(shell.style.lineHeight, "2");
    assert.equal(shell.style.fontFamily, "var(--font-reading-opendyslexic)");
    assert.equal(publications.length, 0, "rerendering must not publish pending typing");
    assert.equal(editorRef.current.flushPendingChanges(), true);
    assert.deepEqual(publications, ["Draft changed"]);

    const alert = host.querySelector('[role="alert"]');
    assert.ok(alert.classList.contains("font-ui"));

    assert.equal(undo(view), true);
    assert.equal(view.state.doc.toString(), "Draft");

    const dismissButton = host.querySelector('button[aria-label="Dismiss error"]');
    flushSync(() => dismissButton.click());
    assert.equal(dismissCount, 1);

    render(null, changedSettings);
    assert.ok(findEditorView(host) === view);
    assert.ok(!host.querySelector('[role="alert"]'));
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
