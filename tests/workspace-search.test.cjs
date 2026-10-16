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

test('matching respects whole Unicode case folds and punctuation expansions in both searches', () => {
  const {phraseMatches} = require('../.tmp/workspace-tests/src/lib/search-text.js');
  for (const [text, query, expected] of [['İ', 'i', 0], ['İ', 'i̇', 1], ['—', '--', 0], ['—', '---', 1], ['😀', '😀', 1]]) {
    const docs = [makeDoc('/a.md', 'A', text)];
    assert.equal(searchWorkspaceDocs(docs, query, new Map()).length, expected, query);
    assert.equal(phraseMatches(text, query).length, expected, query);
  }
});
test('recent boosts do not move nearby or scattered terms ahead of exact phrases', () => {
  const docs = [makeDoc('/a.md', 'A', 'refund policy'), makeDoc('/b.md', 'B', 'policy about refund'), makeDoc('/c.md', 'C', 'refund\npolicy')];
  const results = searchWorkspaceDocs(docs, 'refund policy', createRecentBoostMap(['/c.md','/b.md']));
  assert.deepEqual(results.map(hit => hit.path), ['/a.md','/b.md','/c.md']);
});

test('later nearby terms outrank scattered matches despite distant first occurrences', () => {
  const nearby = makeDoc('/near.md', null, 'Payment ' + 'ordinary explanation '.repeat(18) + 'refund payment terms apply.');
  const exact = makeDoc('/exact.md', null, 'Payment refund terms apply.');
  const scattered = makeDoc('/far.md', null, 'Payment ' + 'ordinary explanation '.repeat(18) + 'refund terms apply.');
  const hits = searchWorkspaceDocs([scattered, nearby, exact], 'payment refund', new Map());
  assert.deepEqual(hits.map(hit => hit.path), ['/exact.md', '/near.md', '/far.md']);
  assert.equal(hits[1].passages[0].phrase, 'refund payment');
  assert.equal(hits[1].passages[0].findQuery, undefined);
  assert.match(hits[1].passages[0].snippet, /refund payment terms apply/);
  assert.equal(hits[2].passageCount, 0);
});

for (const [query, body, expected] of [
  ['payment refund', 'Payment about a refund; later refund payment.', 'refund payment'],
  ['refund refund payment', 'Payment about refund.', 'payment about refund'],
  ['"refund policy" payment', 'Payment ' + 'detail '.repeat(40) + 'refund policy payment.', 'refund policy payment'],
  ['refund 😀', '😀 ' + 'detail '.repeat(40) + 'Refund 😀.', 'refund 😀'],
  ['refund ---', '— ' + 'detail '.repeat(40) + 'Refund —.', 'refund ---'],
  ['refund i̇', 'İ ' + 'detail '.repeat(40) + 'Refund İ.', 'refund i̇'],
]) {
  test(`nearby windows preserve phrases, duplicate terms and Unicode: ${query}`, () => {
    const hit = searchWorkspaceDocs([makeDoc('/a.md', null, body)], query, new Map())[0];
    assert.equal(hit.passages[0].phrase, expected);
  });
}

test('nearby matching cannot cross blocks or partial punctuation expansions', () => {
  const doc = makeDoc('/a.md', null, 'refund\npayment\nRefund —.');
  assert.equal(searchWorkspaceDocs([doc], 'refund payment', new Map())[0].passageCount, 0);
  assert.deepEqual(searchWorkspaceDocs([doc], 'refund --', new Map()), []);
});

test('heading fallback covers code-formatted headings and headings beyond the body ceiling', () => {
  const { buildWorkspaceDoc } = require('../.tmp/workspace-tests/src/lib/workspace-index.js');
  for (const [source, query, heading] of [
    ['# Install `npm` first\n\nBody.', 'install npm', 'install-npm-first'],
    ['word '.repeat(7000) + '\n\n## Late heading here\n\nAfter', 'late heading', 'late-heading-here'],
  ]) {
    const doc = buildWorkspaceDoc({ path: '/a.md', name: 'a.md', relPath: 'a.md' }, source);
    const hit = searchWorkspaceDocs([doc], query, new Map())[0];
    assert.equal(hit.headingId, heading);
    assert.equal(hit.passages.length, 0);
  }
});
