import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { fitReaderPanels, type ReaderPanel, type ReaderPanels } from "../lib/reader-panels";

function restoreHiddenPanelFocus(visible: ReaderPanels, reader: HTMLElement | null) {
  const panel = document.activeElement?.closest("[data-reader-panel]")?.getAttribute("data-reader-panel") as ReaderPanel | undefined;
  if (panel && !visible[panel]) {
    (reader?.querySelector<HTMLElement>('[aria-label="Edit document"]') ?? reader)?.focus({ preventScroll: true });
  }
}

// The panel row spans the window, so its width is known before the first
// render and panels never appear and then disappear during startup.
export function useReaderPanels({ sidebar, toc, notes }: ReaderPanels, readerRef: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(() => window.innerWidth);
  const [preferred, setPreferred] = useState<ReaderPanel>("notes");

  useLayoutEffect(() => {
    const update = () => {
      const nextWidth = window.innerWidth;
      // Move focus before React removes a panel during a resize.
      restoreHiddenPanelFocus(fitReaderPanels(nextWidth, { sidebar, toc, notes }, preferred), readerRef.current);
      setWidth(nextWidth);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [sidebar, toc, notes, preferred, readerRef]);

  const preparePanelChange = useCallback((panel: ReaderPanel, open: boolean) => {
    const requested = { sidebar, toc, notes, [panel]: open };
    restoreHiddenPanelFocus(fitReaderPanels(width, requested, open ? panel : preferred), readerRef.current);
    if (open) setPreferred(panel);
  }, [width, sidebar, toc, notes, preferred, readerRef]);

  return { visible: fitReaderPanels(width, { sidebar, toc, notes }, preferred), preparePanelChange };
}
