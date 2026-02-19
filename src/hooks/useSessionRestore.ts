import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { storeGet, storeSet } from "../lib/store";
import type { SessionData } from "../types";

const STORE_KEY = "session";
const LS_KEY = "binder-session";
const DEBOUNCE_MS = 2000;

interface UseSessionRestoreArgs {
  filePath: string | null;
  activeHeadingId: string | null;
  onRestore: (session: SessionData) => void | Promise<void>;
}

export function useSessionRestore({ filePath, activeHeadingId, onRestore }: UseSessionRestoreArgs) {
  const restoredRef = useRef(false);
  const [restored, setRestored] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Debounced save on filePath / activeHeadingId change
  useEffect(() => {
    if (!filePath) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const session: SessionData = { filePath, headingId: activeHeadingId };
      storeSet(STORE_KEY, session);
      localStorage.setItem(LS_KEY, JSON.stringify(session));
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [filePath, activeHeadingId]);

  // Synchronous save on beforeunload
  useEffect(() => {
    const handleUnload = () => {
      if (!filePath) return;
      const session: SessionData = { filePath, headingId: activeHeadingId };
      localStorage.setItem(LS_KEY, JSON.stringify(session));
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [filePath, activeHeadingId]);

  return { restored };
}
