import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileChangedEvent } from "../types";

interface UseFileWatcherOptions {
  filePath: string | null;
  isEditing: boolean;
  onFileChanged: (changedPath: string) => void;
}

export function useFileWatcher({ filePath, isEditing, onFileChanged }: UseFileWatcherOptions) {
  const callbackRef = useRef(onFileChanged);
  callbackRef.current = onFileChanged;

  useEffect(() => {
    let disposed = false;
    let unlistenFileChanged: (() => void) | null = null;
    const unwatch = () => invoke("unwatch_file").catch(() => {});

    if (!filePath || isEditing) {
      unwatch();
      return;
    }

    const setup = async () => {
      try {
        await invoke("watch_file", { path: filePath });
      } catch (err) {
        console.warn("[file-watcher] Failed to watch:", err);
        return;
      }

      if (disposed) {
        unwatch();
        return;
      }

      try {
        unlistenFileChanged = await listen<FileChangedEvent>("file-changed", (event) => {
          const changedPath = event.payload?.path;
          if (!changedPath) return;
          callbackRef.current(changedPath);
        });
      } catch (err) {
        console.warn("[file-watcher] Failed to subscribe:", err);
        unwatch();
        return;
      }

      if (disposed && unlistenFileChanged) {
        unlistenFileChanged();
        unlistenFileChanged = null;
        unwatch();
      }
    };

    void setup();

    return () => {
      disposed = true;
      if (unlistenFileChanged) {
        unlistenFileChanged();
        unlistenFileChanged = null;
      }
      unwatch();
    };
  }, [filePath, isEditing]);
}
