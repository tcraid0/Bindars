const test = require("node:test");
const assert = require("node:assert/strict");
const { act } = require("react");
const { mockWindows, clearMocks } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { createAppView } = require("./_helpers/render-app.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");
const { click, pressKey } = require("./_helpers/component-view.cjs");

async function until(assertion) {
  for (let i = 0; ; i++) {
    try { return assertion(); } catch (error) { if (i === 80) throw error; }
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const menu = action => act(async () => emit("bindars://menu-action", { action }));
const documentFor = path => ({
  canonicalPath: path, name: path.split("/").at(-1),
  content: `# ${path.split("/").at(-1)}\n\nOpening words.\n\n## Second\n\nClosing words.`,
  revision: { mtimeMs: 1, size: 40, contentHash: path },
});

// A StrictMode App whose settings survive relaunch(), like the native store.
async function mount(t, { platform = "Linux x86_64", initialPath = "/fixture/A.md", recentFiles = [], session = null, holds = [] } = {}) {
  window.localStorage.clear();
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  const priorPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  const settings = { session, "recent-files": { version: 1, files: recentFiles } };
  const writes = [], opened = [], held = new Map(), removed = new Set(), scrolled = [];
  const dialogs = { open: null, save: null };
  const launchHolds = new Map(holds.map(path => [path, deferred()]));
  for (const [path, operation] of launchHolds) held.set(path, operation);
  let native, view, exits = 0;
  const ipc = (cmd, args = {}) => {
    if (cmd === "initialize_annotation_storage") return { settingsReady: true };
    if (cmd === "get_setting") {
      if (args.key === "config-version") return 3;
      if (args.key === "reading-hint-dismissed" || args.key === "sidebar-hint-dismissed") return true;
      return settings[args.key] ?? null;
    }
    if (cmd === "set_setting") { writes.push(structuredClone(args)); settings[args.key] = structuredClone(args.value); return null; }
    if (cmd === "open_markdown_file") {
      opened.push(args.path);
      const hold = held.get(args.path);
      if (hold) { held.delete(args.path); return hold.promise; }
      if (args.path.includes("missing") || removed.has(args.path)) {
        throw { category: "notFound", operation: "readDocument", message: "Missing", detail: "fixture" };
      }
      return documentFor(args.path);
    }
    if (cmd === "plugin:dialog|open") return dialogs.open;
    if (cmd === "plugin:dialog|save") return dialogs.save;
    if (cmd === "plugin:path|resolve_directory") return "/fixture/Documents";
    if (cmd === "check_copy_destination") return args.path;
    if (cmd === "write_markdown_file_if_unmodified") {
      return { conflict: false, canonicalPath: args.path, name: args.path.split("/").at(-1),
        currentRevision: { mtimeMs: 2, size: args.content.length, contentHash: `${args.path}:2` } };
    }
    if (cmd === "export_markdown_file") return null;
    if (cmd === "exit_after_guarded_quit") { exits += 1; return null; }
    if (cmd === "list_draft_documents") return { files: [], limitHit: false, skipped: true };
    if (cmd === "inspect_document_files") return [];
    if (cmd === "is_draft_document") return false;
    if (["load_annotations", "watch_file", "unwatch_file", "authorize_document_images", "plugin:window|set_title",
      "load_search_cache", "save_search_cache", "set_interface_zoom"].includes(cmd)) return null;
    throw new Error(`Unexpected IPC ${cmd}`);
  };
  async function launch(path) {
    for (const key of Object.keys(require.cache)) {
      if (key.includes("/.tmp/workspace-tests/src/")) delete require.cache[key];
    }
    mockWindows("main");
    native = createNativeOpenIpc(path);
    view = createAppView({ ipc: native.wrap(ipc), strictMode: true });
    view.render();
    await until(() => assert.ok(view.host.querySelector("main")));
  }
  const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { if (this.id) scrolled.push(this.id); };
  t.after(() => { window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView; });
  await launch(initialPath);
  if (initialPath && !launchHolds.has(initialPath)) {
    await until(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]')?.disabled, false));
  }
  t.after(async () => {
    await view.cleanup(); clearMocks();
    globalThis.localStorage = priorStorage;
    if (priorPlatform) Object.defineProperty(navigator, "platform", priorPlatform); else delete navigator.platform;
    window.localStorage.clear();
  });
  const home = () => view.host.querySelector("header button[title^='Home']");
  return {
    host: () => view.host, settings, writes, opened, home, launchHolds, dialogs, removed, scrolled,
    hold(path) { const operation = deferred(); held.set(path, operation); return operation; },
    async open(path) {
      native.setPendingPath(path);
      await act(async () => emit("bindars://native-open-available"));
      await until(() => assert.match(view.host.querySelector(".document-header-filename")?.textContent ?? "", new RegExp(path.split("/").at(-1))));
      await until(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]').disabled, false));
    },
    async relaunch(path = null) { await view.cleanup(); await launch(path); },
    // The guarded Quit: the session flush runs before the native exit.
    async quit() {
      const before = exits;
      await act(async () => emit("bindars://quit-requested"));
      await until(() => assert.equal(exits, before + 1));
    },
    homeKey: (target = document.activeElement ?? document.body) => pressOn(target, platform),
  };
}

function pressOn(target, platform) {
  const options = platform === "MacIntel" ? { key: "H", metaKey: true, shiftKey: true } : { key: "Home", altKey: true };
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
  act(() => { target.dispatchEvent(event); });
  return event;
}

const atHome = app => Boolean(app.host().querySelector(".empty-state")) && !app.host().querySelector("article");
const pageHeading = app => app.host().querySelector(".empty-state h1");

for (const [platform, route] of [
  ["Linux x86_64", "button"], ["Linux x86_64", "Alt+Home"], ["MacIntel", "Shift+Cmd+H"], ["MacIntel", "File › Home"],
]) {
  test(`${route} goes Home from a document and lands on the page heading (${platform})`, async t => {
    const app = await mount(t, { platform });
    assert.equal(app.home().getAttribute("aria-current"), null);
    if (route === "button") click(app.home());
    else if (route === "File › Home") await menu("home");
    else app.homeKey();
    await until(() => assert.ok(atHome(app)));
    await until(() => assert.ok(document.activeElement === pageHeading(app)));
    assert.equal(pageHeading(app).tabIndex, -1);
    assert.equal(app.home().getAttribute("aria-current"), "page");
    assert.equal(app.home().disabled, false);
    assert.equal(app.home().textContent, "Home");
  });
}

for (const platform of ["Linux x86_64", "MacIntel"]) {
  test(`the other platform's Home keys do nothing (${platform})`, async t => {
    const app = await mount(t, { platform });
    const other = platform === "MacIntel" ? { key: "Home", altKey: true } : { key: "H", ctrlKey: true, shiftKey: true };
    act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...other })); });
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    assert.ok(app.host().querySelector("article"));
    assert.equal(app.home().getAttribute("aria-current"), null);
  });
}

