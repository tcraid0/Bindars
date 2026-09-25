import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";
import {
  DEFAULT_READER_SETTINGS as DEFAULTS,
  READER_SETTINGS_LIMITS as LIMITS,
  normalizeReaderSettings,
} from "../lib/reader-settings";
import type { ReaderSettings } from "../types";
import { useDeferredState } from "./useDeferredState";
import type { StatePause } from "./useDeferredState";

const STORE_KEY = "reader-settings";
const STORE_DEBOUNCE_MS = 300;
const PRIMARY_LOCAL_STORAGE_KEY = "bindars-settings";
const LEGACY_LOCAL_STORAGE_KEY = "markdown-reader-settings";

function getLocalSettings(): ReaderSettings | null {
  for (const key of [PRIMARY_LOCAL_STORAGE_KEY, LEGACY_LOCAL_STORAGE_KEY]) {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const settings = normalizeReaderSettings(JSON.parse(stored));
        if (settings) return settings;
      }
    } catch {
      // An unreadable or malformed local record must not mask a valid backup.
    }
  }
  return null;
}

function settingsEqual(a: ReaderSettings, b: ReaderSettings): boolean {
  return (Object.keys(a) as (keyof ReaderSettings)[]).every((key) => a[key] === b[key]);
}

export function useReaderSettings(pause?: StatePause) {
  // One initial decode decides both the displayed value and local precedence.
  const [localSettings] = useState(getLocalSettings);
  const [settings, setSettingsState] = useDeferredState<ReaderSettings>(() => localSettings ?? DEFAULTS, pause);
  const storeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStoreRef = useRef<ReaderSettings | null>(null);
  const userUpdatedRef = useRef(false);

  // Load from Tauri store on mount
  useEffect(() => {
    if (localSettings) {
      return;
    }

    let active = true;
    storeGet<unknown>(STORE_KEY).then((stored) => {
      if (!active || userUpdatedRef.current) {
        return;
      }
      const normalized = normalizeReaderSettings(stored);
      if (!normalized) return;
      setSettingsState((prev) => {
        // Printing may hold this update until after a newer user choice.
        return active && !userUpdatedRef.current ? normalized : prev;
      });
    });

    return () => {
      active = false;
    };
  }, [localSettings, setSettingsState]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (storeDebounceRef.current) {
        clearTimeout(storeDebounceRef.current);
        storeDebounceRef.current = null;
      }
      if (pendingStoreRef.current) {
        void storeSet(STORE_KEY, pendingStoreRef.current);
        pendingStoreRef.current = null;
      }
    };
  }, []);

  const persistSettings = useCallback((s: ReaderSettings) => {
    // localStorage is synchronous and fast — write immediately for instant UI
    try {
      localStorage.setItem(PRIMARY_LOCAL_STORAGE_KEY, JSON.stringify(s));
    } catch {
      // localStorage can be unavailable in restricted environments.
    }
    // Debounce the async Tauri store write to avoid disk thrashing during slider drags
    if (storeDebounceRef.current) clearTimeout(storeDebounceRef.current);
    pendingStoreRef.current = s;
    storeDebounceRef.current = setTimeout(() => {
      const pending = pendingStoreRef.current;
      pendingStoreRef.current = null;
      storeDebounceRef.current = null;
      if (pending) {
        void storeSet(STORE_KEY, pending);
      }
    }, STORE_DEBOUNCE_MS);
  }, []);

  const updateSettings = useCallback(
    (updates: Partial<ReaderSettings>) => {
      // A clamped or repeated choice changes nothing, so it must not count as
      // user intent (which would cancel a pending native read), rerender, or
      // write. Decide synchronously against the rendered value so the intent
      // flag still flips before any queued hydration can apply.
      const intended = normalizeReaderSettings(updates, settings);
      if (!intended || settingsEqual(intended, settings)) return;
      userUpdatedRef.current = true;
      setSettingsState((prev) => {
        const next = normalizeReaderSettings(updates, prev);
        if (!next || settingsEqual(next, prev)) return prev;
        persistSettings(next);
        return next;
      });
    },
    [persistSettings, settings],
  );

  const resetSettings = useCallback(() => {
    userUpdatedRef.current = true;
    persistSettings(DEFAULTS);
    setSettingsState(DEFAULTS);
  }, [persistSettings]);

  return { settings, updateSettings, resetSettings, LIMITS };
}
