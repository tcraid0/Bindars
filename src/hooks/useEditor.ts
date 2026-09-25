import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import {
  actionableSaveError,
  normalizeDocumentSavePath,
  saveErrorBlocksCurrentPath,
  successfulSaveOutcome,
} from "../lib/editor-save";
import { OPENABLE_FILE_EXTENSIONS } from "../lib/openable-files";
import type {
  EditorSaveOutcome,
  EditorSaveResult,
  SaveErrorRecovery,
} from "../lib/editor-save";
import { sameFileRevision } from "../lib/document-reconciliation";
import type { ConditionalWriteResult, FileRevision } from "../types";

export type EditorExternalChange = "changed";

interface EditorState {
  buffer: string | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveErrorRecovery: SaveErrorRecovery;
  externalChange: EditorExternalChange | null;
  recoveryPath: string | null;
  savePathBlocked: boolean;
}

interface BlockedSavePath {
  path: string;
  message: string;
}

interface SaveOptions {
  force?: boolean;
  quiet?: boolean;
}

export interface CapturedEditorBuffer {
  content: string;
  dirty: boolean;
}

export interface EditorReconciliationState extends CapturedEditorBuffer {
  sessionId: number;
  expectedRevision: FileRevision | null;
  saveInFlight: boolean;
}

type UnsuccessfulEditorSaveResult = Exclude<
  EditorSaveResult,
  "saved" | "saved-with-newer-edits" | "saved-with-recovery"
>;

export type EditorSaveAsResult = EditorSaveOutcome;

export type FlushPendingBuffer = () => boolean | null;
export type AdoptExternalDocument = (
  capturedDocument: string,
  externalDocument: string,
) => boolean;

function externalChangeMessage(): string {
  return "The file changed outside Bindars. Your current draft is preserved and autosave is paused.";
}

