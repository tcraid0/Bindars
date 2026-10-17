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
async function mount(t, { platform = "Linux x86_64", initialPath = "/fixture/A.md", recentFiles = [], session = null } = {}) {
  window.localStorage.clear();
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  const priorPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  const settings = { session, "recent-files": { version: 1, files: recentFiles } };
  const writes = [], opened = [], held = new Map();
  let native, view;
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
      if (args.path.includes("missing")) throw { category: "notFound", operation: "readDocument", message: "Missing", detail: "fixture" };
      return documentFor(args.path);
    }
    if (cmd === "plugin:dialog|open") return null;
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
    await until(() => assert.ok(view.host.querySelector("article, .empty-state")));
  }
  await launch(initialPath);
  t.after(async () => {
    await view.cleanup(); clearMocks();
    globalThis.localStorage = priorStorage;
    if (priorPlatform) Object.defineProperty(navigator, "platform", priorPlatform); else delete navigator.platform;
    window.localStorage.clear();
  });
  const home = () => view.host.querySelector("header button[title^='Home']");
  return {
    host: () => view.host, settings, writes, opened, home,
    hold(path) { const operation = deferred(); held.set(path, operation); return operation; },
    async open(path) {
      native.setPendingPath(path);
      await act(async () => emit("bindars://native-open-available"));
      await until(() => assert.match(view.host.querySelector(".document-header-filename")?.textContent ?? "", new RegExp(path.split("/").at(-1))));
      await until(() => assert.equal(view.host.querySelector('[aria-label="Edit mode"]').disabled, false));
    },
    async relaunch(path = null) { await view.cleanup(); await launch(path); },
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
