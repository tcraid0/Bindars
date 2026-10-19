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

test("with history, launch shows the compact Home: Open File, recent folders, no example or tagline", async () => {
  await installDom();
  const view = renderEmptyState({ recentFiles });
  try {
    const heading = view.host.querySelector("h1");
    assert.equal(heading.textContent, "Home");
    assert.equal(heading.tabIndex, -1);
    const art = heading.querySelector("svg");
    assert.equal(art.getAttribute("aria-hidden"), "true");
    assert.equal(art.querySelector("use").getAttribute("href"), "#bindars-symbol");
    assert.equal(view.host.querySelectorAll("[data-startup-mark-target], [data-startup-mark-passes], .empty-state-wordmark").length, 0,
      "no large branding, and the startup glide fades onto Home (D5)");
    assert.match(buttonWithText(view.host, "Open File…").className, /\bbg-accent-fill\b/);
    assert.match(view.host.textContent, /reader › Documents/);
    assert.match(view.host.textContent, /reader › Downloads/);
    assert.ok(buttonWithText(view.host, "Keyboard Shortcuts"));
    assert.doesNotMatch(view.host.textContent, /Resume:|Try an Example|Read, highlight|drop a Markdown/);
    assert.ok(view.host.querySelector(".empty-state").classList.contains("empty-state-home"), "Home never plays the welcome entrance");
  } finally {
    view.cleanup();
  }
});

test("Home shows five recent files and marks only the given one with a known section, in its spoken name", async () => {
  await installDom();
  const many = ["a", "b", "c", "d", "e", "f"].map((name, index) => ({
    path: `/Users/reader/Notes/${name}.md`, name: `${name}.md`, openedAt: 10 - index, lastHeadingId: null,
  }));
  const sections = new Map(many.slice(0, 2).map((file, index) => [file.path, { title: null, section: ["Day three", "Key findings"][index] }]));
  const view = renderEmptyState({ recentFiles: many, continuePath: many[0].path, recentDetails: sections });
  try {
    const rows = [...view.host.querySelectorAll('button[aria-label^="Open "]')];
    assert.deepEqual(rows.map(row => row.getAttribute("aria-label")), [
      "Open a.md, reader › Notes, Continue reading", "Open b.md, reader › Notes", "Open c.md, reader › Notes",
      "Open d.md, reader › Notes", "Open e.md, reader › Notes",
    ]);
    assert.match(rows[0].textContent, /^a\.md.*Continue at Day three · reader › Notes$/);
    assert.equal(rows[0].querySelector(".text-accent-text").textContent, "Continue at Day three");
    assert.match(rows[1].textContent, /Key findings · reader › Notes$/, "other rows show their section quietly");
    assert.equal(view.host.textContent.match(/Continue/g).length, 1);
    view.render({ recentDetails: new Map() });
    assert.doesNotMatch(view.host.textContent, /Continue/, "no cue without a known section");
    assert.ok(!view.host.querySelector('[aria-label$="Continue reading"]'), "nor in its spoken name");
    view.render({ recentDetails: sections, recovery: { path: many[0].path, error: { category: "not-found", message: "" }, retryDisabled: false } });
    assert.doesNotMatch(view.host.textContent, /Continue/, "never on an unavailable row");
  } finally { view.cleanup(); }
});

