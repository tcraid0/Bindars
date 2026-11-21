import type { Highlight, Bookmark, HeadingItem } from "../types";
import { HEADING_SELECTOR } from "./editor-position";

export interface HighlightPlace {
  id: string;
  headingId: string | null;
}

/** Painted highlights in reading order, each with the visible heading above it. */
export function readHighlightPlaces(container: HTMLElement | null): HighlightPlace[] {
  if (!container) return [];
  const places: HighlightPlace[] = [];
  const seen = new Set<string>();
  let headingId: string | null = null;
  for (const element of container.querySelectorAll<HTMLElement>(`${HEADING_SELECTOR}, mark[data-highlight-id]`)) {
    if (element.tagName !== "MARK") {
      // Footnotes belong to the last visible section.
      if (!element.classList.contains("sr-only")) headingId = element.id;
      continue;
    }
    const id = element.dataset.highlightId;
    // A passage across blocks paints more than one mark.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    places.push({ id, headingId });
  }
  return places;
}

// Guard Markdown block starts and HTML tags so the copied text stays readable.
const BLOCK_START = /^(\s{0,3})(#{1,6}(?=\s|$)|>|`{3}|~{3}|(?:=+|-{1,2})\s*$|(?<marker>[-*_])(?:[ \t]*\k<marker>){2,}[ \t]*$|\[[^\]]*\]:)/;
// Raw HTML that Markdown would hide: a tag name opening a line (an HTML block),
// or a complete tag, comment or declaration anywhere. "a<b" stays as written.
const HTML_START = /^(\s{0,3})<(?=\/?[A-Za-z])|<(?=\/?[A-Za-z][^<>]*>|[!?])/g;
const escapeTags = (text: string) => text.replace(HTML_START, (_match, indent = "") => `${indent}\\<`);
const guard = (line: string) => escapeTags(line.replace(BLOCK_START, "$1\\$2"));
const inline = (text: string) => escapeTags(text.replace(/\s*[\r\n]+\s*/g, " ").trim());
const lines = (text: string) => text.trim().split(/\r\n|\r|\n/).map((line) => line.trimEnd());
const quote = (text: string) => lines(text)
  .filter((line, index, all) => line || all[index - 1]) // Keep one blank line per run.
  .map((line) => (line ? `> ${guard(line)}` : ">"))
  .join("\n");

function highlightBlocks(highlight: Highlight): string[] {
  const note = highlight.note?.trim();
  return note ? [quote(highlight.exact), lines(note).map(guard).join("\n")] : [quote(highlight.exact)];
}

export interface AnnotationExport {
  fileName: string;
  highlights: Highlight[];
  bookmarks: Bookmark[];
  headings: HeadingItem[];
  places: HighlightPlace[];
}

/** One plain-text and Markdown format for Copy and Export. */
export function buildAnnotationMarkdown({ fileName, highlights, bookmarks, headings, places }: AnnotationExport): string {
  const headingText = new Map(headings.map((heading) => [heading.id, inline(heading.text)]));
  const byId = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  const blocks = [`Highlights and notes from ${inline(fileName)}`];
  const written = new Set<string>();
  let section: string | null = null;
  for (const place of places) {
    const highlight = byId.get(place.id);
    if (!highlight || written.has(highlight.id)) continue;
    written.add(highlight.id);
    if (place.headingId !== section) {
      section = place.headingId;
      const text = section ? headingText.get(section) : undefined;
      if (text) blocks.push(`## ${text}`);
    }
    blocks.push(...highlightBlocks(highlight));
  }
  const unplaced = highlights.filter((highlight) => !written.has(highlight.id));
  if (unplaced.length > 0) {
    blocks.push("## Location unavailable");
    for (const highlight of unplaced) blocks.push(...highlightBlocks(highlight));
  }
  if (bookmarks.length > 0) {
    const order = new Map(headings.map((heading, index) => [heading.id, index]));
    const sorted = [...bookmarks].sort((a, b) =>
      (order.get(a.headingId) ?? headings.length) - (order.get(b.headingId) ?? headings.length));
    blocks.push("## Bookmarks", sorted.map((bookmark) => `- ${inline(bookmark.headingText)}`).join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}
