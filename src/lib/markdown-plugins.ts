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
  // singleDollarTextMath off: single $...$ stays literal text so currency in
  // prose ("$150 to $250") never parses as math; inline math uses $$...$$
  [remarkMath, { singleDollarTextMath: false }],
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
    // plainText math: remark-math emits `language-math` code blocks, which the
    // highlighter has no grammar for and would flag with a file message
    [rehypeHighlight, { plainText: ["math"] }],
    [rehypeSourcePositions, { lineOffset }],
    [rehypeSanitize, sanitizeSchema],
    rehypeKatex,
  ];
}

export const rehypePlugins: PluggableList = createRehypePlugins();
