import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileWatcherPathEvent } from "../types";

export const FILE_CHANGED_EVENT = "file-changed";
export const FILE_WATCHER_UNAVAILABLE_EVENT = "bindars://file-watcher-unavailable";

export type WatcherUnavailableReason = "setup" | "dropped";

interface UseFileWatcherOptions {
  filePath: string | null;
  isEditing: boolean;
  onFileChanged: (changedPath: string) => void;
  onWatchSettled?: (path: string) => void;
  onWatcherUnavailable?: (path: string, reason: WatcherUnavailableReason) => void;
}

export function useFileWatcher({
  filePath,
  isEditing,
  onFileChanged,
  onWatchSettled,
  onWatcherUnavailable,
}: UseFileWatcherOptions) {
  const callbackRef = useRef(onFileChanged);
  callbackRef.current = onFileChanged;
  const watchSettledRef = useRef(onWatchSettled);
  watchSettledRef.current = onWatchSettled;
  const watcherUnavailableRef = useRef(onWatcherUnavailable);
  watcherUnavailableRef.current = onWatcherUnavailable;
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
    let unlistenWatcherUnavailable: (() => void) | null = null;
    const detachListeners = () => {
      unlistenFileChanged?.();
      unlistenFileChanged = null;
      unlistenWatcherUnavailable?.();
      unlistenWatcherUnavailable = null;
    };
    const reportSetupFailure = (path: string) => {
      if (disposed) return;
      // Settle a pending editor exit before offering the general fallback, so
      // both conditions cannot queue separate probes for the same failure.
      watchSettledRef.current?.(path);
      watcherUnavailableRef.current?.(path, "setup");
    };
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
        unlistenFileChanged = await listen<FileWatcherPathEvent>(FILE_CHANGED_EVENT, (event) => {
          if (disposed) return;
          const changedPath = event.payload?.path;
          if (!changedPath) return;
          callbackRef.current(changedPath);
        });
      } catch (err) {
        console.warn("[file-watcher] Failed to subscribe:", err);
        reportSetupFailure(filePath);
        return;
      }

      if (disposed) {
        detachListeners();
        return;
      }

      try {
        unlistenWatcherUnavailable = await listen<FileWatcherPathEvent>(
          FILE_WATCHER_UNAVAILABLE_EVENT,
          (event) => {
            if (disposed) return;
            const unavailablePath = event.payload?.path;
            if (!unavailablePath) return;
            watcherUnavailableRef.current?.(unavailablePath, "dropped");
          },
        );
      } catch (err) {
        console.warn("[file-watcher] Failed to subscribe to watcher health:", err);
        detachListeners();
        reportSetupFailure(filePath);
        return;
      }

      if (disposed) {
        detachListeners();
        return;
      }

      try {
        await enqueueWatcherCommand(
          () => invoke<void>("watch_file", { path: filePath }),
        );
      } catch (err) {
        console.warn("[file-watcher] Failed to watch:", err);
        detachListeners();
        reportSetupFailure(filePath);
        return;
      }

      if (disposed) {
        detachListeners();
        return;
      }
      watchSettledRef.current?.(filePath);
    };

    void setup();

    return () => {
      disposed = true;
      detachListeners();
      unwatch(filePath);
    };
  }, [enqueueWatcherCommand, filePath, isEditing]);
}
