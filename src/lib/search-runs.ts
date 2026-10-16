import { isMarkableText, type TextSpan } from "./dom-text";

export interface SearchRun {
  text: string;
  spans: TextSpan[];
  code: boolean;
  passageEligible: boolean;
}
const BLOCKS =
  "p, h1, h2, h3, h4, h5, h6, pre, li, td, th, blockquote, .mermaid-diagram";
const LITERAL = "code, pre, .katex";
// Find includes this displayed text; the document index excludes it. Keep each
// region separate from adjacent prose, including an image's empty/loading state.
// A fenced block's language label lives in its toolbar, outside pre/code.
const PASSAGE_EXCLUDED =
  `${LITERAL}, .code-block-toolbar, .frontmatter-header, .mermaid-diagram, .mermaid-error, .markdown-image`;

/** Find's displayed text, with explicit eligibility for indexed prose passages.
 * Code and math use literal matching; other displayed text uses prose matching
 * even when it is not indexed. Annotation offsets still use collectText. */
export function collectSearchRuns(container: HTMLElement): SearchRun[] {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  const runs: SearchRun[] = [];
  let run: SearchRun | null = null;
  let block: Element | null = null;
  let code: Element | null = null;
  let excluded: Element | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (element.tagName === "BR" && run) run.text += " ";
      else if (
        element.matches(
          `${BLOCKS}, ${PASSAGE_EXCLUDED}, img, [data-footnote-backref], .fountain-scene-number`,
        )
      )
        run = null;
      continue;
    }
    const text = node as Text;
    if (!text.length) continue;
    if (
      !isMarkableText(text) ||
      text.parentElement?.closest(
        "[data-footnote-backref], .fountain-scene-number",
      )
    ) {
      run = null;
      continue;
    }
    const nextBlock = text.parentElement?.closest(BLOCKS) ?? container;
    const nextCode = text.parentElement?.closest(LITERAL) ?? null;
    const nextExcluded = text.parentElement?.closest(PASSAGE_EXCLUDED) ?? null;
    if (!run || nextBlock !== block || nextCode !== code || nextExcluded !== excluded) {
      run = { text: "", spans: [], code: !!nextCode, passageEligible: !nextExcluded };
      runs.push(run);
    }
    run.spans.push({
      node: text,
      start: run.text.length,
      end: run.text.length + text.length,
    });
    run.text += text.data;
    block = nextBlock;
    code = nextCode;
    excluded = nextExcluded;
  }
  return runs.filter((run) => run.text.trim());
}
