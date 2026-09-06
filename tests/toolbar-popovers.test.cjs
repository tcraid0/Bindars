const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { installDom } = require("./_helpers/dom.cjs");
const { dispatchPointer, pointerClick } = require("./_helpers/pointer.cjs");
const { renderComponent, buttonWithText, click, focus, pressKey } = require("./_helpers/component-view.cjs");
const { Header } = require("../.tmp/workspace-tests/src/components/Header.js");
const { ReaderControls } = require("../.tmp/workspace-tests/src/components/ReaderControls.js");
const { ConfirmDialog } = require("../.tmp/workspace-tests/src/components/ConfirmDialog.js");
const { useReaderSettings } = require("../.tmp/workspace-tests/src/hooks/useReaderSettings.js");
const store = require("../.tmp/workspace-tests/src/lib/store.js");
test.mock.method(store, "storeSet", async () => true);
const settle = () => new Promise((resolve) => setImmediate(resolve));

const defaults = {
  fontSize: 17, contentWidth: 65, lineHeight: 1.7, fontFamily: "newsreader",
  paragraphSpacing: "comfortable", printLayout: "standard",
  sceneLensEnabled: false, reducedEffects: false, printWithTheme: false,
};

function Toolbar({ modal = false, onAction = () => {}, ...headerOverrides }) {
  const [readerOpen, setReaderOpen] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState(false);
  const { settings, updateSettings, resetSettings } = useReaderSettings();
  const [theme, setTheme] = React.useState("light");
  const triggerRef = React.useRef(null);
  const readerId = React.useId();
  const closeModal = () => setConfirmation(false);
  return React.createElement(React.Fragment, null,
    React.createElement(Header, {
      fileName: "example.md", filePath: null, fileType: "markdown", theme,
      progressTextRef: { current: null }, canPresent: false,
      readerControlsVisible: readerOpen, readerControlsTriggerRef: triggerRef,
      readerControlsId: readerId, onToggleReaderControls: () => setReaderOpen((open) => !open),
      onPrint: () => onAction("print", document.activeElement),
      onPresent: () => onAction("present", document.activeElement),
      ...headerOverrides,
    }),
    React.createElement(ReaderControls, {
      id: readerId, triggerRef, visible: readerOpen, settings, theme,
      onSetTheme: setTheme, onUpdate: updateSettings, onReset: resetSettings,
      onClose: () => setReaderOpen(false),
      onClearRecoveryHistory: () => { setReaderOpen(false); setConfirmation(true); },
      recoveryStorageStats: null, recoveryStorageStatsLoading: false, recoveryStorageStatsError: null,
    }),
    React.createElement(ConfirmDialog, {
      visible: modal || confirmation, title: "Confirmation", message: "Continue?",
      confirmLabel: "Confirm", cancelLabel: "Cancel", initialFocus: "cancel",
      onConfirm: closeModal, onCancel: closeModal, onDismiss: closeModal,
    }),
    React.createElement("button", null, "Outside"),
    React.createElement("div", { "data-outside": true }, "Outside text"),
  );
}

async function setup(props = {}) {
  await installDom();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  window.localStorage.setItem("bindars-settings", JSON.stringify(defaults));
  const view = renderComponent(Toolbar, props);
  return {
    ...view,
    cleanup() { view.cleanup(); globalThis.localStorage = previousLocalStorage; },
    trigger(kind) { return view.host.querySelector(`[aria-label="${kind === "reader" ? "Toggle reader settings" : "Export options"}"]`); },
    panel(kind) { return view.host.querySelector(kind === "reader" ? '[role="dialog"]:not([aria-modal])' : '[role="group"][aria-label="Export options"]'); },
    open(kind) { const trigger = this.trigger(kind); focus(trigger); click(trigger); return this.panel(kind); },
  };
}

