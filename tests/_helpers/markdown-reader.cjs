const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MarkdownRenderer } = require("../../.tmp/workspace-tests/src/components/MarkdownRenderer.js");
const { ToastProvider } = require("../../.tmp/workspace-tests/src/components/ToastProvider.js");

function markdownArticle(content, { imagesAuthorized = false } = {}) {
  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(React.createElement(ToastProvider, null,
    React.createElement(MarkdownRenderer, {
      content, filePath: "/workspace/formatting.md", imagesAuthorized,
      settings: { fontSize: 18, contentWidth: 72, lineHeight: 1.6, fontFamily: "newsreader",
        paragraphSpacing: "comfortable", sceneLensEnabled: true, reducedEffects: false },
      contentRef: React.createRef(), onOpenFragment: () => false,
    })));
  return holder.querySelector("article");
}

// Saved-annotation fixtures must carry real snapshot evidence when a test
// expects painting; contextual-only legacy records now require confirmation.
async function positionedHighlight(source, highlight) {
  const { collectText, rangeForOffsets } = require('../../.tmp/workspace-tests/src/lib/dom-text.js');
  const { createPositionedAnchor } = require('../../.tmp/workspace-tests/src/lib/text-anchoring.js');
  const reader = markdownArticle(source, { imagesAuthorized: true });
  const { text, spans } = collectText(reader);
  const start = text.indexOf(highlight.exact);
  if (start < 0) throw new Error('Fixture excerpt is absent');
  const anchor = await createPositionedAnchor(rangeForOffsets(spans, start, start + highlight.exact.length), reader, source);
  return { ...highlight, ...anchor };
}
module.exports = { markdownArticle, positionedHighlight };
