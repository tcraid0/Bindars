import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";
import { trySetLocalStorage } from "../lib/safe-local-storage";
import type { SessionData } from "../types";
import type { InitialNativeOpenSelection } from "./useNativeOpen";

const STORE_KEY = "session";
const LS_KEY = "bindars-session";
const DEBOUNCE_MS = 2000;

/** The last settled place: a document position, or Home. */
const HOME = { kind: "home" } as const;
type Place = SessionData | typeof HOME;

type StoredSession = (SessionData & {
  savedAt: number;
  // Retain the path and position for recovery, without repeatedly opening a
  // known missing file. A successful open writes an ordinary session again.
  restoreDisabled?: true;
}) | (typeof HOME & { savedAt: number });

// Records without a kind are documents, as every build before Home wrote them.
function decodeSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const savedAt = typeof record.savedAt === "number" && Number.isSafeInteger(record.savedAt) && record.savedAt > 0
    ? record.savedAt : 0;
  if (record.kind === HOME.kind) return { ...HOME, savedAt };
  if (typeof record.filePath !== "string" || !record.filePath.trim() || record.filePath.includes("\0")) return null;
  return {
    filePath: record.filePath,
    headingId: typeof record.headingId === "string" ? record.headingId : null,
    savedAt,
    ...(record.restoreDisabled === true ? { restoreDisabled: true as const } : {}),
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
  /**
   * Reopens the saved document. With `knownMissing` the file was already
   * confirmed missing on an earlier launch: report it for recovery without
   * reading it again. Return "not-found" when a read confirms a missing file.
   * A saved Home has nothing to reopen and does not call this.
   */
  onRestore: (session: SessionData, knownMissing: boolean) => void | "not-found" | Promise<void | "not-found">;
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
  // Home is the current place whenever no file is open, once it was chosen
  // (or restored); a launch still reading its document has no place yet.
  const homeRef = useRef(false);
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

  const readCurrentPlace = useCallback((): Place | null => {
    const currentFilePath = filePathRef.current;
    if (currentFilePath) return { filePath: currentFilePath, headingId: getActiveHeadingIdRef.current() };
    return homeRef.current ? HOME : null;
  }, []);

  const stamp = useCallback((place: Place): StoredSession => {
    // Distinguish an unload fallback from a write captured in the same millisecond.
    lastSavedAtRef.current = Math.max(Date.now(), lastSavedAtRef.current + 1);
    return { ...place, savedAt: lastSavedAtRef.current };
  }, []);

  // Every write goes to the local fallback first, then natively after older
  // writes drain, so a slow earlier write can never finish last.
  const writeSession = useCallback((session: StoredSession) => {
    trySetLocalStorage(LS_KEY, JSON.stringify(session));
    const write = pendingWriteRef.current.then(() => storeSet(STORE_KEY, session));
    pendingWriteRef.current = write;
    return write;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flushCurrentSession = useCallback(async () => {
    clearTimer();
    const place = readCurrentPlace();
    if (!place) {
      await pendingWriteRef.current;
      return;
    }
    await writeSession(stamp(place));
  }, [clearTimer, readCurrentPlace, stamp, writeSession]);

  // Written at once, not after the debounce, so a quit straight after keeps
  // Home. Callers name Home explicitly: the closed document's path is still
  // in filePathRef until the next render.
  const rememberHome = useCallback(() => {
    homeRef.current = true;
    clearTimer();
    return writeSession(stamp(HOME));
  }, [clearTimer, stamp, writeSession]);

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
      if (!session) return;

      lastSavedAtRef.current = Math.max(lastSavedAtRef.current, session.savedAt);
      if (!("filePath" in session)) {
        homeRef.current = true;
        return;
      }
      const { filePath, headingId } = session;
      void Promise.resolve(onRestoreRef.current({ filePath, headingId }, session.restoreDisabled === true)).then(async (result) => {
        // A document opened, or Home chosen, since then is the place now.
        if (result !== "not-found" || !isCurrent() || filePathRef.current !== null || homeRef.current) return;
        await writeSession({ ...stamp({ filePath, headingId }), restoreDisabled: true });
      }).catch(reportRestoreError);
    })().catch(reportRestoreError).finally(() => {
      if (isCurrent()) setRestored(true);
    });

    return () => {
      active = false;
    };
  }, [stamp, writeSession]);

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
      const place = readCurrentPlace();
      if (place) trySetLocalStorage(LS_KEY, JSON.stringify(stamp(place)));
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [readCurrentPlace, stamp]);

  return { restored, rememberHome, notifyPositionChanged, flushCurrentSession };
}
