const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");
const { ShortcutOverlay } = require("../.tmp/workspace-tests/src/components/ShortcutOverlay.js");
const { CommandPalette } = require("../.tmp/workspace-tests/src/components/CommandPalette.js");

const hits = [
  { path: "/workspace/first.md", relPath: "first.md", kind: "title", snippet: "First file" },
  { path: "/workspace/second.md", relPath: "second.md", kind: "heading", snippet: "Second heading", headingId: "second" },
];

const dialogs = [
  { Component: ShortcutOverlay, title: "Keyboard Shortcuts", initialSelector: 'button[aria-label="Close"]', props: {} },
  {
    Component: CommandPalette,
    title: "Quick switcher",
    initialSelector: "input",
    props: {
      query: "existing query", results: hits, selectedIndex: 0, status: "ready",
      onQueryChange() {}, onOpenHit() {}, onHoverIndex() {},
    },
  },
];

function renderDialog(spec, overrides = {}) {
  const host = document.createElement("div");
  const trigger = document.createElement("button");
  trigger.textContent = `Open ${spec.title}`;
  document.body.append(trigger, host);
  const root = createRoot(host);
  let dismissCount = 0;
  let props = { ...spec.props, visible: false, onClose() {
    dismissCount += 1;
    render({ visible: false });
  }, ...overrides };

  function render(next = {}) {
    props = { ...props, ...next };
    flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(spec.Component, props))));
  }
  trigger.onclick = () => render({ visible: true });
  render();
  return {
    host, trigger, render,
    get dismissCount() { return dismissCount; },
    open() { trigger.focus(); flushSync(() => trigger.click()); },
    unmount() { flushSync(() => root.unmount()); },
    cleanup() { flushSync(() => root.unmount()); host.remove(); trigger.remove(); },
  };
}

function pressKey(key, options = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  flushSync(() => document.activeElement.dispatchEvent(event));
  return event;
}

for (const spec of dialogs) {
  test(`${spec.title}: opens with a visible accessible name and initial focus`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      assert.equal(view.host.childElementCount, 0);
      view.open();
      const dialog = view.host.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.equal(dialog.getAttribute("aria-modal"), "true");
      const heading = document.getElementById(dialog.getAttribute("aria-labelledby"));
      assert.ok(heading && dialog.contains(heading));
      assert.equal(heading.tagName, "H2");
      assert.equal(heading.textContent, spec.title);
      assert.ok(document.activeElement === dialog.querySelector(spec.initialSelector));
    } finally { view.cleanup(); }
  });

  test(`${spec.title}: wraps Tab and Shift+Tab inside the dialog`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      const controls = view.host.querySelectorAll("button, input");
      const first = controls[0];
      const last = controls[controls.length - 1];
      last.focus();
      assert.equal(pressKey("Tab").defaultPrevented, true);
      assert.ok(document.activeElement === first);
      assert.equal(pressKey("Tab", { shiftKey: true }).defaultPrevented, true);
      assert.ok(document.activeElement === last);
      if (first !== last) {
        first.focus();
        // happy-dom has no native Tab traversal: only the boundaries are simulated.
        assert.equal(pressKey("Tab").defaultPrevented, false);
        assert.ok(document.activeElement === first);
      }
    } finally { view.cleanup(); }
  });

  for (const dismissal of ["Escape", "backdrop"]) {
    test(`${spec.title}: ${dismissal} closes once and restores the opener on every opening`, async () => {
      await installDom();
      const view = renderDialog(spec);
      let leakedEscapes = 0;
      const onKey = (event) => { if (event.key === "Escape") leakedEscapes += 1; };
      window.addEventListener("keydown", onKey);
      try {
        for (let opening = 1; opening <= 2; opening += 1) {
          view.open();
          if (dismissal === "Escape") {
            assert.equal(pressKey("Escape").defaultPrevented, true);
          } else {
            flushSync(() => view.host.firstElementChild.click());
          }
          assert.equal(view.dismissCount, opening);
          assert.equal(view.host.childElementCount, 0);
          assert.ok(document.activeElement === view.trigger);
        }
        assert.equal(leakedEscapes, 0, "Escape must not reach App's bubble listener while open");
        assert.equal(pressKey("Escape").defaultPrevented, false);
        assert.equal(view.dismissCount, 2, "the hidden dialog must not retain its key listener");
      } finally { window.removeEventListener("keydown", onKey); view.cleanup(); }
    });
  }

  test(`${spec.title}: clicks inside and unrelated renders do not dismiss or reset focus`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      flushSync(() => view.host.querySelector("h2").click());
      const controls = view.host.querySelectorAll("button, input");
      const last = controls[controls.length - 1];
      last.focus();
      view.render({ onClose() { throw new Error("Unexpected dismissal"); } });
      assert.equal(view.dismissCount, 0);
      assert.ok(document.activeElement === last);
    } finally { view.cleanup(); }
  });

  test(`${spec.title}: unmount restores focus and removes the keyboard listener`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      view.unmount();
      assert.ok(document.activeElement === view.trigger);
      assert.equal(pressKey("Tab").defaultPrevented, false);
      assert.equal(pressKey("Escape").defaultPrevented, false);
      assert.equal(view.dismissCount, 0);
    } finally { if (view.host.isConnected) view.cleanup(); }
  });
}

