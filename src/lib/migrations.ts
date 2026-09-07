import { storeTryGet, storeSet } from "./store";
import type { RecentFile } from "../types";

const STORE_KEY = "config-version";
const CURRENT_VERSION = 3;

type Migration = () => Promise<void>;

function stripClobberPrefix(id: string): string {
  return id.startsWith("user-content-") ? id.slice("user-content-".length) : id;
}

// Add migration functions here as the store schema evolves.
// Each entry migrates FROM that version TO the next.
const migrations: Record<number, Migration> = {
  // Migration 2→3: Strip user-content- prefix from stored heading IDs.
  // Clobber prefix was disabled in sanitize-schema.ts, so heading IDs
  // no longer have the prefix. Stored IDs must match.
  2: async () => {
    // Migrate recentFiles
    const result = await storeTryGet<RecentFile[]>("recent-files");
    if (!result.ok) throw new Error("Could not read settings for migration");
    const recentFiles = result.value;
    if (recentFiles && Array.isArray(recentFiles)) {
      let changed = false;
      for (const rf of recentFiles) {
        if (typeof rf.lastHeadingId === "string" && rf.lastHeadingId.startsWith("user-content-")) {
          rf.lastHeadingId = stripClobberPrefix(rf.lastHeadingId);
          changed = true;
        }
      }
      if (changed) {
        if (!await storeSet("recent-files", recentFiles)) throw new Error("Could not save migrated settings");
      }
    }
  },
};

export async function runMigrations(): Promise<void> {
  const result = await storeTryGet<number>(STORE_KEY);
  if (!result.ok) throw new Error("Could not read settings version");
  const version = result.value ?? 0;

  if (version >= CURRENT_VERSION) return;

  for (let v = version; v < CURRENT_VERSION; v++) {
    const migrate = migrations[v];
    if (migrate) {
      await migrate();
    }
  }

  if (!await storeSet(STORE_KEY, CURRENT_VERSION)) throw new Error("Could not save settings version");
}
