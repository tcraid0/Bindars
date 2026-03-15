import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileRevision } from "../types";

interface EditorState {
  buffer: string | null;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
}

interface ConditionalWriteResult {
  conflict: boolean;
  currentRevision: FileRevision;
}

interface SaveOptions {
  force?: boolean;
}

export type EditorSaveResult = "saved" | "conflict" | "error" | "noop";

export function useEditor() {
  const [state, setState] = useState<EditorState>({
    buffer: null,
    dirty: false,
    saving: false,
    saveError: null,
  });

  const originalContentRef = useRef<string>("");
  const bufferRef = useRef<string | null>(null);
  const expectedRevisionRef = useRef<FileRevision | null>(null);
  const savingRef = useRef(false);

  const enterEditMode = useCallback((content: string, expectedRevision: FileRevision | null) => {
    originalContentRef.current = content;
    bufferRef.current = content;
    expectedRevisionRef.current = expectedRevision;
    setState({ buffer: content, dirty: false, saving: false, saveError: null });
  }, []);

  const updateBuffer = useCallback((content: string) => {
    bufferRef.current = content;
    setState((prev) => ({
      ...prev,
      buffer: content,
      dirty: content !== originalContentRef.current,
      saveError: null,
    }));
  }, []);

  const save = useCallback(async (filePath: string, options?: SaveOptions): Promise<EditorSaveResult> => {
    if (savingRef.current) return "noop";
    const currentBuffer = bufferRef.current;
    if (currentBuffer === null) return "noop";

    savingRef.current = true;
    setState((prev) => ({ ...prev, saving: true, saveError: null }));
    try {
      const expectedRevision = expectedRevisionRef.current;
      if (!options?.force && expectedRevision === null) {
        setState((prev) => ({
          ...prev,
          saving: false,
          saveError: "Couldn't verify file revision before save. Reload and try again.",
        }));
        return "error";
      }

      const result = await invoke<ConditionalWriteResult>("write_markdown_file_if_unmodified", {
        path: filePath,
        content: currentBuffer,
        expectedRevision,
        force: options?.force ?? false,
      });

      if (result.conflict) {
        setState((prev) => ({
          ...prev,
          saving: false,
          saveError: "This file changed outside Bindars. Reload or overwrite to continue.",
        }));
        return "conflict";
      }

      originalContentRef.current = currentBuffer;
      expectedRevisionRef.current = result.currentRevision;
      setState((prev) => ({
        ...prev,
        saving: false,
        dirty: bufferRef.current !== currentBuffer,
      }));
      return "saved";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, saving: false, saveError: message }));
      return "error";
    } finally {
      savingRef.current = false;
    }
  }, []);

  const exitEditMode = useCallback(() => {
    originalContentRef.current = "";
    bufferRef.current = null;
    expectedRevisionRef.current = null;
    setState({ buffer: null, dirty: false, saving: false, saveError: null });
  }, []);

  const dismissSaveError = useCallback(() => {
    setState((prev) => ({ ...prev, saveError: null }));
  }, []);

  return {
    buffer: state.buffer,
    dirty: state.dirty,
    saving: state.saving,
    saveError: state.saveError,
    enterEditMode,
    updateBuffer,
    save,
    exitEditMode,
    dismissSaveError,
  };
}
