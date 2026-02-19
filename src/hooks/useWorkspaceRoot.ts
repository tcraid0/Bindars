import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { storeGet, storeSet } from "../lib/store";

const STORE_KEY = "workspace:root";
const LS_KEY = "binder-workspace-root";
const WORKSPACE_INDEX_CACHE_KEY = "workspace:index:v1";

export function useWorkspaceRoot() {
  const [rootPath, setRootPathState] = useState<string | null>(null);
  const userSetRef = useRef(false);

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
    userSetRef.current = true;
    setRootPathState(path);
    persist(path);
  }, [persist]);

  const chooseRoot = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) return null;

      setRootPath(selected);
      return selected;
    } catch (err) {
      console.warn("[workspace-root] Failed to choose workspace:", err);
      return null;
    }
  }, [setRootPath]);

  const clearRoot = useCallback(() => {
    setRootPath(null);
    void storeSet(WORKSPACE_INDEX_CACHE_KEY, null);
  }, [setRootPath]);

  return {
    rootPath,
    setRootPath,
    chooseRoot,
    clearRoot,
  };
}
