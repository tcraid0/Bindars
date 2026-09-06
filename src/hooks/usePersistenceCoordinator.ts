import { useCallback, useEffect, useRef, useState } from "react";
import { clearSnapshotHistory, writeDocumentSnapshot } from "../lib/snapshots";
import type { SnapshotDocument } from "../lib/snapshots";
import type { CapturedEditorBuffer } from "./useEditor";
import type { EditorSaveResult } from "../lib/editor-save";
import { normalizeFileError } from "../lib/native-file-error";

export const SNAPSHOT_INTERVAL_MS = 10_000;
export const AUTOSAVE_IDLE_MS = 2_500;
export const AUTOMATIC_SNAPSHOT_RETRY_BASE_MS = 30_000;
export const AUTOMATIC_SNAPSHOT_RETRY_MAX_MS = 5 * 60_000;

export interface AutosaveIssue {
  kind: "conflict" | "error";
  message: string;
}

interface PersistenceCoordinatorOptions {
  snapshotActive: boolean;
  autosaveActive: boolean;
  dirty: boolean;
  sessionKey: number;
  document: SnapshotDocument | null;
  captureBuffer: () => CapturedEditorBuffer | null;
  onAutomaticSnapshotError?: (message: string) => void;
  bufferVersion?: string | null;
  onAutosave?: () => Promise<EditorSaveResult>;
}

interface PersistenceCoordinator {
  snapshotError: string | null;
  autosaveIssue: AutosaveIssue | null;
  snapshotNow: (document?: SnapshotDocument) => Promise<void>;
  waitForSnapshotQueue: () => Promise<void>;
  clearRecoveryHistory: () => Promise<void>;
  flushAutosave: () => Promise<EditorSaveResult | null>;
  cancelAutosaveAndWait: () => Promise<AutosaveIssue | null>;
  clearAutosaveIssue: () => void;
  recordSaveResult: (result: EditorSaveResult) => void;
}

interface EnqueueSnapshotOptions {
  required: boolean;
  document?: SnapshotDocument;
  waitForExisting?: boolean;
  preservePrevious?: boolean;
  allowClean?: boolean;
}

interface AutomaticSnapshotRequest {
  sessionKey: number;
  documentIdentity: string;
  content: string;
}

interface AutomaticSnapshotRetryState {
  sessionKey: number;
  consecutiveFailures: number;
  coolingDown: boolean;
  reportedThisSession: boolean;
}

function automaticRequestMatches(
  left: AutomaticSnapshotRequest | null,
  right: AutomaticSnapshotRequest,
): boolean {
  return left?.sessionKey === right.sessionKey
    && left.documentIdentity === right.documentIdentity
    && left.content === right.content;
}

function automaticSnapshotRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 4);
  return Math.min(
    AUTOMATIC_SNAPSHOT_RETRY_BASE_MS * (2 ** exponent),
    AUTOMATIC_SNAPSHOT_RETRY_MAX_MS,
  );
}

