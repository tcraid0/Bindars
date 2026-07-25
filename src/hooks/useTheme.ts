import { useState, useEffect, useCallback } from "react";
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

  // Load from Tauri store on mount (overrides localStorage if present)
  useEffect(() => {
    storeGet<Theme>(STORE_KEY).then((stored) => {
      if (stored && THEMES.includes(stored)) {
        setThemeState(stored);
      }
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme === "light" ? "" : theme);
    try {
      localStorage.setItem("bindars-theme", theme);
    } catch {
      // Storage may be unavailable in restricted environments.
    }
    storeSet(STORE_KEY, theme);
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setThemeState((current) => {
      const idx = THEMES.indexOf(current);
      return THEMES[(idx + 1) % THEMES.length];
    });
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
  }, []);

  return { theme, setTheme, cycleTheme };
}
