const test = require("node:test");
const assert = require("node:assert/strict");
const { act } = require("react");
const { mockWindows, clearMocks } = require("@tauri-apps/api/mocks");
const { emit, listen } = require("@tauri-apps/api/event");
const { createAppView } = require("./_helpers/render-app.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");
const { buttonWithText, click, pressKey } = require("./_helpers/component-view.cjs");

async function until(assertion) {
  for (let i = 0; ; i++) {
    try { return assertion(); } catch (error) { if (i === 80) throw error; }
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
  }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const menu = action => act(async () => emit("bindars://menu-action", { action }));
const hint = view => view.host.querySelector('[aria-label="Dismiss sidebar hint"]');

async function mount(t, { initialPath = "/fixture/A.md", platform = "Linux x86_64", readingDismissed = true,
  sidebarDismissed = false, localDismissed = false } = {}) {
  window.localStorage.clear();
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  const priorPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  if (localDismissed) localStorage.setItem("bindars-sidebar-hint-dismissed", "true");
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/.tmp/workspace-tests/src/")) delete require.cache[key];
  }
  mockWindows("main");
  const native = createNativeOpenIpc(initialPath);
  const writes = [], dialogs = [], titleStates = [], listings = [];
  const ipc = native.wrap((cmd, args = {}) => {
    if (cmd === "initialize_annotation_storage") return { settingsReady: true };
    if (cmd === "get_setting") {
      if (args.key === "config-version") return 3;
      if (args.key === "recent-files") return { version: 1, files: [] };
      if (args.key === "reading-hint-dismissed") return readingDismissed;
      if (args.key === "sidebar-hint-dismissed") return sidebarDismissed;
      return null;
    }
    if (cmd === "set_setting") { writes.push(args); return null; }
    if (cmd === "plugin:dialog|open") { dialogs.push(args.options); return null; }
    if (cmd === "open_markdown_file") {
      const path = args.path === "/fixture/alias-A.md" ? "/fixture/A.md" : args.path;
      return { canonicalPath: path, name: path.split("/").at(-1), content: "# Fixture\n\nA document.",
        revision: { mtimeMs: 1, size: 25, contentHash: "fixture" } };
    }
    if (cmd === "list_draft_documents") { listings.push(args); return { files: [], limitHit: false, skipped: true }; }
    if (cmd === "inspect_document_files") return [];
    if (cmd === "is_draft_document") return false;
    if (["load_annotations", "watch_file", "unwatch_file", "authorize_document_images", "plugin:window|set_title",
      "load_search_cache", "save_search_cache", "set_interface_zoom"].includes(cmd)) return null;
    throw new Error(`Unexpected IPC ${cmd}`);
  });
  const view = createAppView({ ipc, strictMode: true });
  const unlisten = await listen("bindars://sidebar-visible", event => titleStates.push(event.payload));
  t.after(async () => {
    await view.cleanup(); unlisten(); clearMocks();
    globalThis.localStorage = priorStorage;
    if (priorPlatform) Object.defineProperty(navigator, "platform", priorPlatform); else delete navigator.platform;
    window.localStorage.clear();
  });
  view.render();
  await until(() => assert.ok(view.host.querySelector(initialPath ? "article" : ".empty-state")));
  const ready = () => until(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]').disabled, false));
  if (initialPath) await ready();
  return { ...view, writes, dialogs, titleStates, listings,
    key: (key, options = {}) => pressKey(key, { [platform === "MacIntel" ? "metaKey" : "ctrlKey"]: true, ...options }),
    async open(path) {
      native.setPendingPath(path);
      await act(async () => emit("bindars://native-open-available"));
      await until(() => assert.ok(view.host.querySelector(".document-header-filename").textContent.includes(path === "/fixture/alias-A.md" ? "A.md" : path.split("/").at(-1))));
      await ready();
    },
  };
}

for (const platform of ["Linux x86_64", "MacIntel"]) {
  test(`${platform}: StrictMode counts distinct canonical opens, not a first run or same-file alias`, async t => {
    const view = await mount(t, { platform });
    assert.ok(!hint(view));
    await view.open("/fixture/alias-A.md");
    assert.ok(!hint(view));
    await view.open("/fixture/B.md");
    await until(() => assert.ok(hint(view)));
    assert.equal(view.host.querySelectorAll(".hint-bar").length, 1);
    assert.match(view.host.querySelector(".hint-bar").textContent, /Your recent documents are in the sidebar\./);
  });
}

