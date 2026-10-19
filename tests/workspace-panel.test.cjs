const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const {
  Sidebar,
} = require("../.tmp/workspace-tests/src/components/Sidebar.js");
const {
  ToastProvider,
} = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
test("folder list and global Recent are distinct; removal keeps an untimed Add Back", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let folder = "/project",
    removed = 0,
    restored,
    nextFolder = null;
  const render = () =>
    root.render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(Sidebar, {
          visible: true,
          recentFiles: [
            { path: "/outside/recent.md", name: "recent.md", openedAt: 1 },
          ],
          currentFilePath: null,
          openingPath: null,
          workspaceRootPath: folder,
          workspaceState: {
            status: "ready",
            directories: ["child"],
          },
          docs: [
            {
              path: "/project/folder.md",
              relPath: "folder.md",
              name: "folder.md",
              sources: ["folder"],
            },
          ],
          onClearWorkspaceRoot: () => {
            folder = null;
            removed++;
            render();
          },
          onRestoreFolder: (path) => {
            folder = path;
            restored = path;
            render();
          },
          onOpenCommandPalette() {},
          async onChooseWorkspaceRoot() {
            const chosen = await Promise.resolve(nextFolder);
            if (chosen) {
              folder = chosen;
              render();
            }
          },
          onOpenRecent() {},
          onRemoveRecent() {},
          onReindexWorkspace() {},
          onOpenWorkspacePath() {},
        }),
      ),
    );
  await act(async () => render());
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  assert.match(host.textContent, /recent.md/);
  assert.doesNotMatch(host.textContent, /folder.md/);
  await act(async () => host.querySelector("#navigation-tab-Folders").click());
  assert.match(host.textContent, /folder.md/);
  assert.doesNotMatch(host.textContent, /recent.md/);
  const button = (text) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  // Choose and Change are one element, so focus survives Remove and Add Back.
  const choose = button("Change Folder…");
  await act(async () => button("Remove from Sidebar").click());
  assert.equal(removed, 1);
  assert.match(host.textContent, /Removed ‘project’ from the sidebar\. Nothing was deleted\./);
  assert.ok(document.activeElement === choose);
  assert.equal(choose.textContent, "Choose Folder…");
  assert.ok(button("Add Back"));
  await act(async () => button("Choose Folder…").click());
  assert.ok(button("Add Back"));
  await act(async () => button("Add Back").click());
  assert.equal(restored, "/project");
  assert.match(host.textContent, /folder.md/);
  assert.ok(document.activeElement === choose);
  assert.equal(choose.textContent, "Change Folder…");
  await act(async () => button("Remove from Sidebar").click());
  nextFolder = "/replacement";
  await act(async () => button("Choose Folder…").click());
  assert.ok(!button("Add Back"));
  assert.match(host.textContent, /replacement/);
  const tab = host.querySelector("#navigation-tab-Folders");
  tab.focus();
  await act(async () =>
    tab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  assert.equal(document.activeElement.id, "navigation-tab-Drafts");
  assert.equal(
    host.querySelector('[role="tabpanel"]').getAttribute("aria-labelledby"),
    "navigation-tab-Drafts",
  );
});

function mountSidebar(t, props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (overrides = {}) =>
    root.render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(Sidebar, {
          visible: true,
          recentFiles: [],
          currentFilePath: null,
          openingPath: null,
          workspaceRootPath: "/project",
          docs: [],
          onChooseWorkspaceRoot() {},
          onClearWorkspaceRoot() {},
          onOpenCommandPalette() {},
          onOpenRecent() {},
          onRemoveRecent() {},
          onReindexWorkspace() {},
          onOpenWorkspacePath() {},
          ...props,
          ...overrides,
        }),
      ),
    );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const button = (text) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  const click = (node) => act(async () => node.click());
  return { host, render, button, click };
}

const folderState = (state = {}) => ({
  status: "ready",
  indexedAt: 1,
  directories: [],
  ...state,
});

test("only a first listing shows Checking documents…, never in a live region; rechecks stay quiet", async (t) => {
  const view = mountSidebar(t, {});
  const live = () =>
    [...view.host.querySelectorAll('[role="status"], [aria-live]')].map((node) => node.textContent).join(" ");
  await act(async () => view.render({ workspaceState: folderState({ status: "indexing", indexedAt: null }) }));
  await view.click(view.host.querySelector("#navigation-tab-Folders"));
  assert.match(view.host.textContent, /Checking documents…/);
  assert.match(view.host.textContent, /Looking for documents…/);
  assert.doesNotMatch(live(), /Checking documents/);
  await act(async () => view.render({ workspaceState: folderState() }));
  assert.doesNotMatch(view.host.textContent, /Checking documents|search coverage/);
  // A window-focus recheck keeps indexedAt and shows the last known answer.
  await act(async () => view.render({ workspaceState: folderState({ status: "indexing" }) }));
  assert.doesNotMatch(view.host.textContent, /Checking documents|Looking for/);
  assert.match(view.host.textContent, /No Markdown or Fountain documents in this folder\./);
});

