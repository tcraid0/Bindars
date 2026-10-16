const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderComponent } = require("./_helpers/component-view.cjs");
const { FountainRenderer } = require("../.tmp/workspace-tests/src/components/FountainRenderer.js");
const { TableOfContents } = require("../.tmp/workspace-tests/src/components/TableOfContents.js");
const { useHeadings } = require("../.tmp/workspace-tests/src/hooks/useHeadings.js");
const { parseFountain } = require("../.tmp/workspace-tests/src/lib/fountain.js");
const { createPositionedAnchor, prepareAnnotationDocument, resolveAnchor } = require("../.tmp/workspace-tests/src/lib/text-anchoring.js");
const { collectText, rangeForOffsets } = require("../.tmp/workspace-tests/src/lib/dom-text.js");

const content = "INT. READING ROOM - NIGHT #1#\n\nA reader waits.\n\nEXT. ROAD - DAY\n\nGone.";
const parsed = parseFountain(content);
const settings = { fontSize: 18, contentWidth: 72, lineHeight: 1.6, fontFamily: "newsreader", paragraphSpacing: "comfortable" };

function Screenplay() {
  const ref = React.useRef(null);
  const headings = useHeadings(ref, content);
  return React.createElement(React.Fragment, null,
    React.createElement(FountainRenderer, { parsed, settings, contentRef: ref }),
    React.createElement(TableOfContents, { visible: true, headings, activeId: null }));
}

test("Fountain emits a space in numbered headings and the Contents label", async () => {
  const view = renderComponent(Screenplay);
  await React.act(async () => { await new Promise(setImmediate); });
  try {
    const headings = view.host.querySelectorAll("h3.fountain-scene-heading");
    assert.equal(headings[0].textContent, "INT. READING ROOM - NIGHT 1");
    assert.equal(headings[1].textContent, "EXT. ROAD - DAY");
    assert.ok([...view.host.querySelectorAll("button")].some(button => button.textContent.trim() === "INT. READING ROOM - NIGHT 1"));
  } finally { view.cleanup(); }
});

test("pre-separator highlights in a numbered heading are retained as uncertain when their context changes", async () => {
  const view = renderComponent(FountainRenderer, { parsed, settings, contentRef: React.createRef() });
  try {
    const current = view.host.querySelector(".fountain-scene-heading").parentElement;
    const previous = current.cloneNode(true);
    const heading = previous.querySelector(".fountain-scene-heading");
    const separator = heading.querySelector(".fountain-scene-number").previousSibling;
    assert.equal(separator.textContent, " "); separator.remove();
    const { text, spans } = collectText(previous);
    const start = text.indexOf("READING ROOM");
    const anchor = await createPositionedAnchor(rangeForOffsets(spans, start, start + 12), previous, content);
    assert.equal(resolveAnchor(anchor, previous, await prepareAnnotationDocument(previous, content)).status, "located");
    // The new space changes the saved suffix and rendered-text hash. The existing
    // conservative resolver keeps the note, but cannot authorize painting it.
    const resolved = resolveAnchor(anchor, current, await prepareAnnotationDocument(current, content));
    assert.equal(resolved.status, "uncertain");
    assert.equal(resolved.range, null);
  } finally { view.cleanup(); }
});
