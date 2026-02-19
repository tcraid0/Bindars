import type { WorkspaceDocIndex, WorkspaceSearchHit } from "../types";

const CONTENT_CONTEXT_CHARS = 70;

export function searchWorkspaceDocs(
  docs: WorkspaceDocIndex[],
  query: string,
  recentBoostByPath: Map<string, number>,
  maxResults = 50,
): WorkspaceSearchHit[] {
  const q = query.trim().toLowerCase();

  if (!q) {
    return docs
      .slice()
      .sort((a, b) => {
        const scoreA = recentBoostByPath.get(a.path) ?? 0;
        const scoreB = recentBoostByPath.get(b.path) ?? 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.relPath.localeCompare(b.relPath);
      })
      .slice(0, Math.min(maxResults, 20))
      .map((doc) => ({
        path: doc.path,
        relPath: doc.relPath,
        kind: "title" as const,
        score: 0,
        headingId: null,
        snippet: doc.title || doc.name,
      }));
  }

  const hits: WorkspaceSearchHit[] = [];

  for (const doc of docs) {
    const recentBoost = recentBoostByPath.get(doc.path) ?? 0;
    const title = (doc.title || doc.name).toLowerCase();

    const titleIdx = title.indexOf(q);
    if (titleIdx >= 0) {
      const exact = title === q ? 30 : 0;
      const starts = titleIdx === 0 ? 20 : 0;
      hits.push({
        path: doc.path,
        relPath: doc.relPath,
        kind: "title",
        score: 110 + exact + starts + recentBoost,
        headingId: null,
        snippet: doc.title || doc.name,
      });
    }

    let headingMatches = 0;
    for (const heading of doc.headings) {
      const headingLower = heading.text.toLowerCase();
      const headingIdx = headingLower.indexOf(q);
      if (headingIdx < 0) continue;

      const starts = headingIdx === 0 ? 10 : 0;
      hits.push({
        path: doc.path,
        relPath: doc.relPath,
        kind: "heading",
        score: 85 + starts + recentBoost,
        headingId: heading.id,
        heading: heading.text,
        snippet: heading.text,
      });

      headingMatches += 1;
      if (headingMatches >= 2) break;
    }

    const bodyLower = doc.bodyText.toLowerCase();
    const contentIdx = bodyLower.indexOf(q);
    if (contentIdx >= 0) {
      hits.push({
        path: doc.path,
        relPath: doc.relPath,
        kind: "content",
        score: 60 + recentBoost,
        headingId: null,
        snippet: createSnippet(doc.bodyText, contentIdx, q.length),
      });
    }
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.relPath.length !== b.relPath.length) return a.relPath.length - b.relPath.length;
    return a.relPath.localeCompare(b.relPath);
  });

  return hits.slice(0, maxResults);
}

export function createRecentBoostMap(recentPaths: string[]): Map<string, number> {
  const map = new Map<string, number>();

  recentPaths.forEach((path, idx) => {
    const boost = Math.max(0, 20 - idx * 2);
    if (boost > 0) map.set(path, boost);
  });

  return map;
}

function createSnippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTENT_CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + CONTENT_CONTEXT_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}
