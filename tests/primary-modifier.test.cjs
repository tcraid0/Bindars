const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrimaryModifier } = require("../.tmp/workspace-tests/src/lib/shortcut-labels.js");
const { withShortcutPlatform } = require("./_helpers/shortcut-platform.cjs");

for (const platform of ["macos", "windows-linux"]) {
  test(`${platform} uses only its primary modifier`, () => {
    for (const ctrlKey of [false, true]) {
      for (const metaKey of [false, true]) {
        assert.equal(isPrimaryModifier({ ctrlKey, metaKey }, platform),
          platform === "macos" ? metaKey : ctrlKey);
      }
    }
  });
}

test("primary modifier detects the current platform for app events", () => {
  const control = { ctrlKey: true, metaKey: false };
  const command = { ctrlKey: false, metaKey: true };
  withShortcutPlatform("MacIntel", () => {
    assert.equal(isPrimaryModifier(control), false);
    assert.equal(isPrimaryModifier(command), true);
  });
  withShortcutPlatform("Linux x86_64", () => {
    assert.equal(isPrimaryModifier(control), true);
    assert.equal(isPrimaryModifier(command), false);
  });
});
