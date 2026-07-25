import { useMemo } from "react";
import type { BacklinkItem, MentionItem, SceneItem, WorkspaceDocIndex } from "../types";
import { toPathIdentityKey } from "../lib/paths";

interface WorkspaceInsights {
  backlinks: BacklinkItem[];
  mentions: MentionItem[];
  scenes: SceneItem[];
}

const EMPTY: WorkspaceInsights = {
  backlinks: [],
  mentions: [],
  scenes: [],
};

export function useWorkspaceInsights(docs: WorkspaceDocIndex[], currentFilePath: string | null): WorkspaceInsights {
  return useMemo(() => computeWorkspaceInsights(docs, currentFilePath), [docs, currentFilePath]);
}

function normalizeMentionTerm(input: string | null): string | null {
  if (!input) return null;
  const term = input.replace(/\.(md|markdown)$/i, "").trim();
  if (term.length < 3) return null;
  return term;
}

function findWordMatchIndex(text: string, term: string): number {
  const pattern = new RegExp(`(^|[^\\w])(${escapeRegex(term)})(?=$|[^\\w])`, "i");
  const match = pattern.exec(text);
  if (!match || typeof match.index !== "number") return -1;
  const prefixLength = match[1]?.length ?? 0;
  return match.index + prefixLength;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAround(text: string, index: number, length: number): string {
  const pad = 50;
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function computeWorkspaceInsights(
  docs: WorkspaceDocIndex[],
  currentFilePath: string | null,
): WorkspaceInsights {
  if (!currentFilePath) return EMPTY;

  const currentPathKey = toPathIdentityKey(currentFilePath);
  if (!currentPathKey) return EMPTY;

  const currentDoc = docs.find((doc) => toPathIdentityKey(doc.path) === currentPathKey);
  if (!currentDoc) return EMPTY;

  const backlinks: BacklinkItem[] = [];
  const mentions: MentionItem[] = [];
  const mentionTerm = normalizeMentionTerm(currentDoc.title || currentDoc.name);

  for (const doc of docs) {
    if (toPathIdentityKey(doc.path) === currentPathKey) continue;

    if (doc.links.includes(currentPathKey)) {
      backlinks.push({
        fromPath: doc.path,
        relPath: doc.relPath,
        context: doc.title || doc.name,
      });
    }

    if (mentionTerm && !doc.links.includes(currentPathKey)) {
      const idx = findWordMatchIndex(doc.bodyText, mentionTerm);
      if (idx >= 0) {
        mentions.push({
          path: doc.path,
          relPath: doc.relPath,
          matchText: mentionTerm,
          context: snippetAround(doc.bodyText, idx, mentionTerm.length),
        });
      }
    }
  }

  backlinks.sort((a, b) => a.relPath.localeCompare(b.relPath));
  mentions.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return {
    backlinks,
    mentions,
    scenes: currentDoc.scenes,
  };
}
