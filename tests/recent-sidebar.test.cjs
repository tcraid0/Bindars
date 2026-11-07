const test = require("node:test");
const assert = require("node:assert/strict");
const { act } = require("react");
const { renderComponent, click, focus, pressKey } = require("./_helpers/component-view.cjs");
const { RecentFiles } = require("../.tmp/workspace-tests/src/components/RecentFiles.js");
const { Sidebar } = require("../.tmp/workspace-tests/src/components/Sidebar.js");
const { recentLocationLabels, toPathIdentityKey } = require("../.tmp/workspace-tests/src/lib/paths.js");
const { prepareCatalogDocument } = require("../.tmp/workspace-tests/src/lib/document-catalog.js");

const recent = path => ({ path, name: path.split(/[/\\]/).at(-1), openedAt: 1, lastHeadingId: null });
const rows = host => [...host.querySelectorAll("[data-path]")];
const openButton = row => row.querySelector("button");
const visibleTooltip = () => document.querySelector('[role="tooltip"]:not([hidden])');
const wait = ms => act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const pointer = (target, type, relatedTarget = null) => act(() => target.dispatchEvent(
  new window.PointerEvent(type, { bubbles: true, pointerType: "mouse", relatedTarget })));
function mount(t, files, overrides = {}) {
  const view = renderComponent(RecentFiles, { files, currentFilePath: null, openingPath: null,
    onOpen() {}, onRemove() {}, ...overrides });
  t.after(view.cleanup);
  return view;
}

test("collision ancestry extends beyond two folders, to roots/drives, using existing path identities", () => {
  for (const paths of [
    ["/Team A/shared/notes/plan.md", "/Team B/shared/notes/plan.md"],
    ["/shared/notes/plan.md", "/archive/shared/notes/plan.md"],
    ["C:\\shared\\notes\\plan.md", "D:\\shared\\notes\\plan.md"],
    ["\\\\server-a\\share\\notes\\plan.md", "\\\\server-b\\share\\notes\\plan.md"],
    // Full root paths also distinguish folder names containing the breadcrumb separator.
    ["/a › b/notes/plan.md", "/a/b › notes/plan.md"],
  ]) {
    const labels = recentLocationLabels(paths);
    assert.equal(labels.size, paths.length);
    assert.equal(new Set(labels.values()).size, paths.length, paths.join(" vs "));
    for (const path of paths) assert.ok(labels.get(toPathIdentityKey(path)).includes("notes"));
  }
  const windows = recentLocationLabels(["C:\\Alpha\\Notes.md", "D:\\Beta\\notes.md"]);
  assert.equal(windows.size, 2, "Windows filename case follows path identity");
  assert.equal(recentLocationLabels(["C:\\Alpha\\Notes.md", "c:/alpha/notes.md"]).size, 0, "aliases are one identity");
  assert.equal(recentLocationLabels(["/a/Notes.md", "/b/notes.md"]).size, 0, "POSIX case remains significant");
  assert.equal(recentLocationLabels(["/a/notes.md", "/a/notes(1).md"]).size, 0, "numbered filenames are distinct");
});

test("same titles keep exact filenames, while routine locations and dates are supplementary", t => {
  const files = ["/Downloads/Captive vs level funded call notes(1).md", "/Downloads/Captive vs level funded call notes.md"].map(recent);
  const title = "Captive vs. Level Funded — Call Notes";
  const view = mount(t, files, { details: new Map(files.map(file => [file.path, { title, section: null }])) });
  for (const [index, row] of rows(view.host).entries()) {
    const button = openButton(row);
    assert.equal(button.getAttribute("aria-label"), `Open ${title}, ${files[index].name}`);
    assert.ok(button.textContent.includes(files[index].name));
    assert.doesNotMatch(button.textContent, /Downloads|1970|ago/);
    assert.equal(button.hasAttribute("title"), false);
    assert.ok(!button.querySelector("[title]"));
    const detail = document.getElementById(button.getAttribute("aria-describedby"));
    assert.equal(detail.getAttribute("role"), "tooltip");
    assert.equal(detail.hidden, true);
    assert.ok(detail.textContent.includes(`Location: ${files[index].path}`));
    assert.ok(detail.textContent.includes(`Last opened: ${new Date(1).toLocaleDateString()}`));
  }
});

