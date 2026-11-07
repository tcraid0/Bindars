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
            return chosen;
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
  await act(async () => button("Folder options").click());
  await act(async () => button("Remove from Sidebar").click());
  assert.equal(document.activeElement.id, "navigation-tab-Folders");
  assert.equal(removed, 1);
  assert.match(host.textContent, /Its files and your notes are unchanged/);
  assert.ok(button("Add Folder…"));
  assert.ok(button("Add Back"));
  await act(async () => button("Add Folder…").click());
  assert.ok(button("Add Back"));
  await act(async () => button("Add Back").click());
  assert.equal(restored, "/project");
  assert.match(host.textContent, /folder.md/);
  await act(async () => button("Folder options").click());
  await act(async () => button("Remove from Sidebar").click());
  assert.equal(document.activeElement.id, "navigation-tab-Folders");
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

const { renderComponent, buttonWithText, click, focus, pressKey } = require('./_helpers/component-view.cjs');
const { pointerClick } = require('./_helpers/pointer.cjs');
const defaults = {
  visible: true, recentFiles: [], currentFilePath: null, openingPath: null,
  workspaceRootPath: 'C:\\Research',
  workspaceState: { status: 'ready', directories: ['Interviews', 'Interviews\\November', 'Other'], readFailedCount: 0, complexitySkippedCount: 0 },
  docs: [{ path: 'C:\\Research\\Interviews\\November\\one.md', relPath: 'Interviews\\November\\one.md', name: 'one.md', title: 'Readable title', sources: ['folder'] }],
  onChooseWorkspaceRoot() {}, onClearWorkspaceRoot() {}, onOpenCommandPalette() {},
  onOpenRecent() {}, onRemoveRecent() {}, onReindexWorkspace() {}, onOpenWorkspacePath() {},
};

for (const initialRoot of [null, '/original']) {
  for (const selection of ['/different-folder', null]) {
    test(`${initialRoot ? 'replacing' : 'adding'} a folder ${selection ? 'hands focus to the surviving Folders tab' : 'keeps opener focus on cancellation'}`, async t => {
      let resolveChoice;
      const choice = new Promise(resolve => { resolveChoice = resolve; });
      function Fixture() {
        const [root, setRoot] = React.useState(initialRoot);
        return React.createElement(Sidebar, { ...defaults, workspaceRootPath: root,
          async onChooseWorkspaceRoot() {
            const selected = await choice;
            if (selected) setRoot(selected);
            return selected;
          },
        });
      }
      const view = renderComponent(Fixture);
      t.after(view.cleanup);
      const tab = view.host.querySelector('#navigation-tab-Folders');
      click(tab);
      const opener = buttonWithText(view.host, initialRoot ? 'Folder options' : 'Add Folder…');
      focus(opener); click(opener);
      if (initialRoot) click(buttonWithText(view.host, 'Choose another folder…'));
      assert.ok(document.activeElement === opener, 'the picker leaves focus on its opener while pending');
      await act(async () => resolveChoice(selection));
      if (selection) {
        assert.equal(view.host.querySelector('#navigation-folder-name').textContent, 'different-folder');
        assert.ok(!opener.isConnected, 'the old Add Folder or keyed options trigger was removed');
        assert.ok(document.activeElement === tab, 'focus survives the selected folder mounting');
      } else {
        assert.ok(opener.isConnected);
        assert.ok(document.activeElement === opener);
      }
    });
  }
}

test('a completed folder choice does not take focus from another control', async t => {
  let resolveChoice;
  const choice = new Promise(resolve => { resolveChoice = resolve; });
  const view = renderComponent(Sidebar, { ...defaults,
    async onChooseWorkspaceRoot() { const selected = await choice; view.render({ workspaceRootPath: selected }); return selected; },
  });
  t.after(view.cleanup);
  click(view.host.querySelector('#navigation-tab-Folders'));
  click(buttonWithText(view.host, 'Folder options'));
  click(buttonWithText(view.host, 'Choose another folder…'));
  const search = buttonWithText(view.host, 'Search documents…');
  focus(search);
  await act(async () => resolveChoice('/different-folder'));
  assert.ok(document.activeElement === search);
});

