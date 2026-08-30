import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import {
  isRecoverableDeletedFileSaveError,
  actionableSaveError,
  normalizeDocumentSavePath,
  successfulSaveOutcome,
} from "../lib/editor-save";
import { OPENABLE_FILE_EXTENSIONS } from "../lib/openable-files";
import type {
  EditorSaveOutcome,
  EditorSaveResult,
  SaveErrorRecovery,
} from "../lib/editor-save";
import type { ConditionalWriteResult, FileRevision } from "../types";

interface EditorState {
  buffer: string | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveErrorRecovery: SaveErrorRecovery;
}

interface SaveOptions {
  force?: boolean;
  quiet?: boolean;
}

export interface CapturedEditorBuffer {
  content: string;
  dirty: boolean;
}

type UnsuccessfulEditorSaveResult = Exclude<
  EditorSaveResult,
  "saved" | "saved-with-newer-edits"
>;

export type EditorSaveAsResult = EditorSaveOutcome;

export type FlushPendingBuffer = () => boolean | null;

export function useEditor(flushPendingBuffer?: FlushPendingBuffer) {
  const [state, setState] = useState<EditorState>({
    buffer: null,
    dirty: false,
    saving: false,
    saveError: null,
    saveErrorRecovery: null,
  });

  const originalContentRef = useRef<string>("");
  const bufferRef = useRef<string | null>(null);
  const expectedRevisionRef = useRef<FileRevision | null>(null);
  const editSessionRef = useRef(0);
  const savingSessionRef = useRef<number | null>(null);
  const flushPendingBufferRef = useRef(flushPendingBuffer);
  flushPendingBufferRef.current = flushPendingBuffer;

  const enterEditMode = useCallback((content: string, expectedRevision: FileRevision | null) => {
    editSessionRef.current += 1;
    originalContentRef.current = content;
    bufferRef.current = content;
    expectedRevisionRef.current = expectedRevision;
    setState({
      buffer: content,
      dirty: false,
      saving: false,
      saveError: null,
      saveErrorRecovery: null,
    });
  }, []);

  const updateBuffer = useCallback((content: string): boolean => {
    const dirty = content !== originalContentRef.current;
    bufferRef.current = content;
    setState((prev) => ({
      ...prev,
      buffer: content,
      dirty,
      saveError: null,
      saveErrorRecovery: null,
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
      dirty: content !== originalContentRef.current,
    };
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

    if (result.conflict) {
      setState((prev) => ({
        ...prev,
        saving: false,
        saveError: quiet
          ? null
          : "This file changed outside Bindars. Reload or overwrite to continue.",
        saveErrorRecovery: null,
      }));
      return "conflict";
    }

    originalContentRef.current = savedBuffer;
    expectedRevisionRef.current = result.currentRevision;
    const hasNewerEdits = bufferRef.current !== savedBuffer;
    setState((prev) => ({
      ...prev,
      saving: false,
      dirty: hasNewerEdits,
    }));
    return hasNewerEdits ? "saved-with-newer-edits" : "saved";
  }, [syncCurrentSession]);

  const completeFailure = useCallback((
    editSession: number,
    error: unknown,
    deletedFileIsConflict: boolean,
    quiet: boolean,
  ): UnsuccessfulEditorSaveResult => {
    if (!syncCurrentSession(editSession)) return "stale";

    if (deletedFileIsConflict && isRecoverableDeletedFileSaveError(error)) {
      setState((prev) => ({
        ...prev,
        saving: false,
        saveError: quiet
          ? null
          : "This file was deleted outside Bindars. Overwrite to recreate it.",
        saveErrorRecovery: null,
      }));
      return "conflict";
    }

    const described = actionableSaveError(error);
    setState((prev) => ({
      ...prev,
      saving: false,
      saveError: quiet ? null : described.message,
      saveErrorRecovery: quiet ? null : described.recovery,
    }));
    return "error";
  }, [syncCurrentSession]);

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

      const result = await invoke<ConditionalWriteResult>("write_markdown_file_if_unmodified", {
        path: filePath,
        content: currentBuffer,
        expectedRevision,
        force: options?.force ?? false,
      });
      const status = completeWrite(editSession, currentBuffer, result, options?.quiet ?? false);
      return status === "saved" || status === "saved-with-newer-edits"
        ? successfulSaveOutcome(status, currentBuffer, result)
        : { status };
    } catch (err) {
      return {
        status: completeFailure(
          editSession,
          err,
          !options?.force,
          options?.quiet ?? false,
        ),
      };
    } finally {
      releaseSave(editSession);
    }
  }, [beginSave, completeFailure, completeWrite, releaseSave, syncCurrentSession]);

  const saveAs = useCallback(async (defaultPath: string): Promise<EditorSaveAsResult> => {
    const previousSaveError = state.saveError;
    const previousSaveErrorRecovery = state.saveErrorRecovery;
    const editSession = beginSave();
    if (editSession === null) return { status: "noop" };

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

      const result = await invoke<ConditionalWriteResult>("write_markdown_file_if_unmodified", {
        path: normalizedPath.path,
        content: currentBuffer,
        expectedRevision: null,
        force: true,
      });
      const status = completeWrite(editSession, currentBuffer, result, false);
      if (status !== "saved" && status !== "saved-with-newer-edits") return { status };

      return successfulSaveOutcome(status, currentBuffer, result);
    } catch (err) {
      return { status: completeFailure(editSession, err, false, false) };
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
    setState({
      buffer: null,
      dirty: false,
      saving: false,
      saveError: null,
      saveErrorRecovery: null,
    });
  }, []);

  const dismissSaveError = useCallback(() => {
    setState((prev) => ({
      ...prev,
      saveError: null,
      saveErrorRecovery: null,
    }));
  }, []);

  return {
    buffer: state.buffer,
    dirty: state.dirty,
    saving: state.saving,
    saveError: state.saveError,
    saveErrorRecovery: state.saveErrorRecovery,
    enterEditMode,
    updateBuffer,
    flushAndReadBuffer,
    captureSnapshotBuffer,
    save,
    saveAs,
    exitEditMode,
    dismissSaveError,
  };
}
