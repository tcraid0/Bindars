import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import { sanitizeSchema } from "./sanitize-schema";
import type { PluggableList } from "unified";
import { rehypeSourcePositions } from "./markdown-source-position";

export const remarkPlugins: PluggableList = [
  remarkGfm,
  remarkSmartypants,
  remarkMath,
  remarkFrontmatter,
];

// Order matters:
// 1. rehype-slug: generates heading IDs for TOC
// 2. rehype-highlight: adds syntax highlighting classes
// 3. rehype-sanitize: strips unsafe HTML (preserves math nodes via schema)
// 4. rehype-katex: converts math nodes to KaTeX HTML (runs AFTER sanitize
//    because its output is trusted library-generated HTML)
export function createRehypePlugins(lineOffset = 0): PluggableList {
  return [
    rehypeSlug,
    rehypeHighlight,
    [rehypeSourcePositions, { lineOffset }],
    [rehypeSanitize, sanitizeSchema],
    rehypeKatex,
  ];
}

export const rehypePlugins: PluggableList = createRehypePlugins();
