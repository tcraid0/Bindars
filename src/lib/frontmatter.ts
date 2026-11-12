import { parse as parseYaml } from "yaml";
import { countLogicalLines } from "./source-lines";

export interface Frontmatter {
  title?: string;
  author?: string;
  date?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * A leading byte-order mark is not content: micromark skips one, so
 * remark-frontmatter hides a block after it. Frontmatter checks must too.
 */
export function withoutByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the parsed frontmatter data and the markdown body without the frontmatter block.
 */
export function extractFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  body: string;
  bodyStartLine: number;
  bodyStartColumn: number;
} {
  // Frontmatter must start at the very beginning of the file.
  const text = withoutByteOrderMark(content);
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  // The Markdown parser skips a leading BOM without counting its source column.
  const whole = { frontmatter: null, body: content, bodyStartLine: 1, bodyStartColumn: 1 + content.length - text.length };
  if (!match) return whole;

  const yamlBlock = match[1];
  const body = match[2];

  try {
    const parsed = parseYaml(yamlBlock);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return whole;
    }

    const fm = parsed as Record<string, unknown>;

    // Normalize tags: ensure it's a string array if present
    if (fm.tags && typeof fm.tags === "string") {
      fm.tags = fm.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
    }

    // Normalize date to string
    if (fm.date instanceof Date) {
      fm.date = fm.date.toISOString().split("T")[0];
    }

    const prefix = text.slice(0, text.length - body.length);
    const skippedBodyMark = body.length - withoutByteOrderMark(body).length;
    return {
      frontmatter: Object.keys(fm).length > 0 ? fm : null,
      body,
      bodyStartLine: countLogicalLines(prefix),
      // The body can share the closing fence's line, or itself begin with a BOM.
      bodyStartColumn: prefix.length - Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r")) + skippedBodyMark,
    };
  } catch {
    // If YAML parsing fails, treat the whole content as markdown
    return whole;
  }
}

/** Format a date string for display. Accepts ISO dates, YYYY-MM-DD, etc. */
export function formatFrontmatterDate(date: string): string {
  // Already a readable format — return as-is if not an ISO date
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return date;

  try {
    const d = new Date(date + (date.length === 10 ? "T00:00:00" : ""));
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return date;
  }
}
