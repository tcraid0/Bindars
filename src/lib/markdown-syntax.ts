import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import type { PluggableList } from "unified";

/** Reader grammar only: no rendering transforms or dependencies. */
export const markdownSyntax: PluggableList = [
  remarkGfm,
  // Single dollars are currency; inline math uses $$...$$.
  [remarkMath, { singleDollarTextMath: false }],
  remarkFrontmatter,
];

/**
 * Every character the grammar above can hide from the reader, or use to hide
 * other text: emphasis, code, strikethrough, links, images and footnotes,
 * autolinks, HTML and quote markers, entities, escapes, math and table cells.
 * Source without any of them is shown as written, which highlight continuity
 * relies on to know a passage's own source characters.
 * Review this list whenever a syntax extension is added above.
 */
export const MARKUP_CHARACTERS = /[*_`~[\]<>&\\$|]/;
