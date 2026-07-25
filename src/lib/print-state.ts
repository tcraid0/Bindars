import type { PrintLayout } from "../types";

export const PRINTING_ATTR = "data-printing";
export const PRINT_THEMED_ATTR = "data-print-themed";
export const PRINT_LAYOUT_ATTR = "data-print-layout";

export interface PrintStateTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface ApplyPrintStateOptions {
  printing: boolean;
  themed: boolean;
  layout: PrintLayout;
  targets: readonly (PrintStateTarget | null | undefined)[];
}

export function applyPrintState({ printing, themed, layout, targets }: ApplyPrintStateOptions): void {
  for (const target of targets) {
    if (!target) continue;

    if (printing) {
      target.setAttribute(PRINTING_ATTR, "true");
      target.setAttribute(PRINT_LAYOUT_ATTR, layout);
      if (themed) {
        target.setAttribute(PRINT_THEMED_ATTR, "true");
      } else {
        target.removeAttribute(PRINT_THEMED_ATTR);
      }
      continue;
    }

    target.removeAttribute(PRINTING_ATTR);
    target.removeAttribute(PRINT_THEMED_ATTR);
    target.removeAttribute(PRINT_LAYOUT_ATTR);
  }
}
