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
import { parseFountain, fountainToSearchableText, isMarkdownSceneHeadingText } from "./fountain";
import { updateMarkdownFenceState, type MarkdownFenceState } from "./markdown-fences";
import { resolveMarkdownLink, toPathIdentityKey } from "./paths";

const MAX_BODY_TEXT_CHARS = 30_000;
// Raw HTML links are intentionally not indexed; the renderer does not enable raw HTML.
const markdownLinkParser = new MarkdownIt({ html: false, linkify: false });
export const WORKSPACE_INDEX_CACHE_KEY = "workspace:index:v4";
export const LEGACY_WORKSPACE_INDEX_CACHE_KEYS = [
  "workspace:index:v1",
  "workspace:index:v2",
  "workspace:index:v3",
] as const;
export const WORKSPACE_INDEX_CACHE_VERSION = 4 as const;
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
  listSkippedCount: number;
  limitHit: boolean;
}

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

export function buildWorkspaceDoc(meta: WorkspaceFileMeta, content: string): WorkspaceDocIndex {
  if (meta.name.toLowerCase().endsWith(".fountain")) {
    return buildFountainDoc(meta, content);
  }

  const { frontmatter, body } = extractFrontmatter(content);
  const headingRows = extractHeadings(body);
  const headings = headingRows.map((row) => ({ id: row.id, text: row.text }));
  const title = getTitle(frontmatter, headings, meta.name);

  const links = extractLinks(body, meta.path);
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

function buildFountainDoc(meta: WorkspaceFileMeta, content: string): WorkspaceDocIndex {
  const parsed = parseFountain(content);

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

  const bodyText = fountainToSearchableText(content);

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

  const fallback = fileName.replace(/\.(md|markdown|fountain)$/i, "").trim();
  return fallback || null;
}

function extractHeadings(markdown: string): HeadingWithLine[] {
  const lines = markdown.split(/\r?\n/);
  const slugger = new GithubSlugger();
  const headings: HeadingWithLine[] = [];
  let fenceState: MarkdownFenceState | null = null;

  lines.forEach((line, index) => {
    const previousFenceState = fenceState;
    fenceState = updateMarkdownFenceState(line, fenceState);
    if (previousFenceState || fenceState) {
      return;
    }

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return;

    const text = stripMarkdownInline(match[2]);
    if (!text) return;

    const id = slugger.slug(toRenderedHeadingSlugText(text));
    headings.push({ id, text, line: index + 1 });
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

function extractLinks(markdown: string, currentFilePath: string): string[] {
  const targets = new Set<string>();
  const tokens = markdownLinkParser.parse(markdown, {});

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

function stripMarkdownInline(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
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
