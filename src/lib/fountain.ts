import { Fountain, Lexer, rules } from "fountain-js";
import { MAX_WORKSPACE_BODY_CHARS } from "./workspace-limits";
import type { Token } from "fountain-js/dist.esm/token";
import type {
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

/**
 * fountain-js pairs dual dialogue through a static flag on its Lexer that is
 * only written when a dialogue block is lexed. Because it tokenizes in reverse,
 * the flag left behind is the caret state of the first dialogue block, and the
 * next parse of any text inherits it. The field is private in the library's
 * type declarations; tests/fountain-parser-robustness.test.cjs guards the name.
 */
const fountainLexerState = Lexer as unknown as { lastLineWasDualDialogue: boolean };

export function parseFountain(
  text: string,
  complexityOptions: DocumentComplexityOptions = {},
): ParsedFountain {
  assertDocumentComplexity(text, "fountain", complexityOptions);
  fountainLexerState.lastLineWasDualDialogue = false;
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
  // The blank-line rule matches zero characters at the start of an empty
  // string, which would leave exec() stuck at index 0 below.
  if (normalized.length === 0) return [];
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

/** Extensions such as (V.O.), (CONT'D) or (INTO PHONE) trail the cue. */
const CHARACTER_EXTENSIONS_RE = /(?:\s*\([^)]*\))+\s*$/;

export function normalizeCharacterName(raw: string): string {
  return raw.replace(CHARACTER_EXTENSIONS_RE, "").trim().toUpperCase();
}

export interface FountainInlineSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

type InlineStyle = Pick<FountainInlineSegment, "bold" | "italic" | "underline">;

const PLAIN_INLINE_STYLE: InlineStyle = { bold: false, italic: false, underline: false };

/** The characters a backslash escapes; mirrors `rules.escape` in fountain-js. */
export const FOUNTAIN_ESCAPABLE_CHARACTERS = new Set("@#!*_$~`+=.><\\/");

/**
 * Split inline emphasis into styled segments. Markers are ***, **, * and _.
 * A marker opens only when followed by a non-space, closes only when preceded
 * by one, and never spans a line break; _ must also sit at a word boundary so
 * identifiers like snake_case stay literal. Unmatched markers are text.
 * Both the reader and the search index use this, so they cannot disagree.
 */
export function splitFountainInline(text: string): FountainInlineSegment[] {
  return splitInline(text, PLAIN_INLINE_STYLE);
}

export function fountainPlainText(text: string): string {
  return splitFountainInline(text).map((segment) => segment.text).join("");
}

function splitInline(text: string, style: InlineStyle): FountainInlineSegment[] {
  const segments: FountainInlineSegment[] = [];
  let literal = "";
  const flush = () => {
    if (literal) segments.push({ text: literal, ...style });
    literal = "";
  };

  let index = 0;
  while (index < text.length) {
    if (isEscapeAt(text, index)) {
      literal += text[index + 1];
      index += 2;
      continue;
    }
    const marker = openingMarkerAt(text, index);
    const closeIndex = marker ? findClosingMarker(text, index + marker.length, marker) : -1;
    if (marker && closeIndex !== -1) {
      flush();
      const inner = text.slice(index + marker.length, closeIndex);
      segments.push(...splitInline(inner, styleWithMarker(style, marker)));
      index = closeIndex + marker.length;
      continue;
    }
    literal += text[index];
    index += 1;
  }
  flush();
  return segments;
}

function isEscapeAt(text: string, index: number): boolean {
  return text[index] === "\\" && FOUNTAIN_ESCAPABLE_CHARACTERS.has(text[index + 1] ?? "");
}

function markerRunAt(text: string, index: number): string | null {
  if (text[index] === "_") return "_";
  if (text[index] !== "*") return null;
  let length = 1;
  while (length < 3 && text[index + length] === "*") length += 1;
  return "*".repeat(length);
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /\w/.test(char);
}

function openingMarkerAt(text: string, index: number): string | null {
  const marker = markerRunAt(text, index);
  if (!marker) return null;
  const next = text[index + marker.length];
  if (next === undefined || /\s/.test(next)) return null;
  if (marker === "_" && isWordCharacter(text[index - 1])) return null;
  return marker;
}

function findClosingMarker(text: string, from: number, marker: string): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "\n") return -1;
    if (isEscapeAt(text, index)) {
      index += 2;
      continue;
    }
    const run = markerRunAt(text, index);
    if (!run) {
      index += 1;
      continue;
    }
    const closes =
      run === marker
      && index > from
      && !/\s/.test(text[index - 1])
      && (marker !== "_" || !isWordCharacter(text[index + 1]));
    if (closes) return index;
    index += run.length;
  }
  return -1;
}

function styleWithMarker(style: InlineStyle, marker: string): InlineStyle {
  switch (marker) {
    case "***": return { ...style, bold: true, italic: true };
    case "**": return { ...style, bold: true };
    case "*": return { ...style, italic: true };
    default: return { ...style, underline: true };
  }
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

/**
 * Whether a Markdown heading reads as a scene heading. Fountain files never
 * use this: their scenes come from the parser, which also drops the forced
 * leading dot, so only the INT/EXT/EST forms are recognized here.
 */
export function isMarkdownSceneHeadingText(text: string): boolean {
  return SCENE_HEADING_TEXT_RE.test(text.trim());
}

function splitSceneLocationAndTime(raw: string): Pick<ParsedSceneHeading, "location" | "timeOfDay"> {
  const trimmed = raw.trim();
  const dashIndex = trimmed.lastIndexOf(" - ");
  if (dashIndex === -1) {
    return { location: trimmed, timeOfDay: null };
  }

  return {
    location: trimmed.slice(0, dashIndex).trim(),
    timeOfDay: trimmed.slice(dashIndex + 3).trim().toUpperCase() || null,
  };
}

/** Parse a scene heading token's text; forced-heading dots are already gone. */
export function parseSceneHeading(text: string): ParsedSceneHeading {
  const trimmed = text.trim();
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

export function fountainToSearchableText(parsed: ParsedFountain): string {
  const result: string[] = [];
  let pendingSpace = false;

  const append = (text: string) => {
    for (let index = 0; index < text.length && result.length < MAX_WORKSPACE_BODY_CHARS; index += 1) {
      if (isWhitespaceCodeUnit(text.charCodeAt(index))) {
        pendingSpace = result.length > 0;
        continue;
      }
      if (pendingSpace && result.length < MAX_WORKSPACE_BODY_CHARS) result.push(" ");
      pendingSpace = false;
      if (result.length < MAX_WORKSPACE_BODY_CHARS) result.push(text[index]);
    }
    pendingSpace = result.length > 0;
  };

  for (const entry of parsed.titlePage) {
    append(fountainPlainText(entry.value));
    if (result.length >= MAX_WORKSPACE_BODY_CHARS) return result.join("");
  }

  for (const token of parsed.tokens) {
    if (token.text && token.type !== "spaces" && token.type !== "page_break") {
      append(fountainPlainText(token.text));
      if (result.length >= MAX_WORKSPACE_BODY_CHARS) break;
    }
  }

  return result.join("");
}
