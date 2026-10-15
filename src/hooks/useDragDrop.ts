import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isOpenableDocumentPath } from "../lib/openable-files";

interface UseDragDropOptions {
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (paths: string[]) => void;
  onUnsupportedDrop: () => void;
}

export function useDragDrop({ onDragEnter, onDragLeave, onDrop, onUnsupportedDrop }: UseDragDropOptions) {
  useEffect(() => {
    const window = getCurrentWindow();

    const unlisten = window.onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
        onDragEnter();
      } else if (event.payload.type === "leave") {
        onDragLeave();
      } else if (event.payload.type === "drop") {
        onDragLeave();
        const paths = event.payload.paths.filter(isOpenableDocumentPath);
        if (paths.length > 0) {
          onDrop(paths);
        } else if (event.payload.paths.length > 0) {
          onUnsupportedDrop();
        }
      }
    });

    return () => {
      unlisten
        .then((fn) => fn())
        .catch(() => {
          // Best effort cleanup.
        });
    };
  }, [onDragEnter, onDragLeave, onDrop, onUnsupportedDrop]);
}