test("Home leaves Focus mode, while presentation and an open dialog block it", async t => {
  const app = await mount(t);
  pressKey("f", { ctrlKey: true, shiftKey: true });
  await until(() => assert.ok(app.host().querySelector(".focus-bar")));
  app.homeKey();
  await until(() => assert.ok(atHome(app)));
  assert.ok(!app.host().querySelector(".focus-bar"));
  assert.ok(app.host().querySelector("header"), "Home's toolbar is visible again");

  await app.open("/fixture/B.md");
  // PresentationBar reads the global, as in window-lifecycle's presentation test.
  const originalMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = query => window.matchMedia(query);
  t.after(() => { globalThis.matchMedia = originalMatchMedia; });
  pressKey("F5");
  await until(() => assert.ok(app.host().querySelector(".presentation-overlay")));
  app.homeKey();
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  assert.ok(!atHome(app), "presentation keeps every shortcut, Home included");
  pressKey("Escape");
  await until(() => assert.ok(!app.host().querySelector(".presentation-overlay")));

  pressKey("?", { ctrlKey: true });
  await until(() => assert.ok(document.querySelector('[role="dialog"]')));
  await menu("home");
  assert.ok(!atHome(app), "menu actions wait for the dialog");
});

test("Home at Home changes nothing but moves focus to the heading", async t => {
  const app = await mount(t, { initialPath: null });
  const theme = app.host().querySelector('header button[aria-label^="Switch theme"]');
  theme.focus();
  app.homeKey();
  await until(() => assert.ok(document.activeElement === pageHeading(app)));
  assert.ok(atHome(app));
  assert.equal(app.writes.filter(write => write.key === "session").length, 0);
});

