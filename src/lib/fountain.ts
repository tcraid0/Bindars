import { Fountain, rules } from "fountain-js";
import type { Token } from "fountain-js/dist.esm/token";
import type {
  CharacterInfo,
  ParsedSceneHeading,
  ScriptCharacterStats,
  ScriptSceneStats,
  ScriptStats,
} from "../types";
import type { SourcePoint } from "./source-lines";
import type { DocumentComplexityOptions } from "./document-complexity";
import { assertDocumentComplexity } from "./document-complexity";
import { countWords, isWhitespaceCodeUnit } from "./word-count";

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
  source: SourcePoint | null;
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

const WORDS_PER_SCREENPLAY_PAGE = 160;
const SPOKEN_WORDS_PER_MINUTE = 150;
const SCENE_HEADING_TEXT_RE = /^(?:INT\.?\/EXT\.?|INT\/EXT\.?|I\.?\/E\.?|INT\.?|EXT\.?|EST\.?)\s+\S/i;
const SCENE_HEADING_PREFIX_RE = /^(INT\.?\/EXT\.?|INT\/EXT\.?|I\.?\/E\.?|INT\.?|EXT\.?)\s+(.+)$/i;
const ESTABLISHING_PREFIX_RE = /^EST\.?\s+(.+)$/i;
const FOUNTAIN_EMPHASIS_RE = /\*{1,3}(.+?)\*{1,3}/g;
const FOUNTAIN_UNDERLINE_RE = /_(.+?)_/g;
const NON_SCREENPLAY_STATS_TOKEN_TYPES = new Set(["spaces", "page_break", "section", "synopsis", "note"]);

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

export function parseFountain(
  text: string,
  complexityOptions: DocumentComplexityOptions = {},
): ParsedFountain {
  assertDocumentComplexity(text, "fountain", complexityOptions);
  const fountain = new Fountain();
  const output = fountain.parse(text, true);

  const titlePage: FountainTitlePageEntry[] = [];
  const tokens: FountainToken[] = [];
  const scenes: FountainScene[] = [];
  const sceneSourceCandidates = findFountainSceneSourceCandidates(text, output.tokens as Token[]);
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

      const source = sceneSourceCandidates.get(sceneIndex) ?? null;
      scenes.push({ id, text: token.text, index: sceneIndex, source });
      sceneIndex++;
    }

    tokens.push(ft);
  }

  return { titlePage, tokens, scenes };
}

interface FountainSourceBlock {
  text: string;
  source: SourcePoint;
}

function fountainSourceBlocks(content: string): FountainSourceBlock[] {
  const normalized = content
    .replace(rules.boneyard, (match) => match.replace(/[^\r\n]/g, " "))
    .replace(/\r\n|\r/g, "\n");
  const blankLineFlags = rules.blank_lines.flags.includes("g")
    ? rules.blank_lines.flags
    : `${rules.blank_lines.flags}g`;
  const blankLinesRule = new RegExp(rules.blank_lines.source, blankLineFlags);
  const blocks: FountainSourceBlock[] = [];
  let startOffset = 0;
  let scannedOffset = 0;
  let sourceLine = 1;
  let sourceLineStart = 0;
  let separator: RegExpExecArray | null;

  const sourceAt = (offset: number): SourcePoint => {
    for (let index = scannedOffset; index < offset; index += 1) {
      if (normalized[index] === "\n") {
        sourceLine += 1;
        sourceLineStart = index + 1;
      }
    }
    scannedOffset = offset;
    return { line: sourceLine, column: offset - sourceLineStart + 1 };
  };

  while ((separator = blankLinesRule.exec(normalized)) !== null) {
    if (separator.index > startOffset) {
      blocks.push({
        text: normalized.slice(startOffset, separator.index),
        source: sourceAt(startOffset),
      });
    }
    startOffset = separator.index + separator[0].length;
  }
  if (startOffset < normalized.length) {
    blocks.push({ text: normalized.slice(startOffset), source: sourceAt(startOffset) });
  }
  return blocks;
}