test("complete-list collisions share the same context in visible labels, opening, removal and retry names", t => {
  const files = [recent("/Team A/shared/notes/plan.md"),
    ...Array.from({ length: 50 }, (_, i) => recent(`/other/${i}.md`)),
    recent("/Team B/shared/notes/plan.md")];
  const view = mount(t, files, { recovery: { path: files[0].path, retryDisabled: false }, onRetry() {} });
  const first = rows(view.host)[0];
  const last = rows(view.host).at(-1);
  for (const [row, team] of [[first, "Team A"], [last, "Team B"]]) {
    const context = `${team} › shared › notes`;
    assert.ok(openButton(row).textContent.includes(context));
    for (const button of row.querySelectorAll("button")) assert.ok(button.getAttribute("aria-label").includes(context));
  }
  assert.match(first.textContent, /Unavailable/);
});

test("filename fallbacks, generic titles, extensions and unbroken strings survive indexing", t => {
  const files = ["Untitled.md", "Untitled 4.md", "notes.md", "notes(1).md", "draft.markdown", "script.fountain", `${"x".repeat(240)}(1).md`]
    .map(name => recent(`/Documents/${name}`));
  const view = mount(t, files);
  const buttons = rows(view.host).map(openButton);
  focus(buttons[1]);
  for (const [i, button] of buttons.entries()) assert.equal(button.textContent, files[i].name);
  const titles = [null, "hello", "notes", "Untitled", "Markdown rendering check", "*Fountain title*", "Unbroken".repeat(60)];
  view.render({ details: new Map(files.map((file, i) => [file.path, { title: titles[i], section: null }])) });
  assert.ok(document.activeElement === buttons[1]);
  assert.ok(openButton(rows(view.host)[1]) === buttons[1]);
  assert.equal(buttons[2].textContent, "notes.md", "the shared title rule removes its own filename fallback");
  assert.ok(buttons[3].textContent.startsWith("Untitled"), "no generic-title blacklist");
  for (const [i, button] of buttons.entries()) assert.ok(button.textContent.includes(files[i].name));
});

test("focus describes without opening; Escape dismisses once; opening and unavailable retry still work", async t => {
  const files = [recent("/notes.md"), recent("/missing.md")];
  const opened = [], retried = [];
  const view = mount(t, files, { onOpen: path => opened.push(path), onRetry: () => retried.push(true),
    recovery: { path: files[1].path, retryDisabled: false } });
  const [healthy, unavailable] = rows(view.host).map(openButton);
  focus(healthy);
  assert.equal(opened.length, 0);
  assert.equal(visibleTooltip().id, healthy.getAttribute("aria-describedby"));
  assert.equal(visibleTooltip().querySelectorAll("button, a, [tabindex]").length, 0);
  assert.equal(pressKey("Escape").defaultPrevented, true);
  assert.ok(!visibleTooltip());
  assert.ok(document.activeElement === healthy);
  assert.equal(pressKey("Escape").defaultPrevented, false, "a closed tooltip does not consume app Escape");
  click(healthy);
  assert.deepEqual(opened, [files[0].path]);
  click(unavailable);
  assert.deepEqual(opened, [files[0].path]);
  assert.equal(unavailable.tabIndex, -1);
  const retry = view.host.querySelector('[aria-label="Retry opening missing.md"]');
  focus(retry);
  assert.ok(visibleTooltip().textContent.includes(files[1].path), "the existing Retry tab stop also exposes unavailable details");
  click(retry);
  assert.ok(document.activeElement === unavailable);
  assert.equal(retried.length, 1);
  view.render({ openingPath: files[1].path });
  assert.match(rows(view.host)[1].textContent, /Opening…/);
  assert.equal(retry.disabled, true);
  assert.equal(rows(view.host)[1].querySelector('[aria-label^="Remove"]').disabled, true);
  await wait(170);
});

