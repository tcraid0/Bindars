const test = require("node:test");
const assert = require("node:assert/strict");
const { readerPanelBalance } = require("../.tmp/workspace-tests/src/lib/reader-panels.js");

test("reader panel balance offsets the visible width on either side", () => {
  const none = { sidebar: false, toc: false, notes: false };
  for (const [visible, expected] of [
    [none, 0],
    [{ ...none, toc: true }, 220],
    [{ ...none, toc: true, notes: true }, 500],
    [{ ...none, sidebar: true }, -280],
    [{ ...none, sidebar: true, toc: true }, -60],
  ]) {
    assert.equal(readerPanelBalance(visible), expected, JSON.stringify(visible));
  }
});
