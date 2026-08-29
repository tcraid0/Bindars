const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const { CommandPalette } = require("../.tmp/workspace-tests/src/components/CommandPalette.js");
const { EmptyState } = require("../.tmp/workspace-tests/src/components/EmptyState.js");
const { Header } = require("../.tmp/workspace-tests/src/components/Header.js");
const {
  MarkdownFormattingToggle,
} = require("../.tmp/workspace-tests/src/components/MarkdownFormattingToggle.js");
const { ShortcutOverlay } = require("../.tmp/workspace-tests/src/components/ShortcutOverlay.js");
const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
const { WorkspacePanel } = require("../.tmp/workspace-tests/src/components/WorkspacePanel.js");
const {
  detectShortcutPlatform,
  formatShortcutLabel,
  renderShortcutTemplate,
} = require("../.tmp/workspace-tests/src/lib/shortcut-labels.js");

const workspaceState = {
  rootPath: "/workspace",
  status: "ready",
  fileCount: 1,
  processedCount: 1,
  indexedCount: 1,
  indexedAt: 1,
  error: null,
  listSkippedCount: 0,
  readFailedCount: 0,
  complexitySkippedCount: 0,
  limitHit: false,
};

function withNavigator(navigatorValue, callback) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value: navigatorValue,
  });

  try {
    return callback();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
}

function renderPlatformLabels(navigatorValue) {
  return withNavigator(navigatorValue, () => renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ShortcutOverlay, { visible: true, onClose() {} }),
      React.createElement(EmptyState, {
        onNewFile() {},
        onOpenFile() {},
        recentFiles: [],
        onOpenRecent() {},
        onRestoreDrafts() {},
      }),
      React.createElement(WorkspacePanel, {
        rootPath: "/workspace",
        state: workspaceState,
        backlinks: [],
        mentions: [],
        onChooseRoot() {},
        onClearRoot() {},
        onReindex() {},
        onOpenPath() {},
        onOpenPalette() {},
      }),
      React.createElement(MarkdownFormattingToggle, {
        enabled: true,
        onToggle() {},
      }),
      React.createElement(CommandPalette, {
        visible: true,
        query: "",
        results: [],
        selectedIndex: 0,
        status: "ready",
        onQueryChange() {},
        onClose() {},
        onOpenHit() {},
        onHoverIndex() {},
      }),
      React.createElement(
        ToastProvider,
        null,
        React.createElement(Header, {
          fileName: "Welcome.md",
          filePath: "/workspace/Welcome.md",
          theme: "light",
          onCycleTheme() {},
          onNewFile() {},
          onOpenFile() {},
          onToggleSidebar() {},
          onToggleToc() {},
          onToggleReaderControls() {},
          canGoBack: true,
          canGoForward: true,
          onGoBack() {},
          onGoForward() {},
          isEditing: false,
          isDirty: false,
          isSavedFlash: false,
          saveWarning: null,
          canSave: false,
          canToggleEdit: true,
          onToggleEdit() {},
          onSave() {},
          canRestoreSnapshot: false,
          onRestoreSnapshot() {},
          statsSummary: null,
          progressTextRef: React.createRef(),
          onToggleAnnotations() {},
          hasAnnotations: false,
          onPrint() {},
          onPresent() {},
          canPresent: true,
          fileType: "markdown",
          markdownFormattingEnabled: true,
          onToggleMarkdownFormatting() {},
        }),
      ),
    ),
  ));
}

test("platform detection handles current macOS, Windows, and Linux navigator signals", () => {
  assert.equal(detectShortcutPlatform({ platform: "MacIntel" }), "macos");
  assert.equal(
    detectShortcutPlatform({ userAgentData: { platform: "macOS" } }),
    "macos",
  );
  assert.equal(
    detectShortcutPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }),
    "macos",
  );
  assert.equal(detectShortcutPlatform({ platform: "Win32" }), "windows-linux");
  assert.equal(detectShortcutPlatform({ platform: "Linux x86_64" }), "windows-linux");
  assert.equal(detectShortcutPlatform(null), "windows-linux");
});