test("hover waits, survives the pointer crossing onto details, and cleans up after leaving/removal", async t => {
  const file = recent("/A long folder/notes.md");
  const view = mount(t, [file]);
  const button = openButton(rows(view.host)[0]);
  pointer(button, "pointerover");
  assert.ok(!visibleTooltip());
  assert.equal(pressKey("Escape").defaultPrevented, false, "pending hover is cancelled without consuming the app's Escape");
  await wait(480);
  assert.ok(!visibleTooltip(), "the pending delay cannot reopen after Escape");
  pointer(button, "pointerout", document.body);
  pointer(button, "pointerover");
  await wait(480);
  const tooltip = visibleTooltip();
  assert.ok(tooltip);
  pointer(button, "pointerout", tooltip);
  pointer(tooltip, "pointerover", button);
  await wait(170);
  assert.ok(visibleTooltip() === tooltip);
  pointer(tooltip, "pointerout", document.body);
  await wait(170);
  assert.ok(!visibleTooltip());
  focus(button);
  assert.ok(visibleTooltip());
  view.render({ files: [] });
  assert.ok(!visibleTooltip());
  assert.ok(!document.querySelector('[role="tooltip"]'));
});

test("hover details yield Escape to a newly opened modal", async t => {
  const view = mount(t, [recent("/notes.md")]);
  const button = openButton(rows(view.host)[0]);
  pointer(button, "pointerover");
  await wait(480);
  assert.ok(visibleTooltip());
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = '<button>Close Search</button>';
  document.body.append(modal);
  t.after(() => modal.remove());
  focus(modal.querySelector("button"));
  assert.equal(pressKey("Escape").defaultPrevented, false);
  assert.ok(!visibleTooltip());
});

test("bounded details can be paged from the focused row without another tab stop", t => {
  const view = mount(t, [recent(`/long/${"nested/".repeat(20)}notes.md`)]);
  const button = openButton(rows(view.host)[0]);
  focus(button);
  const details = visibleTooltip();
  // Happy DOM has no layout; model the overflow measured by the native fixture.
  Object.defineProperties(details, {
    clientHeight: { configurable: true, value: 80 },
    scrollHeight: { configurable: true, value: 480 },
  });
  assert.equal(pressKey("PageDown").defaultPrevented, true);
  assert.ok(details.scrollTop > 0, "paging reaches details below the fold");
  const paged = details.scrollTop;
  assert.equal(pressKey("PageUp").defaultPrevented, true);
  assert.ok(details.scrollTop < paged);
  for (let i = 0; i < 12; i++) pressKey("PageDown");
  assert.equal(details.scrollTop, details.scrollHeight - details.clientHeight, "the end containing Last opened is reachable");
  assert.ok(document.activeElement === button);
  assert.equal(details.querySelectorAll("button, a, [tabindex]").length, 0);
  const end = details.scrollTop;
  assert.equal(pressKey("PageUp", { altKey: true }).defaultPrevented, false, "modified app/platform keys retain ownership");
  assert.equal(details.scrollTop, end);
  pressKey("Escape");
  assert.equal(pressKey("PageDown").defaultPrevented, false, "closed details do not intercept paging");
  const outside = document.createElement("button");
  document.body.append(outside);
  t.after(() => outside.remove());
  focus(outside);
  focus(button);
  assert.equal(details.scrollTop, 0, "reopening starts at the full location");
  Object.defineProperty(details, "clientHeight", { value: 480 });
  assert.equal(pressKey("PageDown").defaultPrevented, false, "ordinary non-overflowing rows retain normal paging");
});

