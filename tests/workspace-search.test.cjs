const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRecentBoostMap,
  searchWorkspaceDocs,
} = require("../.tmp/workspace-tests/src/lib/workspace-search.js");

function makeDoc(path, title, bodyText, headings = []) {
  return {
    path,
    relPath: path.replace(/^\/+/, ""),
    name: path.split("/").pop() ?? "doc.md",
    title,
    headings,
    bodyText,
    links: [],
    scenes: [],
  };
}

test("empty query returns recent files first", () => {
  const docs = [
    makeDoc("/workspace/alpha.md", "Alpha", "alpha body"),
    makeDoc("/workspace/beta.md", "Beta", "beta body"),
  ];
  const boost = createRecentBoostMap(["/workspace/beta.md", "/workspace/alpha.md"]);

  const results = searchWorkspaceDocs(docs, "", boost, 50);

  assert.equal(results.length, 2);
  assert.equal(results[0].path, "/workspace/beta.md");
  assert.equal(results[1].path, "/workspace/alpha.md");
});

test("title match outranks content match even with recent boost", () => {
  const docs = [
    makeDoc("/workspace/a.md", "Project Roadmap", "misc notes"),
    makeDoc("/workspace/b.md", "Scratchpad", "contains roadmap references in body"),
  ];
  const boost = createRecentBoostMap(["/workspace/b.md"]);

  const results = searchWorkspaceDocs(docs, "roadmap", boost, 10);

  assert.equal(results.length > 0, true);
  assert.equal(results[0].path, "/workspace/a.md");
  assert.equal(results[0].kind, "title");
});

test("heading hits include heading ids for direct navigation", () => {
  const docs = [
    makeDoc("/workspace/notes.md", "Notes", "body", [
      { id: "weekly-plan", text: "Weekly Plan" },
      { id: "backlog", text: "Backlog" },
    ]),
  ];
  const boost = createRecentBoostMap([]);

  const results = searchWorkspaceDocs(docs, "weekly", boost, 10);
  const headingHit = results.find((hit) => hit.kind === "heading");

  assert.ok(headingHit);
  assert.equal(headingHit.headingId, "weekly-plan");
});

for (const title of ['Annual plan', 'Budget-2026.md', null]) {
  test(`filename stays searchable alongside title ${JSON.stringify(title)}`, () => {
    const docs = [makeDoc('/workspace/finance/budget-2026.MD', title, 'Approved spending.')];
    const results = searchWorkspaceDocs(docs, 'budget-2026', new Map());
    assert.equal(results.filter(hit => hit.kind === 'title').length, 1);
    assert.equal(results[0].path, docs[0].path);
    assert.equal(searchWorkspaceDocs(docs, 'finance', new Map()).length, 0,
      'directory matching is not part of filename search');
  });
}

test('matching title and filename yield one file result; equal basenames retain distinct paths', () => {
  const docs = [
    makeDoc('/workspace/a/notes.md', 'Notes', ''),
    makeDoc('/workspace/b/notes.md', 'Notes', ''),
  ];
  const results = searchWorkspaceDocs(docs, 'notes', new Map());
  assert.deepEqual(results.map(hit => hit.path), docs.map(doc => doc.path));
});
