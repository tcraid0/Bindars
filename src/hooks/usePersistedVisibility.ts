import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";

/** A panel's open state, remembered across launches. localStorage is read synchronously at
 *  launch; the app store is the backup when localStorage has no entry. */
export function usePersistedVisibility(localKey: string, storeKey: string, fallback: boolean) {
  const [visible, setVisible] = useState(() => {
    try {
      const stored = localStorage.getItem(localKey);
      return stored === null ? fallback : stored === "true";
    } catch {
      return fallback;
    }
  });
  const changedRef = useRef(false);

  useEffect(() => {
    let active = true;
    try {
      if (localStorage.getItem(localKey) !== null) return;
    } catch { /* noop */ }
    storeGet<unknown>(storeKey).then((stored) => {
      if (!active || changedRef.current || typeof stored !== "boolean") return;
      setVisible(stored);
    });
    return () => { active = false; };
  }, [localKey, storeKey]);

  const changeVisible = useCallback((next: boolean) => {
    changedRef.current = true;
    setVisible(next);
    try { localStorage.setItem(localKey, String(next)); } catch { /* noop */ }
    void storeSet(storeKey, next);
  }, [localKey, storeKey]);

  return [visible, changeVisible] as const;
}
