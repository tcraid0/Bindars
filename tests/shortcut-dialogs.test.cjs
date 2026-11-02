const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("./_helpers/react.cjs");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");
const { dispatchPointer, pointerClick } = require("./_helpers/pointer.cjs");
const {
  ShortcutOverlay,
} = require("../.tmp/workspace-tests/src/components/ShortcutOverlay.js");
const {
  CommandPalette,
} = require("../.tmp/workspace-tests/src/components/CommandPalette.js");

const hits = [
  {
    path: "/workspace/first.md",
    relPath: "first.md",
    kind: "title",
    snippet: "First file",
  },
  {
    path: "/workspace/second.md",
    relPath: "second.md",
    kind: "heading",
    snippet: "Second heading",
    headingId: "second",
  },
];

const dialogs = [
  {
    Component: ShortcutOverlay,
    title: "Keyboard Shortcuts",
    initialSelector: 'button[aria-label="Close"]',
    props: {},
  },
  {
    Component: CommandPalette,
    title: "Search documents",
    initialSelector: "input",
    props: {
      query: "existing query",
      results: hits,
      selectedIndex: 0,
      status: "ready",
      onQueryChange() {},
      onOpenHit() {},
      onHoverIndex() {},
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
  let props = {
    ...spec.props,
    visible: false,
    onClose() {
      dismissCount += 1;
      render({ visible: false });
    },
    ...overrides,
  };

  function render(next = {}) {
    props = { ...props, ...next };
    flushSync(() =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(spec.Component, props),
        ),
      ),
    );
  }
  trigger.onclick = () => render({ visible: true });
  render();
  return {
    get host() {
      return document.getElementById("dialog-root") ?? host;
    },
    trigger,
    render,
    get dismissCount() {
      return dismissCount;
    },
    open() {
      trigger.focus();
      flushSync(() => trigger.click());
    },
    unmount() {
      flushSync(() => root.unmount());
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
      trigger.remove();
    },
  };
}

function pressKey(key, options = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
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
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog);
      assert.equal(dialog.getAttribute("aria-modal"), "true");
      const heading = document.getElementById(
        dialog.getAttribute("aria-labelledby"),
      );
      assert.ok(heading && dialog.contains(heading));
      assert.equal(heading.tagName, "H2");
      assert.equal(heading.textContent, spec.title);
      assert.ok(
        document.activeElement === dialog.querySelector(spec.initialSelector),
      );
    } finally {
      view.cleanup();
    }
  });

  test(`${spec.title}: wraps Tab and Shift+Tab inside the dialog`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      const controls = view.host.querySelectorAll("button, input, summary");
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
    } finally {
      view.cleanup();
    }
  });

  for (const dismissal of ["Escape", "backdrop"]) {
    test(`${spec.title}: ${dismissal} closes once and restores the opener on every opening`, async () => {
      await installDom();
      const view = renderDialog(spec);
      let leakedEscapes = 0;
      const onKey = (event) => {
        if (event.key === "Escape") leakedEscapes += 1;
      };
      window.addEventListener("keydown", onKey);
      try {
        for (let opening = 1; opening <= 2; opening += 1) {
          view.open();
          if (dismissal === "Escape") {
            assert.equal(pressKey("Escape").defaultPrevented, true);
          } else {
            flushSync(() => pointerClick(view.host.firstElementChild));
          }
          assert.equal(view.dismissCount, opening);
          assert.equal(view.host.childElementCount, 0);
          assert.ok(document.activeElement === view.trigger);
        }
        assert.equal(
          leakedEscapes,
          0,
          "Escape must not reach App's bubble listener while open",
        );
        assert.equal(pressKey("Escape").defaultPrevented, false);
        assert.equal(
          view.dismissCount,
          2,
          "the hidden dialog must not retain its key listener",
        );
      } finally {
        window.removeEventListener("keydown", onKey);
        view.cleanup();
      }
    });
  }

  test(`${spec.title}: clicks inside and unrelated renders do not dismiss or reset focus`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      flushSync(() => view.host.querySelector("h2").click());
      const controls = view.host.querySelectorAll("button, input, summary");
      const last = controls[controls.length - 1];
      last.focus();
      view.render({
        onClose() {
          throw new Error("Unexpected dismissal");
        },
      });
      assert.equal(view.dismissCount, 0);
      assert.ok(document.activeElement === last);
    } finally {
      view.cleanup();
    }
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
    } finally {
      if (view.host.isConnected) view.cleanup();
    }
  });
}

test("Keyboard Shortcuts: the close control dismisses and restores focus", async () => {
  await installDom();
  const view = renderDialog(dialogs[0]);
  try {
    view.open();
    flushSync(() =>
      view.host.querySelector('button[aria-label="Close"]').click(),
    );
    assert.equal(view.dismissCount, 1);
    assert.ok(document.activeElement === view.trigger);
  } finally {
    view.cleanup();
  }
});

