const test = require("node:test");
const assert = require("node:assert/strict");
const { reader } = require("./_helpers/reader-app.cjs");
const { click, focus, pressKey } = require("./_helpers/component-view.cjs");

test("Escape from the toolbar returns focus to the document in Read mode", async t => {
  const { host, main } = await reader(t);
  const edit = host.querySelector('button[aria-label="Edit mode"]');
  focus(edit);

  assert.equal(pressKey("Escape").defaultPrevented, true);
  assert.ok(document.activeElement === main);
  assert.equal(edit.getAttribute("aria-pressed"), "false");
  assert.ok(main.textContent.includes("alpha beta alpha"));
});

test("Escape from a Contents entry returns focus to the document", async t => {
  const { host, main } = await reader(t);
  focus(host.querySelector('[data-reader-panel="toc"] button'));

  assert.equal(pressKey("Escape").defaultPrevented, true);
  assert.ok(document.activeElement === main);
});

test("Escape from a Sidebar tab returns focus to the document", async t => {
  const { host, main } = await reader(t);
  pressKey("b", { ctrlKey: true });
  focus(host.querySelector('[data-reader-panel="sidebar"] [role="tab"]'));

  assert.equal(pressKey("Escape").defaultPrevented, true);
  assert.ok(document.activeElement === main);
});

test("unhandled Escape in the document leaves focus in place", async t => {
  const { main } = await reader(t);

  assert.equal(pressKey("Escape").defaultPrevented, false);
  assert.ok(document.activeElement === main);
});

test("Export handles Escape and returns focus to its trigger before the reader fallback", async t => {
  const { host, main } = await reader(t);
  const trigger = host.querySelector('button[aria-label="Export options"]');
  click(trigger);
  const panel = document.getElementById(trigger.getAttribute("aria-controls"));
  focus(panel.querySelector("button"));

  assert.equal(pressKey("Escape").defaultPrevented, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.ok(document.activeElement === trigger);
  assert.equal(pressKey("Escape").defaultPrevented, true);
  assert.ok(document.activeElement === main);
});
