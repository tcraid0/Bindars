import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { storeGet, storeSet } from "../lib/store";
import { WORKSPACE_INDEX_CACHE_KEYS } from "../lib/workspace-index";

const STORE_KEY = "workspace:root";
const LS_KEY = "bindars-workspace-root";

export function useWorkspaceRoot() {
  const [rootPath, setRootPathState] = useState<string | null>(null);
  const userSetRef = useRef(false);
  const pickerSequenceRef = useRef(0);

  useEffect(() => {
    let active = true;

    void (async () => {
      const stored = await storeGet<string>(STORE_KEY);
      if (!active || userSetRef.current) return;

      if (typeof stored === "string" && stored.trim()) {
        setRootPathState(stored);
        return;
      }

      try {
        const ls = localStorage.getItem(LS_KEY);
        if (ls && active && !userSetRef.current) {
          setRootPathState(ls);
        }
      } catch {
        // Ignore localStorage access issues.
      }
    })();

    return () => {
      active = false;
      pickerSequenceRef.current += 1;
    };
  }, []);

  const persist = useCallback((path: string | null) => {
    storeSet(STORE_KEY, path);
    try {
      if (path) {
        localStorage.setItem(LS_KEY, path);
      } else {
        localStorage.removeItem(LS_KEY);
      }
    } catch {
      // Ignore localStorage access issues.
    }
  }, []);

  const setRootPath = useCallback((path: string | null) => {
    pickerSequenceRef.current += 1;
    userSetRef.current = true;
    setRootPathState(path);
    persist(path);
  }, [persist]);

  const chooseRoot = useCallback(async () => {
    const sequence = ++pickerSequenceRef.current;
    try {
      const selected = await open({ directory: true, multiple: false });
      if (sequence !== pickerSequenceRef.current || !selected || Array.isArray(selected)) return null;

      setRootPath(selected);
      return selected;
    } catch (err) {
      console.warn("[workspace-root] Failed to choose workspace:", err);
      return null;
    }
  }, [setRootPath]);

  const clearRoot = useCallback(() => {
    setRootPath(null);
    for (const key of WORKSPACE_INDEX_CACHE_KEYS) {
      void storeSet(key, null);
    }
  }, [setRootPath]);

  return {
    rootPath,
    setRootPath,
    chooseRoot,
    clearRoot,
  };
}
