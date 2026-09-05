import { useState, useEffect, useCallback, useRef } from "react";
import { storeGet, storeSet } from "../lib/store";
import type { Theme } from "../types";

const STORE_KEY = "theme";
const THEMES: Theme[] = ["light", "sepia", "dark", "deep-dark"];

function getInitialTheme(): Theme {
  // Keep in sync with the pre-paint bootstrap script in index.html.
  // Sync check from localStorage for instant render; async Tauri store load follows
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("bindars-theme") || localStorage.getItem("markdown-reader-theme");
  } catch {
    stored = null;
  }

  if (stored && THEMES.includes(stored as Theme)) {
    return stored as Theme;
  }
  if (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches) {
    return "dark";
  }
  return "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  // Set by the first user theme change this session. The stored value that
  // finishes loading afterwards must never overwrite that newer intent.
  const userUpdatedRef = useRef(false);
  // Store persistence stays disabled until the stored value has finished
  // loading (or a user has chosen a theme), so the temporary startup default
  // cannot overwrite the saved theme before hydration completes.
  const [storeWriteEnabled, setStoreWriteEnabled] = useState(false);

  // Load from Tauri store on mount (overrides localStorage if present)
  useEffect(() => {
    let active = true;
    storeGet<Theme>(STORE_KEY).then((stored) => {
      if (!active) {
        return;
      }
      if (!userUpdatedRef.current && stored && THEMES.includes(stored)) {
        setThemeState(stored);
      }
      setStoreWriteEnabled(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme === "light" ? "" : theme);
    try {
      localStorage.setItem("bindars-theme", theme);
    } catch {
      // Storage may be unavailable in restricted environments.
    }
    if (storeWriteEnabled) {
      storeSet(STORE_KEY, theme);
    }
  }, [theme, storeWriteEnabled]);

  // User-facing theme change: record user intent so a late stored value
  // cannot overwrite it, and enable persistence for the chosen value.
  const applyUserTheme = useCallback((update: Theme | ((current: Theme) => Theme)) => {
    userUpdatedRef.current = true;
    setStoreWriteEnabled(true);
    setThemeState(update);
  }, []);

  const cycleTheme = useCallback(() => {
    applyUserTheme((current) => {
      const idx = THEMES.indexOf(current);
      return THEMES[(idx + 1) % THEMES.length];
    });
  }, [applyUserTheme]);

  const setTheme = useCallback((t: Theme) => {
    applyUserTheme(t);
  }, [applyUserTheme]);

  return { theme, setTheme, cycleTheme };
}