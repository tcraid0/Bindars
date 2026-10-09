const test = require("node:test");
const assert = require("node:assert/strict");
const { installDom } = require("./_helpers/dom.cjs");
const { renderComponent, buttonWithText, click } = require("./_helpers/component-view.cjs");

const { EmptyState } = require("../.tmp/workspace-tests/src/components/EmptyState.js");

const SAVE_HINT = /Choose where to save it/;
const recentFiles = [
  { path: "/Users/reader/Documents/draft.md", name: "draft.md", openedAt: Date.now(), lastHeadingId: null },
  { path: "/Users/reader/Downloads/plan.md", name: "plan.md", openedAt: Date.now(), lastHeadingId: null },
];

function renderEmptyState(props = {}) {
  return renderComponent(EmptyState, {
    onOpenFile() {},
    onTrySample() {},
    onShowShortcuts() {},
    recentFiles: [],
    onOpenRecent() {},
    onRemoveRecent() {},
    onRetry() {},
    onDismiss() {},
    openingPath: null,
    ...props,
  });
}

test("the welcome heading is the brand artwork, named Bindars", async () => {
  await installDom();
  const view = renderEmptyState();
  try {
    const heading = view.host.querySelector("h1");
    assert.equal(heading.textContent, "Bindars");
    const art = [...heading.querySelectorAll("svg")];
    assert.deepEqual(
      art.map((svg) => svg.querySelector("use").getAttribute("href")),
      ["#bindars-symbol", "#bindars-wordmark"],
    );
    assert.ok(art.every((svg) => svg.getAttribute("aria-hidden") === "true"));
    // src/main.tsx moves the startup mark onto this symbol, past the wordmark.
    assert.equal(view.host.querySelectorAll("[data-startup-mark-target]").length, 1);
    assert.ok(art[0].hasAttribute("data-startup-mark-target"));
    assert.ok(art[1].hasAttribute("data-startup-mark-passes"));
  } finally {
    view.cleanup();
  }
});

test("a first visit leads with Open File and explains the example's Save step", async () => {
  await installDom();
  const view = renderEmptyState();
  try {
    assert.match(buttonWithText(view.host, "Open File…").className, /\bbg-accent-fill\b/);
    assert.doesNotMatch(buttonWithText(view.host, "Try an Example…").className, /\bbg-accent-fill\b/);
    assert.match(view.host.textContent, SAVE_HINT);
    assert.doesNotMatch(view.host.textContent, /New File|Resume:|Ctrl\+N/);
  } finally {
    view.cleanup();
  }
});

test("recent files show their folders below Open File without an unverified Resume", async () => {
  await installDom();
  let sampleCount = 0;
  const view = renderEmptyState({ recentFiles, onTrySample() { sampleCount += 1; } });
  try {
    assert.match(buttonWithText(view.host, "Open File…").className, /\bbg-accent-fill\b/);
    const sample = buttonWithText(view.host, "Try an Example…");
    assert.doesNotMatch(sample.className, /\bbg-accent-fill\b/);
    assert.match(sample.className, /\bborder-border\b/);
    assert.match(view.host.textContent, /\/Users\/reader\/Documents/);
    assert.match(view.host.textContent, /\/Users\/reader\/Downloads/);
    assert.doesNotMatch(view.host.textContent, /Resume:/);
    click(sample);
    assert.equal(sampleCount, 1);
  } finally {
    view.cleanup();
  }
});

for (const [path, parent] of [
  ["/Users/Shared/Notes/notes.md", "/Users/Shared/Notes"],
  ["/Users/another/Notes/notes.md", "/Users/another/Notes"],
  ["/home/another/Notes/notes.md", "/home/another/Notes"],
  ["C:\\Users\\reader\\Notes\\notes.md", "C:\\Users\\reader\\Notes"],
  ["\\\\server\\share\\notes.md", "\\\\server\\share"],
  ["/notes.md", "/"],
  ["C:\\notes.md", "C:\\"],
]) {
  test("recent folder labels preserve the original path: " + path, async () => {
    await installDom();
    const view = renderEmptyState({ recentFiles: [{ path, name: "notes.md", openedAt: 1, lastHeadingId: null }] });
    try {
      const label = view.host.querySelector('[aria-label="Open notes.md"] span[title]');
      assert.equal(label.textContent, parent);
      assert.equal(label.title, path, "the tooltip includes the original complete file path");
    } finally { view.cleanup(); }
  });
}

