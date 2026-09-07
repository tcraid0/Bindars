import type { Highlight, Bookmark, HeadingItem } from "../types";

function literal(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#!|~$+\-.=:]/g, "\\$&");
}

export function buildAnnotationMarkdown(
  fileName: string,
  highlights: Highlight[],
  bookmarks: Bookmark[],
  headings: HeadingItem[],
): string {
  const lines: string[] = [];
  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  lines.push(`# Annotations: ${literal(fileName.replace(/\r?\n/g, " "))}`);
  lines.push("");
  lines.push(`*Exported from Bindars on ${date}*`);
  lines.push("");

  if (bookmarks.length > 0) {
    lines.push("## Bookmarks");
    lines.push("");
    for (const bm of bookmarks) {
      lines.push(`- **${literal(bm.headingText.replace(/\r?\n/g, " "))}**`);
    }
    lines.push("");
  }

  if (highlights.length > 0) {
    lines.push("## Highlights");
    lines.push("");

    // Build heading lookup
    const headingMap = new Map<string, string>();
    for (const h of headings) {
      headingMap.set(h.id, h.text);
    }

    // Group highlights by nearestHeadingId
    const groups = new Map<string | null, Highlight[]>();
    for (const hl of highlights) {
      const key = hl.nearestHeadingId;
      const group = groups.get(key);
      if (group) {
        group.push(hl);
      } else {
        groups.set(key, [hl]);
      }
    }

    for (const [headingId, group] of groups) {
      const headingText = headingId ? headingMap.get(headingId) : null;
      if (headingText) {
        lines.push(`### ${literal(headingText.replace(/\r?\n/g, " "))}`);
        lines.push("");
      }

      for (const hl of group) {
        const safeExact = literal(hl.exact).replace(/\r?\n/g, "\n> ");
        lines.push(`> "${safeExact}"`);
        lines.push(`>`);
        lines.push(`> — *${hl.color} highlight*`);
        lines.push("");
        if (hl.note) {
          const safeNote = literal(hl.note.trim()).replace(/\r?\n/g, "  \n");
          lines.push(`**Note:** ${safeNote}`);
          lines.push("");
        }
      }
    }
  }

  return lines.join("\n");
}
