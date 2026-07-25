import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";

const STORE_KEY = "markdown-formatting-enabled";
const LOCAL_STORAGE_KEY = "bindars-markdown-formatting-enabled";

interface MarkdownFormattingPreference {
  enabled: boolean;
  loaded: boolean;
  toggle: () => void;
}

function readLocalPreference(): boolean | null {
  try {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Local storage may be unavailable in restricted environments.
  }
  return null;
}

function writeLocalPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, String(enabled));
  } catch {
    // The Tauri store remains the durable fallback.
  }
}

export function useMarkdownFormatting(): MarkdownFormattingPreference {
  const [initialPreference] = useState(readLocalPreference);
  const [enabled, setEnabled] = useState(initialPreference ?? true);
  const [loaded, setLoaded] = useState(initialPreference !== null);
  const enabledRef = useRef(enabled);
  const userUpdatedRef = useRef(false);
  const persistenceRef = useRef<Promise<void>>(Promise.resolve());

  const persistPreference = useCallback((next: boolean) => {
    persistenceRef.current = persistenceRef.current.then(async () => {
      await storeSet(STORE_KEY, next);
    });
  }, []);

  useEffect(() => {
    if (initialPreference !== null) {
      // Local storage is the synchronous source of truth. Repair the backup
      // store rather than allowing a stale asynchronous value to overwrite it.
      persistPreference(initialPreference);
      return;
    }

    let active = true;
    void storeGet<unknown>(STORE_KEY).then((stored) => {
      if (!active || userUpdatedRef.current) return;
      const storedPreference = typeof stored === "boolean" ? stored : null;
      const resolved = storedPreference ?? true;
      enabledRef.current = resolved;
      setEnabled(resolved);
      writeLocalPreference(resolved);
      setLoaded(true);
      if (storedPreference === null) persistPreference(resolved);
    });
    return () => {
      active = false;
    };
  }, [initialPreference, persistPreference]);

  const toggle = useCallback(() => {
    userUpdatedRef.current = true;
    const next = !enabledRef.current;
    enabledRef.current = next;
    setEnabled(next);
    setLoaded(true);
    writeLocalPreference(next);
    persistPreference(next);
  }, [persistPreference]);

  return { enabled, loaded, toggle };
}