test("Keyboard Shortcuts: the close control dismisses and restores focus", async () => {
  await installDom();
  const view = renderDialog(dialogs[0]);
  try {
    view.open();
    flushSync(() => view.host.querySelector('button[aria-label="Close"]').click());
    assert.equal(view.dismissCount, 1);
    assert.ok(document.activeElement === view.trigger);
  } finally { view.cleanup(); }
});

test("Quick switcher: selects the query only on opening and preserves result activation", async () => {
  await installDom();
  const opened = [];
  const hovered = [];
  const queries = [];
  const view = renderDialog(dialogs[1], {
    onOpenHit(hit) { opened.push(hit); },
    onHoverIndex(index) { hovered.push(index); },
    onQueryChange(query) { queries.push(query); },
  });
  try {
    view.open();
    const input = view.host.querySelector("input");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, input.value.length);
    input.setSelectionRange(2, 2);
    view.render({ status: "indexing" });
    assert.equal(input.selectionStart, 2);
    assert.equal(input.selectionEnd, 2);
    assert.match(view.host.textContent, /Indexing in progress/);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setValue.call(input, "new query");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    assert.deepEqual(queries, ["new query"]);
    const second = view.host.querySelectorAll("li button")[1];
    flushSync(() => second.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })));
    flushSync(() => second.click());
    assert.deepEqual(hovered, [1]);
    assert.deepEqual(opened, [hits[1]]);
    assert.equal(view.dismissCount, 0);
    pressKey("Escape");
    view.open();
    const reopened = view.host.querySelector("input");
    assert.equal(reopened.selectionStart, 0);
    assert.equal(reopened.selectionEnd, reopened.value.length);
  } finally { view.cleanup(); }
});

test("Quick switcher: contains focus with no results and after results change", async () => {
  await installDom();
  const view = renderDialog(dialogs[1], { results: [], query: "" });
  try {
    view.open();
    const input = view.host.querySelector("input");
    assert.match(view.host.textContent, /Type to search your workspace/);
    for (const shiftKey of [false, true]) {
      assert.equal(pressKey("Tab", { shiftKey }).defaultPrevented, true);
      assert.ok(document.activeElement === input);
    }
    view.render({ results: hits });
    assert.ok(document.activeElement === input);
    assert.equal(pressKey("Tab", { shiftKey: true }).defaultPrevented, true);
    assert.ok(document.activeElement === view.host.querySelectorAll("li button")[1]);
    input.focus();
    view.render({ results: [], query: "missing" });
    assert.match(view.host.textContent, /No matches for this query/);
    assert.equal(pressKey("Tab").defaultPrevented, true);
    assert.ok(document.activeElement === input);
  } finally { view.cleanup(); }
});
