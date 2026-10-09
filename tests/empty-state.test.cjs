const test = require("node:test");
const assert = require("node:assert/strict");
const { installDom } = require("./_helpers/dom.cjs");
const { renderComponent, buttonWithText, click } = require("./_helpers/component-view.cjs");

const { EmptyState } = require("../.tmp/workspace-tests/src/components/EmptyState.js");

const SAVE_HINT = /Save your own copy/;
const recentFiles = [
  { path: "/notes/draft.md", name: "draft.md" },
  { path: "/notes/plan.md", name: "plan.md" },
];

function renderEmptyState(props = {}) {
  return renderComponent(EmptyState, {
    onNewFile() {},
    onOpenFile() {},
    onTrySample() {},
    recentFiles: [],
    onOpenRecent() {},
    ...props,
  });
}

test("the welcome heading is the brand artwork, named Bindars", async () => {
  await installDom();
  const view = renderEmptyState();
  try {
    const heading = view.host.querySelector("h1");
    assert.equal(heading.textContent, "Bindars");
    const art = [...heading.querySelectorAll("svg")];
    assert.deepEqual(
      art.map((svg) => svg.querySelector("use").getAttribute("href")),
      ["#bindars-symbol", "#bindars-wordmark"],
    );
    assert.ok(art.every((svg) => svg.getAttribute("aria-hidden") === "true"));
    // src/main.tsx moves the startup mark onto this symbol, past the wordmark.
    assert.equal(view.host.querySelectorAll("[data-startup-mark-target]").length, 1);
    assert.ok(art[0].hasAttribute("data-startup-mark-target"));
    assert.ok(art[1].hasAttribute("data-startup-mark-passes"));
  } finally {
    view.cleanup();
  }
});

test("a first visit leads with Try an example and explains saving a copy", async () => {
  await installDom();
  const view = renderEmptyState();
  try {
    assert.match(buttonWithText(view.host, "Try an example").className, /\bbg-accent-fill\b/);
    assert.match(view.host.textContent, SAVE_HINT);
  } finally {
    view.cleanup();
  }
});

test("with recent files, Resume is the only main action and the save hint is gone", async () => {
  await installDom();
  let sampleCount = 0;
  const view = renderEmptyState({ recentFiles, onTrySample() { sampleCount += 1; } });
  try {
    assert.match(buttonWithText(view.host, "Resume: draft.md").className, /\bbg-accent-fill\b/);
    const sample = buttonWithText(view.host, "Try an example");
    assert.doesNotMatch(sample.className, /\bbg-accent-fill\b/);
    assert.match(sample.className, /\bborder-border\b/);
    assert.doesNotMatch(view.host.textContent, SAVE_HINT);
    click(sample);
    assert.equal(sampleCount, 1);
  } finally {
    view.cleanup();
  }
});

test("the entrance plays unless the startup screen is revealing the welcome screen", async () => {
  await installDom();
  const later = renderEmptyState();
  try {
    assert.equal(later.host.querySelector(".empty-state").classList.contains("empty-state-at-launch"), false);
  } finally {
    later.cleanup();
  }

  const screen = document.createElement("div");
  screen.id = "loading-screen";
  document.body.append(screen);
  const atLaunch = renderEmptyState();
  try {
    // Decided at mount: the screen leaving doesn't restart the entrance.
    screen.remove();
    atLaunch.render({ recentFiles });
    assert.equal(atLaunch.host.querySelector(".empty-state").classList.contains("empty-state-at-launch"), true);
  } finally {
    atLaunch.cleanup();
  }
});
