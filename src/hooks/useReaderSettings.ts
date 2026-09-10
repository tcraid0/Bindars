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
      userUpdatedRef.current = true;
      setSettingsState((prev) => {
        const next = normalizeReaderSettings(updates, prev);
        if (!next) return prev;
        persistSettings(next);
        return next;
      });
    },
    [persistSettings],
  );

  const resetSettings = useCallback(() => {
    userUpdatedRef.current = true;
    persistSettings(DEFAULTS);
    setSettingsState(DEFAULTS);
  }, [persistSettings]);

  return { settings, updateSettings, resetSettings, LIMITS };
}
