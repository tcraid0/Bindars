/** Text in which an HTML mark can be displayed without damaging the renderer. */
export function isMarkableText(node: Text): boolean {
  const element = node.parentElement;
  if (!element || element.closest("script, style, button, .katex-mathml, .mermaid-loading, .sr-only")) return false;
  return !element.closest("svg") || !!element.closest("foreignObject");
}

export interface TextSpan { node: Text; start: number; end: number }
export function collectText(container: HTMLElement): { text: string; spans: TextSpan[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const spans: TextSpan[] = [];
  let text = "";
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!node.length) continue;
    if (!isMarkableText(node)) {
      // Prevent matching across hidden/unsupported text without treating it as
      // selectable content. All annotation coordinates use this representation.
      text += "\0";
      continue;
    }
    const start = text.length;
    text += node.data;
    spans.push({ node, start, end: text.length });
  }
  return { text, spans };
}

export function rangeForOffsets(spans: TextSpan[], start: number, end: number): Range | null {
  if (end <= start) return null;
  const first = spans.find((span) => span.start <= start && span.end > start);
  const last = spans.find((span) => span.start < end && span.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}
