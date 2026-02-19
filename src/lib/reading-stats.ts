export interface ReadingStats {
  wordCount: number;
  readingTimeMinutes: number;
  pageCount?: number;
}

const WORDS_PER_MINUTE = 230;

/**
 * Compute word count and estimated reading time from markdown/fountain content.
 * Strips frontmatter/title page and code blocks before counting.
 */
export function computeReadingStats(content: string, fileType?: string): ReadingStats {
  let text = content;

  if (fileType === "fountain") {
    // Strip Fountain title page (key: value lines at start, ending at first blank line)
    text = text.replace(/^(?:[A-Za-z][A-Za-z ]*:.*(?:\r?\n(?:[ \t]+.*))*\r?\n)*\r?\n/, "");
  } else {
    // Strip YAML frontmatter
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  }

  // Strip fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/~~~[\s\S]*?~~~/g, "");

  // Split on whitespace, filter empty
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));

  const WORDS_PER_SCREENPLAY_PAGE = 160;
  const pageCount = fileType === "fountain"
    ? Math.max(1, Math.round(wordCount / WORDS_PER_SCREENPLAY_PAGE))
    : undefined;

  return { wordCount, readingTimeMinutes, pageCount };
}

export function formatWordCount(count: number): string {
  return count.toLocaleString();
}
