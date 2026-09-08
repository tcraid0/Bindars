import { storeTryGet, storeSet } from "./store";
import { decodeRecentFiles } from "./recent-files";

const STORE_KEY = "config-version";
const CURRENT_VERSION = 3;
let preparation: Promise<void> | null = null;

async function migrate(): Promise<void> {
  const result = await storeTryGet<unknown>(STORE_KEY);
  if (!result.ok) throw new Error("Could not read settings version");
  const version = result.value ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > CURRENT_VERSION) {
    throw new Error("Unsupported settings version");
  }
  if (version === CURRENT_VERSION) return;

  // Every supported legacy version historically passed through 2→3.
  const history = await storeTryGet<unknown>("recent-files");
  if (!history.ok) throw new Error("Could not read settings for migration");
  const files = decodeRecentFiles(history.value);
  if (files === null) throw new Error("Unsupported recent history format");
  let changed = false;
  const migrated = files.map((file) => {
    if (!file.lastHeadingId?.startsWith("user-content-")) return file;
    changed = true;
    return { ...file, lastHeadingId: file.lastHeadingId.slice("user-content-".length) };
  });
  if (changed && !await storeSet("recent-files", migrated)) {
    throw new Error("Could not save migrated settings");
  }
  // The array and version remain separate writes. A failed acknowledgement
  // can still cause a repeated migration after restart.
  if (!await storeSet(STORE_KEY, CURRENT_VERSION)) throw new Error("Could not save settings version");
}

export function runMigrations(): Promise<void> {
  // Cache rejection too: a failed save may have already changed plugin cache.
  // Retrying transformation in this process could strip a second prefix.
  return preparation ??= migrate();
}