test("shortcut formatting covers modifiers, arrows, symbols, and modifier-free keys", () => {
  assert.equal(formatShortcutLabel("newFile", "macos"), "⌘N");
  assert.equal(formatShortcutLabel("toggleMarkdownFormatting", "macos"), "⌥⌘M");
  assert.equal(formatShortcutLabel("cycleTheme", "macos"), "⇧⌘T");
  assert.equal(formatShortcutLabel("focusMode", "macos"), "⇧⌘F");
  assert.equal(formatShortcutLabel("goBack", "macos"), "⌥←");
  assert.equal(formatShortcutLabel("goForward", "macos"), "⌥→");
  assert.equal(formatShortcutLabel("previousScene", "macos"), "⌥↑");
  assert.equal(formatShortcutLabel("nextScene", "macos"), "⌥↓");
  assert.equal(formatShortcutLabel("increaseFontSize", "macos"), "⌘+");
  assert.equal(formatShortcutLabel("decreaseFontSize", "macos"), "⌘−");
  assert.equal(formatShortcutLabel("toggleBothPanels", "macos"), "⌘\\");
  assert.equal(formatShortcutLabel("escape", "macos"), "Esc");
  assert.equal(formatShortcutLabel("presentation", "macos"), "F5");

  assert.equal(formatShortcutLabel("newFile", "windows-linux"), "Ctrl+N");
  assert.equal(
    formatShortcutLabel("toggleMarkdownFormatting", "windows-linux"),
    "Ctrl+Alt+M",
  );
  assert.equal(formatShortcutLabel("cycleTheme", "windows-linux"), "Ctrl+Shift+T");
  assert.equal(formatShortcutLabel("goBack", "windows-linux"), "Alt+←");
  assert.equal(formatShortcutLabel("increaseFontSize", "windows-linux"), "Ctrl++");
  assert.equal(formatShortcutLabel("decreaseFontSize", "windows-linux"), "Ctrl+−");
  assert.equal(formatShortcutLabel("toggleBothPanels", "windows-linux"), "Ctrl+\\");
  assert.equal(formatShortcutLabel("showShortcuts", "windows-linux"), "?");
});

test("default formatting reads the navigator at call time instead of import time", () => {
  withNavigator({ platform: "MacIntel" }, () => {
    assert.equal(formatShortcutLabel("openFile"), "⌘O");
  });
  withNavigator({ platform: "Linux x86_64" }, () => {
    assert.equal(formatShortcutLabel("openFile"), "Ctrl+O");
  });
});

test("visible shortcut components render macOS labels consistently", () => {
  const markup = renderPlatformLabels({ platform: "MacIntel" });

  assert.match(markup, /⌘N/);
  assert.match(markup, /⌥⌘M/);
  assert.match(markup, /⇧⌘T/);
  assert.match(markup, /⌥←/);
  assert.match(markup, /Quick switcher \(⌘K\)/);
  assert.match(markup, /Enter opens\. Esc closes\./);
  assert.doesNotMatch(markup, /Ctrl\+|Alt\+/);
});

test("visible shortcut components preserve Windows and Linux labels", () => {
  const markup = renderPlatformLabels({ platform: "Linux x86_64" });

  assert.match(markup, /Ctrl\+N/);
  assert.match(markup, /Ctrl\+Alt\+M/);
  assert.match(markup, /Ctrl\+Shift\+T/);
  assert.match(markup, /Alt\+←/);
  assert.match(markup, /Quick switcher \(Ctrl\+K\)/);
  assert.doesNotMatch(markup, /⌘|⌥|⇧/);
});

test("the real Welcome template renders only explicit shortcut tokens", () => {
  const template = fs.readFileSync(
    path.join(__dirname, "../src/assets/welcome.md"),
    "utf8",
  );
  const macosContent = renderShortcutTemplate(template, "macos");
  const windowsLinuxContent = renderShortcutTemplate(template, "windows-linux");

  assert.match(template, /\{\{shortcut:openFile\}\}/);
  assert.match(macosContent, /\*\*⌘O\*\*/);
  assert.match(macosContent, /\*\*⌥⌘M\*\*/);
  assert.doesNotMatch(macosContent, /\{\{shortcut:/);
  assert.doesNotMatch(macosContent, /Ctrl\+|Alt\+/);
  assert.match(windowsLinuxContent, /\*\*Ctrl\+O\*\*/);
  assert.match(windowsLinuxContent, /\*\*Ctrl\+Alt\+M\*\*/);
  assert.doesNotMatch(windowsLinuxContent, /\{\{shortcut:/);

  assert.equal(
    renderShortcutTemplate("Ctrl remains ordinary prose. {{shortcut:newFile}}", "macos"),
    "Ctrl remains ordinary prose. ⌘N",
  );
  assert.throws(
    () => renderShortcutTemplate("{{shortcut:notARealShortcut}}", "macos"),
    /Unknown shortcut token/,
  );
  assert.throws(
    () => renderShortcutTemplate("{{shortcut:openFile", "macos"),
    /Unresolved shortcut token/,
  );
});
