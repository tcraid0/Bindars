const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideEditNavigation,
} = require("../.tmp/workspace-tests/src/lib/edit-navigation.js");

test("clean edit navigation exits edit mode and runs the action", () => {
  assert.equal(
    decideEditNavigation({
      editing: true,
      dirty: false,
      confirmDialogOpen: false,
      conflictDialogOpen: false,
    }),
    "run-after-exit",
  );
});

test("dirty edit navigation prompts before running the action", () => {
  assert.equal(
    decideEditNavigation({
      editing: true,
      dirty: true,
      confirmDialogOpen: false,
      conflictDialogOpen: false,
    }),
    "confirm-discard",
  );
});

test("navigation runs directly outside edit mode", () => {
  assert.equal(
    decideEditNavigation({
      editing: false,
      dirty: false,
      confirmDialogOpen: false,
      conflictDialogOpen: false,
    }),
    "run",
  );
});

test("navigation is ignored while a modal is open", () => {
  assert.equal(
    decideEditNavigation({
      editing: true,
      dirty: false,
      confirmDialogOpen: true,
      conflictDialogOpen: false,
    }),
    "ignore",
  );
});
