import type { Root } from "hast";

interface SourcePositionOptions {
  lineOffset?: number;
}

export interface SourcePositionAttributes {
  "data-bindars-source-line"?: number | string;
  "data-bindars-source-column"?: number | string;
}

const SOURCE_BACKED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "blockquote", "li", "pre", "table",
]);

interface PositionedNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: PositionedNode[];
  position?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
}

function firstTextPosition(node: PositionedNode): { line: number; column: number } | null {
  if (node.type === "text") {
    const line = node.position?.start?.line;
    const column = node.position?.start?.column;
    return line && column ? { line, column } : null;
  }
  for (const child of node.children ?? []) {
    const position = firstTextPosition(child);
    if (position) return position;
  }
  return null;
}

export function rehypeSourcePositions(options: SourcePositionOptions = {}) {
  const lineOffset = Math.max(0, Math.trunc(options.lineOffset ?? 0));

  return (tree: Root): void => {
    const visit = (node: PositionedNode): void => {
      if (node.type === "element" && node.tagName && SOURCE_BACKED_TAGS.has(node.tagName)) {
        const fallback = node.position?.start;
        const anchor = firstTextPosition(node) ?? (
          fallback?.line && fallback.column
            ? { line: fallback.line, column: fallback.column }
            : null
        );
        if (anchor) {
          node.properties ??= {};
          node.properties.dataBindarsSourceLine = anchor.line + lineOffset;
          node.properties.dataBindarsSourceColumn = anchor.column;
        }
      }

      for (const child of node.children ?? []) visit(child);
    };

    visit(tree as PositionedNode);
  };
}
