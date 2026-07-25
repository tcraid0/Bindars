const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveActiveHeadingId,
} = require("../.tmp/workspace-tests/src/lib/active-heading.js");

const headings = [
  { id: "intro", offsetTop: 0 },
  { id: "middle", offsetTop: 500 },
  { id: "near-end", offsetTop: 1200 },
  { id: "end", offsetTop: 1500 },
];

function resolve(overrides) {
  return resolveActiveHeadingId({
    headingOffsets: headings,
    scrollTop: 0,
    clientHeight: 500,
    scrollHeight: 1800,
    topOffsetPx: 60,
    hysteresisPx: 0,
    currentId: null,
    ...overrides,
  });
}

test("resolveActiveHeadingId picks the latest heading above the top threshold", () => {
  assert.equal(resolve({ scrollTop: 440 }), "middle");
  assert.equal(resolve({ scrollTop: 1140 }), "near-end");
});

test("resolveActiveHeadingId keeps the first heading before the second reaches the threshold", () => {
  assert.equal(resolve({ scrollTop: 430 }), "intro");
});

test("resolveActiveHeadingId applies hysteresis near heading boundaries", () => {
  assert.equal(
    resolve({
      scrollTop: 1390,
      hysteresisPx: 20,
      currentId: "end",
    }),
    "end",
  );

  assert.equal(
    resolve({
      scrollTop: 1220,
      hysteresisPx: 20,
      currentId: "end",
    }),
    "near-end",
  );
});

test("resolveActiveHeadingId uses the viewport bottom when scroll is clamped at document end", () => {
  assert.equal(
    resolve({
      scrollTop: 1300,
      clientHeight: 500,
      scrollHeight: 1800,
      currentId: "near-end",
      hysteresisPx: 12,
    }),
    "end",
  );
});

test("resolveActiveHeadingId treats near-bottom scroll positions as bottom-clamped", () => {
  assert.equal(
    resolve({
      scrollTop: 1292,
      clientHeight: 500,
      scrollHeight: 1800,
    }),
    "end",
  );
});

test("resolveActiveHeadingId clamps scrollTop below and above the valid range", () => {
  assert.equal(resolve({ scrollTop: -100 }), "intro");
  assert.equal(resolve({ scrollTop: 5000 }), "end");
});

test("resolveActiveHeadingId only treats exact bottom as bottom when threshold is zero", () => {
  assert.equal(
    resolve({
      scrollTop: 1299,
      clientHeight: 500,
      scrollHeight: 1800,
      bottomThresholdPx: 0,
    }),
    "near-end",
  );

  assert.equal(
    resolve({
      scrollTop: 1300,
      clientHeight: 500,
      scrollHeight: 1800,
      bottomThresholdPx: 0,
    }),
    "end",
  );
});

test("resolveActiveHeadingId switches to the bottom heading despite hysteresis in bottom mode", () => {
  assert.equal(
    resolve({
      scrollTop: 1300,
      clientHeight: 500,
      scrollHeight: 1800,
      currentId: "middle",
      hysteresisPx: 200,
    }),
    "end",
  );
});

test("resolveActiveHeadingId does not select the last heading just because the document fits", () => {
  assert.equal(
    resolve({
      scrollTop: 0,
      clientHeight: 2000,
      scrollHeight: 1800,
    }),
    "intro",
  );
});

test("resolveActiveHeadingId ignores bottom mode for non-scrollable documents with nonzero scrollTop", () => {
  assert.equal(
    resolve({
      scrollTop: 100,
      clientHeight: 1000,
      scrollHeight: 500,
    }),
    "intro",
  );
});

test("resolveActiveHeadingId falls back when the current heading is no longer present", () => {
  assert.equal(
    resolve({
      scrollTop: 440,
      currentId: "removed",
      hysteresisPx: 12,
    }),
    "middle",
  );
});

test("resolveActiveHeadingId handles empty heading lists", () => {
  assert.equal(
    resolveActiveHeadingId({
      headingOffsets: [],
      scrollTop: 0,
      clientHeight: 500,
      scrollHeight: 1800,
      topOffsetPx: 60,
      hysteresisPx: 0,
      currentId: null,
    }),
    null,
  );
});
