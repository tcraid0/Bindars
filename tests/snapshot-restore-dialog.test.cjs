const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");
const { pointerClick } = require("./_helpers/pointer.cjs");

const {
  SnapshotRestoreDialog,
} = require("../.tmp/workspace-tests/src/components/SnapshotRestoreDialog.js");

function renderDialog(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(SnapshotRestoreDialog, props)));
  return {
    host,
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

function dispatchKey(key) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function dispatchKeyOn(target, type, key) {
  const event = new KeyboardEvent(type, {
    key,
    bubbles: true,
    cancelable: true,
  });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

function renderRestoreList(restoringId = null) {
  const restored = [];
  const rendered = renderDialog({
    visible: true,
    title: "Restore snapshot",
    loading: false,
    error: null,
    emptyMessage: "No snapshots yet.",
    restoringId,
    choices: [
      { id: "newer", title: "Today, 2:00 PM", detail: "20 bytes" },
      { id: "older", title: "Yesterday, 1:00 PM", detail: "18 bytes" },
    ],
    onRestore(id) { restored.push(id); },
    onDismiss() {},
  });
  const firstButton = rendered.host.querySelector("li button");
  assert.ok(firstButton, "expected a restore row button");
  return { ...rendered, restored, firstButton };
}

test("snapshot restore dialog lists choices and reports the selected id", async () => {
  await installDom();
  const selected = [];
  const rendered = renderDialog({
    visible: true,
    title: "Restore snapshot",
    loading: false,
    error: null,
    emptyMessage: "No snapshots yet.",
    restoringId: null,
    choices: [
      { id: "new", title: "Today, 2:00 PM", detail: "20 bytes" },
      { id: "old", title: "Yesterday, 1:00 PM", detail: "18 bytes" },
    ],
    onRestore(id) { selected.push(id); },
    onDismiss() {},
  });

  try {
    const buttons = Array.from(rendered.host.querySelectorAll("li button"));
    assert.equal(buttons.length, 2);
    flushSync(() => buttons[1].click());
    assert.deepEqual(selected, ["old"]);
    assert.match(rendered.host.textContent, /snapshots the current state first/i);
  } finally {
    rendered.cleanup();
  }
});

test("snapshot restore dialog renders loading, empty, and error states explicitly", async () => {
  await installDom();
  const states = [
    { loading: true, error: null, expected: /Loading snapshots/ },
    { loading: false, error: null, expected: /Nothing recoverable/ },
    { loading: false, error: "app-data unavailable", expected: /app-data unavailable/ },
  ];

  for (const state of states) {
    const rendered = renderDialog({
      visible: true,
      title: "Restore snapshot",
      loading: state.loading,
      error: state.error,
      emptyMessage: "Nothing recoverable.",
      restoringId: null,
      choices: [],
      onRestore() {},
      onDismiss() {},
    });
    try {
      assert.match(rendered.host.textContent, state.expected);
    } finally {
      rendered.cleanup();
    }
  }
});

// Regression coverage for the WebKit "held Enter leaks blank lines" bug.
//
// The restore rows are native <button>s. A native button fires its click on
// Enter *keydown*, so restoring — which mounts and focuses the editor — happened
// while Enter was still held; the OS key-repeat then leaked extra newlines into
// the freshly focused editor, which autosaved. The fix activates the restore on
// keyup (like Space), so the key is released before the editor mounts.

test("restore waits for Enter keyup so a held key cannot leak into the editor", async () => {
  await installDom();
  const { restored, firstButton, cleanup } = renderRestoreList();

  try {
    // A realistic held Enter: repeated keydowns while held, then one release.
    const keydown = dispatchKeyOn(firstButton, "keydown", "Enter");
    dispatchKeyOn(firstButton, "keydown", "Enter");
    dispatchKeyOn(firstButton, "keydown", "Enter");
    assert.equal(restored.length, 0, "keydown (even repeated) must not activate the restore");
    assert.ok(keydown.defaultPrevented, "the native keydown click must be suppressed");

    dispatchKeyOn(firstButton, "keyup", "Enter");
    assert.deepEqual(restored, ["newer"], "release restores the focused snapshot exactly once");
  } finally {
    cleanup();
  }
});

test("Space is left to the browser's native click path, not the Enter interceptor", async () => {
  await installDom();
  const { restored, firstButton, cleanup } = renderRestoreList();

  try {
    // In a real browser Space activates a button on keyup via a synthesized
    // click; the first test above and the WebKit verification pass cover that
    // real restore. happy-dom does not synthesize that click, so here we assert
    // only that our keyup interceptor ignores Space and leaves it to native.
    dispatchKeyOn(firstButton, "keydown", " ");
    dispatchKeyOn(firstButton, "keyup", " ");
    assert.equal(restored.length, 0, "the Enter interceptor must not fire for Space");
  } finally {
    cleanup();
  }
});

test("a keyup after a restore is already in flight cannot start a second restore", async () => {
  await installDom();
  // With a restore in flight every row is disabled; the keyup guard is the
  // belt-and-suspenders that a stray release cannot start a second restore.
  const { restored, firstButton, cleanup } = renderRestoreList("older");

  try {
    dispatchKeyOn(firstButton, "keyup", "Enter");
    assert.equal(restored.length, 0, "no restore may fire while one is in flight");
  } finally {
    cleanup();
  }
});

test("snapshot restore dialog blocks Escape and backdrop dismissal while restoring", async () => {
  await installDom();
  let dismissCount = 0;
  const rendered = renderDialog({
    visible: true,
    title: "Restore snapshot",
    loading: false,
    error: null,
    emptyMessage: "No snapshots yet.",
    restoringId: "current",
    choices: [{ id: "current", title: "Today", detail: "20 bytes" }],
    onRestore() {},
    onDismiss() { dismissCount += 1; },
  });

  try {
    const escapeEvent = dispatchKey("Escape");
    const backdrop = rendered.host.firstElementChild;
    assert.ok(backdrop);
    flushSync(() => pointerClick(backdrop));

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(dismissCount, 0);
    const tab = dispatchKey("Tab");
    assert.equal(tab.defaultPrevented, true);
    assert.equal(document.activeElement.getAttribute("role"), "dialog");
  } finally {
    rendered.cleanup();
  }
});
