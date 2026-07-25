export const SEARCH_HIGHLIGHT_CLASS = "search-highlight";
export const SEARCH_ACTIVE_CLASS = "search-highlight-active";

export function isSearchMark(element: Element): boolean {
  return (
    element.tagName.toLowerCase() === "mark" &&
    (element.classList.contains(SEARCH_HIGHLIGHT_CLASS) ||
      element.classList.contains(SEARCH_ACTIVE_CLASS))
  );
}

export function isAnnotationMark(element: Element): boolean {
  return element.tagName.toLowerCase() === "mark" && element.hasAttribute("data-highlight-id");
}

export function unwrapElementPreservingChildren(element: Element): Node | null {
  const parent = element.parentNode;
  if (!parent) return null;

  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
  return parent;
}

export function clearMarks(
  container: HTMLElement,
  predicate: (element: Element) => boolean,
): void {
  const marks = Array.from(container.querySelectorAll("mark")).filter(predicate);
  const parents = new Set<Node>();

  for (const mark of marks) {
    try {
      const parent = unwrapElementPreservingChildren(mark);
      if (parent) parents.add(parent);
    } catch {
      // DOM can change between query and unwrap during document transitions.
    }
  }

  for (const parent of parents) {
    if (typeof parent.normalize === "function") {
      parent.normalize();
    }
  }
}
