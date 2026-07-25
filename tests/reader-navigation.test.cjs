const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

const headings = [
  { id: "first", text: "First", level: 1 },
  { id: "second", text: "Second", level: 2 },
];

function rect(top, height = 30) {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 500,
    width: 500,
    height,
    toJSON() {},
  };
}

test("active heading updates stay inside reader navigation and preserve suppression", async () => {
  await installDom();
  const { ReaderNavigation } = require("../.tmp/workspace-tests/src/components/ReaderNavigation.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const navigationRef = React.createRef();
  const activeSnapshots = [];
  let parentRenderCount = 0;

  function Probe() {
    parentRenderCount += 1;
    const scrollRootRef = React.useRef(null);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "main",
        { ref: scrollRootRef },
        React.createElement("h1", { id: "first" }, "First"),
        React.createElement("h2", { id: "second" }, "Second"),
      ),
      React.createElement(ReaderNavigation, {
        ref: navigationRef,
        visible: true,
        headings,
        scrollRootRef,
        syncIntervalMs: 0,
        useIntersectionObserver: false,
        onActiveHeadingChange: (id) => activeSnapshots.push(id),
      }),
    );
  }

  try {
    flushSync(() => root.render(React.createElement(Probe)));
    const main = host.querySelector("main");
    Object.defineProperties(main, {
      scrollTop: { value: 0, writable: true, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollHeight: { value: 1500, configurable: true },
    });
    main.getBoundingClientRect = () => rect(0, 500);
    host.querySelector("#first").getBoundingClientRect = () => rect(20);
    host.querySelector("#second").getBoundingClientRect = () => rect(700);

    for (const id of ["second", "first", "second"]) {
      await act(async () => {
        navigationRef.current.setActiveId(id, { suppressObserverMs: 10_000 });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    }

    assert.equal(
      parentRenderCount,
      1,
      "repeated active heading changes must not rerender the parent shell",
    );
    assert.match(host.querySelector(".toc-active-item").textContent, /Second/);

    await act(async () => {
      main.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    assert.equal(
      activeSnapshots.at(-1),
      "second",
      "observer sync must not overwrite an explicitly suppressed heading",
    );
    assert.equal(parentRenderCount, 1);
    assert.equal(activeSnapshots.at(-1), "second");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
