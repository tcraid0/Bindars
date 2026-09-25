import type { RecentFile } from "../types";
import { storeTryGet, storeSet } from "./store";

const STORE_KEY = "recent-files";
const FORMAT_VERSION = 1;
let legacyUpgrade: Promise<void> | null = null;

// Keep valid entries (and their extra fields) in their original order.
function decodeRecentFiles(value: unknown): RecentFile[] {
  if (!Array.isArray(value)) throw new Error("Unsupported recent history format");
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

export function saveRecentFiles(files: RecentFile[]): Promise<boolean> {
  return storeSet(STORE_KEY, { version: FORMAT_VERSION, files });
}

async function readRecentFilesValue(): Promise<unknown> {
  const result = await storeTryGet<unknown>(STORE_KEY);
  if (!result.ok) throw new Error("Could not read recent history");
  return result.value;
}

async function upgradeLegacyFiles(value: unknown[]) {
  const result = await storeTryGet<unknown>("config-version");
  if (!result.ok) throw new Error("Could not read legacy settings version");
  const version = result.value ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 3) {
    throw new Error("Unsupported legacy settings version");
  }
  const files = decodeRecentFiles(value);
  // Only legacy versions below 3 used an extra heading prefix.
  const migrated = version === 3 ? files : files.map((file) =>
    file.lastHeadingId?.startsWith("user-content-")
      ? { ...file, lastHeadingId: file.lastHeadingId.slice("user-content-".length) }
      : file);
  // One value keeps transformed headings and their interpretation together,
  // even when a rejected save leaves a changed plugin cache for a later flush.
  if (!await saveRecentFiles(migrated)) throw new Error("Could not save upgraded recent history");
}

export async function loadRecentFiles(): Promise<RecentFile[]> {
  // Share legacy preparation, including failure, without caching a stale list.
  if (legacyUpgrade) await legacyUpgrade;
  let value = await readRecentFilesValue();
  if (Array.isArray(value)) {
    await (legacyUpgrade ??= upgradeLegacyFiles(value));
    value = await readRecentFilesValue();
  }
  if (value === null) return [];
  if (typeof value === "object" && !Array.isArray(value)
    && "version" in value && value.version === FORMAT_VERSION
    && "files" in value) {
    return decodeRecentFiles(value.files);
  }
  throw new Error("Unsupported recent history format");
}
