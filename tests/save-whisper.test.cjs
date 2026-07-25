const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const {
  SaveWhisper,
} = require("../.tmp/workspace-tests/src/components/SaveWhisper.js");
const {
  FocusBar,
} = require("../.tmp/workspace-tests/src/components/FocusBar.js");

function renderComponent(Component, props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  flushSync(() => root.render(React.createElement(Component, props)));
  return {
    host,
    rerender(nextProps) {
      flushSync(() => root.render(React.createElement(Component, nextProps)));
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

test("SaveWhisper moves from unsaved to a fading saved check", async () => {
  await installDom();
  const rendered = renderComponent(SaveWhisper, {
    dirty: true,
    saved: false,
    warning: null,
  });

  try {
    assert.ok(rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    rendered.rerender({ dirty: false, saved: true, warning: null });
    const saved = rendered.host.querySelector('[aria-label="Saved"]');
    assert.ok(saved);
    assert.equal(saved.textContent, "✓");
    assert.equal(saved.classList.contains("save-whisper-saved"), true);
  } finally {
    rendered.cleanup();
  }
});

test("SaveWhisper gives a paused-save warning precedence over dirty and saved", async () => {
  await installDom();
  const warning = "The file changed outside Bindars. Autosave is paused.";
  const rendered = renderComponent(SaveWhisper, { dirty: true, saved: true, warning });

  try {
    const status = rendered.host.querySelector('[role="status"]');
    assert.ok(status);
    assert.equal(status.getAttribute("aria-label"), `Save warning: ${warning}`);
    assert.equal(status.getAttribute("title"), warning);
    assert.equal(status.textContent, "!");
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
  } finally {
    rendered.cleanup();
  }
});

test("SaveWhisper renders nothing for a quiet clean state", async () => {
  await installDom();
  const rendered = renderComponent(SaveWhisper, {
    dirty: false,
    saved: false,
    warning: null,
  });

  try {
    assert.equal(rendered.host.childElementCount, 0);
  } finally {
    rendered.cleanup();
  }
});

test("FocusBar uses the shared warning whisper", async () => {
  await installDom();
  const warning = "Autosave failed and is paused until you save manually.";
  const rendered = renderComponent(FocusBar, {
    fileName: "draft.md",
    isDirty: true,
    isSavedFlash: false,
    saveWarning: warning,
    onExit() {},
    statsSummary: null,
    progressTextRef: React.createRef(),
    reducedEffects: false,
    showMarkdownFormatting: false,
    markdownFormattingEnabled: false,
    onToggleMarkdownFormatting() {},
  });

  try {
    const status = rendered.host.querySelector('[role="status"]');
    assert.ok(status);
    assert.equal(status.getAttribute("aria-label"), `Save warning: ${warning}`);
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
  } finally {
    rendered.cleanup();
  }
});
