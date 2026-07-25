const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { installDom } = require("./_helpers/dom.cjs");

async function settleHeadingExtraction() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("useHeadings clears stale reader state and rebinds when unchanged content remounts", async () => {
  await installDom();
  const { useHeadings } = require("../.tmp/workspace-tests/src/hooks/useHeadings.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const snapshots = [];
  let firstArticle = null;

  function Probe({ enabled, generation }) {
    const contentRef = React.useRef(null);
    const headings = useHeadings(contentRef, "same content", enabled);
    React.useEffect(() => {
      snapshots.push(headings.map((heading) => heading.id));
    }, [headings]);
    return enabled
      ? React.createElement("article", { ref: contentRef, "data-generation": generation },
          React.createElement("h2", { id: `heading-${generation}` }, `Heading ${generation}`))
      : null;
  }

  try {
    flushSync(() => root.render(React.createElement(Probe, { enabled: true, generation: 1 })));
    await settleHeadingExtraction();
    firstArticle = host.querySelector("article");
    assert.deepEqual(snapshots.at(-1), ["heading-1"]);

    flushSync(() => root.render(React.createElement(Probe, { enabled: false, generation: 1 })));
    await settleHeadingExtraction();
    assert.deepEqual(snapshots.at(-1), []);
    assert.equal(firstArticle.isConnected, false);

    flushSync(() => root.render(React.createElement(Probe, { enabled: true, generation: 2 })));
    await settleHeadingExtraction();
    assert.ok(host.querySelector("article") !== firstArticle);
    assert.deepEqual(snapshots.at(-1), ["heading-2"]);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
