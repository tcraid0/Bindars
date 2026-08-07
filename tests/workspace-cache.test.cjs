const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWorkspaceStateFromCache,
  buildWorkspaceErrorState,
  buildWorkspaceRefreshErrorState,
  LEGACY_WORKSPACE_INDEX_CACHE_KEYS,
  normalizeWorkspaceIndexCache,
  WORKSPACE_INDEX_CACHE_KEY,
  WORKSPACE_INDEX_CACHE_VERSION,
} = require("../.tmp/workspace-tests/src/lib/workspace-index.js");

function makeMeta(name) {
  return {
    path: `/workspace/${name}`,
    relPath: name,
    name,
    mtimeMs: 0,
    size: 0,
  };
}

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

test("workspace index cache version invalidates entries built under an older complexity policy", () => {
  assert.equal(WORKSPACE_INDEX_CACHE_VERSION, 6);
  assert.equal(WORKSPACE_INDEX_CACHE_KEY, "workspace:index:v6");
  assert.ok(LEGACY_WORKSPACE_INDEX_CACHE_KEYS.includes("workspace:index:v5"));
});

test("buildWorkspaceStateFromCache restores cached diagnostics", () => {
  const state = buildWorkspaceStateFromCache({
    version: WORKSPACE_INDEX_CACHE_VERSION,
    rootPath: "/workspace",
    indexedAt: 1234,
    files: [
      makeMeta("a.md"),
      makeMeta("b.md"),
      makeMeta("c.md"),
      makeMeta("d.md"),
    ],
    docs: [makeDoc("a.md"), makeDoc("b.md"), makeDoc("c.md")],
    processedCount: 4,
    readFailedCount: 1,
    complexitySkippedCount: 1,
    listSkippedCount: 2,
    limitHit: true,
  }, "/workspace");

  assert.deepEqual(state, {
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

test("normalizeWorkspaceIndexCache clamps malformed persisted diagnostics", () => {
  const normalized = normalizeWorkspaceIndexCache({
    version: WORKSPACE_INDEX_CACHE_VERSION,
    rootPath: "/workspace",
    indexedAt: Number.POSITIVE_INFINITY,
    files: [makeMeta("a.md"), makeMeta("b.md")],
    docs: "not docs",
    processedCount: 99,
    readFailedCount: -4,
    complexitySkippedCount: -2,
    listSkippedCount: "many",
    limitHit: "yes",
  });

  assert.equal(normalized.indexedAt, 0);
  assert.equal(normalized.files.length, 2);
  assert.deepEqual(normalized.docs, []);
  assert.equal(normalized.processedCount, 2);
  assert.equal(normalized.readFailedCount, 0);
  assert.equal(normalized.complexitySkippedCount, 0);
  assert.equal(normalized.listSkippedCount, 0);
  assert.equal(normalized.limitHit, false);
});

test("buildWorkspaceStateFromCache normalizes malformed persisted arrays before deriving state", () => {
  const state = buildWorkspaceStateFromCache({
    version: WORKSPACE_INDEX_CACHE_VERSION,
    rootPath: "/workspace",
    indexedAt: 4321,
    files: null,
    docs: null,
    processedCount: 4,
    readFailedCount: 2.8,
    complexitySkippedCount: 3.8,
    listSkippedCount: 1.2,
    limitHit: true,
  }, "/workspace");

  assert.deepEqual(state, {
    rootPath: "/workspace",
    status: "ready",
    fileCount: 0,
    processedCount: 0,
    indexedCount: 0,
    indexedAt: 4321,
    error: null,
    listSkippedCount: 1,
    readFailedCount: 2,
    complexitySkippedCount: 3,
    limitHit: true,
  });
});
