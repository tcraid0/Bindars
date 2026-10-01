export const READER_PANEL_WIDTHS = { sidebar: 260, toc: 220, notes: 280 } as const;
export type ReaderPanel = keyof typeof READER_PANEL_WIDTHS;
export type ReaderPanels = Record<ReaderPanel, boolean>;
const MIN_READER_WIDTH = 320;

/** Keep room for the document; below the minimum width, still show the preferred panel. */
export function fitReaderPanels(width: number, requested: ReaderPanels, preferred: ReaderPanel): ReaderPanels {
  let available = width - MIN_READER_WIDTH;
  const visible: ReaderPanels = { sidebar: false, toc: false, notes: false };
  const order: ReaderPanel[] = [preferred, ...(["notes", "toc", "sidebar"] as const).filter(panel => panel !== preferred)];
  for (const panel of order) {
    if (requested[panel] && (panel === preferred || READER_PANEL_WIDTHS[panel] <= available)) {
      visible[panel] = true;
      available -= READER_PANEL_WIDTHS[panel];
    }
  }
  return visible;
}
