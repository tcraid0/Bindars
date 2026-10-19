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
    onNewFile() {},
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

test("with history, launch shows Home: a small heading, quiet Open File and New, recent folders, the drop line", async () => {
  await installDom();
  let opened = 0, created = 0;
  const three = [...recentFiles, { path: "/Users/reader/Notes/c.md", name: "c.md", openedAt: Date.now(), lastHeadingId: null }];
  const view = renderEmptyState({ recentFiles: three, onOpenFile() { opened += 1; }, onNewFile() { created += 1; } });
  try {
    const heading = view.host.querySelector("h1");
    assert.equal(heading.textContent, "Home");
    assert.equal(heading.tabIndex, -1);
    assert.equal(view.host.querySelectorAll("h1").length, 1);
    assert.equal(heading.querySelectorAll("svg").length, 0, "the toolbar's Home button carries the symbol");
    assert.equal(view.host.querySelectorAll("[data-startup-mark-target], [data-startup-mark-passes], .empty-state-wordmark").length, 0,
      "no large branding, and the startup glide fades onto Home (D5)");
    const open = buttonWithText(view.host, "Open File…");
    const create = buttonWithText(view.host, "New");
    for (const button of [open, create]) {
      assert.doesNotMatch(button.className, /\bbg-accent-fill\b/, "no filled button on Home");
      assert.match(button.className, /\bborder-border\b/);
    }
    click(open);
    click(create);
    assert.deepEqual([opened, created], [1, 1]);
    assert.match(view.host.textContent, /reader › Documents/);
    assert.match(view.host.textContent, /reader › Downloads/);
    assert.match(view.host.textContent, /Drop a Markdown or Fountain file anywhere to open it\./);
    assert.ok(![...view.host.querySelectorAll("button")].some(button => button.textContent === "Keyboard Shortcuts"),
      "the toolbar's ? button lists shortcuts");
    assert.doesNotMatch(view.host.textContent, /Recent files|Resume:|Try an Example|Read, highlight/);
    assert.ok(view.host.querySelector(".empty-state").classList.contains("empty-state-home"), "Home never plays the welcome entrance");
    assert.ok(view.host.querySelector(".empty-state-content.home-column"), "the reading-width column");
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

const startRows = host => [...host.querySelectorAll("button.home-row")];

for (const platform of ["Linux x86_64", "MacIntel"]) {
  test(`a chosen or restored blank Home offers ways to start in its own layout (${platform})`, async () => {
    await installDom();
    const priorPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    const calls = [];
    const empty = renderEmptyState({ preferHome: true, onOpenFile() { calls.push("open"); },
      onTrySample() { calls.push("example"); }, onNewFile() { calls.push("new"); } });
    try {
      const mac = platform === "MacIntel";
      assert.equal(empty.host.querySelector("h1").textContent, "Home");
      assert.equal(empty.host.querySelectorAll("h1").length, 1);
      assert.equal(empty.host.querySelector("h2").textContent, "Start with a document");
      assert.match(empty.host.textContent, /Documents you open will be listed here, with where you left off in each\./);
      assert.deepEqual(startRows(empty.host).map(row => row.getAttribute("aria-label")), [
        `Open a file…, Markdown or Fountain, from anywhere on your ${mac ? "Mac" : "computer"}`,
        "Try an example…, Save a short guide to reading, highlights and notes",
        "New document, Kept in Bindars Drafts until you save it somewhere",
      ]);
      assert.deepEqual(startRows(empty.host).map(row => row.querySelector("kbd")?.textContent ?? null),
        mac ? ["⌘O", null, "⌘N"] : ["Ctrl+O", null, "Ctrl+N"]);
      assert.ok([...empty.host.querySelectorAll("kbd")].every(hint => hint.getAttribute("aria-hidden") === "true"));
      startRows(empty.host).forEach(click);
      assert.deepEqual(calls, ["open", "example", "new"]);
      assert.match(empty.host.textContent, /You can also drop a Markdown or Fountain file anywhere in this window\./);
      assert.doesNotMatch(empty.host.textContent, /No recent files|Open File…|Keyboard Shortcuts|Read, highlight/,
        "no header buttons, no dead end, and not the first-run welcome");
      empty.render({ canTrySample: false });
      assert.equal(startRows(empty.host)[1].disabled, true, "the example waits while another action runs");
    } finally {
      empty.cleanup();
      if (priorPlatform) Object.defineProperty(navigator, "platform", priorPlatform); else delete navigator.platform;
    }
  });
}

test("one or two documents keep Open and New below the list; three bring the quiet header buttons", async () => {
  await installDom();
  const files = ["a", "b", "c"].map((name, index) => ({
    path: `/Users/reader/Notes/${name}.md`, name: `${name}.md`, openedAt: 10 - index, lastHeadingId: null,
  }));
  const view = renderEmptyState({ recentFiles: files.slice(0, 1) });
  try {
    const open = buttonWithText(view.host, "Open a file…");
    for (const count of [1, 2]) {
      view.render({ recentFiles: files.slice(0, count) });
      assert.equal(view.host.querySelectorAll("[data-path]").length, count);
      assert.match(view.host.textContent, /More ways to start/);
      assert.deepEqual(startRows(view.host).map(row => row.getAttribute("aria-label").split(",")[0]),
        ["Open a file…", "New document"], "no example once there are documents");
      assert.ok(buttonWithText(view.host, "Open a file…") === open, "the ways to start stay in place as documents arrive");
      assert.ok(![...view.host.querySelectorAll("button")].some(button => button.textContent.startsWith("Open File…")));
      assert.match(view.host.textContent, /Drop a Markdown or Fountain file anywhere to open it\./);
    }
    view.render({ recentFiles: files });
    assert.equal(startRows(view.host).length, 0);
    assert.doesNotMatch(view.host.textContent, /More ways to start/);
    assert.ok(buttonWithText(view.host, "Open File…"));
    assert.ok(buttonWithText(view.host, "New"));
  } finally { view.cleanup(); }
});

test("removing the last row keeps Home: the ways to start replace the list and keep focus", async () => {
  await installDom();
  const view = renderEmptyState({ recentFiles: recentFiles.slice(0, 1),
    onRemoveRecent() { view.render({ recentFiles: [] }); } });
  try {
    const remove = view.host.querySelector('[aria-label="Remove draft.md from recent files"]');
    remove.focus();
    click(remove);
    assert.equal(view.host.querySelector("h1").textContent, "Home", "removing the last row keeps Home");
    assert.match(view.host.textContent, /Start with a document/);
    assert.equal(startRows(view.host).length, 3);
    assert.ok(document.activeElement === buttonWithText(view.host, "Open a file…"));
  } finally { view.cleanup(); }

  const pointer = renderEmptyState({ recentFiles: recentFiles.slice(0, 1),
    onRemoveRecent() { pointer.render({ recentFiles: [] }); } });
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    elsewhere.focus();
    click(pointer.host.querySelector('[aria-label="Remove draft.md from recent files"]'));
    assert.ok(document.activeElement === elsewhere, "a pointer removal leaves focus where it was");
  } finally { pointer.cleanup(); elsewhere.remove(); }
});

test("with Recent unavailable, Home keeps its message and the quiet header buttons", async () => {
  await installDom();
  const view = renderEmptyState({ recentHistoryUnavailable: true });
  try {
    assert.equal(view.host.querySelector("h1").textContent, "Home");
    assert.match(view.host.textContent, /Recent history is unavailable\./);
    assert.ok(buttonWithText(view.host, "Open File…"));
    assert.ok(buttonWithText(view.host, "New"));
    assert.equal(startRows(view.host).length, 0);
  } finally { view.cleanup(); }
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
    assert.ok(document.activeElement === buttonWithText(view.host, "Open a file…"),
      "Dismiss hands focus to the primary action, Home's Open row below two documents");
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
