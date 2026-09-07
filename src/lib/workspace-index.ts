import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
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
import { resolveMarkdownLink, toPathIdentityKey } from "./paths";
import { replaceOpenableDocumentExtension } from "./openable-files";

const MAX_BODY_TEXT_CHARS = 30_000;
// One parse per document serves both headings and links. Raw HTML is parsed
// as opaque html tokens so, like the renderer (which drops raw HTML), neither
// links nor heading text inside it are indexed.
const markdownParser = new MarkdownIt({ html: true, linkify: false });
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
  const env: MarkdownEnv = {};
  const tokens = markdownParser.parse(body, env);
  const headingRows = extractHeadings(tokens, collectFootnoteNumbers(tokens, env));
  const headings = headingRows.map((row) => ({ id: row.id, text: row.text }));
  const title = getTitle(frontmatter, headings, meta.name);

  const links = extractLinks(tokens, meta.path);
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

interface MarkdownEnv {
  /** markdown-it stores link reference definitions here, keyed by normalized label. */
  references?: Record<string, unknown>;
}

const FOOTNOTE_REFERENCE_RE = /\[\^([^\]\s]+)\]/g;
const FOOTNOTE_DEFINITION_LINE_RE = /^ {0,3}\[\^([^\]\s]+)\]:/;

function normalizeFootnoteLabel(label: string): string {
  return label.toLowerCase();
}

/**
 * remark-gfm renders `[^label]` as its footnote number when a definition
 * exists, numbering by first reference in document order and matching labels
 * case-insensitively. markdown-it has no footnote syntax: a multi-word
 * definition stays a paragraph starting with `[^label]:`, and a single-word
 * one (`[^n]: note`) is consumed as a link reference definition, turning each
 * `[^n]` into a reference link whose text is `^n`. Both forms are recognised
 * here so heading ids match the rendered ones.
 */
function collectFootnoteNumbers(tokens: Token[], env: MarkdownEnv): Map<string, number> {
  const defined = new Set<string>();
  for (const label of Object.keys(env.references ?? {})) {
    if (label.startsWith("^")) defined.add(normalizeFootnoteLabel(label.slice(1)));
  }
  for (const token of tokens) {
    if (token.type !== "inline") continue;
    for (const line of token.content.split("\n")) {
      const match = FOOTNOTE_DEFINITION_LINE_RE.exec(line);
      if (match) defined.add(normalizeFootnoteLabel(match[1]));
    }
  }

  const numbers = new Map<string, number>();
  if (defined.size === 0) return numbers;
  const assign = (label: string): void => {
    const key = normalizeFootnoteLabel(label);
    if (defined.has(key) && !numbers.has(key)) numbers.set(key, numbers.size + 1);
  };
  const visit = (children: Token[]): void => {
    for (const child of children) {
      if (child.type === "text") {
        for (const match of child.content.matchAll(FOOTNOTE_REFERENCE_RE)) assign(match[1]);
      } else if (child.type === "link_open") {
        const label = referenceLinkFootnoteLabel(children, child);
        if (label) assign(label);
      }
      if (child.children) visit(child.children);
    }
  };
  for (const token of tokens) {
    if (token.type === "inline" && token.children) visit(token.children);
  }
  return numbers;
}

/** The `^label` text of a reference link markdown-it built from `[^label]`, if any. */
function referenceLinkFootnoteLabel(siblings: Token[], linkOpen: Token): string | null {
  const index = siblings.indexOf(linkOpen);
  const text = siblings[index + 1];
  const close = siblings[index + 2];
  if (text?.type !== "text" || close?.type !== "link_close" || !text.content.startsWith("^")) {
    return null;
  }
  return text.content.slice(1);
}

/**
 * Headings come from the same token stream as links, so ATX and setext
 * headings, headings inside lists and quotes, closing `#` runs, entities, and
 * inline markup all follow markdown-it rather than a second hand-written
 * parser. The id must equal the one rehype-slug assigns to the rendered
 * heading, because the palette navigates by it; `markdown-render.test.mjs`
 * compares the two pipelines shape by shape.
 */
function extractHeadings(tokens: Token[], footnotes: Map<string, number>): HeadingWithLine[] {
  const slugger = new GithubSlugger();
  const headings: HeadingWithLine[] = [];

  tokens.forEach((token, index) => {
    if (token.type !== "heading_open") return;
    const inline = tokens[index + 1];
    const rawText = inline?.type === "inline" ? inlineText(inline.children ?? [], footnotes) : "";
    const text = rawText.trim();
    if (!text) return;

    // Slug the untrimmed text: rehype-slug keeps the whitespace an image or
    // dropped tag leaves behind (`## ![x](a.png) after` renders as `-after`).
    const id = slugger.slug(toRenderedHeadingSlugText(rawText));
    headings.push({ id, text, line: (token.map?.[0] ?? 0) + 1 });
  });

  return headings;
}

/**
 * Text the renderer would slug: images and raw HTML contribute nothing, line
 * breaks inside a setext heading stay newlines (which the slugger drops rather
 * than hyphenates), and defined footnote references become their number.
 */
function inlineText(children: Token[], footnotes: Map<string, number>): string {
  let text = "";
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    switch (child.type) {
      case "text":
        text += child.content.replace(FOOTNOTE_REFERENCE_RE, (whole, label: string) => {
          const number = footnotes.get(normalizeFootnoteLabel(label));
          return number === undefined ? whole : String(number);
        });
        break;
      case "code_inline":
        text += child.content;
        break;
      case "softbreak":
      case "hardbreak":
        text += "\n";
        break;
      case "image":
      case "html_inline":
        break;
      case "link_open": {
        const label = referenceLinkFootnoteLabel(children, child);
        const number = label === null ? undefined : footnotes.get(normalizeFootnoteLabel(label));
        if (number !== undefined) {
          text += String(number);
          index += 2;
        }
        break;
      }
      default:
        if (child.children) text += inlineText(child.children, footnotes);
    }
  }
  return text;
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

function extractLinks(tokens: Token[], currentFilePath: string): string[] {
  const targets = new Set<string>();

  for (const raw of extractLinkHrefs(tokens)) {
    const href = raw.trim();
    if (!href) continue;

    const resolved = resolveMarkdownLink(href, currentFilePath);
    if (!resolved) continue;
    const targetKey = toPathIdentityKey(resolved.path);
    if (!targetKey) continue;
    targets.add(targetKey);
  }

  return Array.from(targets);
}

function extractLinkHrefs(tokens: Token[]): string[] {
  const hrefs: string[] = [];

  for (const token of tokens) {
    if (token.type === "link_open") {
      const href = token.attrGet("href");
      if (href) hrefs.push(href);
    }
    if (token.children) {
      hrefs.push(...extractLinkHrefs(token.children));
    }
  }

  return hrefs;
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

function toRenderedHeadingSlugText(value: string): string {
  // Keep workspace-index heading IDs aligned with remark-smartypants before rehype-slug.
  return value.replace(/(^|[^-])--(?!-)/g, "$1—");
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampCount(value: unknown, min: number, max: number): number {
  const numberValue = finiteNumberOrDefault(value, min);
  return Math.min(Math.max(Math.trunc(numberValue), min), max);
}
