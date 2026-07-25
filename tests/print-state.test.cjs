const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyPrintState,
  PRINT_LAYOUT_ATTR,
  PRINTING_ATTR,
  PRINT_THEMED_ATTR,
} = require("../.tmp/workspace-tests/src/lib/print-state.js");

function createTarget() {
  const attrs = new Map();
  return {
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    has(name) {
      return attrs.has(name);
    },
    get(name) {
      return attrs.get(name);
    },
  };
}

test("applyPrintState sets printing and themed attributes when both are enabled", () => {
  const target = createTarget();

  applyPrintState({
    printing: true,
    themed: true,
    layout: "book",
    targets: [target],
  });

  assert.equal(target.get(PRINTING_ATTR), "true");
  assert.equal(target.get(PRINT_THEMED_ATTR), "true");
  assert.equal(target.get(PRINT_LAYOUT_ATTR), "book");
});

test("applyPrintState removes themed attribute when printing without themed mode", () => {
  const target = createTarget();
  target.setAttribute(PRINT_THEMED_ATTR, "true");

  applyPrintState({
    printing: true,
    themed: false,
    layout: "standard",
    targets: [target],
  });

  assert.equal(target.get(PRINTING_ATTR), "true");
  assert.equal(target.has(PRINT_THEMED_ATTR), false);
  assert.equal(target.get(PRINT_LAYOUT_ATTR), "standard");
});

test("applyPrintState clears all print attributes when print session ends", () => {
  const target = createTarget();
  target.setAttribute(PRINTING_ATTR, "true");
  target.setAttribute(PRINT_THEMED_ATTR, "true");

  applyPrintState({
    printing: false,
    themed: true,
    layout: "book",
    targets: [target],
  });

  assert.equal(target.has(PRINTING_ATTR), false);
  assert.equal(target.has(PRINT_THEMED_ATTR), false);
  assert.equal(target.has(PRINT_LAYOUT_ATTR), false);
});

test("applyPrintState ignores null targets safely", () => {
  const target = createTarget();

  applyPrintState({
    printing: true,
    themed: false,
    layout: "standard",
    targets: [null, target, undefined],
  });

  assert.equal(target.get(PRINTING_ATTR), "true");
});