test("Search documents: selects the query only on opening and preserves result activation", async () => {
  await installDom();
  const opened = [];
  const hovered = [];
  const queries = [];
  const view = renderDialog(dialogs[1], {
    onOpenHit(hit) {
      opened.push(hit);
    },
    onHoverIndex(index) {
      hovered.push(index);
    },
    onQueryChange(query) {
      queries.push(query);
    },
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
    assert.match(view.host.textContent, /Checking content/);
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setValue.call(input, "new query");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    assert.deepEqual(queries, ["new query"]);
    const second = view.host.querySelectorAll('[role="option"]')[1];
    flushSync(() =>
      second.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      ),
    );
    flushSync(() => second.click());
    assert.deepEqual(hovered, [1]);
    assert.deepEqual(opened, [hits[1]]);
    assert.equal(view.dismissCount, 0);
    pressKey("Escape");
    view.open();
    const reopened = view.host.querySelector("input");
    assert.equal(reopened.selectionStart, 0);
    assert.equal(reopened.selectionEnd, reopened.value.length);
  } finally {
    view.cleanup();
  }
});

test("Search documents: contains focus with no results and after results change", async () => {
  await installDom();
  const view = renderDialog(dialogs[1], { results: [], query: "" });
  try {
    view.open();
    const input = view.host.querySelector("input");
    assert.match(view.host.textContent, /Open a document, create a draft/);
    assert.equal(
      pressKey("Tab").defaultPrevented,
      false,
      "coverage is keyboard reachable after the input",
    );
    view.host.querySelector("button").focus();
    assert.equal(pressKey("Tab", { shiftKey: true }).defaultPrevented, true);
    assert.ok(document.activeElement === view.host.querySelector("summary"));
    input.focus();
    view.render({ results: hits });
    assert.ok(document.activeElement === input);
    assert.equal(
      input.getAttribute("aria-activedescendant"),
      "document-result-0",
    );
    view.render({ results: [], query: "missing" });
    assert.match(view.host.textContent, /No matching documents/);
    assert.equal(input.getAttribute("aria-activedescendant"), null);
    assert.ok(document.activeElement === input);
  } finally {
    view.cleanup();
  }
});

for (const spec of dialogs) {
  test(`${spec.title}: recovers Tab focus after a non-focusable area is clicked`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      const controls = view.host.querySelectorAll("button, input, summary");
      for (const shiftKey of [false, true]) {
        // happy-dom does not blur on a text click; reproduce the browser's resulting state.
        document.activeElement.blur();
        assert.equal(document.activeElement.tagName, "BODY");
        assert.equal(pressKey("Tab", { shiftKey }).defaultPrevented, true);
        assert.ok(
          document.activeElement ===
            controls[shiftKey ? controls.length - 1 : 0],
        );
      }
    } finally {
      view.cleanup();
    }
  });

  test(`${spec.title}: backdrop ignores drags, cancelled gestures, and stale clicks`, async () => {
    await installDom();
    const view = renderDialog(spec);
    try {
      view.open();
      const backdrop = view.host.firstElementChild;
      const inside = view.host.querySelector(spec.initialSelector);
      flushSync(() => {
        dispatchPointer(inside, "pointerdown");
        dispatchPointer(backdrop, "pointerup");
        backdrop.click();
      });
      assert.equal(
        view.dismissCount,
        0,
        "a drag out of the card is not backdrop activation",
      );
      flushSync(() => {
        dispatchPointer(backdrop, "pointerdown");
        dispatchPointer(inside, "pointerup");
        backdrop.click();
        dispatchPointer(backdrop, "pointerdown");
        dispatchPointer(backdrop, "pointercancel");
        backdrop.click();
      });
      assert.equal(view.dismissCount, 0);
      flushSync(() => pointerClick(backdrop));
      assert.equal(view.dismissCount, 1);
      view.open();
      flushSync(() => view.host.firstElementChild.click());
      assert.equal(
        view.dismissCount,
        1,
        "reopening cannot reuse the previous gesture",
      );
    } finally {
      view.cleanup();
    }
  });
}

test("Search documents: result updates retain combobox focus", async () => {
  await installDom();
  const view = renderDialog(dialogs[1]);
  try {
    view.open();
    const input = view.host.querySelector("input");
    view.render({ results: [] });
    assert.ok(document.activeElement === input);
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
  } finally {
    view.cleanup();
  }
});

