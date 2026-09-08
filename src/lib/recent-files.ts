import type { RecentFile } from "../types";

// null means an unknown whole-record format, not confirmed empty history.
// Keep valid entries (and their extra fields) in their original order.
export function decodeRecentFiles(value: unknown): RecentFile[] | null {
  if (value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry): RecentFile[] => {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.path !== "string" || entry.path.length === 0
      || typeof entry.name !== "string"
      || typeof entry.openedAt !== "number" || !Number.isFinite(entry.openedAt)
      || !Number.isFinite(new Date(entry.openedAt).getTime())
    ) return [];
    return [{
      ...entry,
      lastHeadingId: typeof entry.lastHeadingId === "string" ? entry.lastHeadingId : null,
    }];
  });
}
