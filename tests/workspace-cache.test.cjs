const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWorkspaceStateFromCache,
  buildWorkspaceErrorState,
  buildWorkspaceRefreshErrorState,
  LEGACY_WORKSPACE_INDEX_CACHE_KEYS,
  isWorkspaceIndexCache,
  WORKSPACE_INDEX_CACHE_KEY,
  WORKSPACE_INDEX_CACHE_VERSION,
} = require("../.tmp/workspace-tests/src/lib/workspace-index.js");

function makeDoc(name) {
  return {
    path: `/workspace/${name}`,
    relPath: name,
    name,
    title: name,
    headings: [],
    bodyText: "",
    links: [],
    scenes: [],
  };
}

test("workspace index cache version invalidates entries built under older heading ids or complexity policy", () => {
  assert.equal(WORKSPACE_INDEX_CACHE_VERSION, 8);
  assert.equal(WORKSPACE_INDEX_CACHE_KEY, "workspace:index:v8");
  assert.ok(LEGACY_WORKSPACE_INDEX_CACHE_KEYS.includes("workspace:index:v7"));
  assert.ok(LEGACY_WORKSPACE_INDEX_CACHE_KEYS.includes("workspace:index:v5"));
  assert.ok(LEGACY_WORKSPACE_INDEX_CACHE_KEYS.includes("workspace:index:v6"));
});

test("buildWorkspaceStateFromCache restores cached diagnostics", () => {
  const state = buildWorkspaceStateFromCache({
    version: WORKSPACE_INDEX_CACHE_VERSION,
    rootPath: "/workspace",
    indexedAt: 1234,
    fileCount: 4,
    docs: [makeDoc("a.md"), makeDoc("b.md")],
    readFailedCount: 1,
    complexitySkippedCount: 1,
    listSkippedCount: 2,
    limitHit: true,
  });

  assert.deepEqual(state, {
    rootPath: "/workspace",
    status: "ready",
    fileCount: 4,
    processedCount: 4,
    indexedCount: 2,
    indexedAt: 1234,
    error: null,
    listSkippedCount: 2,
    readFailedCount: 1,
    complexitySkippedCount: 1,
    limitHit: true,
  });
});

test("buildWorkspaceErrorState preserves diagnostics for the same root", () => {
  const previous = {
    rootPath: "/workspace",
    status: "ready",
    fileCount: 4,
    processedCount: 4,
    indexedCount: 3,
    indexedAt: 1234,
    error: null,
    listSkippedCount: 2,
    readFailedCount: 1,
    complexitySkippedCount: 1,
    limitHit: true,
  };

  assert.deepEqual(buildWorkspaceErrorState(previous, "/workspace", "network unavailable"), {
    ...previous,
    status: "error",
    error: "network unavailable",
  });
});

test("buildWorkspaceErrorState clears diagnostics for a different root", () => {
  const previous = {
    rootPath: "/workspace",
    status: "ready",
    fileCount: 4,
    processedCount: 4,
    indexedCount: 3,
    indexedAt: 1234,
    error: null,
    listSkippedCount: 2,
    readFailedCount: 1,
    limitHit: true,
  };

  assert.deepEqual(buildWorkspaceErrorState(previous, "/other", "missing"), {
    rootPath: "/other",
    status: "error",
    fileCount: 0,
    processedCount: 0,
    indexedCount: 0,
    indexedAt: null,
    error: "missing",
    listSkippedCount: 0,
    readFailedCount: 0,
    complexitySkippedCount: 0,
    limitHit: false,
  });
});

test("buildWorkspaceRefreshErrorState prefers last-good diagnostics over in-progress counters", () => {
  const previous = {
    rootPath: "/workspace",
    status: "indexing",
    fileCount: 4,
    processedCount: 0,
    indexedCount: 0,
    indexedAt: 1234,
    error: null,
    listSkippedCount: 2,
    readFailedCount: 0,
    complexitySkippedCount: 0,
    limitHit: true,
  };
  const lastGood = {
    rootPath: "/workspace",
    status: "ready",
    fileCount: 4,
    processedCount: 4,
    indexedCount: 3,
    indexedAt: 1234,
    error: null,
    listSkippedCount: 2,
    readFailedCount: 1,
    complexitySkippedCount: 1,
    limitHit: true,
  };

  assert.deepEqual(buildWorkspaceRefreshErrorState(previous, lastGood, "/workspace", "network unavailable"), {
    ...lastGood,
    status: "error",
    error: "network unavailable",
  });
});

