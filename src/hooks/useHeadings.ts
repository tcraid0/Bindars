import { useState, useEffect } from "react";
import type { HeadingItem } from "../types";

/** Strip KaTeX aria-hidden decorative spans to get clean heading text for TOC. */
function getCleanHeadingText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  for (const el of clone.querySelectorAll('[aria-hidden="true"]')) el.remove();
  return clone.textContent?.trim() || "";
}

/**
 * Extract headings from the rendered DOM after markdown renders.
 * Uses the actual IDs that rehype-slug generated — zero chance of mismatch.
 */
export function useHeadings(
  contentRef: React.RefObject<HTMLElement | null>,
  content: string | null,
): HeadingItem[] {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);

  useEffect(() => {
    if (!content || !contentRef.current) {
      setHeadings([]);
      return;
    }

    // Small delay to ensure DOM is rendered after markdown processing
    const timer = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;

      const nodes = el.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
      const items: HeadingItem[] = [];

      nodes.forEach((node) => {
        // Skip footnotes section heading (has sr-only class)
        if (node.classList.contains("sr-only")) return;

        const id = node.getAttribute("id");
        const text = getCleanHeadingText(node);
        const level = parseInt(node.tagName.charAt(1), 10);

        if (id && text) {
          items.push({ id, text, level });
        }
      });

      setHeadings(items);
    });

    return () => cancelAnimationFrame(timer);
  }, [content]);

  return headings;
}