test("stacked dialogs keep keyboard ownership across callback renders and restore each opener", async () => {
  await installDom();
  const host = document.createElement("div");
  const opener = document.createElement("button");
  document.body.append(opener, host);
  opener.focus();
  const root = createRoot(host);
  let shortcuts = true;
  let palette = false;
  const dismissals = [];
  function render() {
    flushSync(() =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(ShortcutOverlay, {
            visible: shortcuts,
            onClose() {
              dismissals.push("shortcuts");
              shortcuts = false;
              render();
            },
          }),
          React.createElement(CommandPalette, {
            ...dialogs[1].props,
            visible: palette,
            onClose() {
              dismissals.push("palette");
              palette = false;
              render();
            },
          }),
        ),
      ),
    );
  }
  try {
    render();
    const close = document.querySelector('button[aria-label="Close"]');
    palette = true;
    render();
    render(); // New callbacks must not promote the underlying dialog.
    const input = document.querySelector("input");
    for (const shiftKey of [false, true]) {
      document.activeElement.blur();
      assert.equal(pressKey("Tab", { shiftKey }).defaultPrevented, true);
      const expected = shiftKey
        ? Array.from(
            input.closest("[role=dialog]").querySelectorAll("summary"),
          ).at(-1)
        : input.closest("[role=dialog]").querySelector("button");
      assert.ok(document.activeElement === expected);
    }
    assert.equal(pressKey("Escape").defaultPrevented, true);
    assert.deepEqual(dismissals, ["palette"]);
    assert.ok(document.activeElement === close);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    pressKey("Escape");
    assert.deepEqual(dismissals, ["palette", "shortcuts"]);
    assert.ok(document.activeElement === opener);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    opener.remove();
  }
});

test("closing a foreground dialog recovers focus inside the remaining dialog", async () => {
  await installDom();
  const host = document.createElement("div");
  const opener = document.createElement("button");
  document.body.append(opener, host);
  opener.focus();
  const root = createRoot(host);
  let palette = false;
  function render() {
    flushSync(() =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ShortcutOverlay, { visible: true, onClose() {} }),
          React.createElement(CommandPalette, {
            ...dialogs[1].props,
            visible: palette,
            onClose() {
              palette = false;
              render();
            },
          }),
        ),
      ),
    );
  }
  try {
    render();
    document.activeElement.blur();
    assert.equal(document.activeElement.tagName, "BODY");
    palette = true;
    render();
    assert.ok(document.activeElement === document.querySelector("input"));
    pressKey("Escape");
    const remainingDialog = document.querySelector('[role="dialog"]');
    assert.ok(remainingDialog);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(remainingDialog.contains(document.activeElement));
    assert.equal(document.activeElement.getAttribute("aria-label"), "Close");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    opener.remove();
  }
});

test("unmounting a covered dialog preserves the foreground dialog's opener chain", async () => {
  await installDom();
  const host = document.createElement("div");
  const opener = document.createElement("button");
  document.body.append(opener, host);
  opener.focus();
  const root = createRoot(host);
  function render(shortcuts, palette) {
    flushSync(() =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          shortcuts &&
            React.createElement(ShortcutOverlay, {
              visible: true,
              onClose() {},
            }),
          React.createElement(CommandPalette, {
            ...dialogs[1].props,
            visible: palette,
            onClose() {},
          }),
        ),
      ),
    );
  }
  try {
    render(true, false);
    render(true, true);
    const input = document.querySelector("input");
    render(false, true);
    assert.ok(document.activeElement === input);
    render(false, false);
    assert.ok(document.activeElement === opener);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    opener.remove();
  }
});

for (const spec of dialogs) {
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    test(`${spec.title}: IME ${Object.keys(composition)[0]} keeps Escape and Tab with composition`, async () => {
      await installDom();
      const view = renderDialog(spec);
      try {
        view.open();
        const controls = view.host.querySelectorAll("button, input, summary");
        const last = controls[controls.length - 1];
        last.focus();
        for (const key of ["Escape", "Tab"]) {
          const event = pressKey(key, composition);
          assert.equal(event.defaultPrevented, false);
          assert.equal(view.dismissCount, 0);
          assert.ok(document.querySelector('[role="dialog"]'));
          assert.ok(document.activeElement === last);
        }
        assert.equal(pressKey("Tab").defaultPrevented, true);
        assert.ok(document.activeElement === controls[0]);
        assert.equal(pressKey("Escape").defaultPrevented, true);
        assert.equal(view.dismissCount, 1);
      } finally {
        view.cleanup();
      }
    });
  }
}

test("Search explains the selected scope and exposes the selected document full path outside its option", async () => {
  await installDom();
  const view = renderDialog(dialogs[1], { folderName: "Project notes" });
  try {
    view.open();
    const scope = () =>
      view.host.querySelector("#document-search-scope").textContent;
    assert.match(scope(), /recent documents, drafts and Project notes/);
    view.render({ folderOnly: true });
    assert.match(scope(), /Searching only Project notes/);
    assert.doesNotMatch(scope(), /recent documents|drafts/);
    const details = view.host.querySelector("details.document-location");
    assert.ok(details);
    assert.equal(details.open, false);
    assert.equal(details.querySelector("p").textContent, "/workspace/first.md");
    assert.ok(!details.closest('[role="option"]'));
    view.render({ folderOnly: false, folderName: undefined });
    assert.match(scope(), /Searching recent documents, drafts\./);
    assert.doesNotMatch(scope(), /Project notes/);
  } finally {
    view.cleanup();
  }
});
