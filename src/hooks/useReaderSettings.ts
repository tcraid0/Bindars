import { useState, useCallback, useEffect, useRef } from "react";
import { storeGet, storeSet } from "../lib/store";
import { isFontFamily, isParagraphSpacing, isPrintLayout } from "../lib/reader-settings";
import type { ReaderSettings } from "../types";

const STORE_KEY = "reader-settings";
const STORE_DEBOUNCE_MS = 300;
const PRIMARY_LOCAL_STORAGE_KEY = "binder-settings";
const LEGACY_LOCAL_STORAGE_KEY = "markdown-reader-settings";

const DEFAULTS: ReaderSettings = {
  fontSize: 17,
  contentWidth: 65,
  lineHeight: 1.7,
  fontFamily: "newsreader",
  paragraphSpacing: "comfortable",
  sceneLensEnabled: false,
  reducedEffects: false,
  printLayout: "standard",
  printWithTheme: false,
};

const LIMITS = {
  fontSize: { min: 14, max: 24 },
  contentWidth: { min: 50, max: 80 },
  lineHeight: { min: 1.4, max: 2.0 },
} as const;

function getInitialSettings(): ReaderSettings {
  try {
    const stored = localStorage.getItem(PRIMARY_LOCAL_STORAGE_KEY) || localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const merged = { ...DEFAULTS, ...parsed };
      // Validate enum fields against known values
      if (!isFontFamily(merged.fontFamily)) merged.fontFamily = DEFAULTS.fontFamily;
      if (!isParagraphSpacing(merged.paragraphSpacing)) merged.paragraphSpacing = DEFAULTS.paragraphSpacing;
      if (!isPrintLayout(merged.printLayout)) merged.printLayout = DEFAULTS.printLayout;
      return merged;
    }
  } catch {
    // ignore
  }
  return DEFAULTS;
}

function hasLocalSettings(): boolean {
  try {
    return Boolean(localStorage.getItem(PRIMARY_LOCAL_STORAGE_KEY) || localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function useReaderSettings() {
  const [settings, setSettingsState] = useState<ReaderSettings>(getInitialSettings);
  const storeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStoreRef = useRef<ReaderSettings | null>(null);
  const userUpdatedRef = useRef(false);

  // Load from Tauri store on mount
  useEffect(() => {
    if (hasLocalSettings()) {
      return;
    }

    let active = true;
    storeGet<ReaderSettings>(STORE_KEY).then((stored) => {
      if (!active || userUpdatedRef.current || !stored) {
        return;
      }
      setSettingsState((prev) => {
        const merged = { ...prev, ...stored };
        if (!isFontFamily(merged.fontFamily)) merged.fontFamily = DEFAULTS.fontFamily;
        if (!isParagraphSpacing(merged.paragraphSpacing)) merged.paragraphSpacing = DEFAULTS.paragraphSpacing;
        if (!isPrintLayout(merged.printLayout)) merged.printLayout = DEFAULTS.printLayout;
        return merged;
      });
    });

    return () => {
      active = false;
    };
  }, []);

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
        const next = { ...prev, ...updates };
        next.fontSize = clamp(next.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max);
        next.contentWidth = clamp(next.contentWidth, LIMITS.contentWidth.min, LIMITS.contentWidth.max);
        next.lineHeight = clamp(
          Math.round(next.lineHeight * 10) / 10,
          LIMITS.lineHeight.min,
          LIMITS.lineHeight.max,
        );
        if (!isFontFamily(next.fontFamily)) next.fontFamily = DEFAULTS.fontFamily;
        if (!isParagraphSpacing(next.paragraphSpacing)) next.paragraphSpacing = DEFAULTS.paragraphSpacing;
        if (!isPrintLayout(next.printLayout)) next.printLayout = DEFAULTS.printLayout;
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
