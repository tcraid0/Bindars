import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import { toString as hastToString } from "hast-util-to-string";
import { SKIP, visit } from "unist-util-visit";
import type { Element as HastElement, Root as HastRoot } from "hast";
import type {
  SceneItem,
  WorkspaceDocIndex,
  WorkspaceFileMeta,
  WorkspaceHeading,
} from "../types";
import { extractFrontmatter } from "./frontmatter";
import type { DocumentComplexityOptions } from "./document-complexity";
import { assertDocumentComplexity, isDocumentComplexityError } from "./document-complexity";
import { parseFountain, fountainToSearchableText, isMarkdownSceneHeadingText } from "./fountain";
import { remarkPlugins } from "./markdown-plugins";
import { resolveMarkdownLink, toPathIdentityKey } from "./paths";
import { documentFileType, replaceOpenableDocumentExtension } from "./openable-files";
import { MAX_WORKSPACE_BODY_CHARS } from "./workspace-limits";

/**
 * The index parses with the reader's own remark plugin list and the same
 * remark-rehype + rehype-slug steps MarkdownRenderer runs, so heading ids and
 * link targets follow one set of syntax rules: setext and nested headings,
 * entities, images, footnote numbering, SmartyPants dashes, and dropped raw
 * HTML all come out as the reader renders them. `markdown-render.test.mjs`
 * still compares the two, because the reader adds sanitize and KaTeX after
 * slugging and this pipeline stops at the slug.
 *
 * The catalog yields after each document and publishes incremental results.
 * Matching stat metadata avoids reparsing unchanged documents. The bounded
 * native cache is disposable and is never stored in preferences. JavaScriptCore
 * performance is guarded by `npm run verify:jsc`, alongside the shared reader
 * complexity limits and the parser patches in patches/.
 */
const indexPipeline = unified()
  .use(remarkParse)
  .use(remarkPlugins)
  .use(remarkRehype)
  .use(rehypeSlug);
interface HeadingWithLine extends WorkspaceHeading { line: number }
export type WorkspaceDocumentBuildResult =
  | { status: "indexed"; doc: WorkspaceDocIndex }
  | { status: "too-complex" };

export function buildWorkspaceDoc(
  meta: WorkspaceFileMeta,
  content: string,
  complexityOptions: DocumentComplexityOptions = {},
): WorkspaceDocIndex {
  if (documentFileType(meta.name) === "fountain") {
    return buildFountainDoc(meta, content, complexityOptions);
  }

  assertDocumentComplexity(content, "markdown", complexityOptions);
  const { frontmatter, body } = extractFrontmatter(content);
  const tree = indexPipeline.runSync(indexPipeline.parse(body)) as HastRoot;
  const headingRows = extractHeadings(tree);
  const headings = headingRows.map((row) => ({ id: row.id, text: row.text }));
  const title = getTitle(frontmatter, headings, meta.name);

  const links = extractLinks(tree, meta.path);
  const scenes = extractScenes(headingRows);
  const bodyText = toSearchableText(tree);

  return {
    path: meta.path,
    relPath: meta.relPath,
    name: meta.name,
    title,
    headings,
    bodyText,
    links,
    scenes,
  };
}

export function tryBuildWorkspaceDoc(
  meta: WorkspaceFileMeta,
  content: string,
  complexityOptions: DocumentComplexityOptions = {},
): WorkspaceDocumentBuildResult {
  try {
    return { status: "indexed", doc: buildWorkspaceDoc(meta, content, complexityOptions) };
  } catch (error) {
    if (isDocumentComplexityError(error)) return { status: "too-complex" };
    throw error;
  }
}