function firstCandidateIndexAtOrAfter(indices: number[], minimum: number): number | null {
  let left = 0;
  let right = indices.length - 1;
  let match: number | null = null;
  while (left <= right) {
    const middle = (left + right) >> 1;
    if (indices[middle] >= minimum) {
      match = indices[middle];
      right = middle - 1;
    } else {
      left = middle + 1;
    }
  }
  return match;
}

function findFountainSceneSourceCandidates(
  content: string,
  parsedTokens: Token[],
): Map<number, SourcePoint> {
  const candidates: Array<{ text: string; source: SourcePoint }> = [];
  const sceneRule = new RegExp(rules.scene_heading.source, rules.scene_heading.flags);
  const sceneNumberRule = new RegExp(rules.scene_number.source, rules.scene_number.flags);

  for (const block of fountainSourceBlocks(content)) {
    const match = sceneRule.exec(block.text);
    if (!match) continue;
    const captured = match[1] || match[2];
    if (!captured) continue;
    const normalized = captured.trim().replace(sceneNumberRule, "");
    const capturedIndex = block.text.indexOf(captured);
    candidates.push({
      text: normalized,
      source: {
        line: block.source.line,
        column: block.source.column + Math.max(0, capturedIndex),
      },
    });
  }

  const parsedScenes = parsedTokens
    .filter((token) => !token.is_title && token.type === "scene_heading" && token.text)
    .map((token) => token.text as string);
  const aligned = new Map<number, SourcePoint>();
  const candidateIndicesByText = new Map<string, number[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const indices = candidateIndicesByText.get(candidates[index].text) ?? [];
    indices.push(index);
    candidateIndicesByText.set(candidates[index].text, indices);
  }
  let minimumCandidateIndex = 0;
  for (let sceneIndex = 0; sceneIndex < parsedScenes.length; sceneIndex += 1) {
    const text = parsedScenes[sceneIndex];
    const candidateIndex = firstCandidateIndexAtOrAfter(
      candidateIndicesByText.get(text) ?? [],
      minimumCandidateIndex,
    );
    if (candidateIndex === null) continue;
    const candidate = candidates[candidateIndex];
    aligned.set(sceneIndex, candidate.source);
    minimumCandidateIndex = candidateIndex + 1;
  }
  return aligned;
}

const CHARACTER_EXTENSION_RE = /\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D)\)\s*/gi;

export function normalizeCharacterName(raw: string): string {
  return raw.replace(CHARACTER_EXTENSION_RE, "").trim().toUpperCase();
}

function stripFountainEmphasis(text: string): string {
  return text
    .replace(FOUNTAIN_EMPHASIS_RE, "$1")
    .replace(FOUNTAIN_UNDERLINE_RE, "$1");
}

function countTokenWords(text?: string): number {
  if (!text) return 0;
  return countWords(text);
}

function shouldCountForScreenplayStats(tokenType: string): boolean {
  return !NON_SCREENPLAY_STATS_TOKEN_TYPES.has(tokenType);
}

function normalizeScenePrefix(prefix: string): ParsedSceneHeading["intExt"] {
  const normalized = prefix.replace(/\./g, "").toUpperCase();
  if (normalized === "I/E" || normalized === "INT/EXT") return "INT/EXT";
  if (normalized === "INT") return "INT";
  if (normalized === "EXT") return "EXT";
  return null;
}

function normalizeSceneLocation(raw: string): string {
  return raw.trim().replace(/^\.\s*/, "");
}

function stripForcedSceneHeadingDot(text: string): string {
  return text.startsWith(".") ? text.slice(1).trimStart() : text;
}

export function isSceneHeadingText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith(".")) {
    return stripForcedSceneHeadingDot(trimmed).length > 0;
  }
  return SCENE_HEADING_TEXT_RE.test(trimmed);
}

export function isMarkdownSceneHeadingText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith(".")) {
    return false;
  }
  return isSceneHeadingText(trimmed);
}