test("moving directly between rows hides stale details throughout the next hover delay", async t => {
  const files = [recent("/alpha/notes.md"), recent("/beta/notes.md")];
  const opened = [];
  const view = mount(t, files, { onOpen: path => opened.push(path) });
  const [a, b] = rows(view.host).map(openButton);
  pointer(a, "pointerover");
  await wait(480);
  assert.ok(visibleTooltip().textContent.includes(files[0].path));
  pointer(a, "pointerout", b);
  pointer(b, "pointerover", a);
  assert.ok(!visibleTooltip(), "row A's details cannot be attributed to row B");
  await wait(200);
  assert.ok(!visibleTooltip());
  await wait(300);
  assert.ok(visibleTooltip().textContent.includes(files[1].path));
  click(b);
  assert.deepEqual(opened, [files[1].path]);
});

test("pointer focus does not flash details, including a held press; keyboard focus still shows them", async t => {
  const file = recent("/notes.md");
  const opened = [];
  const view = mount(t, [file], { onOpen: path => opened.push(path) });
  const button = openButton(rows(view.host)[0]);
  pointer(button, "pointerover");
  pointer(button, "pointerdown");
  focus(button);
  assert.ok(!visibleTooltip());
  await wait(480);
  assert.ok(!visibleTooltip(), "holding a press cannot fire the hover delay");
  assert.deepEqual(opened, []);
  // Release outside the trigger so a later keyboard focus is not mistaken for a press.
  pointer(document.body, "pointerup");
  click(button);
  assert.deepEqual(opened, [file.path]);
  const outside = document.createElement("button");
  document.body.append(outside);
  t.after(() => outside.remove());
  focus(outside);
  focus(button);
  assert.ok(visibleTooltip());
});

test("Drafts discloses its shared directory once and keeps numbered names and recovery actions", t => {
  const docs = [
    prepareCatalogDocument({ ...recent("/Documents/Bindars Drafts/Untitled.md"), relPath: "Untitled.md", sources: ["draft"] }, ""),
    prepareCatalogDocument({ ...recent("/Documents/Bindars Drafts/Untitled 2.md"), relPath: "Untitled 2.md", sources: ["draft"] }, "hello"),
  ];
  docs[1].problem = "Could not read this draft.";
  docs[1].coverage = "missing";
  const opened = [];
  const view = renderComponent(Sidebar, { visible: true, recentFiles: [], currentFilePath: null, openingPath: null,
    docs, workspaceRootPath: null, workspaceState: { status: "ready", draftsRootPath: "/Documents/Bindars Drafts" }, onOpenWorkspacePath: path => opened.push(path),
    onOpenCommandPalette() {}, onReindexWorkspace() {}, onFindNotes() {} });
  t.after(view.cleanup);
  click(view.host.querySelector("#navigation-tab-Drafts"));
  const details = view.host.querySelectorAll(".navigation-help > details.document-location");
  assert.equal(details.length, 1);
  assert.equal(details[0].querySelector("p").textContent, "/Documents/Bindars Drafts");
  assert.equal(details[0].closest("li"), null);
  assert.equal(view.host.querySelectorAll(".document-list li:first-child details").length, 0, "healthy drafts have no repeated disclosure");
  assert.equal(view.host.querySelector(".document-problem details p").textContent, docs[1].path, "recovery keeps the affected file's complete path");
  const buttons = [...view.host.querySelectorAll(".document-open")];
  assert.equal(buttons[0].textContent, "Untitled.md");
  assert.equal(buttons[1].textContent, "helloUntitled 2.md");
  assert.match(view.host.querySelector(".document-problem").textContent, /Retry.*Reconnect notes/);
  click(buttons[1]);
  assert.deepEqual(opened, [docs[1].path]);
  view.render({ docs: [] });
  assert.equal(view.host.querySelectorAll("details.document-location").length, 1, "an empty known drafts folder still has its location");
  view.render({ docs, workspaceState: { status: "ready", draftsRootPath: null } });
  assert.equal(view.host.querySelectorAll(".navigation-help > details.document-location").length, 0, "a file's parent is not a substitute for an unknown drafts root");
});
