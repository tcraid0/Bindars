const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const saving = readFileSync(join(__dirname, "../docs/recovery-and-privacy.md"), "utf8").replace(/\s+/g, " ");
const usage = readFileSync(join(__dirname, "../docs/usage.md"), "utf8").replace(/\s+/g, " ");

test("saving guide uses the actual earlier-drafts button label", () => {
  assert.match(saving, /Show earlier drafts/);
  assert.doesNotMatch(saving, /Show existing drafts/);
});

test("usage distinguishes ordinary Save from choosing a location", () => {
  assert.doesNotMatch(usage, /guarded Save\/Save As/);
  assert.match(usage, /Save updates an ordinary open file at its current location/);
  assert.match(usage, /dialog is used for new documents and drafts, Make a copy, and errors that offer Save As/);
});

for (const [behavior, description] of [
  ["switch-away autosave", /Autosave also runs when you switch away from Bindars/],
  ["slow-save feedback", /A slow save shows.*Saving….*Still saving\. Your text is safe in this window\./],
  ["macOS creation dates", /On macOS, saving keeps the file's creation date/],
  ["annotated Save As destinations", /Save As refuses a destination with saved highlights, notes, or bookmarks/],
]) {
  test(`saving guide explains ${behavior}`, () => assert.match(saving, description));
}
