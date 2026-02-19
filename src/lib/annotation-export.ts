import type { Highlight, Bookmark, HeadingItem } from "../types";

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

  lines.push(`# Annotations: ${fileName}`);
  lines.push("");
  lines.push(`*Exported from Binder on ${date}*`);
  lines.push("");

  if (bookmarks.length > 0) {
    lines.push("## Bookmarks");
    lines.push("");
    for (const bm of bookmarks) {
      lines.push(`- **${bm.headingText.replace(/\n/g, " ")}**`);
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
        lines.push(`### ${headingText}`);
        lines.push("");
      }

      for (const hl of group) {
        const safeExact = hl.exact.replace(/\n+/g, " ");
        lines.push(`> "${safeExact}"`);
        lines.push(`>`);
        lines.push(`> — *${hl.color} highlight*`);
        lines.push("");
        if (hl.note) {
          const safeNote = hl.note.replace(/\n+/g, " ").trim();
          lines.push(`**Note:** ${safeNote}`);
          lines.push("");
        }
      }
    }
  }

  return lines.join("\n");
}
