import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";
import { trySetLocalStorage } from "../lib/safe-local-storage";
import type { SessionData } from "../types";
import type { InitialNativeOpenSelection } from "./useNativeOpen";

const STORE_KEY = "session";
const LS_KEY = "bindars-session";
const DEBOUNCE_MS = 2000;

interface StoredSession extends SessionData {
  savedAt: number;
}

function decodeSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.filePath !== "string" || !record.filePath.trim() || record.filePath.includes("\0")) return null;
  return {
    filePath: record.filePath,
    headingId: typeof record.headingId === "string" ? record.headingId : null,
    savedAt: typeof record.savedAt === "number" && Number.isSafeInteger(record.savedAt) && record.savedAt > 0
      ? record.savedAt : 0,
  };
}

function readLocalSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? decodeSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

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
  const pendingWriteRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const lastSavedAtRef = useRef(0);
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

  const captureStoredSession = useCallback((): StoredSession | null => {
    const session = readCurrentSession();
    if (!session) return null;
    // Distinguish an unload fallback from a write captured in the same millisecond.
    lastSavedAtRef.current = Math.max(Date.now(), lastSavedAtRef.current + 1);
    return { ...session, savedAt: lastSavedAtRef.current };
  }, [readCurrentSession]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flushCurrentSession = useCallback(async () => {
    clearTimer();
    const session = captureStoredSession();
    if (!session) {
      await pendingWriteRef.current;
      return;
    }
    trySetLocalStorage(LS_KEY, JSON.stringify(session));
    // Drain an older debounced write before the exit snapshot, so it cannot
    // finish last and replace the position that quit just saved.
    const write = pendingWriteRef.current.then(() => storeSet(STORE_KEY, session));
    pendingWriteRef.current = write;
    await write;
  }, [captureStoredSession, clearTimer]);

  const notifyPositionChanged = useCallback(() => {
    if (!filePathRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => { void flushCurrentSession(); }, DEBOUNCE_MS);
  }, [clearTimer, flushCurrentSession]);

  // Restore session once on mount
  useEffect(() => {
    const generation = restoreGenerationRef.current + 1;
    restoreGenerationRef.current = generation;
    let active = true;
    const isCurrent = () => active && restoreGenerationRef.current === generation;
    const reportRestoreError = (error: unknown) => {
      console.warn("[session] Could not restore the saved session:", error);
    };

    void (async () => {
      const nativeSelection = await waitForInitialNativeOpenRef.current();
      if (!isCurrent() || nativeSelection === "native") return;

      let session = decodeSession(await storeGet<unknown>(STORE_KEY));
      if (!isCurrent()) return;

      const local = readLocalSession();
      // Legacy records have no timestamp. Preserve native precedence for ties,
      // but prefer a newer unload fallback even when the native record is valid.
      if (local && (!session || local.savedAt > session.savedAt)) session = local;

      if (session) {
        lastSavedAtRef.current = Math.max(lastSavedAtRef.current, session.savedAt);
        const { filePath, headingId } = session;
        void Promise.resolve(onRestoreRef.current({ filePath, headingId })).catch(reportRestoreError);
      }
    })().catch(reportRestoreError).finally(() => {
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

    return clearTimer;
  }, [clearTimer, filePath, notifyPositionChanged]);

  // Synchronous save on beforeunload
  useEffect(() => {
    const handleUnload = () => {
      const session = captureStoredSession();
      if (!session) return;
      trySetLocalStorage(LS_KEY, JSON.stringify(session));
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [captureStoredSession]);

  return { restored, notifyPositionChanged, flushCurrentSession };
}
