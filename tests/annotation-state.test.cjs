const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyAnnotationMutation,
  areAnnotationsReady,
  beginAnnotationLoad,
  completeAnnotationLoad,
  createAnnotationLoadState,
  failAnnotationLoad,
} = require("../.tmp/workspace-tests/src/lib/annotation-state.js");

function annotations(label) {
  return {
    highlights: [
      {
        id: label,
        prefix: "",
        exact: label,
        suffix: "",
        color: "yellow",
        createdAt: 1,
        nearestHeadingId: null,
      },
    ],
    bookmarks: [],
  };
}

test("path change clears previous annotations while loading", () => {
  const ready = completeAnnotationLoad(
    beginAnnotationLoad(createAnnotationLoadState(null), "/a.md"),
    "/a.md",
    annotations("old"),
  );

  const loading = beginAnnotationLoad(ready, "/b.md");

  assert.deepEqual(loading.annotations, { highlights: [], bookmarks: [] });
  assert.equal(loading.status, "loading");
});

test("mutation during loading is ignored", () => {
  const loading = beginAnnotationLoad(createAnnotationLoadState(null), "/b.md");
  const result = applyAnnotationMutation(loading, () => annotations("new"));

  assert.equal(result.mutated, false);
  assert.deepEqual(result.state.annotations, { highlights: [], bookmarks: [] });
});

test("stale annotation load result is discarded", () => {
  const state = beginAnnotationLoad(createAnnotationLoadState(null), "/b.md");
  const next = completeAnnotationLoad(state, "/a.md", annotations("old"));

  assert.equal(next, state);
});

test("current annotation load result becomes ready", () => {
  const state = beginAnnotationLoad(createAnnotationLoadState(null), "/b.md");
  const next = completeAnnotationLoad(state, "/b.md", annotations("new"));

  assert.equal(next.status, "ready");
  assert.equal(next.annotations.highlights[0].id, "new");
});

test("annotations are ready only after the current path load completes", () => {
  const idle = createAnnotationLoadState(null);
  const loading = beginAnnotationLoad(idle, "/b.md");
  const ready = completeAnnotationLoad(loading, "/b.md", annotations("new"));

  assert.equal(areAnnotationsReady(idle), false);
  assert.equal(areAnnotationsReady(loading), false);
  assert.equal(areAnnotationsReady(ready), true);
});

test("failed annotation load is not ready and preserves the error", () => {
  const loading = beginAnnotationLoad(createAnnotationLoadState(null), "/b.md");
  const failed = failAnnotationLoad(loading, "/b.md", "store unavailable");

  assert.equal(failed.status, "error");
  assert.equal(failed.error, "store unavailable");
  assert.equal(areAnnotationsReady(failed), false);
});

test("mutation after failed annotation load is ignored", () => {
  const loading = beginAnnotationLoad(createAnnotationLoadState(null), "/b.md");
  const failed = failAnnotationLoad(loading, "/b.md", "store unavailable");
  const result = applyAnnotationMutation(failed, () => annotations("new"));

  assert.equal(result.mutated, false);
  assert.deepEqual(result.state.annotations, { highlights: [], bookmarks: [] });
});

test("stale annotation load failure is discarded", () => {
  const loading = beginAnnotationLoad(createAnnotationLoadState(null), "/b.md");
  const next = failAnnotationLoad(loading, "/a.md", "old failure");

  assert.equal(next, loading);
});