test("Alt+Home and Alt+arrows pass through a focused sidebar tab", async t => {
  const app = await mount(t);
  click(app.host().querySelector('[aria-label="Toggle sidebar"]'));
  const drafts = await until(() => {
    const tab = app.host().querySelector("#navigation-tab-Drafts");
    assert.ok(tab);
    return tab;
  });
  click(drafts);
  drafts.focus();
  app.homeKey(drafts);
  await until(() => assert.ok(atHome(app)));
  assert.equal(app.host().querySelector("#navigation-tab-Drafts").getAttribute("aria-selected"), "true",
    "the modified key never moves the tab, and Home keeps the selected tab");
  const tab = app.host().querySelector("#navigation-tab-Drafts");
  tab.focus();
  pressKey("Home");
  assert.equal(app.host().querySelector("#navigation-tab-Recent").getAttribute("aria-selected"), "true",
    "plain Home still moves to the first tab");
});

test("Home, an untouched New, and New then Home are each remembered when Bindars quits", async t => {
  const app = await mount(t);
  app.homeKey();
  await until(() => assert.ok(atHome(app)));
  await until(() => assert.equal(app.settings.session?.kind, "home", "Home is saved as soon as it commits"));
  await app.quit();
  await app.relaunch();
  assert.ok(atHome(app));
  assert.deepEqual(app.opened, ["/fixture/A.md"], "nothing was reopened");

  await app.open("/fixture/B.md");
  pressKey("n", { ctrlKey: true });
  await until(() => assert.ok(app.host().querySelector(".cm-editor")));
  await app.quit();
  await app.relaunch();
  assert.ok(atHome(app), "a new document that was never saved counts as Home");

  await app.open("/fixture/C.md");
  pressKey("n", { ctrlKey: true });
  await until(() => assert.ok(app.host().querySelector(".cm-editor")));
  app.homeKey(document.body);
  await until(() => assert.ok(atHome(app)));
  await app.quit();
  await app.relaunch();
  assert.ok(atHome(app));

  await app.open("/fixture/D.md");
  await app.quit();
  await app.relaunch();
  await until(() => assert.match(app.host().querySelector(".document-header-filename")?.textContent ?? "", /D\.md/));
  assert.equal(app.opened.at(-1), "/fixture/D.md", "a document stays the place to reopen");
});

for (const launch of ["restore", "explicit"]) {
  test(`${launch === "restore" ? "a restored" : "an explicit"} open at launch shows the file it is opening, never Home first`, async t => {
    const path = launch === "restore" ? "/fixture/slow.md" : "/fixture/finder.md";
    const app = await mount(t, {
      initialPath: launch === "explicit" ? path : null, holds: [path],
      session: launch === "restore" ? { filePath: path, headingId: "second", savedAt: 1 } : { kind: "home", savedAt: 1 },
    });
    await until(() => assert.match(app.host().querySelector("main").textContent, new RegExp(`Opening ${path.split("/").at(-1)}…`)));
    assert.ok(!app.host().querySelector(".empty-state"), "no Home while the launch read is pending");
    assert.equal(app.home().getAttribute("aria-current"), null);
    await act(async () => app.launchHolds.get(path).resolve(documentFor(path)));
    await until(() => assert.ok(app.host().querySelector("article")));
    assert.ok(!app.host().querySelector(".empty-state"));
  });
}

