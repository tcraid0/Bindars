import GithubSlugger from "github-slugger";
import type {
  SceneItem,
  WorkspaceDocIndex,
  WorkspaceFileMeta,
  WorkspaceHeading,
} from "../types";
import { extractFrontmatter } from "./frontmatter";
import { parseFountain, fountainToSearchableText } from "./fountain";
import { resolveMarkdownLink, toPathIdentityKey } from "./paths";

const MAX_BODY_TEXT_CHARS = 30_000;
const SCENE_RE = /^(?:INT\.|EXT\.|INT\/EXT\.|EST\.)\s+/i;

interface HeadingWithLine extends WorkspaceHeading {
  line: number;
}

export interface WorkspaceIndexCache {
  version: 1;
  rootPath: string;
  indexedAt: number;
  files: WorkspaceFileMeta[];
  docs: WorkspaceDocIndex[];
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
  let inFence = false;
  let fenceChar = "";

  lines.forEach((line, index) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const currentFence = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = currentFence;
      } else if (fenceChar === currentFence) {
        inFence = false;
        fenceChar = "";
      }
      return;
    }
    if (inFence) return;

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return;

    const text = stripMarkdownInline(match[2]);
    if (!text) return;

    const id = slugger.slug(text);
    headings.push({ id, text, line: index + 1 });
  });

  return headings;
}

function extractScenes(headings: HeadingWithLine[]): SceneItem[] {
  const scenes: SceneItem[] = [];

  for (const heading of headings) {
    if (!SCENE_RE.test(heading.text)) continue;
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
  const sanitized = stripFencedCode(markdown);
  const targets = new Set<string>();
  const re = /\[[^\]]*\]\(([^)]+)\)/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(sanitized))) {
    // Skip image syntax: ![alt](url)
    const matchIndex = match.index;
    if (matchIndex > 0 && sanitized[matchIndex - 1] === "!") {
      continue;
    }

    const raw = normalizeHref(match[1]);
    if (!raw) continue;

    const resolved = resolveMarkdownLink(raw, currentFilePath);
    if (!resolved) continue;
    const targetKey = toPathIdentityKey(resolved.path);
    if (!targetKey) continue;
    targets.add(targetKey);
  }

  return Array.from(targets);
}

function normalizeHref(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace > 0) {
    return trimmed.slice(0, firstSpace).trim();
  }

  return trimmed;
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

function stripFencedCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ");
}