for (const kind of ["reader", "export"]) {
  test(`${kind}: names and trigger relationship, repeated Escape, no leaked event`, async () => {
    const view = await setup();
    let leaked = 0;
    const listener = () => { leaked += 1; };
    window.addEventListener("keydown", listener);
    try {
      for (let i = 0; i < 3; i += 1) {
        const panel = view.open(kind);
        assert.ok(panel);
        assert.equal(view.trigger(kind).getAttribute("aria-expanded"), "true");
        assert.equal(view.trigger(kind).getAttribute("aria-controls"), panel.id);
        if (kind === "reader") {
          assert.equal(document.getElementById(panel.getAttribute("aria-labelledby")).textContent, "Reader Settings");
          assert.equal(document.activeElement.getAttribute("aria-label"), "Close reader settings");
        } else {
          assert.ok(document.activeElement === view.trigger(kind));
          assert.ok(panel.querySelector('[role="menuitem"]') === null);
          assert.equal(view.trigger(kind).hasAttribute("aria-haspopup"), false);
          focus(panel.querySelector("button"));
        }
        assert.equal(pressKey("Escape").defaultPrevented, true);
        assert.ok(view.panel(kind) === null);
        assert.ok(document.activeElement === view.trigger(kind));
        assert.equal(view.trigger(kind).getAttribute("aria-expanded"), "false");
      }
      assert.equal(leaked, 0);
      pressKey("Escape");
      assert.equal(leaked, 1, "closed popovers must release keyboard ownership");
    } finally { window.removeEventListener("keydown", listener); view.cleanup(); }
  });

  test(`${kind}: Tab is native, focus can leave, and leaving does not restore the trigger`, async () => {
    const view = await setup();
    try {
      const panel = view.open(kind);
      const buttons = [...panel.querySelectorAll("button")].filter((button) => !button.disabled && button.tabIndex >= 0);
      focus(buttons.at(-1));
      assert.equal(pressKey("Tab").defaultPrevented, false);
      const outside = buttonWithText(view.host, "Outside");
      // happy-dom does not implement native Tab traversal. Simulate its focus destination.
      focus(outside);
      assert.ok(view.panel(kind) === null);
      assert.ok(document.activeElement === outside);
      view.open(kind);
      focus(view.panel(kind).querySelector("button"));
      assert.equal(pressKey("Tab", { shiftKey: true }).defaultPrevented, false);
      focus(view.trigger(kind));
      assert.ok(view.panel(kind), "the trigger remains inside the disclosure boundary");
    } finally { view.cleanup(); }
  });

  test(`${kind}: deliberate outside gestures dismiss without stealing focus or swallowing activation`, async () => {
    const view = await setup();
    try {
      view.open(kind);
      const outside = buttonWithText(view.host, "Outside");
      let activated = 0;
      outside.onclick = () => { activated += 1; };
      flushSync(() => dispatchPointer(outside, "pointerdown"));
      focus(outside);
      assert.ok(view.panel(kind), "do not dismiss before the gesture completes");
      flushSync(() => { dispatchPointer(outside, "pointerup"); outside.click(); });
      assert.ok(view.panel(kind) === null);
      assert.ok(document.activeElement === outside);
      assert.equal(activated, 1);
      view.open(kind);
      focus(view.panel(kind).querySelector("button"));
      flushSync(() => pointerClick(view.host.querySelector("[data-outside]")));
      assert.ok(view.panel(kind) === null);
      assert.ok(document.activeElement === view.trigger(kind));
    } finally { view.cleanup(); }
  });

  test(`${kind}: ignores inside clicks, drags, cancelled gestures, right-clicks and composing Escape`, async () => {
    const view = await setup();
    try {
      const panel = view.open(kind);
      const outside = buttonWithText(view.host, "Outside");
      flushSync(() => pointerClick(panel));
      assert.ok(view.panel(kind));
      for (const [start, end] of [[panel, outside], [outside, panel]]) {
        flushSync(() => { dispatchPointer(start, "pointerdown"); dispatchPointer(end, "pointerup"); end.click(); });
        assert.ok(view.panel(kind));
      }
      flushSync(() => {
        dispatchPointer(outside, "pointerdown"); dispatchPointer(outside, "pointercancel");
        dispatchPointer(outside, "pointerup"); outside.click();
      });
      assert.ok(view.panel(kind));
      flushSync(() => {
        dispatchPointer(outside, "pointerdown", { button: 2 });
        dispatchPointer(outside, "pointerup", { button: 2 }); outside.click();
      });
      assert.ok(view.panel(kind));
      assert.equal(pressKey("Escape", { isComposing: true }).defaultPrevented, false);
      assert.equal(pressKey("Escape", { keyCode: 229 }).defaultPrevented, false);
      assert.ok(view.panel(kind));
      flushSync(() => {
        dispatchPointer(outside, "pointerdown", { pointerId: 1 });
        dispatchPointer(outside, "pointerup", { pointerId: 2 }); outside.click();
      });
      assert.ok(view.panel(kind));
      const focused = document.activeElement;
      view.render({ canPresent: true });
      assert.ok(view.panel(kind), "callback changes must not reset the opening lifecycle");
      assert.ok(document.activeElement === focused);
    } finally { view.cleanup(); }
  });

  test(`${kind}: a covering modal owns Escape and outside clicks and restores its popover opener`, async () => {
    const view = await setup();
    try {
      const panel = view.open(kind);
      const opener = panel.querySelector("button");
      focus(opener);
      view.render({ modal: true });
      assert.ok(view.panel(kind));
      const modal = view.host.querySelector('[aria-modal="true"]');
      flushSync(() => pointerClick(modal));
      assert.ok(view.panel(kind));
      pressKey("Escape");
      assert.ok(view.panel(kind), "one Escape must not dismiss the underlying surface");
      view.render({ modal: false });
      assert.ok(document.activeElement === opener);
      pressKey("Escape");
      assert.ok(view.panel(kind) === null);
    } finally { view.cleanup(); }
  });
}

