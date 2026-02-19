import { parse as parseYaml } from "yaml";

export interface Frontmatter {
  title?: string;
  author?: string;
  date?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the parsed frontmatter data and the markdown body without the frontmatter block.
 */
export function extractFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  body: string;
} {
  // Frontmatter must start at the very beginning of the file
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const yamlBlock = match[1];
  const body = match[2];

  try {
    const parsed = parseYaml(yamlBlock);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { frontmatter: null, body: content };
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

    return {
      frontmatter: Object.keys(fm).length > 0 ? fm : null,
      body,
    };
  } catch {
    // If YAML parsing fails, treat the whole content as markdown
    return { frontmatter: null, body: content };
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