function buildFountainDoc(
  meta: WorkspaceFileMeta,
  content: string,
  complexityOptions: DocumentComplexityOptions,
): WorkspaceDocIndex {
  const parsed = parseFountain(content, complexityOptions);

  const titleEntry = parsed.titlePage.find((e) => e.key.toLowerCase() === "title");
  const title = titleEntry?.value || replaceOpenableDocumentExtension(meta.name, "").trim() || null;

  const headings: WorkspaceHeading[] = parsed.scenes.map((s) => ({
    id: s.id,
    text: s.text,
  }));

  const scenes: SceneItem[] = parsed.scenes.map((s) => ({
    id: `scene-${s.id}`,
    label: s.text,
    line: s.index + 1,
    headingId: s.id,
  }));

  const bodyText = fountainToSearchableText(parsed);

  return {
    path: meta.path,
    relPath: meta.relPath,
    name: meta.name,
    title,
    headings,
    bodyText,
    links: [],
    scenes,
  };
}

function getTitle(
  frontmatter: Record<string, unknown> | null,
  headings: WorkspaceHeading[],
  fileName: string,
): string | null {
  if (frontmatter && typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }

  const firstHeading = headings[0]?.text?.trim();
  if (firstHeading) return firstHeading;

  const fallback = replaceOpenableDocumentExtension(fileName, "").trim();
  return fallback || null;
}

const HEADING_TAG_RE = /^h[1-6]$/;

function elementClassNames(element: HastElement): string[] {
  const className = element.properties.className;
  return Array.isArray(className) ? className.map(String) : [];
}

/**
 * Headings the reader's table of contents would list: every slugged heading
 * except the visually hidden "Footnotes" label remark-gfm appends, which
 * `useHeadings` skips by the same `sr-only` class.
 */
function extractHeadings(tree: HastRoot): HeadingWithLine[] {
  const headings: HeadingWithLine[] = [];

  visit(tree, "element", (node) => {
    if (!HEADING_TAG_RE.test(node.tagName)) return;
    const id = node.properties.id;
    if (typeof id !== "string" || !id) return;
    if (elementClassNames(node).includes("sr-only")) return;
    const text = hastToString(node).trim();
    if (!text) return;
    headings.push({ id, text, line: node.position?.start.line ?? 0 });
  });

  return headings;
}

function extractScenes(headings: HeadingWithLine[]): SceneItem[] {
  const scenes: SceneItem[] = [];

  for (const heading of headings) {
    if (!isMarkdownSceneHeadingText(heading.text)) continue;
    scenes.push({
      id: `scene-${heading.id}`,
      label: heading.text,
      line: heading.line,
      headingId: heading.id,
    });
  }

  return scenes;
}

/**
 * Every anchor the reader would render, resolved by the same rule its click
 * handler uses. Reference-style links are already resolved by remark-rehype;
 * footnote and fragment links, external URLs, and unsupported files fall out
 * of `resolveMarkdownLink`.
 */
function extractLinks(tree: HastRoot, currentFilePath: string): string[] {
  const targets = new Set<string>();

  visit(tree, "element", (node) => {
    if (node.tagName !== "a") return;
    const href = node.properties.href;
    if (typeof href !== "string" || !href.trim()) return;

    const resolved = resolveMarkdownLink(href.trim(), currentFilePath);
    if (!resolved) return;
    const targetKey = toPathIdentityKey(resolved.path);
    if (targetKey) targets.add(targetKey);
  });

  return Array.from(targets);
}

const BODY_BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "hr", "blockquote",
]);

function toSearchableText(tree: HastRoot): string {
  const parts: string[] = [];
  visit(tree, (node) => {
    if (node.type === "text") parts.push(node.value.replace(/\s+/g, " "));
    if (node.type !== "element") return;
    // Code includes math and diagram source. Neither that source nor image alt
    // text is part of the body excerpt. Keep a boundary across omitted content.
    if (node.tagName === "code" || node.tagName === "pre" || node.tagName === "img"
      || elementClassNames(node).includes("sr-only") || node.properties.dataFootnoteBackref !== undefined) {
      parts.push("\n");
      return SKIP;
    }
    if (BODY_BLOCK_TAGS.has(node.tagName)) parts.push("\n");
    if (node.tagName === "br") parts.push(" ");
  });
  // Spaces join inline formatting; newlines prevent matching across blocks.
  return parts.join("").replace(/ +/g, " ").replace(/ *\n */g, "\n")
    .replace(/\n+/g, "\n").trim().slice(0, MAX_WORKSPACE_BODY_CHARS);
}
