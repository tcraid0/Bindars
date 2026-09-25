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
const { Header } = require("../.tmp/workspace-tests/src/components/Header.js");
const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");

function renderComponent(Component, props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  const element = (nextProps) => Component === Header
    ? React.createElement(ToastProvider, null, React.createElement(Component, nextProps))
    : React.createElement(Component, nextProps);
  flushSync(() => root.render(element(props)));
  return {
    host,
    rerender(nextProps) {
      flushSync(() => root.render(element(nextProps)));
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

test("SaveWhisper shows unsaved text before its existing fading Saved confirmation", async () => {
  await installDom();
  const rendered = renderComponent(SaveWhisper, {
    dirty: true,
    saved: false,
    warning: null,
  });

  try {
    assert.equal(rendered.host.querySelector('[aria-label="Unsaved changes"]').textContent.trim(), "Unsaved changes");
    rendered.rerender({ dirty: false, saved: true, warning: null });
    const saved = rendered.host.querySelector('[aria-label="Saved"]');
    assert.ok(saved);
    assert.equal(saved.textContent, "Saved");
    assert.equal(saved.classList.contains("save-whisper-saved"), true);
  } finally {
    rendered.cleanup();
  }
});

test("SaveWhisper gives a readable paused-save warning precedence over draft, dirty, and saved", async () => {
  await installDom();
  const warning = "The file changed outside Bindars. Autosave is paused.";
  const rendered = renderComponent(SaveWhisper, { isDraft: true, dirty: true, saved: true, warning });

  try {
    const status = rendered.host.querySelector('[role="status"]');
    assert.ok(status);
    assert.equal(status.getAttribute("aria-label"), `Save warning: ${warning}`);
    assert.equal(status.getAttribute("title"), warning);
    assert.equal(status.textContent, warning);
    assert.ok(!rendered.host.querySelector('[aria-label="Not saved yet"]'));
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
  } finally {
    rendered.cleanup();
  }
});

for (const dirty of [false, true]) {
  test(`SaveWhisper labels an actual ${dirty ? "changed" : "empty or recovered clean"} draft until saved-file adoption`, async () => {
    await installDom();
    const rendered = renderComponent(SaveWhisper, { isDraft: true, dirty, saved: true, warning: null });
    try {
      const label = rendered.host.querySelector('[aria-label="Not saved yet"]');
      assert.equal(label.textContent, "Not saved yet");
      assert.match(label.title, /choose a filename and location/);
      assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
      rendered.rerender({ isDraft: false, dirty: false, saved: true, warning: null });
      assert.ok(!rendered.host.querySelector('[aria-label="Not saved yet"]'));
      assert.equal(rendered.host.textContent, "Saved");
    } finally { rendered.cleanup(); }
  });
}

test("SaveWhisper keeps newer unsaved changes ahead of an earlier saved flash", async () => {
  await installDom();
  const rendered = renderComponent(SaveWhisper, { isDraft: false, dirty: true, saved: true, warning: null });
  try {
    assert.equal(rendered.host.textContent.trim(), "Unsaved changes");
    assert.ok(!rendered.host.querySelector('[aria-label="Saved"]'));
  } finally { rendered.cleanup(); }
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

for (const [name, Component] of [["Header", Header], ["FocusBar", FocusBar]]) {
 test(`${name} forwards draft status and preserves recovery-warning precedence`, async () => {
  await installDom();
  const warning = "Recovery copy failed: disk full.";
  const props = {
    fileName: "draft.md",
    filePath: null,
    theme: "light",
    isEditing: true,
    isDraft: true,
    isDirty: false,
    isSavedFlash: true,
    saveWarning: null,
    canSave: true,
    canToggleEdit: true,
    onExit() {},
    statsSummary: null,
    progressTextRef: React.createRef(),
    reducedEffects: false,
    showMarkdownFormatting: false,
    markdownFormattingEnabled: false,
    onToggleMarkdownFormatting() {},
  };
  const rendered = renderComponent(Component, props);

  try {
    assert.equal(rendered.host.querySelector('[aria-label="Not saved yet"]').textContent, "Not saved yet");
    rendered.rerender({ ...props, saveWarning: warning });
    const status = rendered.host.querySelector('[role="status"]');
    assert.ok(status);
    assert.equal(status.getAttribute("aria-label"), `Save warning: ${warning}`);
    assert.equal(status.textContent, warning);
    assert.equal(status.title, warning);
    assert.ok(!rendered.host.querySelector('[aria-label="Not saved yet"]'));
    assert.ok(!rendered.host.querySelector('[aria-label="Unsaved changes"]'));
    rendered.rerender({ ...props, isDraft: false, filePath: "/tmp/draft.md" });
    assert.ok(!rendered.host.querySelector('[aria-label="Not saved yet"]'));
    assert.equal(rendered.host.querySelector('[aria-label="Saved"]').textContent, "Saved");
  } finally {
    rendered.cleanup();
  }
 });
}