function splitSceneLocationAndTime(raw: string): Pick<ParsedSceneHeading, "location" | "timeOfDay"> {
  const trimmed = raw.trim();
  const dashIndex = trimmed.lastIndexOf(" - ");
  if (dashIndex === -1) {
    return {
      location: normalizeSceneLocation(trimmed),
      timeOfDay: null,
    };
  }

  return {
    location: normalizeSceneLocation(trimmed.slice(0, dashIndex)),
    timeOfDay: trimmed.slice(dashIndex + 3).trim().toUpperCase() || null,
  };
}

export function parseSceneHeading(text: string): ParsedSceneHeading {
  const trimmed = stripForcedSceneHeadingDot(text.trim());
  const establishingMatch = ESTABLISHING_PREFIX_RE.exec(trimmed);
  if (establishingMatch) {
    const { location, timeOfDay } = splitSceneLocationAndTime(establishingMatch[1]);
    return {
      intExt: null,
      location,
      timeOfDay,
    };
  }

  const sceneMatch = SCENE_HEADING_PREFIX_RE.exec(trimmed);
  if (!sceneMatch) {
    const { location, timeOfDay } = splitSceneLocationAndTime(trimmed);
    return {
      intExt: null,
      location,
      timeOfDay,
    };
  }

  const intExt = normalizeScenePrefix(sceneMatch[1]);
  const { location, timeOfDay } = splitSceneLocationAndTime(sceneMatch[2]);

  return {
    intExt,
    location,
    timeOfDay,
  };
}

function roundToTenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function toPageCount(wordCount: number): number {
  if (wordCount <= 0) return 0;
  return Math.max(1, Math.round(wordCount / WORDS_PER_SCREENPLAY_PAGE));
}

interface CharacterAccumulator {
  dialogueCount: number;
  dialogueWordCount: number;
  sceneIds: Set<string>;
  firstSceneId: string | null;
  lastSceneId: string | null;
}

interface SceneAccumulator {
  sceneId: string;
  heading: string;
  parsed: ParsedSceneHeading;
  wordCount: number;
  characterNames: Set<string>;
}

function finalizeScene(scene: SceneAccumulator | null): ScriptSceneStats | null {
  if (!scene) return null;
  return {
    sceneId: scene.sceneId,
    heading: scene.heading,
    parsed: scene.parsed,
    wordCount: scene.wordCount,
    pageEstimate: roundToTenths(scene.wordCount / WORDS_PER_SCREENPLAY_PAGE),
    characterNames: Array.from(scene.characterNames).sort(),
  };
}

function getOrCreateCharacter(
  map: Map<string, CharacterAccumulator>,
  name: string,
): CharacterAccumulator {
  const existing = map.get(name);
  if (existing) return existing;

  const created: CharacterAccumulator = {
    dialogueCount: 0,
    dialogueWordCount: 0,
    sceneIds: new Set<string>(),
    firstSceneId: null,
    lastSceneId: null,
  };
  map.set(name, created);
  return created;
}

