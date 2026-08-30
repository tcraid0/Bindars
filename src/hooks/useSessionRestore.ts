import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";
import { trySetLocalStorage } from "../lib/safe-local-storage";
import type { SessionData } from "../types";
import type { InitialNativeOpenSelection } from "./useNativeOpen";

const STORE_KEY = "session";
const LS_KEY = "bindars-session";
const DEBOUNCE_MS = 2000;

interface UseSessionRestoreArgs {
  filePath: string | null;
  getActiveHeadingId: () => string | null;
  onRestore: (session: SessionData) => void | Promise<void>;
  waitForInitialNativeOpen: () => Promise<InitialNativeOpenSelection>;
}

export function useSessionRestore({
  filePath,
  getActiveHeadingId,
  onRestore,
  waitForInitialNativeOpen,
}: UseSessionRestoreArgs) {
  const restoreGenerationRef = useRef(0);
  const [restored, setRestored] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef(filePath);
  const getActiveHeadingIdRef = useRef(getActiveHeadingId);
  const onRestoreRef = useRef(onRestore);
  const waitForInitialNativeOpenRef = useRef(waitForInitialNativeOpen);
  filePathRef.current = filePath;
  getActiveHeadingIdRef.current = getActiveHeadingId;
  onRestoreRef.current = onRestore;
  waitForInitialNativeOpenRef.current = waitForInitialNativeOpen;

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
    const generation = restoreGenerationRef.current + 1;
    restoreGenerationRef.current = generation;
    let active = true;
    const isCurrent = () => active && restoreGenerationRef.current === generation;

    void (async () => {
      const nativeSelection = await waitForInitialNativeOpenRef.current();
      if (!isCurrent() || nativeSelection === "native") return;

      let session = await storeGet<SessionData>(STORE_KEY);
      if (!isCurrent()) return;

      if (!session) {
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (raw) session = JSON.parse(raw) as SessionData;
        } catch {
          // corrupt localStorage — ignore
        }
      }

      if (session?.filePath) {
        void onRestoreRef.current(session);
      }
    })().finally(() => {
      if (isCurrent()) setRestored(true);
    });

    return () => {
      active = false;
    };
  }, []);

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
