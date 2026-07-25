import { storeGet, storeSet, storeKeys } from "./store";
import type { RecentFile, FileAnnotations } from "../types";

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
    const recentFiles = await storeGet<RecentFile[]>("recent-files");
    if (recentFiles && Array.isArray(recentFiles)) {
      let changed = false;
      for (const rf of recentFiles) {
        if (typeof rf.lastHeadingId === "string" && rf.lastHeadingId.startsWith("user-content-")) {
          rf.lastHeadingId = stripClobberPrefix(rf.lastHeadingId);
          changed = true;
        }
      }
      if (changed) {
        await storeSet("recent-files", recentFiles);
      }
    }

    // Migrate annotations
    const keys = await storeKeys();
    for (const key of keys) {
      if (!key.startsWith("annotations:")) continue;
      const annotations = await storeGet<FileAnnotations>(key);
      if (!annotations) continue;

      let changed = false;

      if (annotations.bookmarks) {
        for (const bm of annotations.bookmarks) {
          if (typeof bm.headingId === "string" && bm.headingId.startsWith("user-content-")) {
            bm.headingId = stripClobberPrefix(bm.headingId);
            changed = true;
          }
        }
      }

      if (annotations.highlights) {
        for (const hl of annotations.highlights) {
          if (typeof hl.nearestHeadingId === "string" && hl.nearestHeadingId.startsWith("user-content-")) {
            hl.nearestHeadingId = stripClobberPrefix(hl.nearestHeadingId);
            changed = true;
          }
        }
      }

      if (changed) {
        await storeSet(key, annotations);
      }
    }
  },
};

export async function runMigrations(): Promise<void> {
  const version = (await storeGet<number>(STORE_KEY)) ?? 0;

  if (version >= CURRENT_VERSION) return;

  for (let v = version; v < CURRENT_VERSION; v++) {
    const migrate = migrations[v];
    if (migrate) {
      await migrate();
    }
  }

  await storeSet(STORE_KEY, CURRENT_VERSION);
}