test("buildWorkspaceRefreshErrorState ignores last-good diagnostics from another root", () => {
  const previous = {
    rootPath: "/other",
    status: "indexing",
    fileCount: 0,
    processedCount: 0,
    indexedCount: 0,
    indexedAt: null,
    error: null,
    listSkippedCount: 0,
    readFailedCount: 0,
    complexitySkippedCount: 0,
    limitHit: false,
  };
  const lastGood = {
    rootPath: "/workspace",
    status: "ready",
    fileCount: 4,
    processedCount: 4,
    indexedCount: 3,
    indexedAt: 1234,
    error: null,
    listSkippedCount: 2,
    readFailedCount: 1,
    complexitySkippedCount: 1,
    limitHit: true,
  };

  assert.deepEqual(buildWorkspaceRefreshErrorState(previous, lastGood, "/other", "missing"), {
    rootPath: "/other",
    status: "error",
    fileCount: 0,
    processedCount: 0,
    indexedCount: 0,
    indexedAt: null,
    error: "missing",
    listSkippedCount: 0,
    readFailedCount: 0,
    complexitySkippedCount: 0,
    limitHit: false,
  });
});


function validCache() {
  return {
    version: WORKSPACE_INDEX_CACHE_VERSION, rootPath: '/workspace', indexedAt: 1234,
    fileCount: 1, docs: [makeDoc('good.md')], readFailedCount: 0,
    complexitySkippedCount: 0, listSkippedCount: 0, limitHit: false,
  };
}

test('current cache survives a JSON round trip and restores complete and partial counts', () => {
  const cache = JSON.parse(JSON.stringify(validCache()));
  assert.equal(isWorkspaceIndexCache(cache, '/workspace'), true);
  cache.fileCount = 3;
  cache.readFailedCount = 1;
  cache.complexitySkippedCount = 1;
  assert.equal(isWorkspaceIndexCache(cache, '/workspace'), true);
  const state = buildWorkspaceStateFromCache(cache);
  assert.equal(state.processedCount, 3);
  assert.equal(state.indexedCount, 1);
  assert.equal(state.readFailedCount, 1);
  assert.equal(state.complexitySkippedCount, 1);
  assert.equal(isWorkspaceIndexCache(cache, '/different'), false);
});

for (const [label, mutate] of [
  ['previous version', c => { c.version = 7; }],
  ['invalid timestamp', c => { c.indexedAt = Infinity; }],
  ['negative count', c => { c.readFailedCount = -1; }],
  ['fractional count', c => { c.fileCount = 1.5; }],
  ['incomplete snapshot', c => { c.fileCount = 2; }],
  ['invalid limit flag', c => { c.limitHit = 'yes'; }],
  ['null docs', c => { c.docs = null; }],
  ['null document', c => { c.docs = [null]; }],
  ['missing path', c => { delete c.docs[0].path; }],
  ['non-string title', c => { c.docs[0].title = {}; }],
  ['non-string body', c => { c.docs[0].bodyText = 42; }],
  ['null heading', c => { c.docs[0].headings = [null]; }],
  ['bad heading text', c => { c.docs[0].headings = [{id:'x',text:3}]; }],
  ['invalid links', c => { c.docs[0].links = [null]; }],
  ['null scene', c => { c.docs[0].scenes = [null]; }],
  ['invalid scene target', c => { c.docs[0].scenes = [{id:'x',label:'X',line:1,headingId:4}]; }],
]) {
  test(`derived cache rejects ${label} instead of salvaging an unsafe payload`, () => {
    const cache = validCache();
    mutate(cache);
    assert.equal(isWorkspaceIndexCache(cache, '/workspace'), false);
  });
}

test('missing or non-object caches are safe misses', () => {
  for (const value of [null, undefined, [], 1, 'cache']) {
    assert.equal(isWorkspaceIndexCache(value, '/workspace'), false);
  }
});
