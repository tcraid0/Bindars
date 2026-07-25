const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const {
  ConfirmDialog,
} = require("../.tmp/workspace-tests/src/components/ConfirmDialog.js");

function noop() {}

function renderDialog(props = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  flushSync(() => {
    root.render(
      React.createElement(ConfirmDialog, {
        visible: true,
        title: "Unsaved changes",
        message: "You have unsaved changes.",
        confirmLabel: "Save",
        cancelLabel: "Cancel",
        onConfirm: noop,
        onCancel: noop,
        onDismiss: noop,
        ...props,
      }),
    );
  });

  return {
    host,
    root,
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

function dispatchKey(key, options = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  window.dispatchEvent(event);
  return event;
}

test("ConfirmDialog uses instance-scoped accessible labels", async () => {
  await installDom();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    flushSync(() => {
      root.render(
        React.createElement(React.Fragment, null,
          React.createElement(ConfirmDialog, {
            visible: true,
            title: "First",
            message: "First message",
            confirmLabel: "Save",
            cancelLabel: "Cancel",
            onConfirm: noop,
            onCancel: noop,
            onDismiss: noop,
          }),
          React.createElement(ConfirmDialog, {
            visible: true,
            title: "Second",
            message: "Second message",
            confirmLabel: "Reload",
            cancelLabel: "Cancel",
            onConfirm: noop,
            onCancel: noop,
            onDismiss: noop,
          }),
        ),
      );
    });

    const dialogs = Array.from(host.querySelectorAll('[role="dialog"]'));
    assert.equal(dialogs.length, 2);

    const titleIds = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
    const messageIds = dialogs.map((dialog) => dialog.getAttribute("aria-describedby"));
    assert.equal(new Set(titleIds).size, 2);
    assert.equal(new Set(messageIds).size, 2);

    for (const dialog of dialogs) {
      const titleId = dialog.getAttribute("aria-labelledby");
      const messageId = dialog.getAttribute("aria-describedby");
      assert.ok(titleId);
      assert.ok(messageId);
      const title = document.getElementById(titleId);
      const message = document.getElementById(messageId);
      assert.ok(title);
      assert.ok(message);
      assert.equal(dialog.contains(title), true);
      assert.equal(dialog.contains(message), true);
    }
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

test("ConfirmDialog wraps Tab from last focusable control to first", async () => {
  await installDom();
  const rendered = renderDialog({
    secondaryLabel: "Overwrite",
    onSecondary: noop,
  });

  try {
    const buttons = Array.from(rendered.host.querySelectorAll("button"));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();

    const event = dispatchKey("Tab");

    assert.equal(event.defaultPrevented, true);
    assert.ok(document.activeElement === first);
  } finally {
    rendered.cleanup();
  }
});

test("ConfirmDialog wraps Shift+Tab from first focusable control to last", async () => {
  await installDom();
  const rendered = renderDialog({
    secondaryLabel: "Overwrite",
    onSecondary: noop,
  });

  try {
    const buttons = Array.from(rendered.host.querySelectorAll("button"));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    first.focus();

    const event = dispatchKey("Tab", { shiftKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.ok(document.activeElement === last);
  } finally {
    rendered.cleanup();
  }
});

test("ConfirmDialog focuses the confirm button by default", async () => {
  await installDom();
  const rendered = renderDialog();

  try {
    assert.equal(document.activeElement?.textContent, "Save");
  } finally {
    rendered.cleanup();
  }
});

test("ConfirmDialog can initially focus the cancel button", async () => {
  await installDom();
  const rendered = renderDialog({
    initialFocus: "cancel",
    confirmLabel: "Reload",
    secondaryLabel: "Overwrite",
    onSecondary: noop,
    cancelLabel: "Cancel",
  });

  try {
    assert.equal(document.activeElement?.textContent, "Cancel");
  } finally {
    rendered.cleanup();
  }
});

test("ConfirmDialog calls onDismiss when Escape is pressed", async () => {
  await installDom();
  let dismissCount = 0;
  const rendered = renderDialog({
    onDismiss() {
      dismissCount += 1;
    },
  });

  try {
    const event = dispatchKey("Escape");

    assert.equal(event.defaultPrevented, true);
    assert.equal(dismissCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("ConfirmDialog calls onDismiss when the backdrop is clicked", async () => {
  await installDom();
  let dismissCount = 0;
  const rendered = renderDialog({
    onDismiss() {
      dismissCount += 1;
    },
  });

  try {
    const backdrop = rendered.host.firstElementChild;
    assert.ok(backdrop);
    flushSync(() => backdrop.click());

    assert.equal(dismissCount, 1);
  } finally {
    rendered.cleanup();
  }
});

test("ConfirmDialog restores focus when it closes", async () => {
  await installDom();
  const trigger = document.createElement("button");
  trigger.textContent = "Editor surface";
  document.body.appendChild(trigger);
  trigger.focus();

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const props = {
    title: "Unsaved changes",
    message: "You have unsaved changes.",
    confirmLabel: "Save",
    cancelLabel: "Cancel",
    onConfirm: noop,
    onCancel: noop,
    onDismiss: noop,
  };

  try {
    flushSync(() => root.render(React.createElement(ConfirmDialog, { ...props, visible: true })));
    assert.ok(document.activeElement !== trigger);

    flushSync(() => root.render(React.createElement(ConfirmDialog, { ...props, visible: false })));
    assert.ok(document.activeElement === trigger);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    trigger.remove();
  }
});