test("reader: Close and recovery confirmation restore a connected toolbar opener", async () => {
  const view = await setup();
  try {
    view.open("reader");
    click(view.host.querySelector('[aria-label="Close reader settings"]'));
    assert.ok(document.activeElement === view.trigger("reader"));
    view.open("reader");
    const clear = buttonWithText(view.host, "Clear recovery history");
    focus(clear);
    click(clear);
    assert.ok(view.panel("reader") === null);
    assert.ok(view.host.querySelector('[aria-modal="true"]'));
    assert.equal(document.activeElement.textContent, "Cancel");
    pressKey("Escape");
    assert.ok(view.host.querySelector('[aria-modal="true"]') === null);
    assert.ok(document.activeElement === view.trigger("reader"));
  } finally { view.cleanup(); }
});

test("toolbar surfaces replace each other, and rapid trigger toggles leave no stale listeners", async () => {
  const view = await setup();
  try {
    view.open("reader");
    view.open("export");
    assert.ok(view.panel("reader") === null);
    view.open("reader");
    assert.ok(view.panel("export") === null);
    click(view.trigger("reader"));
    for (let i = 0; i < 4; i += 1) click(view.trigger("export"));
    flushSync(() => { view.trigger("export").click(); view.trigger("export").click(); });
    assert.ok(view.panel("export") === null);
    view.open("export");
    pressKey("Escape");
    assert.ok(view.panel("export") === null);
  } finally { view.cleanup(); }
});

test("export: pointer activation establishes keyboard ownership even when the browser does not focus buttons", async () => {
  const view = await setup();
  try {
    focus(buttonWithText(view.host, "Outside"));
    // Unlike open(), this deliberately does not focus the trigger before activation.
    flushSync(() => pointerClick(view.trigger("export")));
    assert.ok(document.activeElement === view.trigger("export"));
    assert.ok(view.panel("export"));
    pressKey("Escape");
    assert.ok(view.panel("export") === null);
    assert.ok(document.activeElement === view.trigger("export"));
  } finally { view.cleanup(); }
});

test("export: cancelled HTML save returns focus before opening the native dialog", async (t) => {
  const view = await setup();
  const body = document.createElement("div");
  body.className = "markdown-body";
  document.body.append(body);
  let calls = 0;
  t.mock.method(require("@tauri-apps/plugin-dialog"), "save", async () => {
    calls += 1;
    assert.ok(document.activeElement === view.trigger("export"));
    return null;
  });
  try {
    const html = buttonWithText(view.open("export"), "Export as HTML");
    focus(html);
    click(html);
    await settle();
    assert.equal(calls, 1);
    assert.ok(view.panel("export") === null);
    assert.ok(document.activeElement === view.trigger("export"));
  } finally { body.remove(); view.cleanup(); }
});

