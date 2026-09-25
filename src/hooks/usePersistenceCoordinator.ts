import { useCallback, useEffect, useRef, useState } from "react";
import type { CapturedEditorBuffer } from "./useEditor";
import type { EditorSaveResult } from "../lib/editor-save";

export const AUTOSAVE_IDLE_MS = 2_500;
export const AUTOSAVE_MAX_INTERVAL_MS = 10_000;

export interface AutosaveIssue {
  kind: "conflict" | "error";
  message: string;
}

interface PersistenceCoordinatorOptions {
  autosaveActive: boolean;
  dirty: boolean;
  sessionKey: number;
  documentIdentity: string | null;
  captureBuffer: () => CapturedEditorBuffer | null;
  bufferVersion?: string | null;
  onAutosave?: () => Promise<EditorSaveResult>;
}

interface PersistenceCoordinator {
  autosaveIssue: AutosaveIssue | null;
  flushAutosave: () => Promise<EditorSaveResult | null>;
  cancelAutosaveAndWait: () => Promise<AutosaveIssue | null>;
  clearAutosaveIssue: () => void;
  recordSaveResult: (result: EditorSaveResult) => void;
  rearmAutosave: () => void;
}

export function usePersistenceCoordinator({
  autosaveActive,
  dirty,
  sessionKey,
  documentIdentity,
  captureBuffer,
  bufferVersion = null,
  onAutosave,
}: PersistenceCoordinatorOptions): PersistenceCoordinator {
  const autosaveAvailable = documentIdentity !== null && Boolean(onAutosave);
  const [autosaveIssue, setAutosaveIssue] = useState<AutosaveIssue | null>(null);
  const [autosaveGeneration, setAutosaveGeneration] = useState(0);
  const autosaveActiveRef = useRef(autosaveActive);
  const sessionKeyRef = useRef(sessionKey);
  const documentIdentityRef = useRef(documentIdentity);
  const captureBufferRef = useRef(captureBuffer);
  const onAutosaveRef = useRef(onAutosave);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveDirtySinceRef = useRef<number | null>(null);
  const autosaveInFlightRef = useRef<Promise<EditorSaveResult | null> | null>(null);
  const autosaveIssueRef = useRef<AutosaveIssue | null>(null);

  // Autosave timers cross render boundaries; read the current session and buffer.
  autosaveActiveRef.current = autosaveActive;
  sessionKeyRef.current = sessionKey;
  documentIdentityRef.current = documentIdentity;
  captureBufferRef.current = captureBuffer;
  onAutosaveRef.current = onAutosave;

  useEffect(() => {
    autosaveDirtySinceRef.current = null;
    if (autosaveIssueRef.current !== null) {
      autosaveIssueRef.current = null;
      setAutosaveIssue(null);
    }
  }, [sessionKey]);

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
    if (result === "conflict" || result === "error" || result === "saved-with-recovery") {
      const issue: AutosaveIssue = {
        kind: result === "conflict" ? "conflict" : "error",
        message: result === "conflict"
          ? "The file changed outside Bindars. Autosave is paused."
          : result === "saved-with-recovery"
            ? "Autosave is paused. Another version was kept beside the document."
            : "Autosave is paused. Save manually to continue.",
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
    const requestedDocumentIdentity = documentIdentityRef.current;
    const captured = captureBufferRef.current();
    const save = onAutosaveRef.current;
    if (!autosaveActiveRef.current
      || requestedDocumentIdentity === null
      || !captured?.dirty
      || !save) {
      return Promise.resolve(null);
    }

    const operation = (async (): Promise<EditorSaveResult | null> => {
      // Register the in-flight promise before a save that may synchronously rerender.
      await Promise.resolve();
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
        // Only completed attempts reset here; early returns never re-arm the timer.
        autosaveDirtySinceRef.current = null;
      }
    });

    autosaveInFlightRef.current = operation;
    return operation;
  }, [clearAutosaveTimer, recordSaveResult]);

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

  // Manual save clears the countdown on entry, so callers re-arm when it returns.
  // The effect below returns immediately while an autosave issue is latched,
  // which makes a separate skip for pauses unnecessary.
  const rearmAutosave = useCallback(() => {
    setAutosaveGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    clearAutosaveTimer();
    if (!autosaveActive
      || !dirty
      || !autosaveAvailable
      || autosaveIssueRef.current) {
      autosaveDirtySinceRef.current = null;
      return;
    }

    if (autosaveDirtySinceRef.current === null) {
      autosaveDirtySinceRef.current = Date.now();
    }
    const delay = Math.min(
      AUTOSAVE_IDLE_MS,
      Math.max(0, autosaveDirtySinceRef.current + AUTOSAVE_MAX_INTERVAL_MS - Date.now()),
    );
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void runAutosave();
    }, delay);
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
    autosaveIssue,
    flushAutosave,
    cancelAutosaveAndWait,
    clearAutosaveIssue,
    recordSaveResult,
    rearmAutosave,
  };
}