test("a missing document at launch shows Home with its message; Quit keeps it, Dismiss saves Home", async t => {
  const app = await mount(t, { initialPath: null, session: { filePath: "/fixture/missing.md", headingId: null, savedAt: 1 } });
  const message = () => app.host().querySelector(".empty-state-recovery-message");
  await until(() => assert.match(message()?.textContent ?? "", /missing\.md/));
  assert.equal(app.settings.session.restoreDisabled, true);
  await app.quit();
  assert.equal(app.settings.session.restoreDisabled, true, "quitting with the message showing keeps it");
  await app.relaunch();
  await until(() => assert.match(message()?.textContent ?? "", /missing\.md/));
  click([...message().querySelectorAll("button")].find(button => button.textContent === "Dismiss"));
  await until(() => assert.equal(app.settings.session.kind, "home"));
  await app.relaunch();
  assert.ok(atHome(app));
  assert.equal(message(), null, "the dismissed file does not return at the next launch");
});

const header = app => app.host().querySelector(".document-header-filename")?.textContent ?? "";
const toolbar = (app, label) => app.host().querySelector(`header [aria-label="${label}"]`);
async function settle(app) {
  await until(() => assert.equal(app.host().querySelector('header button[title^="Open"]').disabled, false));
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
}
async function arriveAt(app, name) {
  if (name === "Home") await until(() => assert.ok(atHome(app)));
  else await until(() => assert.equal(header(app), name));
  await settle(app);
}
async function press(app, label) {
  await until(() => assert.equal(toolbar(app, label).disabled, false));
  click(toolbar(app, label));
}

const routes = {
  async "Open File…"(app) { app.dialogs.open = "/fixture/B.md"; click(app.host().querySelector('header button[title^="Open"]')); return "B.md"; },
  async "Finder open"(app) { await app.open("/fixture/F.md"); return "F.md"; },
  async "New"(app) { pressKey("n", { ctrlKey: true }); await until(() => assert.ok(app.host().querySelector(".cm-editor"))); return "Untitled.md"; },
  async "Make a Copy…"(app) {
    app.dialogs.save = "/fixture/A copy.md";
    click(app.host().querySelector('[aria-label="Export options"]'));
    click([...app.host().querySelectorAll("button")].find(button => button.textContent === "Make a copy…"));
    return "A copy.md";
  },
  async "Home"(app) { click(app.home()); return "Home"; },
  // The example is on the first-run screen (no history yet).
  async "Try an Example…"(app) {
    app.dialogs.save = "/fixture/Example.md";
    click([...app.host().querySelectorAll(".empty-state button")].find(button => button.textContent === "Try an Example…"));
    return "Example.md";
  },
};

for (const [route, go] of Object.entries(routes)) {
  test(`${route} records the place it leaves: Back returns there and Forward repeats the move`, async t => {
    const firstRun = route === "Try an Example…";
    const app = await mount(t, firstRun ? { initialPath: null } : {});
    const from = firstRun ? "Home" : "A.md";
    const to = await go(app);
    await arriveAt(app, to);
    await press(app, "Go back");
    await arriveAt(app, from);
    await press(app, "Go forward");
    // An untitled document that was never saved counts as Home.
    await arriveAt(app, route === "New" ? "Home" : to);
  });
}

test("Home and documents move both ways through Back and Forward", async t => {
  const app = await mount(t, { recentFiles: [{ path: "/fixture/B.md", name: "B.md", openedAt: 2, lastHeadingId: null }] });
  click(app.home());
  await arriveAt(app, "Home");
  click(app.host().querySelector('.empty-state [aria-label^="Open B.md"]'));
  await arriveAt(app, "B.md");
  for (const [label, place] of [["Go back", "Home"], ["Go back", "A.md"], ["Go forward", "Home"], ["Go forward", "B.md"]]) {
    await press(app, label);
    await arriveAt(app, place);
  }
  assert.equal(toolbar(app, "Go forward").disabled, true);
});

