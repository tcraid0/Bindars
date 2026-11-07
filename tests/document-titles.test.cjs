const test = require("node:test");
const assert = require("node:assert/strict");
const { renderComponent, click, focus } = require("./_helpers/component-view.cjs");
const { documentTitle } = require("../.tmp/workspace-tests/src/lib/document-title.js");
const { prepareCatalogDocument, discoveredDocument } = require("../.tmp/workspace-tests/src/lib/document-catalog.js");
const { searchWorkspaceDocs } = require("../.tmp/workspace-tests/src/lib/workspace-search.js");
const { RecentFiles } = require("../.tmp/workspace-tests/src/components/RecentFiles.js");
const { CommandPalette } = require("../.tmp/workspace-tests/src/components/CommandPalette.js");

const meta = (name = "notes.md") => ({ name, path: `/Research/${name}`, relPath: name });
const titleOf = doc => documentTitle(doc.name, doc.title, doc.sources?.includes("draft") ? doc.draftLabel : undefined);

test("display reuses parsed frontmatter, heading and Fountain titles, with filename and draft fallbacks", () => {
  for (const [name, content, expected] of [
    ["notes.md", "---\ntitle: '  November planning  '\n---\n# Another heading", "November planning"],
    ["notes.markdown", "# A **readable** heading\n\nBody", "A readable heading"],
    ["script.fountain", "Title: Night Train\nAuthor: Writer\n\nINT. TRAIN - NIGHT\n\nQuiet.", "Night Train"],
    ["notes.md", "Plain prose.", null],
    ["notes.md", "# notes", null],
    ["notes.md", "# notes.md", null],
    ["script.fountain", "INT. TRAIN - NIGHT\n\nQuiet.", null],
  ]) assert.equal(titleOf(prepareCatalogDocument(meta(name), content)), expected, name + content);
  const draft = prepareCatalogDocument({ ...meta(), sources: ["draft"] }, "Opening thought without a heading.");
  assert.equal(titleOf(draft), "Opening thought without a heading.");
  assert.equal(titleOf(discoveredDocument(meta())), null);
});

for (const welcome of [false, true]) {
  test(`delayed, duplicate and long titles preserve path identity, filenames, focus and opening (Home=${welcome})`, t => {
    const files = [meta(), { name: "other.md", path: "/Elsewhere/other.md" }].map(f => ({ ...f, openedAt: 1, lastHeadingId: null }));
    const opened = [];
    const view = renderComponent(RecentFiles, { files, welcome, currentFilePath: files[1].path,
      openingPath: null, onOpen: path => opened.push(path), onRemove() {} });
    t.after(view.cleanup);
    const buttons = [...view.host.querySelectorAll("[data-path] > div > button")];
    focus(buttons[0]);
    assert.equal(buttons[0].getAttribute("aria-label"), `Open notes.md${welcome ? ", Research" : ""}`);
    const title = "A long document title that helps a reader recognize their notes ".repeat(5).trim();
    view.render({ details: new Map(files.map(f => [f.path, { title, section: null }])) });
    assert.ok(document.activeElement === buttons[0], "indexing does not replace the focused button");
    for (const [i, button] of buttons.entries()) {
      assert.ok(button.textContent.startsWith(title));
      assert.ok(button.textContent.includes(files[i].name));
      assert.ok(button.getAttribute("aria-label").startsWith(`Open ${title}, ${files[i].name}`));
      click(button);
    }
    assert.deepEqual(opened, files.map(f => f.path));
    assert.deepEqual([...view.host.querySelectorAll("[data-path]")].map(row => row.dataset.path), files.map(f => f.path));
    assert.equal(buttons[1].getAttribute("aria-current"), "page");
    assert.equal(files[0].name, "notes.md", "display never overwrites a filename");
  });
}

test("Search keeps the same label for name, title, body and empty queries without repeating its title as a snippet", t => {
  const doc = prepareCatalogDocument(meta("meeting-v2.md"), "# November planning\n\nFollow up on the interview findings.");
  const opened = [];
  const view = renderComponent(CommandPalette, { visible: true, query: "", results: [], selectedIndex: 0,
    status: "ready", pending: false, onQueryChange() {}, onClose() {}, onOpenHit: hit => opened.push(hit), onHoverIndex() {} });
  t.after(view.cleanup);
  for (const query of ["", "meeting", "November", "interview"]) {
    const results = searchWorkspaceDocs([doc], query, new Map());
    view.render({ query, results });
    const row = document.querySelector('[role="option"]');
    assert.equal(row.querySelector("strong").textContent, "November planning");
    assert.match(row.textContent, /meeting-v2.md · Research/);
    assert.equal([...row.querySelectorAll("p")].filter(p => p.textContent === "November planning").length, 0);
    if (query === "interview") {
      assert.match(row.textContent, /Follow up on the interview findings/);
      assert.match(row.textContent, /1 matching passage/);
    }
    click(row);
    assert.equal(opened.at(-1), results[0], "the hit and its passage are passed through unchanged");
  }
  const draft = prepareCatalogDocument({ ...meta(), sources: ["draft"] }, "A thought to return to.");
  for (const query of ["", "notes", "thought"]) {
    view.render({ query, results: searchWorkspaceDocs([draft], query, new Map()) });
    assert.equal(document.querySelector('[role="option"] strong').textContent, "A thought to return to.");
  }
  view.render({ results: searchWorkspaceDocs([discoveredDocument(meta())], "notes", new Map()) });
  const row = document.querySelector('[role="option"]');
  assert.equal(row.querySelector("strong").textContent, "notes.md");
  assert.equal(row.textContent.match(/notes.md/g).length, 1);
});
