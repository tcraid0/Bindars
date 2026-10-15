function handleContextMenu(event: MouseEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : (event.target as Node | null)?.parentElement;
  if (target?.closest("input, textarea, select") || target?.isContentEditable) return;
  if (target?.closest("a[href]")) {
    event.preventDefault();
    return;
  }
  if (target?.closest("img")) return;

  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    // WebKit may return the nearest caret even in a blank margin. Require the
    // pointer to be over the selected text as well as inside its DOM range.
    if (caret && range.isPointInRange(caret.startContainer, caret.startOffset)
      && Array.from(range.getClientRects()).some((rect) =>
        event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom)) return;
  }
  event.preventDefault();
}

export function installContextMenuPolicy(): () => void {
  document.addEventListener("contextmenu", handleContextMenu);
  return () => document.removeEventListener("contextmenu", handleContextMenu);
}
