import { defaultSchema } from "rehype-sanitize";
import type { Options as Schema } from "rehype-sanitize";

/**
 * Custom sanitize schema for markdown rendering.
 *
 * Extends the default GitHub schema to:
 * - Allow `id` on all headings (needed for TOC anchor navigation via rehype-slug)
 * - Allow `className` on code/span/pre/div elements (for syntax highlighting + KaTeX math)
 * - Allow math-related classes on div/span (so rehype-katex can process math nodes after sanitize)
 * - Restrict `href` to safe protocols only (blocks javascript:, data: schemes)
 *
 * Clobber protection (`clobber: [], clobberPrefix: ''`) is intentionally disabled.
 * rehype-sanitize defaults prefix element IDs with "user-content-", but TOC navigation,
 * scroll restore, bookmarks, and heading observer all depend on clean IDs from rehype-slug.
 * This is safe because: (1) built-in window/document properties cannot be overridden by
 * named element access per the HTML spec, and (2) the app never uses dynamic
 * window[id]/document[id] lookups with user-controlled heading IDs.
 */
export const sanitizeSchema: Schema = {
  ...defaultSchema,
  clobber: [],
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    h1: [...(defaultSchema.attributes?.h1 || []), "id"],
    h2: [...(defaultSchema.attributes?.h2 || []), "id"],
    h3: [...(defaultSchema.attributes?.h3 || []), "id"],
    h4: [...(defaultSchema.attributes?.h4 || []), "id"],
    h5: [...(defaultSchema.attributes?.h5 || []), "id"],
    h6: [...(defaultSchema.attributes?.h6 || []), "id"],
    code: [["className", /^(language-.+|hljs|math-(display|inline))$/]],
    span: [...(defaultSchema.attributes?.span || []), "className"],
    pre: [...(defaultSchema.attributes?.pre || []), "className"],
    div: [...(defaultSchema.attributes?.div || []), "className"],
    input: [...(defaultSchema.attributes?.input || []), ["type", "checkbox"], "checked", "disabled"],
    li: [...(defaultSchema.attributes?.li || []), "className", "id"],
    ul: [...(defaultSchema.attributes?.ul || []), "className"],
    section: [...(defaultSchema.attributes?.section || []), "className", "id", "dataFootnotes"],
    a: [...(defaultSchema.attributes?.a || []), "id", "className", "dataFootnoteRef", "dataFootnoteBackref", "ariaDescribedBy"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
  },
};