export function computeScriptStats(parsed: ParsedFountain): ScriptStats {
  const characterMap = new Map<string, CharacterAccumulator>();
  const scenes: ScriptSceneStats[] = [];
  const locationKeys = new Set<string>();
  let currentScene: SceneAccumulator | null = null;
  let currentSpeaker: string | null = null;
  let currentSceneId: string | null = null;
  let sceneIdx = 0;
  let dialogueWords = 0;
  let actionWords = 0;
  let totalWords = 0;

  for (const token of parsed.tokens) {
    const tokenWordCount =
      shouldCountForScreenplayStats(token.type)
        ? countTokenWords(token.text)
        : 0;

    if (token.type === "scene_heading" && token.text) {
      const finalized = finalizeScene(currentScene);
      if (finalized) {
        scenes.push(finalized);
        if (finalized.parsed.location) {
          locationKeys.add(finalized.parsed.location.toUpperCase());
        }
      }

      const scene = parsed.scenes[sceneIdx];
      sceneIdx += 1;
      currentSceneId = scene?.id ?? null;
      currentSpeaker = null;
      currentScene = currentSceneId
        ? {
            sceneId: currentSceneId,
            heading: token.text,
            parsed: parseSceneHeading(token.text),
            wordCount: 0,
            characterNames: new Set<string>(),
          }
        : null;

      totalWords += tokenWordCount;
      continue;
    }

    if (tokenWordCount > 0) {
      totalWords += tokenWordCount;
      if (currentScene) {
        currentScene.wordCount += tokenWordCount;
      }
    }

    if (token.type === "character" && token.text) {
      const name = normalizeCharacterName(token.text);
      currentSpeaker = name || null;
      if (!name) {
        continue;
      }

      const character = getOrCreateCharacter(characterMap, name);
      character.dialogueCount += 1;

      if (currentSceneId) {
        character.sceneIds.add(currentSceneId);
        character.firstSceneId ??= currentSceneId;
        character.lastSceneId = currentSceneId;
        currentScene?.characterNames.add(name);
      }
      continue;
    }

    if ((token.type === "dialogue" || token.type === "parenthetical") && tokenWordCount > 0) {
      dialogueWords += tokenWordCount;
      if (currentSpeaker) {
        const character = getOrCreateCharacter(characterMap, currentSpeaker);
        character.dialogueWordCount += tokenWordCount;
      }
      continue;
    }

    if (token.type === "action" && tokenWordCount > 0) {
      actionWords += tokenWordCount;
    }
  }

  const finalized = finalizeScene(currentScene);
  if (finalized) {
    scenes.push(finalized);
    if (finalized.parsed.location) {
      locationKeys.add(finalized.parsed.location.toUpperCase());
    }
  }

  const characters: ScriptCharacterStats[] = Array.from(characterMap.entries())
    .map(([name, info]) => ({
      name,
      dialogueCount: info.dialogueCount,
      dialogueWordCount: info.dialogueWordCount,
      speakingTimeMinutes: roundToTenths(info.dialogueWordCount / SPOKEN_WORDS_PER_MINUTE),
      sceneCount: info.sceneIds.size,
      firstSceneId: info.firstSceneId,
      lastSceneId: info.lastSceneId,
    }))
    .sort((a, b) =>
      b.dialogueWordCount - a.dialogueWordCount ||
      b.dialogueCount - a.dialogueCount ||
      a.name.localeCompare(b.name),
    );

  const totalPages = toPageCount(totalWords);
  const totalContentWords = dialogueWords + actionWords;

  return {
    totalPages,
    estimatedRuntimeMinutes: totalPages,
    speakingCharacterCount: characters.filter((character) => character.dialogueWordCount > 0).length,
    uniqueLocationCount: locationKeys.size,
    dialoguePercentage: totalContentWords > 0
      ? Math.round((dialogueWords / totalContentWords) * 100)
      : 0,
    scenes,
    characters,
  };
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

export function fountainToSearchableText(parsed: ParsedFountain): string {
  const result: string[] = [];
  let pendingSpace = false;

  const append = (text: string) => {
    for (let index = 0; index < text.length && result.length < 30_000; index += 1) {
      if (isWhitespaceCodeUnit(text.charCodeAt(index))) {
        pendingSpace = result.length > 0;
        continue;
      }
      if (pendingSpace && result.length < 30_000) result.push(" ");
      pendingSpace = false;
      if (result.length < 30_000) result.push(text[index]);
    }
    pendingSpace = result.length > 0;
  };

  for (const entry of parsed.titlePage) {
    append(stripFountainEmphasis(entry.value));
    if (result.length >= 30_000) return result.join("");
  }

  for (const token of parsed.tokens) {
    if (token.text && token.type !== "spaces" && token.type !== "page_break") {
      append(stripFountainEmphasis(token.text));
      if (result.length >= 30_000) break;
    }
  }

  return result.join("");
}