export function useEditor(flushPendingBuffer?: FlushPendingBuffer) {
  const [state, setState] = useState<EditorState>({
    buffer: null,
    dirty: false,
    saving: false,
    saveError: null,
    saveErrorRecovery: null,
    externalChange: null,
    recoveryPath: null,
    savePathBlocked: false,
  });

  const originalContentRef = useRef<string>("");
  const bufferRef = useRef<string | null>(null);
  const expectedRevisionRef = useRef<FileRevision | null>(null);
  const recoveryRequiredRef = useRef(false);
  const blockedSaveRef = useRef<BlockedSavePath | null>(null);
  const editSessionRef = useRef(0);
  const savingSessionRef = useRef<number | null>(null);
  const flushPendingBufferRef = useRef(flushPendingBuffer);
  flushPendingBufferRef.current = flushPendingBuffer;

  const enterEditMode = useCallback((content: string, expectedRevision: FileRevision | null) => {
    editSessionRef.current += 1;
    originalContentRef.current = content;
    bufferRef.current = content;
    expectedRevisionRef.current = expectedRevision;
    recoveryRequiredRef.current = false;
    blockedSaveRef.current = null;
    setState({
      buffer: content,
      dirty: false,
      saving: false,
      saveError: null,
      saveErrorRecovery: null,
      externalChange: null,
      recoveryPath: null,
      savePathBlocked: false,
    });
  }, []);

  const updateBuffer = useCallback((content: string): boolean => {
    const dirty = recoveryRequiredRef.current || content !== originalContentRef.current;
    bufferRef.current = content;
    const keepSaveError = recoveryRequiredRef.current || blockedSaveRef.current !== null;
    setState((prev) => ({
      ...prev,
      buffer: content,
      dirty,
      saveError: prev.externalChange || keepSaveError ? prev.saveError : null,
      saveErrorRecovery: prev.externalChange || keepSaveError ? prev.saveErrorRecovery : null,
    }));
    return dirty;
  }, []);

  const syncCurrentSession = useCallback((editSession: number): boolean => {
    if (editSessionRef.current !== editSession) return false;
    flushPendingBufferRef.current?.();
    return editSessionRef.current === editSession;
  }, []);

  const flushAndReadBuffer = useCallback((): string | null => {
    flushPendingBufferRef.current?.();
    return bufferRef.current;
  }, []);

  const captureSnapshotBuffer = useCallback((): CapturedEditorBuffer | null => {
    flushPendingBufferRef.current?.();
    const content = bufferRef.current;
    if (content === null) return null;
    return {
      content,
      dirty: recoveryRequiredRef.current || content !== originalContentRef.current,
    };
  }, []);

  const getReconciliationState = useCallback((): EditorReconciliationState | null => {
    const captured = captureSnapshotBuffer();
    if (!captured) return null;
    return {
      ...captured,
      sessionId: editSessionRef.current,
      expectedRevision: expectedRevisionRef.current,
      saveInFlight: savingSessionRef.current === editSessionRef.current,
    };
  }, [captureSnapshotBuffer]);

  const ownsReconciliationSession = useCallback((
    sessionId: number,
    capturedExpectedRevision: FileRevision | null,
  ): boolean => {
    flushPendingBufferRef.current?.();
    return editSessionRef.current === sessionId
      && bufferRef.current !== null
      && sameFileRevision(expectedRevisionRef.current, capturedExpectedRevision);
  }, []);

  const ownsCleanReconciliation = useCallback((
    sessionId: number,
    capturedContent: string,
    capturedExpectedRevision: FileRevision | null,
  ): boolean => {
    return ownsReconciliationSession(sessionId, capturedExpectedRevision)
      && bufferRef.current === capturedContent
      && bufferRef.current === originalContentRef.current;
  }, [ownsReconciliationSession]);

  const refreshCleanExpectedRevision = useCallback((
    sessionId: number,
    capturedContent: string,
    capturedExpectedRevision: FileRevision | null,
    revision: FileRevision,
  ): boolean => {
    if (!ownsCleanReconciliation(sessionId, capturedContent, capturedExpectedRevision)) return false;
    expectedRevisionRef.current = revision;
    return true;
  }, [ownsCleanReconciliation]);

  const refreshDirtyExpectedRevision = useCallback((
    sessionId: number,
    capturedExpectedRevision: FileRevision,
    revision: FileRevision,
  ): boolean => {
    if (!ownsReconciliationSession(sessionId, capturedExpectedRevision)) return false;
    expectedRevisionRef.current = revision;
    return true;
  }, [ownsReconciliationSession]);

  const refreshCleanBuffer = useCallback((
    sessionId: number,
    capturedContent: string,
    capturedExpectedRevision: FileRevision | null,
    content: string,
    revision: FileRevision,
    adoptExternalDocument: AdoptExternalDocument,
  ): boolean => {
    if (!ownsCleanReconciliation(sessionId, capturedContent, capturedExpectedRevision)) return false;
    if (!adoptExternalDocument(capturedContent, content)) {
      if (editSessionRef.current === sessionId && bufferRef.current !== null) {
        recoveryRequiredRef.current = true;
        setState((prev) => ({
          ...prev,
          dirty: true,
          externalChange: "changed",
          saveError: prev.saveError ?? externalChangeMessage(),
        }));
      }
      return false;
    }

    originalContentRef.current = content;
    bufferRef.current = content;
    expectedRevisionRef.current = revision;
    recoveryRequiredRef.current = false;
    setState((prev) => ({
      ...prev,
      buffer: content,
      dirty: false,
      externalChange: null,
    }));
    return true;
  }, [ownsCleanReconciliation]);

  const protectFromExternalChange = useCallback((
    sessionId: number,
    change: EditorExternalChange,
  ): boolean => {
    flushPendingBufferRef.current?.();
    if (editSessionRef.current !== sessionId || bufferRef.current === null) return false;
    recoveryRequiredRef.current = true;

    setState((prev) => ({
      ...prev,
      dirty: true,
      externalChange: change,
      saveError: prev.saveError ?? externalChangeMessage(),
    }));
    return true;
  }, []);

  const beginSave = useCallback((): number | null => {
    const editSession = editSessionRef.current;
    if (savingSessionRef.current === editSession || bufferRef.current === null) return null;

    savingSessionRef.current = editSession;
    setState((prev) => ({
      ...prev,
      saving: true,
      saveError: null,
      saveErrorRecovery: null,
    }));
    return editSession;
  }, []);

  const completeWrite = useCallback((
    editSession: number,
    savedBuffer: string,
    result: ConditionalWriteResult,
    quiet: boolean,
  ): EditorSaveResult => {
    if (!syncCurrentSession(editSession)) return "stale";

    if (result.recoveryPath) {
      // The exchange finished. Remember the written revision and destination
      // so the next save follows them. The recovery path stays in state,
      // separate from the dismissible error string. Autosave stays paused
      // because this result is not a completed save.
      expectedRevisionRef.current = result.currentRevision;
      originalContentRef.current = savedBuffer;
      recoveryRequiredRef.current = true;
      blockedSaveRef.current = null;
      setState((prev) => ({
        ...prev,
        saving: false,
        dirty: true,
        externalChange: null,
        saveError: null,
        saveErrorRecovery: null,
        recoveryPath: result.recoveryPath ?? null,
        savePathBlocked: false,
      }));
      return "saved-with-recovery";
    }

    if (result.conflict) {
      recoveryRequiredRef.current = true;
      setState((prev) => ({
        ...prev,
        saving: false,
        dirty: true,
        saveError: quiet
          ? null
          : "This file changed outside Bindars. Reload or overwrite to continue.",
        saveErrorRecovery: null,
      }));
      return "conflict";
    }

    originalContentRef.current = savedBuffer;
    expectedRevisionRef.current = result.currentRevision;
    recoveryRequiredRef.current = false;
    blockedSaveRef.current = null;
    const hasNewerEdits = bufferRef.current !== savedBuffer;
    setState((prev) => ({
      ...prev,
      saving: false,
      dirty: hasNewerEdits,
      externalChange: null,
      saveError: null,
      saveErrorRecovery: null,
      recoveryPath: null,
      savePathBlocked: false,
    }));
    return hasNewerEdits ? "saved-with-newer-edits" : "saved";
  }, [syncCurrentSession]);

  const completeFailure = useCallback((
    editSession: number,
    error: unknown,
    quiet: boolean,
    currentPath?: string,
  ): UnsuccessfulEditorSaveResult => {
    if (!syncCurrentSession(editSession)) return "stale";

    const described = actionableSaveError(error);
    if (saveErrorBlocksCurrentPath(error)) {
      if (currentPath) {
        blockedSaveRef.current = { path: currentPath, message: described.message };
      }
      recoveryRequiredRef.current = true;
    }
    const blocked = blockedSaveRef.current !== null;
    const showError = !quiet || described.recovery !== null || blocked;
    setState((prev) => ({
      ...prev,
      saving: false,
      dirty: recoveryRequiredRef.current || prev.dirty,
      saveError: showError ? described.message : null,
      saveErrorRecovery: showError ? described.recovery : null,
      savePathBlocked: blocked,
    }));
    return "error";
  }, [syncCurrentSession]);

  const outcomeForWrite = (
    status: EditorSaveResult,
    content: string,
    result: ConditionalWriteResult,
  ): EditorSaveOutcome => {
    if (status === "saved" || status === "saved-with-newer-edits") {
      return successfulSaveOutcome(status, content, result);
    }
    if (status === "saved-with-recovery" && result.recoveryPath) {
      return {
        status,
        recoveryPath: result.recoveryPath,
        file: {
          canonicalPath: result.canonicalPath,
          name: result.name,
          content,
          revision: result.currentRevision,
        },
      };
    }
    if (status === "saved-with-recovery") return { status: "error" };
    return { status };
  };

  const refuseBlockedSave = (filePath: string): EditorSaveOutcome | null => {
    const blocked = blockedSaveRef.current;
    if (!blocked || blocked.path !== filePath) return null;
    recoveryRequiredRef.current = true;
    setState((prev) => ({
      ...prev,
      saving: false,
      dirty: true,
      saveError: blocked.message,
      saveErrorRecovery: "save-as",
      savePathBlocked: true,
    }));
    return { status: "error" };
  };

  const releaseSave = useCallback((editSession: number) => {
    if (savingSessionRef.current === editSession) {
      savingSessionRef.current = null;
    }
  }, []);

  const save = useCallback(async (filePath: string, options?: SaveOptions): Promise<EditorSaveOutcome> => {
    const editSession = beginSave();
    if (editSession === null) return { status: "noop" };

    try {
      if (!syncCurrentSession(editSession)) return { status: "stale" };
      const refused = refuseBlockedSave(filePath);
      if (refused) return refused;
      const currentBuffer = bufferRef.current;
      if (currentBuffer === null) return { status: "stale" };

      const expectedRevision = expectedRevisionRef.current;
      if (!options?.force && expectedRevision === null) {
        setState((prev) => ({
          ...prev,
          saving: false,
          saveError: "Couldn't verify file revision before save. Reload and try again.",
          saveErrorRecovery: null,
        }));
        return { status: "error" };
      }

      let result = await invoke<ConditionalWriteResult>("write_markdown_file_if_unmodified", {
        path: filePath,
        content: currentBuffer,
        expectedRevision,
        force: options?.force ?? false,
      });
      if (
        !options?.force
        && expectedRevision !== null
        && result.canonicalPath === filePath
        && result.conflict
        && result.currentRevision.size === expectedRevision.size
        && result.currentRevision.contentHash === expectedRevision.contentHash
      ) {
        result = await invoke<ConditionalWriteResult>("write_markdown_file_if_unmodified", {
          path: filePath,
          content: currentBuffer,
          expectedRevision: result.currentRevision,
          force: false,
        });
      }
      const status = completeWrite(editSession, currentBuffer, result, options?.quiet ?? false);
      return outcomeForWrite(status, currentBuffer, result);
    } catch (err) {
      return {
        status: completeFailure(
          editSession,
          err,
          options?.quiet ?? false,
          filePath,
        ),
      };
    } finally {
      releaseSave(editSession);
    }
  }, [beginSave, completeFailure, completeWrite, releaseSave, syncCurrentSession]);

  const createDraft = useCallback(async (): Promise<EditorSaveOutcome> => {
    const editSession = beginSave();
    if (editSession === null) return { status: "noop" };

    try {
      if (!syncCurrentSession(editSession)) return { status: "stale" };
      const currentBuffer = bufferRef.current;
      if (currentBuffer === null) return { status: "stale" };

      const result = await invoke<ConditionalWriteResult>("create_draft_document", {
        content: currentBuffer,
      });
      const status = completeWrite(editSession, currentBuffer, result, true);
      return outcomeForWrite(status, currentBuffer, result);
    } catch (err) {
      return { status: completeFailure(editSession, err, true) };
    } finally {
      releaseSave(editSession);
    }
  }, [beginSave, completeFailure, completeWrite, releaseSave, syncCurrentSession]);

  const saveAs = useCallback(async (
    defaultPath: string,
    currentPath: string | null,
  ): Promise<EditorSaveAsResult> => {
    const previousSaveError = state.saveError;
    const previousSaveErrorRecovery = state.saveErrorRecovery;
    const editSession = beginSave();
    if (editSession === null) return { status: "noop" };

    let attemptedPath: string | undefined;
    try {
      const selectedPath = await showSaveDialog({
        defaultPath,
        filters: [{ name: "Bindars document", extensions: [...OPENABLE_FILE_EXTENSIONS] }],
      });

      if (!syncCurrentSession(editSession)) return { status: "stale" };
      if (!selectedPath) {
        setState((prev) => ({
          ...prev,
          saving: false,
          saveError: previousSaveError,
          saveErrorRecovery: previousSaveErrorRecovery,
        }));
        return { status: "cancelled" };
      }

      const normalizedPath = normalizeDocumentSavePath(selectedPath);
      if (normalizedPath.status === "error") {
        setState((prev) => ({
          ...prev,
          saving: false,
          saveError: normalizedPath.message,
          saveErrorRecovery: "save-as",
        }));
        return { status: "error" };
      }

      const currentBuffer = bufferRef.current;
      if (currentBuffer === null) return { status: "stale" };

      attemptedPath = normalizedPath.path;
      const result = await invoke<ConditionalWriteResult>("write_markdown_file_if_unmodified", {
        path: normalizedPath.path,
        content: currentBuffer,
        expectedRevision: null,
        force: !normalizedPath.appendedExtension,
        createNew: normalizedPath.appendedExtension,
      });
      const status = completeWrite(editSession, currentBuffer, result, false);
      return outcomeForWrite(status, currentBuffer, result);
    } catch (err) {
      // A failed Save As does not adopt its destination. Only a failure at the
      // current pathname can update its block; other failures leave it intact.
      return {
        status: completeFailure(
          editSession, err, false, attemptedPath === currentPath ? attemptedPath : undefined,
        ),
      };
    } finally {
      releaseSave(editSession);
    }
  }, [
    beginSave,
    completeFailure,
    completeWrite,
    releaseSave,
    state.saveError,
    state.saveErrorRecovery,
    syncCurrentSession,
  ]);

  const exitEditMode = useCallback(() => {
    editSessionRef.current += 1;
    originalContentRef.current = "";
    bufferRef.current = null;
    expectedRevisionRef.current = null;
    recoveryRequiredRef.current = false;
    blockedSaveRef.current = null;
    setState({
      buffer: null,
      dirty: false,
      saving: false,
      saveError: null,
      saveErrorRecovery: null,
      externalChange: null,
      recoveryPath: null,
      savePathBlocked: false,
    });
  }, []);

  const dismissSaveError = useCallback(() => {
    if (blockedSaveRef.current) return;
    setState((prev) => ({
      ...prev,
      saveError: null,
      saveErrorRecovery: null,
    }));
  }, []);

  // Consumers should depend on the members they use, not this per-render result object.
  return {
    buffer: state.buffer,
    dirty: state.dirty,
    saving: state.saving,
    saveError: state.saveError,
    saveErrorRecovery: state.saveErrorRecovery,
    externalChange: state.externalChange,
    recoveryPath: state.recoveryPath,
    savePathBlocked: state.savePathBlocked,
    enterEditMode,
    updateBuffer,
    flushAndReadBuffer,
    captureSnapshotBuffer,
    getReconciliationState,
    refreshCleanExpectedRevision,
    refreshDirtyExpectedRevision,
    refreshCleanBuffer,
    protectFromExternalChange,
    save,
    createDraft,
    saveAs,
    exitEditMode,
    dismissSaveError,
  };
}
