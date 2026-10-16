const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cachedDocuments,
  buildSearchCache,
  retainCachedDocuments,
  CACHE_MAX_CHARS,
  CACHE_MAX_DOCS,
} = require("../.tmp/workspace-tests/src/lib/search-cache.js");
const {
  prepareCatalogDocument,
} = require("../.tmp/workspace-tests/src/lib/document-catalog.js");
const {
  MAX_WORKSPACE_BODY_CHARS,
} = require("../.tmp/workspace-tests/src/lib/workspace-limits.js");
const doc = prepareCatalogDocument(
  { path: "/a.md", name: "a.md", relPath: "a.md", size: 4, mtimeMs: 1 },
  "# A",
);

test("disposable cache survives a round trip without preferences", () => {
  const cache = JSON.parse(JSON.stringify(buildSearchCache([doc])));
  assert.equal(cache.version, 2);
  assert.deepEqual(cachedDocuments(cache), [doc]);
  assert.deepEqual(Object.keys(cache), ["version", "docs"]);
});

for (const version of [undefined, 0, 1, 99]) {
  test(`unsupported extraction version is a safe cache miss: ${version}`, () => {
    assert.deepEqual(cachedDocuments({ version, docs: [doc] }), []);
  });
}

// Use the current envelope so version rejection cannot mask invalid entries.
for (const value of [
  null,
  {},
  [],
  { ...buildSearchCache([]), docs: [null] },
  buildSearchCache([{ ...doc, headings: [null] }]),
  buildSearchCache([{ ...doc, size: -1 }]),
  buildSearchCache([{ ...doc, bodyText: 4 }]),
]) {
  test(
    "malformed cache is a safe miss " + JSON.stringify(value).slice(0, 100),
    () => {
      assert.deepEqual(cachedDocuments(value), []);
    },
  );
}

test("cache bounds discard derived entries without changing the catalog", () => {
  const docs = Array.from({ length: 200 }, (_, i) => ({
    ...doc,
    path: `/${i}.md`,
    bodyText: "a".repeat(MAX_WORKSPACE_BODY_CHARS),
  }));
  const cache = buildSearchCache(docs);
  assert.ok(cache.docs.length < docs.length);
  assert.equal(docs.length, 200);
  assert.ok(JSON.stringify(cache).length < 3000100);
});

test("retained entries stay within the cache bounds, evicting the oldest first", () => {
  const { retainCachedDocuments, CACHE_MAX_CHARS } = require("../.tmp/workspace-tests/src/lib/search-cache.js");
  const known = new Map();
  const big = (path) => ({ ...doc, path, bodyText: "a".repeat(MAX_WORKSPACE_BODY_CHARS) });
  const count = Math.ceil(CACHE_MAX_CHARS / MAX_WORKSPACE_BODY_CHARS) + 3;
  retainCachedDocuments(known, Array.from({ length: count }, (_, i) => big(`/old/${i}.md`)));
  assert.ok(known.size < count && known.size > 0);
  assert.ok(!known.has("/old/0.md") && known.has(`/old/${count - 1}.md`));
  retainCachedDocuments(known, [big("/new/a.md")]);
  assert.ok(known.has("/new/a.md"));
  let chars = 0;
  for (const entry of known.values()) chars += JSON.stringify(entry).length;
  assert.ok(chars <= CACHE_MAX_CHARS);
  // Re-publishing an existing path refreshes its age instead of duplicating it.
  retainCachedDocuments(known, [{ ...big(`/old/${count - 1}.md`), title: "fresh" }]);
  assert.equal([...known.keys()].at(-1), `/old/${count - 1}.md`);
  assert.equal(known.get(`/old/${count - 1}.md`).title, "fresh");
});

const entryChars = docs => [...docs].reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);

for (const [name, source] of [
  ['YAML titles', '---\ntitle: ' + 'metadata '.repeat(15000) + '\n---\n\nTiny body.'],
  ['code-only headings', '# `' + 'h'.repeat(50000) + '`'],
]) {
  test(`whole-entry retention bounds real metadata-heavy documents: ${name}`, () => {
    const docs = Array.from({ length: 24 }, (_, i) => prepareCatalogDocument(
      { path: `/metadata-${i}.md`, name: 'a.md', relPath: 'a.md', size: source.length, mtimeMs: 1 }, source,
    ));
    assert.ok(docs.every(doc => doc.coverage === 'ready'));
    assert.ok(entryChars(docs) > CACHE_MAX_CHARS, 'fixture must exceed the whole-entry budget');
    const known = new Map();
    retainCachedDocuments(known, docs);
    assert.ok(known.size > 0 && known.size < docs.length);
    assert.ok(!known.has(docs[0].path));
    assert.ok(known.has(docs.at(-1).path));
    assert.ok(entryChars(known.values()) <= CACHE_MAX_CHARS);
    const disk = buildSearchCache(docs);
    assert.ok(entryChars(disk.docs) <= CACHE_MAX_CHARS);
    assert.deepEqual(cachedDocuments(JSON.parse(JSON.stringify(disk))), disk.docs);
  });
}

test('replacement metadata counts once, updates age and evicts older entries', () => {
  const docs = Array.from({ length: 4 }, (_, i) => ({ ...doc, path: `/${i}.md`, title: 't'.repeat(400000) }));
  const known = new Map();
  retainCachedDocuments(known, docs);
  const replacement = { ...docs[0], title: 'new', headings: [{ id: 'heading', text: 'h'.repeat(500000) }], links: ['l'.repeat(400000)] };
  retainCachedDocuments(known, [replacement]);
  assert.deepEqual([...known.keys()], ['/2.md', '/3.md', '/0.md']);
  assert.ok(known.get('/0.md') === replacement);
  assert.ok(entryChars(known.values()) <= CACHE_MAX_CHARS);
  retainCachedDocuments(known, [{ ...doc, path: '/0.md' }]);
  assert.equal(known.size, 3);
  assert.ok(entryChars(known.values()) < 900000, 'a smaller replacement releases its old cost');
});

test('an oversized entry is omitted without evicting other usable entries', () => {
  const huge = { ...doc, path: '/huge.md', title: 'x'.repeat(CACHE_MAX_CHARS) };
  const known = new Map();
  retainCachedDocuments(known, [doc, huge]);
  assert.deepEqual([...known.values()], [doc]);
  assert.deepEqual(buildSearchCache([huge, doc]).docs, [doc]);
  retainCachedDocuments(known, [{ ...huge, path: doc.path }]);
  assert.equal(known.size, 0, 'an oversized replacement must not leave stale text behind');
});

test('session and disk builders enforce the reader document-count ceiling', () => {
  // Deliberately minimal valid entries make the count cap bind before size.
  const small = { path: 'a', name: '', relPath: '', size: 0, mtimeMs: 0, coverage: 'ready', title: null, bodyText: '', headings: [], links: [], scenes: [] };
  const docs = Array.from({ length: CACHE_MAX_DOCS + 4 }, (_, i) => ({ ...small, path: String(i) }));
  assert.ok(entryChars(docs) < CACHE_MAX_CHARS);
  const known = new Map();
  retainCachedDocuments(known, docs);
  assert.equal(known.size, CACHE_MAX_DOCS);
  assert.ok(!known.has('0') && known.has(String(docs.length - 1)));
  const cache = buildSearchCache(docs);
  assert.equal(cache.docs.length, CACHE_MAX_DOCS);
  assert.deepEqual(cachedDocuments(cache), cache.docs);
});
