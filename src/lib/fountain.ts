import { Fountain } from "fountain-js";
import type { Token } from "fountain-js/dist.esm/token";
import type { CharacterInfo } from "../types";

export interface FountainToken {
  type: string;
  text?: string;
  scene_number?: string;
  dual?: string;
  is_title?: boolean;
  depth?: number;
}

export interface FountainScene {
  id: string;
  text: string;
  index: number;
}

export interface FountainTitlePageEntry {
  key: string;
  value: string;
}

export interface ParsedFountain {
  titlePage: FountainTitlePageEntry[];
  tokens: FountainToken[];
  scenes: FountainScene[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeTitleKey(type: string): string {
  return type.replace(/_/g, " ").trim();
}

export function parseFountain(text: string): ParsedFountain {
  const fountain = new Fountain();
  const output = fountain.parse(text, true);

  const titlePage: FountainTitlePageEntry[] = [];
  const tokens: FountainToken[] = [];
  const scenes: FountainScene[] = [];
  const slugCounts = new Map<string, number>();

  let sceneIndex = 0;

  for (const token of output.tokens as Token[]) {
    const ft: FountainToken = {
      type: token.type,
      text: token.text,
      scene_number: token.scene_number,
      dual: token.dual as string | undefined,
      is_title: token.is_title,
      depth: token.depth,
    };

    if (token.is_title && token.text) {
      const key = normalizeTitleKey(token.type);
      const value = token.text.trim();
      if (key && value) {
        titlePage.push({ key, value });
      }
      continue;
    }

    if (token.type === "scene_heading" && token.text) {
      const baseSlug = slugify(token.text) || "scene";
      const count = slugCounts.get(baseSlug) || 0;
      slugCounts.set(baseSlug, count + 1);
      const id = count === 0 ? baseSlug : `${baseSlug}-${count}`;

      scenes.push({ id, text: token.text, index: sceneIndex });
      sceneIndex++;
    }

    tokens.push(ft);
  }

  return { titlePage, tokens, scenes };
}

const CHARACTER_EXTENSION_RE = /\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D)\)\s*/gi;

export function normalizeCharacterName(raw: string): string {
  return raw.replace(CHARACTER_EXTENSION_RE, "").trim().toUpperCase();
}

export function extractCharacters(parsed: ParsedFountain): CharacterInfo[] {
  const map = new Map<string, { dialogueCount: number; firstSceneId: string | null }>();
  let currentSceneId: string | null = null;
  let sceneIdx = 0;

  for (const token of parsed.tokens) {
    if (token.type === "scene_heading") {
      currentSceneId = parsed.scenes[sceneIdx]?.id ?? null;
      sceneIdx++;
    }
    if (token.type === "character" && token.text) {
      const name = normalizeCharacterName(token.text);
      if (!name) continue;
      const existing = map.get(name);
      if (existing) {
        existing.dialogueCount++;
      } else {
        map.set(name, { dialogueCount: 1, firstSceneId: currentSceneId });
      }
    }
  }

  return Array.from(map.entries())
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => b.dialogueCount - a.dialogueCount);
}

export function fountainToSearchableText(text: string): string {
  const { titlePage, tokens } = parseFountain(text);
  const parts: string[] = [];

  for (const entry of titlePage) {
    parts.push(entry.value);
  }

  for (const token of tokens) {
    if (token.text && token.type !== "spaces" && token.type !== "page_break") {
      parts.push(token.text);
    }
  }

  let result = parts.join(" ");
  // Strip Fountain emphasis markers (*italic*, **bold**, ***bold-italic***, _underline_)
  result = result.replace(/\*{1,3}(.+?)\*{1,3}/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/\s+/g, " ").trim();
  if (result.length > 30_000) {
    return result.slice(0, 30_000);
  }
  return result;
}