test('folder breadcrumbs keep the chosen directory, expose ancestors and full paths, and leave sensible keyboard focus', t => {
  const opened = [];
  const view = renderComponent(Sidebar, { ...defaults, onOpenWorkspacePath: path => opened.push(path) });
  t.after(view.cleanup);
  click(view.host.querySelector('#navigation-tab-Folders'));
  assert.ok(view.host.querySelector('[aria-label="Folder location"]') === null, 'the root is named once, without a redundant breadcrumb');
  click(buttonWithText(view.host, '▸ Interviews'));
  click(buttonWithText(view.host, '▸ November'));
  assert.equal(document.activeElement.getAttribute('role'), 'tabpanel');
  assert.equal(document.activeElement.getAttribute('aria-describedby'), 'navigation-folder-breadcrumbs');
  const crumbs = view.host.querySelector('nav');
  assert.equal(crumbs.querySelector('[aria-current]').textContent, 'November');
  assert.deepEqual([...crumbs.querySelectorAll('button')].map(b => b.textContent), ['Research', 'Interviews']);
  assert.equal(view.host.querySelector('.document-open strong').textContent, 'one.md', 'Folders keeps filenames primary');
  click(buttonWithText(view.host, 'one.md'));
  assert.deepEqual(opened, [defaults.docs[0].path]);
  view.render({ currentFilePath: 'C:\\Research\\Other\\elsewhere.md' });
  assert.equal(view.host.querySelector('nav [aria-current]').textContent, 'November');
  click(buttonWithText(view.host, 'Folder options'));
  assert.equal(document.activeElement.textContent, 'Choose another folder…');
  assert.ok(!view.host.querySelector('[role="menu"]'));
  assert.match(view.host.querySelector('.folder-options').textContent, /C:\\Research/);
  assert.match(view.host.querySelector('.folder-options').textContent, /C:\/Research\/Interviews\/November/);
  pressKey('Escape');
  assert.ok(view.host.querySelector('.folder-options') === null);
  assert.equal(document.activeElement.textContent, 'Folder options');
  click(buttonWithText(crumbs, 'Interviews'));
  assert.equal(view.host.querySelector('nav [aria-current]').textContent, 'Interviews');
  assert.equal(document.activeElement.getAttribute('role'), 'tabpanel');
  click(buttonWithText(view.host.querySelector('nav'), 'Research'));
  assert.ok(view.host.querySelector('nav') === null);
});

test('folder options follow the shared outside-click and focus dismissal pattern', t => {
  const view = renderComponent(Sidebar, defaults);
  t.after(view.cleanup);
  click(view.host.querySelector('#navigation-tab-Folders'));
  const trigger = buttonWithText(view.host, 'Folder options');
  const outside = document.createElement('button'); document.body.append(outside);
  t.after(() => outside.remove());
  focus(trigger); click(trigger);
  act(() => pointerClick(outside));
  assert.ok(view.host.querySelector('.folder-options') === null);
  focus(trigger); click(trigger);
  focus(outside);
  assert.ok(view.host.querySelector('.folder-options') === null);
  assert.ok(document.activeElement === outside);
});

test('folder and document pagination, errors, and discovery limits survive compact context', t => {
  let retries = 0;
  const docs = Array.from({ length: 103 }, (_, i) => ({ name: `doc-${i}.md`, path: `/project/doc-${i}.md`, relPath: `doc-${i}.md`, sources: ['folder'] }));
  const directories = Array.from({ length: 102 }, (_, i) => `Folder-${i}`);
  const view = renderComponent(Sidebar, { ...defaults, workspaceRootPath: '/project', docs,
    workspaceState: { ...defaults.workspaceState, directories, limitHit: true, error: 'Permission denied.', issues: ['Unreadable directory'] },
    onReindexWorkspace() { retries++; } });
  t.after(view.cleanup);
  click(view.host.querySelector('#navigation-tab-Folders'));
  assert.equal(view.host.querySelectorAll('.document-open').length, 200);
  click(buttonWithText(view.host, 'More folders'));
  click(buttonWithText(view.host, 'Show next 3 documents'));
  assert.equal(view.host.querySelectorAll('.document-open').length, 205);
  assert.match(view.host.textContent, /Only part of this folder is listed/);
  assert.match(view.host.textContent, /Unreadable directory/);
  click(buttonWithText(view.host, 'Retry'));
  assert.equal(retries, 1);
  click(buttonWithText(view.host, '▸ Folder-0'));
  view.render({ docs: [], workspaceState: { ...defaults.workspaceState, status: 'indexing', directories: [] } });
  assert.match(view.host.textContent, /Looking for documents/);
  view.render({ workspaceState: { ...defaults.workspaceState, directories: [] } });
  assert.match(view.host.textContent, /No supported documents/);
});
