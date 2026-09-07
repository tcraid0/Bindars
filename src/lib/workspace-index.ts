import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import { toString as hastToString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import type { Element as HastElement, Root as HastRoot } from "hast";
import type {
  SceneItem,
  WorkspaceDocIndex,
  WorkspaceFileMeta,
  WorkspaceHeading,
  WorkspaceState,
} from "../types";
import { extractFrontmatter } from "./frontmatter";
import type { DocumentComplexityOptions } from "./document-complexity";
import { assertDocumentComplexity, isDocumentComplexityError } from "./document-complexity";
import { parseFountain, fountainToSearchableText, isMarkdownSceneHeadingText } from "./fountain";
import { remarkPlugins } from "./markdown-plugins";
import { resolveMarkdownLink, toPathIdentityKey } from "./paths";
import { replaceOpenableDocumentExtension } from "./openable-files";

const MAX_BODY_TEXT_CHARS = 30_000;
/**
 * The index parses with the reader's own remark plugin list and the same
 * remark-rehype + rehype-slug steps MarkdownRenderer runs, so heading ids and
 * link targets follow one set of syntax rules: setext and nested headings,
 * entities, images, footnote numbering, SmartyPants dashes, and dropped raw
 * HTML all come out as the reader renders them. `markdown-render.test.mjs`
 * still compares the two, because the reader adds sanitize and KaTeX after
 * slugging and this pipeline stops at the slug.
 *
 * Cost: about 0.9 ms per KiB on Node (measured on a 408-file, 1.7 MiB corpus:
 * 1.5 s against 55 ms for the markdown-it parser this replaced, most of it in
 * SmartyPants). Indexing reads files in batches of eight and yields between
 * batches, so a batch of typical 5-20 KiB documents costs 40-150 ms of
 * main-thread time; the result is cached per workspace.
 */
const indexPipeline = unified()
  .use(remarkParse)
  .use(remarkPlugins)
  .use(remarkRehype)
  .use(rehypeSlug);
// v7: heading ids follow the rendered slug pipeline; v6 entries hold ids the
// reader no longer produces for some headings.
export const WORKSPACE_INDEX_CACHE_KEY = "workspace:index:v7";
export const LEGACY_WORKSPACE_INDEX_CACHE_KEYS = [
  "workspace:index:v1",
  "workspace:index:v2",
  "workspace:index:v3",
  "workspace:index:v4",
  "workspace:index:v5",
  "workspace:index:v6",
] as const;
export const WORKSPACE_INDEX_CACHE_VERSION = 7 as const;
export const WORKSPACE_INDEX_CACHE_KEYS = [
  ...LEGACY_WORKSPACE_INDEX_CACHE_KEYS,
  WORKSPACE_INDEX_CACHE_KEY,
] as const;

interface HeadingWithLine extends WorkspaceHeading {
  line: number;
}

export interface WorkspaceIndexCache {
  version: typeof WORKSPACE_INDEX_CACHE_VERSION;
  rootPath: string;
  indexedAt: number;
  files: WorkspaceFileMeta[];
  docs: WorkspaceDocIndex[];
  processedCount: number;
  readFailedCount: number;
  complexitySkippedCount: number;
  listSkippedCount: number;
  limitHit: boolean;
}

export type WorkspaceDocumentBuildResult =
  | { status: "indexed"; doc: WorkspaceDocIndex }
  | { status: "too-complex" };

export function normalizeWorkspaceIndexCache(
  cache: Partial<WorkspaceIndexCache>,
): WorkspaceIndexCache {
  const files = Array.isArray(cache.files) ? cache.files : [];
  const docs = Array.isArray(cache.docs) ? cache.docs : [];

  return {
    version: WORKSPACE_INDEX_CACHE_VERSION,
    rootPath: typeof cache.rootPath === "string" ? cache.rootPath : "",
    indexedAt: finiteNumberOrDefault(cache.indexedAt, 0),
    files,
    docs,
    processedCount: clampCount(cache.processedCount, 0, files.length),
    readFailedCount: clampCount(cache.readFailedCount, 0, Number.MAX_SAFE_INTEGER),
    complexitySkippedCount: clampCount(cache.complexitySkippedCount, 0, Number.MAX_SAFE_INTEGER),
    listSkippedCount: clampCount(cache.listSkippedCount, 0, Number.MAX_SAFE_INTEGER),
    limitHit: cache.limitHit === true,
  };
}

export function buildWorkspaceStateFromCache(
  cache: WorkspaceIndexCache,
  rootPath: string,
): WorkspaceState {
  const normalized = normalizeWorkspaceIndexCache(cache);

  return {
    rootPath,
    status: "ready",
    fileCount: normalized.files.length,
    processedCount: normalized.processedCount,
    indexedCount: normalized.docs.length,
    indexedAt: normalized.indexedAt,
    error: null,
    listSkippedCount: normalized.listSkippedCount,
    readFailedCount: normalized.readFailedCount,
    complexitySkippedCount: normalized.complexitySkippedCount,
    limitHit: normalized.limitHit,
  };
}

export function buildWorkspaceErrorState(
  previous: WorkspaceState,
  rootPath: string,
  error: string,
): WorkspaceState {
  const preservePrevious = previous.rootPath === rootPath;

  return {
    rootPath,
    status: "error",
    fileCount: preservePrevious ? previous.fileCount : 0,
    processedCount: preservePrevious ? previous.processedCount : 0,
    indexedCount: preservePrevious ? previous.indexedCount : 0,
    indexedAt: preservePrevious ? previous.indexedAt : null,
    error,
    listSkippedCount: preservePrevious ? previous.listSkippedCount : 0,
    readFailedCount: preservePrevious ? previous.readFailedCount : 0,
    complexitySkippedCount: preservePrevious ? previous.complexitySkippedCount : 0,
    limitHit: preservePrevious ? previous.limitHit : false,
  };
}

export function buildWorkspaceRefreshErrorState(
  previous: WorkspaceState,
  lastGoodState: WorkspaceState | null,
  rootPath: string,
  error: string,
): WorkspaceState {
  const baseState = lastGoodState?.rootPath === rootPath ? lastGoodState : previous;
  return buildWorkspaceErrorState(baseState, rootPath, error);
}

export function buildWorkspaceDoc(
  meta: WorkspaceFileMeta,
  content: string,
  complexityOptions: DocumentComplexityOptions = {},
): WorkspaceDocIndex {
  if (meta.name.toLowerCase().endsWith(".fountain")) {
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
  const bodyText = toSearchableText(body);

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
  const title = titleEntry?.value || meta.name.replace(/\.fountain$/i, "").trim() || null;

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

function toSearchableText(markdown: string): string {
  let text = markdown;

  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " ");
  text = text.replace(/`[^`]*`/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, " $1 ");
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, " ");
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, " ");
  text = text.replace(/^>\s?/gm, " ");
  text = text.replace(/[\r\n]+/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  if (text.length > MAX_BODY_TEXT_CHARS) {
    return text.slice(0, MAX_BODY_TEXT_CHARS);
  }

  return text;
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampCount(value: unknown, min: number, max: number): number {
  const numberValue = finiteNumberOrDefault(value, min);
  return Math.min(Math.max(Math.trunc(numberValue), min), max);
}
