// Move focus before the focused row disappears. Both lists use native buttons;
// skip unavailable rows and keep a stable container as the empty-list fallback.
export function focusAfterRemoval(row: HTMLElement | null, fallback: HTMLElement | null): void {
  if (!row?.contains(document.activeElement)) return;
  const rows = Array.from(row.parentElement?.children ?? []);
  const index = rows.indexOf(row);
  const candidates = [...rows.slice(index + 1), ...rows.slice(0, index).reverse()];
  for (const candidate of candidates) {
    const button = candidate.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (button) {
      button.focus();
      return;
    }
  }
  fallback?.focus();
}
