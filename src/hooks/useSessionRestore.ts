import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { storeGet, storeSet } from "../lib/store";
import { trySetLocalStorage } from "../lib/safe-local-storage";
import type { SessionData } from "../types";

const STORE_KEY = "session";
const LS_KEY = "bindars-session";
const DEBOUNCE_MS = 2000;

interface UseSessionRestoreArgs {
  filePath: string | null;
  getActiveHeadingId: () => string | null;
  onRestore: (session: SessionData) => void | Promise<void>;
}

export function useSessionRestore({ filePath, getActiveHeadingId, onRestore }: UseSessionRestoreArgs) {
  const restoredRef = useRef(false);
  const [restored, setRestored] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef(filePath);
  const getActiveHeadingIdRef = useRef(getActiveHeadingId);
  filePathRef.current = filePath;
  getActiveHeadingIdRef.current = getActiveHeadingId;

  const readCurrentSession = useCallback((): SessionData | null => {
    const currentFilePath = filePathRef.current;
    if (!currentFilePath) return null;
    return {
      filePath: currentFilePath,
      headingId: getActiveHeadingIdRef.current(),
    };
  }, []);

  const persistCurrentSession = useCallback(() => {
    timerRef.current = null;
    const session = readCurrentSession();
    if (!session) return;
    storeSet(STORE_KEY, session);
    trySetLocalStorage(LS_KEY, JSON.stringify(session));
  }, [readCurrentSession]);

  const notifyPositionChanged = useCallback(() => {
    if (!filePathRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(persistCurrentSession, DEBOUNCE_MS);
  }, [persistCurrentSession]);

  // Restore session once on mount
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      // Check if launched via file association (CLI arg) — takes priority
      try {
        const cliPath = await invoke<string | null>("get_cli_file_path");
        if (cliPath) {
          void onRestore({ filePath: cliPath, headingId: null });
          return;
        }
      } catch {
        // Command unavailable (e.g. dev mode without backend) — continue
      }

      let session = await storeGet<SessionData>(STORE_KEY);

      if (!session) {
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (raw) session = JSON.parse(raw) as SessionData;
        } catch {
          // corrupt localStorage — ignore
        }
      }

      if (session?.filePath) {
        void onRestore(session);
      }
    })().finally(() => {
      setRestored(true);
    });
  }, [onRestore]);

  // File changes start a fresh debounced save. Heading changes call the
  // returned notifier so they do not need to flow through App state.
  useEffect(() => {
    if (!filePath) return;
    notifyPositionChanged();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [filePath, notifyPositionChanged]);

  // Synchronous save on beforeunload
  useEffect(() => {
    const handleUnload = () => {
      const session = readCurrentSession();
      if (!session) return;
      trySetLocalStorage(LS_KEY, JSON.stringify(session));
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [readCurrentSession]);

  return { restored, notifyPositionChanged };
}