export function usePersistenceCoordinator({
  snapshotActive,
  autosaveActive,
  dirty,
  sessionKey,
  document,
  captureBuffer,
  onAutomaticSnapshotError,
  bufferVersion = null,
  onAutosave,
}: PersistenceCoordinatorOptions): PersistenceCoordinator {
  const documentIdentity = document?.kind === "file"
    ? `file\0${document.path}`
    : document
      ? `draft\0${document.id}`
      : null;
  const autosaveAvailable = document?.kind === "file" && Boolean(onAutosave);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [autosaveIssue, setAutosaveIssue] = useState<AutosaveIssue | null>(null);
  const [autosaveGeneration, setAutosaveGeneration] = useState(0);
  const [snapshotRetryGeneration, setSnapshotRetryGeneration] = useState(0);
  const snapshotErrorRef = useRef<string | null>(null);
  const snapshotActiveRef = useRef(snapshotActive);
  const autosaveActiveRef = useRef(autosaveActive);
  const sessionKeyRef = useRef(sessionKey);
  const documentRef = useRef(document);
  const captureBufferRef = useRef(captureBuffer);
  const onAutomaticSnapshotErrorRef = useRef(onAutomaticSnapshotError);
  const onAutosaveRef = useRef(onAutosave);
  const automaticSnapshotRetryRef = useRef<AutomaticSnapshotRetryState | null>(null);
  const automaticSnapshotRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutomaticRequestRef = useRef<AutomaticSnapshotRequest | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveInFlightRef = useRef<Promise<EditorSaveResult | null> | null>(null);
  const autosaveIssueRef = useRef<AutosaveIssue | null>(null);

  // Snapshot timers and queued writes cross render boundaries. Keep every value
  // they read mirrored explicitly so a late callback cannot capture another
  // document's buffer or place a newer edit session in an old retry cooldown.
  snapshotActiveRef.current = snapshotActive;
  autosaveActiveRef.current = autosaveActive;
  sessionKeyRef.current = sessionKey;
  documentRef.current = document;
  captureBufferRef.current = captureBuffer;
  onAutomaticSnapshotErrorRef.current = onAutomaticSnapshotError;
  onAutosaveRef.current = onAutosave;

  const clearAutomaticSnapshotRetryTimer = useCallback(() => {
    if (automaticSnapshotRetryTimerRef.current !== null) {
      clearTimeout(automaticSnapshotRetryTimerRef.current);
      automaticSnapshotRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearAutomaticSnapshotRetryTimer();
    automaticSnapshotRetryRef.current = null;
    lastAutomaticRequestRef.current = null;
    if (autosaveIssueRef.current !== null) {
      autosaveIssueRef.current = null;
      setAutosaveIssue(null);
    }
    if (snapshotErrorRef.current !== null) {
      snapshotErrorRef.current = null;
      setSnapshotError(null);
    }
  }, [clearAutomaticSnapshotRetryTimer, sessionKey]);

  useEffect(() => clearAutomaticSnapshotRetryTimer, [clearAutomaticSnapshotRetryTimer]);

  const resetAutomaticSnapshotBackoff = useCallback((requestedSession: number) => {
    if (sessionKeyRef.current !== requestedSession) return;
    clearAutomaticSnapshotRetryTimer();
    const previous = automaticSnapshotRetryRef.current;
    automaticSnapshotRetryRef.current = {
      sessionKey: requestedSession,
      consecutiveFailures: 0,
      coolingDown: false,
      reportedThisSession: previous?.sessionKey === requestedSession
        ? previous.reportedThisSession
        : false,
    };
    if (snapshotErrorRef.current !== null) {
      snapshotErrorRef.current = null;
      setSnapshotError(null);
    }
  }, [clearAutomaticSnapshotRetryTimer]);

  const enqueueSnapshot = useCallback(({
    required,
    document: documentOverride,
    waitForExisting = false,
    preservePrevious = false,
    allowClean = false,
  }: EnqueueSnapshotOptions): Promise<boolean> => {
    const requestedSession = sessionKeyRef.current;
    const shouldPreservePrevious = required || preservePrevious;
    const retryState = automaticSnapshotRetryRef.current;
    if (!required
      && retryState?.sessionKey === requestedSession
      && retryState.coolingDown) {
      return Promise.resolve(false);
    }

    const requestedDocument = documentOverride ?? documentRef.current;
    const captured = captureBufferRef.current();
    if ((!required && !snapshotActiveRef.current) || !requestedDocument || captured === null) {
      return required
        ? Promise.reject(new Error("There is no active document to snapshot."))
        : Promise.resolve(false);
    }
    if (!required && !captured.dirty && !allowClean) return Promise.resolve(false);

    const requestedDocumentIdentity = requestedDocument.kind === "file"
      ? `file\0${requestedDocument.path}`
      : `draft\0${requestedDocument.id}`;
    const automaticRequest: AutomaticSnapshotRequest = {
      sessionKey: requestedSession,
      documentIdentity: requestedDocumentIdentity,
      content: captured.content,
    };
    const lastAutomaticRequest = lastAutomaticRequestRef.current;
    if (!required && automaticRequestMatches(lastAutomaticRequest, automaticRequest)) {
      return waitForExisting
        ? queueRef.current.then(() => true, () => false)
        : Promise.resolve(false);
    }
    if (!required) {
      lastAutomaticRequestRef.current = automaticRequest;
    }

    const operation = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        const currentRetry = automaticSnapshotRetryRef.current;
        if (!required
          && currentRetry?.sessionKey === requestedSession
          && currentRetry.coolingDown) {
          if (automaticRequestMatches(lastAutomaticRequestRef.current, automaticRequest)) {
            lastAutomaticRequestRef.current = null;
          }
          return false;
        }

        try {
          await writeDocumentSnapshot(requestedDocument, captured.content, {
            preservePrevious: shouldPreservePrevious,
          });
          // Required safety snapshots bypass automatic cooldowns. If one
          // succeeds, storage is writable again, so it resets that cooldown
          // just like a successful automatic snapshot.
          resetAutomaticSnapshotBackoff(requestedSession);
          return true;
        } catch (error) {
          if (required) throw error;

          if (sessionKeyRef.current === requestedSession) {
            const message = normalizeFileError(error, "Bindars could not access recovery data.").message;
            if (automaticRequestMatches(lastAutomaticRequestRef.current, automaticRequest)) {
              lastAutomaticRequestRef.current = null;
            }
            const previous = automaticSnapshotRetryRef.current;
            const previousFailureCount = previous?.sessionKey === requestedSession
              ? previous.consecutiveFailures
              : 0;
            const consecutiveFailures = Math.min(
              previousFailureCount + 1,
              Number.MAX_SAFE_INTEGER,
            );
            const alreadyReported = previous?.sessionKey === requestedSession
              ? previous.reportedThisSession
              : false;
            automaticSnapshotRetryRef.current = {
              sessionKey: requestedSession,
              consecutiveFailures,
              coolingDown: true,
              reportedThisSession: true,
            };
            snapshotErrorRef.current = message;
            setSnapshotError(message);
            if (!alreadyReported) {
              onAutomaticSnapshotErrorRef.current?.(message);
            }

            clearAutomaticSnapshotRetryTimer();
            automaticSnapshotRetryTimerRef.current = setTimeout(() => {
              automaticSnapshotRetryTimerRef.current = null;
              const latestRetry = automaticSnapshotRetryRef.current;
              if (sessionKeyRef.current !== requestedSession
                || latestRetry?.sessionKey !== requestedSession) {
                return;
              }
              automaticSnapshotRetryRef.current = {
                ...latestRetry,
                coolingDown: false,
              };
              setSnapshotRetryGeneration((current) => current + 1);
            }, automaticSnapshotRetryDelay(consecutiveFailures));
          }
          return false;
        }
      });

    queueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [clearAutomaticSnapshotRetryTimer, resetAutomaticSnapshotBackoff]);

  const snapshotNow = useCallback(async (
    requestedDocument?: SnapshotDocument,
  ): Promise<void> => {
    await enqueueSnapshot({ required: true, document: requestedDocument });
  }, [enqueueSnapshot]);

  const waitForSnapshotQueue = useCallback(async (): Promise<void> => {
    await queueRef.current.catch(() => undefined);
  }, []);

  // Deletion joins the same queue as snapshot writes, so it can never race an
  // in-flight write and later snapshots always observe the cleared state.
  const clearRecoveryHistory = useCallback((): Promise<void> => {
    const operation = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await clearSnapshotHistory();
          // A successful clear is a fresh start: cancel any recovery cooldown
          // so the next automatic pass can protect the current buffer again.
          resetAutomaticSnapshotBackoff(sessionKeyRef.current);
        } finally {
          // Even on failure the history may be partially gone; dropping the
          // dedupe record lets the next automatic pass re-protect the current
          // buffer instead of assuming its last snapshot still exists.
          lastAutomaticRequestRef.current = null;
        }
      });
    queueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [resetAutomaticSnapshotBackoff]);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const clearAutosaveIssue = useCallback(() => {
    if (autosaveIssueRef.current === null) return;
    autosaveIssueRef.current = null;
    setAutosaveIssue(null);
  }, []);

  const recordSaveResult = useCallback((result: EditorSaveResult) => {
    if (result === "conflict" || result === "error") {
      const issue: AutosaveIssue = {
        kind: result,
        message: result === "conflict"
          ? "The file changed outside Bindars. Autosave is paused."
          : "Autosave failed and is paused until you save manually.",
      };
      autosaveIssueRef.current = issue;
      setAutosaveIssue(issue);
      return;
    }
    if (result === "saved" || result === "saved-with-newer-edits") {
      clearAutosaveIssue();
    }
  }, [clearAutosaveIssue]);

  const runAutosave = useCallback((): Promise<EditorSaveResult | null> => {
    clearAutosaveTimer();
    if (autosaveIssueRef.current) {
      return Promise.resolve(autosaveIssueRef.current.kind);
    }
    if (autosaveInFlightRef.current) return autosaveInFlightRef.current;

    const requestedSession = sessionKeyRef.current;
    const requestedDocument = documentRef.current;
    const captured = captureBufferRef.current();
    const save = onAutosaveRef.current;
    if (!autosaveActiveRef.current
      || requestedDocument?.kind !== "file"
      || !captured?.dirty
      || !save) {
      return Promise.resolve(null);
    }

    const operation = (async (): Promise<EditorSaveResult | null> => {
      // Snapshot failure is deliberately non-blocking for the real file save.
      await enqueueSnapshot({ required: false, waitForExisting: true });
      let result: EditorSaveResult;
      try {
        result = await save();
      } catch {
        result = "error";
      }
      if (sessionKeyRef.current !== requestedSession) return result;

      recordSaveResult(result);
      if (result === "saved-with-newer-edits" || result === "noop") {
        const latest = captureBufferRef.current();
        if (latest?.dirty) setAutosaveGeneration((current) => current + 1);
      }
      return result;
    })().finally(() => {
      if (autosaveInFlightRef.current === operation) {
        autosaveInFlightRef.current = null;
      }
    });

    autosaveInFlightRef.current = operation;
    return operation;
  }, [clearAutosaveTimer, enqueueSnapshot, recordSaveResult]);

  const flushAutosave = useCallback(async (): Promise<EditorSaveResult | null> => {
    clearAutosaveTimer();
    if (autosaveIssueRef.current) return autosaveIssueRef.current.kind;
    if (autosaveInFlightRef.current) return autosaveInFlightRef.current;
    return runAutosave();
  }, [clearAutosaveTimer, runAutosave]);

  const cancelAutosaveAndWait = useCallback(async (): Promise<AutosaveIssue | null> => {
    clearAutosaveTimer();
    await autosaveInFlightRef.current;
    return autosaveIssueRef.current;
  }, [clearAutosaveTimer]);

  useEffect(() => {
    const retryState = automaticSnapshotRetryRef.current;
    const retryReady = retryState?.sessionKey === sessionKey
      && retryState.consecutiveFailures > 0
      && !retryState.coolingDown;
    if (!snapshotActive || !documentIdentity || (!dirty && !retryReady)) return;

    // A completed cooldown remains retry-ready while a dialog temporarily
    // deactivates persistence. Retry checkpoints never merge away the last
    // known-good snapshot, and they may verify storage after autosave has made
    // the editor clean.
    void enqueueSnapshot({
      required: false,
      allowClean: retryReady,
      preservePrevious: retryReady,
    });
  }, [
    snapshotActive,
    dirty,
    documentIdentity,
    enqueueSnapshot,
    sessionKey,
    snapshotRetryGeneration,
  ]);

  useEffect(() => {
    if (!snapshotActive || !documentIdentity) return;

    const interval = setInterval(() => {
      void enqueueSnapshot({ required: false, preservePrevious: true });
    }, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [documentIdentity, enqueueSnapshot, sessionKey, snapshotActive]);

  useEffect(() => {
    clearAutosaveTimer();
    if (!autosaveActive
      || !dirty
      || !autosaveAvailable
      || autosaveIssueRef.current) {
      return;
    }

    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void runAutosave();
    }, AUTOSAVE_IDLE_MS);
    return clearAutosaveTimer;
  }, [
    autosaveActive,
    autosaveAvailable,
    autosaveGeneration,
    bufferVersion,
    clearAutosaveTimer,
    dirty,
    documentIdentity,
    runAutosave,
    sessionKey,
  ]);

  return {
    snapshotError,
    autosaveIssue,
    snapshotNow,
    waitForSnapshotQueue,
    clearRecoveryHistory,
    flushAutosave,
    cancelAutosaveAndWait,
    clearAutosaveIssue,
    recordSaveResult,
  };
}