test("Home → New → Home records nothing, and leaving an untitled document records Home", async t => {
  const app = await mount(t);
  click(app.home());
  await arriveAt(app, "Home");
  pressKey("n", { ctrlKey: true });
  await until(() => assert.ok(app.host().querySelector(".cm-editor")));
  app.homeKey(document.body);
  await arriveAt(app, "Home");
  await press(app, "Go back");
  await arriveAt(app, "A.md");
  assert.equal(toolbar(app, "Go back").disabled, true, "Home → New → Home added no entry of its own");

  pressKey("n", { ctrlKey: true });
  await until(() => assert.ok(app.host().querySelector(".cm-editor")));
  await app.open("/fixture/F.md");
  await press(app, "Go back");
  await arriveAt(app, "Home");
  await press(app, "Go back");
  await arriveAt(app, "A.md");
});

test("Back to a deleted file drops its entry, and Retry opens that file", async t => {
  const app = await mount(t);
  await app.open("/fixture/F.md");
  app.removed.add("/fixture/A.md");
  await press(app, "Go back");
  await until(() => assert.match(app.host().querySelector('[role="alert"]')?.textContent ?? "", /A\.md/));
  assert.equal(header(app), "F.md");
  assert.equal(toolbar(app, "Go back").disabled, true, "the gone file lost its entry");
  app.removed.delete("/fixture/A.md");
  click([...app.host().querySelectorAll('[role="alert"] button')].find(button => button.textContent === "Retry"));
  await arriveAt(app, "A.md");
  await press(app, "Go back");
  await arriveAt(app, "F.md");
});

test("launch opens record nothing, and cancelled or failed opens change nothing", async t => {
  const finder = await mount(t, { initialPath: "/fixture/Launch.md" });
  assert.equal(toolbar(finder, "Go back").disabled, true, "an explicit open at launch records nothing");
  finder.dialogs.open = null;
  click(finder.host().querySelector('header button[title^="Open"]'));
  await settle(finder);
  await finder.open("/fixture/missing.md").catch(() => {});
  await settle(finder);
  assert.equal(header(finder), "Launch.md");
  assert.equal(toolbar(finder, "Go back").disabled, true, "a cancelled dialog and a failed open record nothing");
});

test("a launch restore records nothing", async t => {
  const app = await mount(t, { initialPath: null, session: { filePath: "/fixture/A.md", headingId: "second", savedAt: 1 } });
  await arriveAt(app, "A.md");
  assert.equal(toolbar(app, "Go back").disabled, true);
});

test("an entry recorded straight after an open never carries the previous document's heading", async t => {
  const app = await mount(t, { initialPath: null, session: { filePath: "/fixture/A.md", headingId: "second", savedAt: 1 } });
  await arriveAt(app, "A.md");
  assert.ok(app.scrolled.includes("second"));
  await app.open("/fixture/F.md");
  click(app.home());
  await arriveAt(app, "Home");
  app.scrolled.length = 0;
  await press(app, "Go back");
  await arriveAt(app, "F.md");
  assert.ok(!app.scrolled.includes("second"), "F was left at its top, not at A's heading");
});

test("Continue reading marks the newest saved file, never one just found missing, even after Dismiss", async t => {
  const recentFiles = [
    { path: "/fixture/missing.md", name: "missing.md", openedAt: 3, lastHeadingId: null },
    { path: "/fixture/B.md", name: "B.md", openedAt: 2, lastHeadingId: null },
  ];
  const app = await mount(t, { initialPath: null, recentFiles, session: { filePath: "/fixture/missing.md", headingId: null, savedAt: 1 } });
  const cue = () => [...app.host().querySelectorAll('.empty-state button[aria-label$=", Continue reading"]')].map(row => row.title);
  const message = () => app.host().querySelector(".empty-state-recovery-message");
  await until(() => assert.ok(message()));
  assert.equal(app.host().querySelector(".empty-state h1").textContent, "Home");
  assert.deepEqual(cue(), [], "the newest file just failed to open");
  click([...message().querySelectorAll("button")].find(button => button.textContent === "Dismiss"));
  await until(() => assert.equal(message(), null));
  assert.deepEqual(cue(), [], "dismissing the message does not make the missing file the one to continue");
  click(app.host().querySelector('.empty-state [aria-label^="Open B.md"]'));
  await arriveAt(app, "B.md");
  click(app.home());
  await arriveAt(app, "Home");
  assert.deepEqual(cue(), ["/fixture/B.md"]);
});
