const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const { EmptyState } = require("../.tmp/workspace-tests/src/components/EmptyState.js");
const { Header } = require("../.tmp/workspace-tests/src/components/Header.js");
const { ShortcutOverlay } = require("../.tmp/workspace-tests/src/components/ShortcutOverlay.js");
const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");

function render(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(element));
  return {
    host,
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

function buttonWithText(host, text) {
  const button = Array.from(host.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === text);
  assert.ok(button, `expected a ${text} button`);
  return button;
}

function click(element) {
  flushSync(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

test("EmptyState exposes a working New File action alongside Open File", async () => {
  await installDom();
  let newCount = 0;
  let openCount = 0;
  let restoreCount = 0;
  const rendered = render(React.createElement(EmptyState, {
    onNewFile() { newCount += 1; },
    onOpenFile() { openCount += 1; },
    recentFiles: [],
    onOpenRecent() {},
    onRestoreDrafts() { restoreCount += 1; },
  }));

  try {
    click(buttonWithText(rendered.host, "New File"));
    click(buttonWithText(rendered.host, "Open File"));
    click(buttonWithText(rendered.host, "Restore an unsaved draft…"));
    assert.equal(newCount, 1);
    assert.equal(openCount, 1);
    assert.equal(restoreCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("Header exposes New and permits saving a clean virtual editor", async () => {
  await installDom();
  let newCount = 0;
  let saveCount = 0;
  let formattingToggleCount = 0;
  const rendered = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(Header, {
        fileName: "Untitled.md",
        filePath: null,
        theme: "light",
        onCycleTheme() {},
        onNewFile() { newCount += 1; },
        onOpenFile() {},
        onToggleSidebar() {},
        onToggleToc() {},
        onToggleReaderControls() {},
        canGoBack: false,
        canGoForward: false,
        onGoBack() {},
        onGoForward() {},
        isEditing: true,
        isDirty: false,
        isSavedFlash: false,
        saveWarning: null,
        canSave: true,
        canToggleEdit: true,
        onToggleEdit() {},
        onSave() { saveCount += 1; },
        canRestoreSnapshot: false,
        onRestoreSnapshot() {},
        statsSummary: null,
        progressTextRef: React.createRef(),
        onToggleAnnotations() {},
        hasAnnotations: false,
        onPrint() {},
        onPresent() {},
        canPresent: false,
        fileType: "markdown",
        markdownFormattingEnabled: true,
        onToggleMarkdownFormatting() { formattingToggleCount += 1; },
      }),
    ),
  );

  try {
    click(buttonWithText(rendered.host, "New"));
    const saveButton = buttonWithText(rendered.host, "Save");
    assert.equal(saveButton.classList.contains("text-text-muted"), true);
    assert.equal(saveButton.classList.contains("text-accent"), false);
    click(saveButton);
    click(buttonWithText(rendered.host, "Styled"));
    assert.equal(newCount, 1);
    assert.equal(saveCount, 1);
    assert.equal(formattingToggleCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("ShortcutOverlay documents the New file shortcut", async () => {
  await installDom();
  const rendered = render(React.createElement(ShortcutOverlay, {
    visible: true,
    onClose() {},
  }));

  try {
    const rows = Array.from(rendered.host.querySelectorAll(".flex.items-center.justify-between"));
    const newFileRow = rows.find((row) => row.textContent.includes("New file"));
    assert.ok(newFileRow);
    assert.match(newFileRow.textContent, /Ctrl\+N/);
  } finally {
    rendered.cleanup();
  }
});
