import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface UseDragDropOptions {
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (paths: string[]) => void;
}

export function useDragDrop({ onDragEnter, onDragLeave, onDrop }: UseDragDropOptions) {
  useEffect(() => {
    const window = getCurrentWindow();

    const unlisten = window.onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
        onDragEnter();
      } else if (event.payload.type === "leave") {
        onDragLeave();
      } else if (event.payload.type === "drop") {
        onDragLeave();
        const paths = event.payload.paths.filter(
          (p) => {
            const lower = p.toLowerCase();
            return (
              lower.endsWith(".md") ||
              lower.endsWith(".markdown") ||
              lower.endsWith(".fountain")
            );
          },
        );
        if (paths.length > 0) {
          onDrop(paths);
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
  }, [onDragEnter, onDragLeave, onDrop]);
}