for (const intervention of ["none", "focus another control", "become busy", "unmount"]) {
  test("welcome waits for splash removal: " + intervention, async () => {
    await installDom();
    const splash = document.createElement("div");
    splash.id = "loading-screen";
    document.body.append(splash);
    const view = renderEmptyState({ canFocus: true });
    const open = buttonWithText(view.host, "Open File…");
    let unmounted = false;
    try {
      assert.ok(document.activeElement !== open);
      if (intervention === "focus another control") {
        const shortcuts = buttonWithText(view.host, "Keyboard Shortcuts");
        shortcuts.focus();
        shortcuts.blur();
      } else if (intervention === "become busy") {
        view.render({ canFocus: false });
      } else if (intervention === "unmount") {
        view.cleanup();
        unmounted = true;
      }
      splash.remove();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(document.activeElement === open, intervention === "none");
      if (intervention === "become busy") {
        view.render({ canFocus: true });
        assert.ok(document.activeElement === open);
      }
    } finally {
      splash.remove();
      if (!unmounted) view.cleanup();
    }
  });
}

test("the entrance plays unless the startup screen is revealing the welcome screen", async () => {
  await installDom();
  const later = renderEmptyState();
  try {
    assert.equal(later.host.querySelector(".empty-state").classList.contains("empty-state-at-launch"), false);
  } finally {
    later.cleanup();
  }

  const screen = document.createElement("div");
  screen.id = "loading-screen";
  document.body.append(screen);
  const atLaunch = renderEmptyState();
  try {
    // Decided at mount: the screen leaving doesn't restart the entrance.
    screen.remove();
    atLaunch.render({ recentFiles });
    assert.equal(atLaunch.host.querySelector(".empty-state").classList.contains("empty-state-at-launch"), true);
  } finally {
    atLaunch.cleanup();
  }
});

test("recovery Retry, Dismiss and removal are explicit, and the next recent file receives focus", async () => {
  await installDom();
  let retries = 0;
  let dismissals = 0;
  const removed = [];
  const view = renderEmptyState({
    recentFiles,
    recovery: { path: recentFiles[0].path, error: { category: "not-found", message: "" }, retryDisabled: true },
    onRetry() { retries += 1; },
    onDismiss() { dismissals += 1; },
    onRemoveRecent(path) { removed.push(path); view.render({ recentFiles: recentFiles.filter(file => file.path !== path) }); },
  });
  try {
    const retry = view.host.querySelector('[aria-label="Retry opening draft.md"]');
    assert.equal(retry.disabled, true);
    assert.equal(view.host.querySelector('[aria-label="Open draft.md"]').disabled, true,
      "the unavailable entry offers one retry action");
    assert.ok(!view.host.querySelector('[aria-label="Retry draft.md"]'));
    view.render({ recovery: { path: recentFiles[0].path, error: { category: "not-found", message: "" }, retryDisabled: false } });
    click(retry);
    assert.equal(retries, 1);
    const dismiss = buttonWithText(view.host.querySelector(".empty-state-recovery-message"), "Dismiss");
    dismiss.focus();
    click(dismiss);
    assert.equal(dismissals, 1);
    assert.ok(document.activeElement === buttonWithText(view.host, "Open File…"), "Dismiss hands focus to the primary action");
    const remove = view.host.querySelector('[aria-label="Remove draft.md from recent files"]');
    remove.focus();
    click(remove);
    assert.deepEqual(removed, [recentFiles[0].path]);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Open plan.md");
  } finally { view.cleanup(); }
});

test("welcome focuses Open only after startup settles and never steals focus from a chosen control", async () => {
  await installDom();
  const view = renderEmptyState();
  try {
    assert.ok(document.activeElement !== buttonWithText(view.host, "Open File…"));
    view.render({ canFocus: true });
    assert.ok(document.activeElement === buttonWithText(view.host, "Open File…"));
    const shortcuts = buttonWithText(view.host, "Keyboard Shortcuts");
    shortcuts.focus();
    view.render({ canFocus: false });
    view.render({ canFocus: true });
    assert.ok(document.activeElement === shortcuts);
  } finally { view.cleanup(); }

  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const late = renderEmptyState();
  try {
    late.render({ canFocus: true });
    assert.ok(document.activeElement === opener);
  } finally { late.cleanup(); opener.remove(); }
});