test("Home names a document by its title, keeps the filename and folder, and reveals Remove on hover or focus", async () => {
  await installDom();
  const files = [
    { path: "/Users/reader/Reading/Field notes.md", name: "Field notes.md", openedAt: Date.now() - 2 * 3600_000, lastHeadingId: "river" },
    { path: "/Users/reader/Notes/plan.md", name: "plan.md", openedAt: Date.now(), lastHeadingId: null },
  ];
  const details = new Map([[files[0].path, { title: "Field Notes from the Delta", section: "Day three: the river" }]]);
  const view = renderEmptyState({ recentFiles: files, continuePath: files[0].path, recentDetails: details });
  try {
    const [titled, plain] = view.host.querySelectorAll("[data-path]");
    const open = titled.querySelector("button");
    assert.equal(open.getAttribute("aria-label"),
      "Open Field Notes from the Delta, Field notes.md, reader › Reading, Continue reading");
    assert.equal(open.title, files[0].path);
    assert.equal(open.querySelector(".font-reading").textContent, "Field Notes from the Delta");
    assert.match(open.textContent, /2h ago/);
    assert.match(open.textContent, /Continue at Day three: the river · Field notes\.md in reader › Reading$/);
    assert.equal(plain.querySelector("button").getAttribute("aria-label"), "Open plan.md, reader › Notes");
    assert.match(plain.textContent, /^plan\.mdjust nowreader › Notes$/, "an untitled row keeps today's name and location");
    for (const row of [titled, plain]) {
      const remove = row.querySelector('[aria-label$="from recent files"]');
      assert.match(remove.className, /\bopacity-0\b/);
      assert.match(remove.className, /\bgroup-hover:opacity-100\b/);
      assert.match(remove.className, /\bgroup-focus-within:opacity-100\b/);
      assert.match(remove.className, /\bfocus-visible:opacity-100\b/);
    }
    view.render({ recovery: { path: files[1].path, error: { category: "not-found", message: "" }, retryDisabled: false } });
    const unavailable = view.host.querySelector('[data-path="/Users/reader/Notes/plan.md"]');
    assert.match(unavailable.textContent, /reader › Notes · Unavailable/);
    assert.doesNotMatch(unavailable.querySelector('[aria-label$="from recent files"]').className, /opacity-0|absolute/,
      "an unavailable row keeps Retry and Remove visible and inline");
  } finally { view.cleanup(); }
});

test("chosen or restored Home is compact without history, and keeps its page when rows go", async () => {
  await installDom();
  const empty = renderEmptyState({ preferHome: true });
  try {
    assert.equal(empty.host.querySelector("h1").textContent, "Home");
    assert.match(empty.host.textContent, /No recent files/);
    assert.doesNotMatch(empty.host.textContent, /Try an Example/);
  } finally { empty.cleanup(); }

  const launch = renderEmptyState({ recentFiles: recentFiles.slice(0, 1) });
  try {
    launch.render({ recentFiles: [] });
    assert.equal(launch.host.querySelector("h1").textContent, "Home", "removing the last row keeps Home");
    assert.match(launch.host.textContent, /No recent files/);
  } finally { launch.cleanup(); }
});

for (const [path, label] of [
  ["/Users/Shared/Notes/notes.md", "Shared › Notes"],
  ["/Users/another/Notes/notes.md", "another › Notes"],
  ["/home/another/Notes/notes.md", "another › Notes"],
  ["C:\\Users\\reader\\Notes\\notes.md", "reader › Notes"],
  ["\\\\server\\share\\notes.md", "server › share"],
  ["/notes.md", "/"],
  ["C:\\notes.md", "C:"],
]) {
  test("recent locations are visible and spoken, with the full path as a supplemental title: " + path, async () => {
    await installDom();
    const view = renderEmptyState({ recentFiles: [{ path, name: "notes.md", openedAt: 1, lastHeadingId: null }] });
    try {
      const row = view.host.querySelector('button[aria-label^="Open notes.md"]');
      assert.equal(row.getAttribute("aria-label"), `Open notes.md, ${label}`);
      assert.equal(row.title, path);
      assert.ok(row.textContent.includes(label), "location is available without hover");
      assert.ok(row.textContent.includes(new Date(1).toLocaleDateString()), "Home shows when you last read it");
      assert.ok(!view.host.querySelector("details.document-location"));
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
    const unavailable = view.host.querySelector('[aria-label="Open draft.md, reader › Documents"]');
    assert.equal(unavailable.getAttribute("aria-disabled"), "true");
    assert.equal(unavailable.tabIndex, -1, "Tab goes to the explicit Retry action");
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
    assert.equal(document.activeElement.getAttribute("aria-label"), "Open plan.md, reader › Downloads");
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

test("a launch onto Home focuses its heading after the startup screen; a chosen control keeps focus", async () => {
  await installDom();
  const splash = document.createElement("div");
  splash.id = "loading-screen";
  document.body.append(splash);
  const view = renderEmptyState({ recentFiles, canFocus: true });
  try {
    const heading = view.host.querySelector("h1");
    assert.ok(document.activeElement !== heading, "nothing moves while the startup screen covers the page");
    splash.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.activeElement === heading);
  } finally {
    splash.remove();
    view.cleanup();
  }

  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const chosen = renderEmptyState({ recentFiles, canFocus: true });
  try {
    assert.ok(document.activeElement === opener);
  } finally { chosen.cleanup(); opener.remove(); }
});
