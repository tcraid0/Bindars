import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileChangedEvent } from "../types";

interface UseFileWatcherOptions {
  filePath: string | null;
  isEditing: boolean;
  onFileChanged: (changedPath: string) => void;
  onWatchSettled?: (path: string) => void;
}

export function useFileWatcher({
  filePath,
  isEditing,
  onFileChanged,
  onWatchSettled,
}: UseFileWatcherOptions) {
  const callbackRef = useRef(onFileChanged);
  callbackRef.current = onFileChanged;
  const watchSettledRef = useRef(onWatchSettled);
  watchSettledRef.current = onWatchSettled;
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Preserve watcher ownership order across effect cleanup/setup. Tauri IPC
  // calls may otherwise complete a same-path unwatch after its replacement watch.
  const enqueueWatcherCommand = useCallback((command: () => Promise<void>): Promise<void> => {
    const result = commandQueueRef.current.then(command, command);
    commandQueueRef.current = result.catch(() => {});
    return result;
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenFileChanged: (() => void) | null = null;
    const unwatch = (path: string) => {
      void enqueueWatcherCommand(
        () => invoke<void>("unwatch_file", { path }),
      ).catch(() => {});
    };

    if (!filePath) {
      return;
    }

    if (isEditing) {
      unwatch(filePath);
      return;
    }

    const setup = async () => {
      try {
        unlistenFileChanged = await listen<FileChangedEvent>("file-changed", (event) => {
          const changedPath = event.payload?.path;
          if (!changedPath) return;
          callbackRef.current(changedPath);
        });
      } catch (err) {
        console.warn("[file-watcher] Failed to subscribe:", err);
        if (!disposed) watchSettledRef.current?.(filePath);
        return;
      }

      if (disposed) {
        unlistenFileChanged();
        unlistenFileChanged = null;
        return;
      }

      try {
        await enqueueWatcherCommand(
          () => invoke<void>("watch_file", { path: filePath }),
        );
      } catch (err) {
        console.warn("[file-watcher] Failed to watch:", err);
        if (unlistenFileChanged) {
          unlistenFileChanged();
          unlistenFileChanged = null;
        }
        if (!disposed) watchSettledRef.current?.(filePath);
        return;
      }

      if (disposed) {
        if (unlistenFileChanged) {
          unlistenFileChanged();
          unlistenFileChanged = null;
        }
        return;
      }
      watchSettledRef.current?.(filePath);
    };

    void setup();

    return () => {
      disposed = true;
      if (unlistenFileChanged) {
        unlistenFileChanged();
        unlistenFileChanged = null;
      }
      unwatch(filePath);
    };
  }, [enqueueWatcherCommand, filePath, isEditing]);
}
