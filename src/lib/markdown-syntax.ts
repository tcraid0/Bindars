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
