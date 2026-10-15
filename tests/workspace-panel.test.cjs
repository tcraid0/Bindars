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
            readFailedCount: 0,
            complexitySkippedCount: 0,
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
  await act(async () => button("Remove from Sidebar").click());
  assert.equal(removed, 1);
  assert.match(host.textContent, /Its files and your notes are unchanged/);
  assert.ok(button("Add Folder…"));
  assert.ok(button("Add Back"));
  await act(async () => button("Add Folder…").click());
  assert.ok(button("Add Back"));
  await act(async () => button("Add Back").click());
  assert.equal(restored, "/project");
  assert.match(host.textContent, /folder.md/);
  await act(async () => button("Remove from Sidebar").click());
  nextFolder = "/replacement";
  await act(async () => button("Add Folder…").click());
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

test("background rechecks are visible but never announced through a live region", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (status) =>
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
          workspaceState: { status, directories: [], readFailedCount: 1, complexitySkippedCount: 0 },
          docs: [],
          onChooseWorkspaceRoot() {},
          onClearWorkspaceRoot() {},
          onOpenCommandPalette() {},
          onOpenRecent() {},
          onRemoveRecent() {},
          onReindexWorkspace() {},
          onOpenWorkspacePath() {},
        }),
      ),
    );
  await act(async () => render("indexing"));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const live = () =>
    [...host.querySelectorAll('[role="status"], [aria-live]')].map((node) => node.textContent).join(" ");
  assert.match(host.textContent, /Checking documents…/);
  assert.doesNotMatch(live(), /Checking documents/);
  await act(async () => render("ready"));
  assert.match(host.textContent, /limited search coverage/);
  assert.doesNotMatch(live(), /limited search coverage/);
});