for (const action of ["dismiss", "show", "toolbar", "shortcut", "menu"]) {
  test(`sidebar hint retires permanently through ${action}, with focus preserved`, async t => {
    const view = await mount(t, { platform: "MacIntel" });
    await view.open("/fixture/B.md");
    await until(() => assert.ok(hint(view)));
    hint(view).focus();
    if (action === "dismiss") click(hint(view));
    if (action === "show") click(buttonWithText(view.host.querySelector(".hint-bar"), "Show Sidebar"));
    if (action === "toolbar") click(view.host.querySelector('[aria-label="Toggle sidebar"]'));
    if (action === "shortcut") view.key("b");
    if (action === "menu") await menu("toggle-sidebar");
    await until(() => assert.ok(!hint(view)));
    assert.ok(document.activeElement !== document.body);
    assert.equal(localStorage.getItem("bindars-sidebar-hint-dismissed"), "true");
    await until(() => assert.equal(view.writes.filter(write => write.key === "sidebar-hint-dismissed").length, 1));
    if (action !== "dismiss") view.key("b");
    await view.open("/fixture/C.md");
    assert.ok(!hint(view));
  });
}

test("reading hint has priority; dismissing it waits for a later open before the sidebar hint", async t => {
  const view = await mount(t, { readingDismissed: false });
  await view.open("/fixture/B.md");
  assert.ok(view.host.querySelector('[aria-label="Dismiss reading hint"]'));
  assert.ok(!hint(view));
  click(view.host.querySelector('[aria-label="Dismiss reading hint"]'));
  assert.ok(!hint(view));
  await view.open("/fixture/C.md");
  await until(() => assert.ok(hint(view)));
  const bar = view.host.querySelector(".hint-bar");
  view.host.querySelector("main").focus(); view.key("f");
  assert.ok(bar.classList.contains("invisible"));
  pressKey("Escape");
  assert.ok(!bar.classList.contains("invisible"));
  assert.notEqual(localStorage.getItem("bindars-sidebar-hint-dismissed"), "true");
});

for (const saved of [false, true]) {
  test(`late hint preferences retain distinct open count and respect saved dismissal=${saved}`, async t => {
    const reading = deferred(), sidebar = deferred();
    const view = await mount(t, { readingDismissed: reading.promise, sidebarDismissed: sidebar.promise });
    await view.open("/fixture/B.md");
    assert.ok(!hint(view));
    await act(async () => { reading.resolve(true); sidebar.resolve(saved); });
    await until(() => assert.equal(!!hint(view), !saved));
  });
}

test("the local dismissal mirror suppresses the hint even when settings have not caught up", async t => {
  const view = await mount(t, { localDismissed: true });
  await view.open("/fixture/B.md");
  assert.ok(!hint(view));
  assert.equal(view.writes.filter(write => write.key === "sidebar-hint-dismissed").length, 0);
});

test("menu sidebar actions sync intent, respect dialogs, and hide a fit-hidden sidebar", async t => {
  const view = await mount(t, { platform: "MacIntel" });
  const sidebar = () => view.host.querySelector('[data-reader-panel="sidebar"]');
  assert.equal(view.titleStates.at(-1), false);
  await menu("show-shortcuts");
  assert.ok(document.querySelector('[role="dialog"]'));
  await menu("toggle-sidebar");
  assert.ok(!sidebar());
  pressKey("Escape");
  await menu("toggle-sidebar");
  assert.ok(sidebar()); assert.equal(view.titleStates.at(-1), true);
  await view.open("/fixture/B.md");
  assert.ok(!hint(view), "an already shown sidebar needs no discovery hint");
  const oldWidth = window.innerWidth;
  try {
    view.key("m", { shiftKey: true });
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      window.dispatchEvent(new Event("resize"));
    });
    assert.ok(!sidebar());
    assert.equal(view.titleStates.at(-1), true, "fit must not change the menu's intent payload");
    await menu("toggle-sidebar");
    assert.equal(view.titleStates.at(-1), false, "Hide Sidebar clears intent even when fitted away");
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
      window.dispatchEvent(new Event("resize"));
    });
    assert.ok(!sidebar());
    await menu("toggle-sidebar");
    assert.deepEqual([...sidebar().querySelectorAll('button[aria-label^="Open "]')].map(row => row.title), ["/fixture/B.md", "/fixture/A.md"]);
    assert.equal(view.titleStates.at(-1), true);
  } finally { Object.defineProperty(window, "innerWidth", { configurable: true, value: oldWidth }); }
});

for (const initialPath of [null, "/fixture/Project/A.md"]) {
  test(`Add Folder starts in the current document folder: ${initialPath ?? "welcome"}`, async t => {
    const view = await mount(t, { initialPath });
    assert.ok(!hint(view));
    await menu("toggle-sidebar");
    click(view.host.querySelector('#navigation-tab-Drafts'));
    assert.match(view.host.textContent, /New documents are saved here until you save them somewhere else\./);
    assert.ok(buttonWithText(view.host, "Show existing drafts"));
    assert.ok(view.listings.every(args => args.force === false), "the Drafts privacy gate is never forced by discovery");
    click(view.host.querySelector('#navigation-tab-Folders'));
    assert.match(view.host.textContent, /Add a folder to browse the documents in it\. Nothing is moved or copied\./);
    click(buttonWithText(view.host, "Add Folder…"));
    await until(() => assert.equal(view.dialogs.length, 1));
    assert.equal(view.dialogs[0].directory, true);
    assert.equal(view.dialogs[0].defaultPath, initialPath ? "/fixture/Project" : undefined);
  });
}
