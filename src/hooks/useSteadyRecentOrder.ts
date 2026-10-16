import { useEffect, useMemo, useRef, useState } from "react";
import type { RecentFile } from "../types";

/** Keep sidebar rows in place; the saved history remains newest-first. */
export function useSteadyRecentOrder(recentFiles: RecentFile[], sidebarVisible: boolean) {
  const [paths, setPaths] = useState(() => recentFiles.map(file => file.path));
  const wasVisible = useRef(false);

  useEffect(() => {
    const savedPaths = recentFiles.map(file => file.path);
    const reset = !sidebarVisible || !wasVisible.current;
    wasVisible.current = sidebarVisible;
    setPaths(previous => {
      const next = reset ? savedPaths : [
        ...savedPaths.filter(path => !previous.includes(path)),
        ...previous.filter(path => savedPaths.includes(path)),
      ];
      return next.length === previous.length && next.every((path, index) => path === previous[index])
        ? previous : next;
    });
  }, [recentFiles, sidebarVisible]);

  return useMemo(() => {
    const files = new Map(recentFiles.map(file => [file.path, file]));
    return paths.flatMap(path => files.get(path) ? [files.get(path)!] : []);
  }, [recentFiles, paths]);
}
