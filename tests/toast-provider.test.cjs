const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("./_helpers/react.cjs");
const { renderComponent, click } = require("./_helpers/component-view.cjs");
const { useToast } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
const { DialogFrame } = require("../.tmp/workspace-tests/src/components/DialogFrame.js");

function setup(t) {
  let toast;
  function Probe({ first = false, second = false }) {
    toast = useToast().toast;
    const focus = React.useRef(null);
    return [first, second].map((visible, key) => React.createElement(DialogFrame,
      { key, visible, title: `Dialog ${key}`, initialFocusRef: focus, onDismiss() {} }, "Dialog content"));
  }
  const view = renderComponent(Probe);
  t.after(() => view.cleanup());
  return { ...view, toast: (message, variant = "error") => flushSync(() => toast(message, variant)) };
}

test("errors persist, duplicate errors coalesce, and the oldest of six messages is evicted", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = setup(t);
  view.toast("Error"); view.toast("Error");
  view.toast("Success", "success"); view.toast("Info", "info");
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 1);
  flushSync(() => t.mock.timers.tick(3001));
  assert.equal(view.host.querySelector('[role="status"]').textContent, "Error");
  flushSync(() => t.mock.timers.tick(30000));
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 1);
  for (let i = 1; i <= 5; i++) view.toast(`Error ${i}`);
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 5);
  assert.equal(view.host.querySelector('[role="alert"]').textContent, "Error 1");
  click(view.host.querySelector('[aria-label="Dismiss notification"]'));
  assert.equal(view.host.querySelectorAll('[role="alert"]').length, 4);
});

test("dialog messages move underneath once, deduplicate there, and keep their existing timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = setup(t);
  view.toast("Main");
  const main = view.host.querySelector('[role="status"]');
  const original = main.firstElementChild;
  await act(async () => view.render({ first: true }));
  let dialog = document.querySelector('[role="dialog"]');
  assert.equal(main.style.visibility, "hidden");
  assert.equal(dialog.querySelector('[role="status"]').textContent, "");
  view.toast("Main"); view.toast("Dialog");
  assert.equal(dialog.querySelectorAll('[role="alert"]').length, 2);
  await act(async () => view.render({ second: true }));
  const top = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  assert.equal(top.querySelector('[role="status"]').textContent, "");
  view.toast("Nested"); view.toast("Dialog");
  await act(async () => view.render({ second: false }));
  assert.equal(dialog.querySelectorAll('[role="alert"]').length, 3);
  assert.equal(dialog.textContent.split("Nested").length, 2);
  view.toast("Timed", "info");
  flushSync(() => t.mock.timers.tick(2000));
  await act(async () => view.render({ first: false }));
  assert.equal(main.style.visibility, "");
  assert.ok(main.firstElementChild === original, "main entries never move into a dialog");
  assert.equal(main.querySelectorAll('[role="alert"]').length, 3);
  assert.equal(main.textContent, "MainDialogNestedTimed");
  flushSync(() => t.mock.timers.tick(1001));
  assert.equal(main.textContent, "MainDialogNested");
  // A completion after close belongs to the now-visible context.
  view.toast("Nested");
  assert.equal(main.querySelectorAll('[role="alert"]').length, 3);
});