test("Folders hides folders with no documents, puts content before notes, and names the way back after the parent", async (t) => {
  const doc = (relPath, extra = {}) => ({
    path: `/project/${relPath}`,
    relPath,
    name: relPath.split("/").pop(),
    sources: ["folder"],
    ...extra,
  });
  const view = mountSidebar(t, {
    workspaceState: folderState({
      directories: ["Empty", "Novel", "Novel/Notes", "Novel/Part 1"],
      limitHit: true,
      issues: ["Private — not allowed"],
    }),
    docs: [
      doc("Novel/Part 1/one.md"),
      doc("long.md", { coverage: "partial" }),
      doc("new.md", { coverage: "pending" }),
    ],
  });
  await act(async () => view.render());
  await view.click(view.host.querySelector("#navigation-tab-Folders"));
  const folders = () =>
    [...view.host.querySelectorAll('button[aria-label$=", folder"]')].map((row) => row.textContent);
  const heading = () => view.host.querySelector("h2").textContent;
  assert.equal(heading(), "project");
  assert.equal(view.host.querySelector("h2").title, "/project");
  assert.deepEqual(folders(), ["Novel ›"]);
  assert.ok(view.button("Change Folder…") && view.button("Remove from Sidebar"));
  assert.match(view.host.textContent, /Only part of this folder is listed\. Use Change Folder… to choose a folder inside it\./);
  assert.match(view.host.textContent, /Some places in this folder couldn't be opened/);
  assert.doesNotMatch(
    view.host.textContent,
    /Top folder|Folder location|What appears here|Preparing text search|characters searchable|search coverage/,
  );
  await view.click(view.host.querySelector('button[aria-label="Novel, folder"]'));
  assert.equal(heading(), "Novel");
  assert.deepEqual(folders(), ["Part 1 ›"]);
  assert.ok(view.button("‹ project"));
  assert.ok(!view.button("Change Folder…"), "folder actions stay at the folder's top");
  await view.click(view.host.querySelector('button[aria-label="Part 1, folder"]'));
  assert.equal(heading(), "Part 1");
  assert.match(view.host.textContent, /one\.md/);
  await view.click(view.button("‹ Novel"));
  assert.equal(heading(), "Novel");
  await view.click(view.button("‹ project"));
  assert.equal(heading(), "project");
  assert.ok(view.button("Change Folder…"));
  await view.click(view.host.querySelector("#navigation-tab-Recent"));
  assert.doesNotMatch(view.host.textContent, /too big to list/, "the folder's notices stay with the folder");
});

test("a missing recent document says what may have happened and offers Locate File…", async (t) => {
  const located = [];
  const view = mountSidebar(t, {
    workspaceRootPath: null,
    workspaceState: folderState(),
    recentFiles: [{ path: "/notes/gone.md", name: "gone.md", openedAt: 1 }],
    docs: [{ path: "/notes/gone.md", relPath: "gone.md", name: "gone.md", sources: ["recent"], coverage: "missing" }],
    onFindNotes: (path) => located.push(path),
  });
  await act(async () => view.render());
  assert.match(view.host.textContent, /Can't find gone\.md\. It may have been moved or deleted\./);
  await view.click(view.button("Locate File…"));
  assert.deepEqual(located, ["/notes/gone.md"]);
});

test("Drafts rows carry no repeated location disclosure", async (t) => {
  const view = mountSidebar(t, {
    workspaceRootPath: null,
    workspaceState: folderState(),
    docs: [{
      path: "/Documents/Bindars Drafts/Untitled.md",
      relPath: "Untitled.md",
      name: "Untitled.md",
      draftLabel: "Shopping list",
      sources: ["draft"],
    }],
  });
  await act(async () => view.render());
  await view.click(view.host.querySelector("#navigation-tab-Drafts"));
  assert.match(view.host.textContent, /Shopping list/);
  assert.ok(!view.host.querySelector("details"));
});

test("each listing's limit is reported in its own tab, and an incomplete listing never claims a folder is empty", async (t) => {
  const view = mountSidebar(t, {
    workspaceRootPath: "/Volumes/Backup/Writing",
    workspaceState: folderState({ directories: ["Private"], issues: ["Private — not allowed"], draftsLimitHit: true }),
  });
  await act(async () => view.render());
  await view.click(view.host.querySelector("#navigation-tab-Drafts"));
  assert.match(view.host.textContent, /Only some drafts are listed\. Use Open to open one that isn't shown\./);
  await view.click(view.host.querySelector("#navigation-tab-Folders"));
  assert.match(view.host.textContent, /In Volumes › Backup/, "the folder says where it is in words");
  assert.doesNotMatch(view.host.textContent, /Only part of this folder|Only some drafts/);
  assert.match(view.host.textContent, /No documents could be listed here\./);
  assert.doesNotMatch(view.host.textContent, /No Markdown or Fountain documents/);
  await act(async () => view.render({ workspaceState: folderState({ limitHit: true }) }));
  assert.match(view.host.textContent, /Only part of this folder is listed/);
  assert.match(view.host.textContent, /No documents could be listed here\./);
  await act(async () => view.render({ workspaceState: folderState() }));
  assert.match(view.host.textContent, /No Markdown or Fountain documents in this folder\./);
});