test("reader: external close and unmount restore the opener and remove listeners", async () => {
  await installDom();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const triggerRef = { current: trigger };
  let closed = 0;
  focus(trigger);
  const view = renderComponent(ReaderControls, {
    id: "reader", triggerRef, visible: true, settings: defaults, theme: "light", onClose: () => { closed += 1; },
  });
  try {
    assert.equal(document.activeElement.getAttribute("aria-label"), "Close reader settings");
    view.render({ visible: false });
    assert.ok(document.activeElement === trigger);
    view.render({ visible: true });
    view.cleanup();
    assert.ok(document.activeElement === trigger);
    assert.equal(pressKey("Escape").defaultPrevented, false);
    assert.equal(closed, 0);
  } finally { view.cleanup(); trigger.remove(); }
});

test("export: native disabled actions, action handoff, and disappearing trigger", async () => {
  const actions = [];
  const view = await setup({ onAction: (...args) => actions.push(args) });
  try {
    const panel = view.open("export");
    const present = buttonWithText(panel, "Present as Slides");
    assert.equal(present.disabled, true);
    click(present);
    assert.deepEqual(actions, []);
    assert.ok(view.panel("export"));
    view.render({ canPresent: true });
    focus(present);
    click(present);
    assert.ok(view.panel("export") === null);
    assert.deepEqual(actions.map(([action]) => action), ["present"]);
    assert.ok(actions[0][1] === view.trigger("export"));
    view.open("export");
    const print = buttonWithText(view.panel("export"), "Print to PDF");
    focus(print);
    click(print);
    assert.equal(actions[1][0], "print");
    assert.ok(actions[1][1] === view.trigger("export"));
    view.open("export");
    view.render({ isEditing: true });
    assert.ok(view.panel("export") === null);
    view.render({ isEditing: false });
    assert.ok(view.panel("export") === null, "returning to read mode must not reopen stale UI");
    view.open("export");
    view.render({ fileName: null });
    view.render({ fileName: "other.md", fileType: "fountain" });
    assert.ok(view.panel("export") === null);
    assert.equal(buttonWithText(view.open("export"), "Print to PDF").disabled, false);
    assert.equal([...view.panel("export").querySelectorAll("button")].some((b) => b.textContent.includes("Present")), false);
  } finally { view.cleanup(); }
});

test("reader: values announce only real changes, reset coalesces, and selected groups expose state", async () => {
  const view = await setup();
  try {
    const panel = view.open("reader");
    const status = panel.querySelector('[role="status"]');
    assert.equal(status.textContent, "");
    assert.equal(status.getAttribute("aria-atomic"), "true");
    for (const [label, selected] of [["Font", "Newsreader"], ["Paragraph spacing", "Comfortable"], ["Print layout", "Standard"]]) {
      const group = panel.querySelector(`[role="group"][aria-label="${label}"]`);
      assert.equal(group.querySelectorAll('[aria-pressed="true"]').length, 1);
      assert.equal(group.querySelector('[aria-pressed="true"]').textContent.trim(), selected);
      click(group.querySelectorAll("button")[1]);
      assert.equal(group.querySelectorAll('[aria-pressed="true"]').length, 1);
      assert.equal(status.textContent, "");
    }
    for (const [label, spoken] of [["font size", "Font size 18 pixels"], ["width", "Width 70 characters"], ["line height", "Line height 1.8"]]) {
      const increase = panel.querySelector(`[aria-label="Increase ${label}"]`);
      focus(increase);
      // Announcements update from an effect after the settings render. A single
      // event-loop turn can finish before React commits that follow-up update.
      await React.act(async () => { click(increase); });
      assert.equal(status.textContent, spoken);
      assert.ok(document.activeElement === increase);
    }
    const group = panel.querySelector('[role="group"][aria-label="Font size"]');
    assert.equal(document.getElementById(group.getAttribute("aria-describedby")).textContent, "18px");
    await React.act(async () => { click(buttonWithText(panel, "Reset to defaults")); });
    assert.equal(status.textContent, "Font size 17 pixels. Width 65 characters. Line height 1.7");
    const increase = panel.querySelector('[aria-label="Increase font size"]');
    await React.act(async () => {
      for (let i = 0; i < 10; i += 1) click(increase);
    });
    assert.equal(status.textContent, "Font size 24 pixels");
    const lastText = status.firstChild;
    await React.act(async () => { click(increase); });
    assert.ok(status.firstChild === lastText, "clamped no-op must not mutate the live region");
    pressKey("Escape");
    assert.equal(view.open("reader").querySelector('[role="status"]').textContent, "");
  } finally { view.cleanup(); }
});
