import { memo, useCallback, useEffect, useRef } from "react";
import type { CharacterInfo, HeadingItem, SceneItem } from "../types";
import { useReducedMotion } from "../hooks/useReducedMotion";

interface TableOfContentsProps {
  visible: boolean;
  headings: HeadingItem[];
  activeId: string | null;
  scenes?: SceneItem[];
  characters?: CharacterInfo[];
  focusedCharacter?: string | null;
  onToggleCharacterFocus?: (name: string) => void;
  isBookmarked?: (headingId: string) => boolean;
  onToggleBookmark?: (headingId: string, headingText: string) => void;
  onOpenScene?: (scene: SceneItem) => void;
}

const indentByLevel: Record<number, string> = {
  1: "pl-4",
  2: "pl-4",
  3: "pl-8",
  4: "pl-10",
  5: "pl-12",
  6: "pl-14",
};

const TOC_AUTO_SCROLL_PADDING_PX = 10;

interface TOCItemProps {
  heading: HeadingItem;
  isActive: boolean;
  isBookmarked: boolean;
  onToggleBookmark?: (headingId: string, headingText: string) => void;
  onClick: (id: string) => void;
  activeRef: React.RefObject<HTMLButtonElement | null>;
}

const TOCItem = memo(function TOCItem({
  heading,
  isActive,
  isBookmarked: bookmarked,
  onToggleBookmark,
  onClick,
  activeRef,
}: TOCItemProps) {
  return (
    <li className="group relative">
      <button
        type="button"
        ref={isActive ? activeRef : null}
        onClick={() => onClick(heading.id)}
        className={`w-full text-left px-4 py-1.5 pr-8 text-[13px] leading-snug transition-colors duration-200 hover:text-text-primary ${
          indentByLevel[heading.level] || "pl-4"
        } ${
          isActive
            ? "text-text-primary font-medium border-l-2 border-l-accent toc-active-item"
            : "text-text-secondary border-l-2 border-l-transparent"
        }`}
      >
        <span className="line-clamp-2">{heading.text}</span>
      </button>
      {onToggleBookmark && (
        <button
          type="button"
          aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
          title={bookmarked ? "Remove bookmark" : "Bookmark"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleBookmark(heading.id, heading.text);
          }}
          className={`absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-accent transition-opacity duration-150 ${
            bookmarked ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill={bookmarked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={bookmarked ? "text-accent" : ""}>
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}
    </li>
  );
});

function TableOfContentsComponent({
  visible,
  headings,
  activeId,
  scenes = [],
  characters = [],
  focusedCharacter,
  onToggleCharacterFocus,
  isBookmarked,
  onToggleBookmark,
  onOpenScene,
}: TableOfContentsProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const contentScrollBehavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";

  useEffect(() => {
    return () => {
      if (autoScrollFrameRef.current !== null) {
        cancelAnimationFrame(autoScrollFrameRef.current);
      }
    };
  }, []);

  // Keep active TOC item visible, but avoid adding smooth animation churn.
  useEffect(() => {
    if (!activeRef.current || !navRef.current) {
      return;
    }

    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
    }

    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;

      const container = navRef.current;
      const activeButton = activeRef.current;
      if (!container || !activeButton) {
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const activeRect = activeButton.getBoundingClientRect();

      const outsideTop = activeRect.top < containerRect.top + TOC_AUTO_SCROLL_PADDING_PX;
      const outsideBottom = activeRect.bottom > containerRect.bottom - TOC_AUTO_SCROLL_PADDING_PX;

      if (outsideTop || outsideBottom) {
        activeButton.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
    });
  }, [activeId]);

  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ block: "start", behavior: contentScrollBehavior });
    }
  }, [contentScrollBehavior]);

  if (!visible) return null;

  return (
    <nav
      ref={navRef}
      aria-label="Table of contents"
      className="print-hide w-[220px] shrink-0 border-l border-border overflow-y-auto py-4"
      style={{ animation: "tocIn 250ms cubic-bezier(0.2, 0, 0, 1)" }}
    >
      <h2 className="px-4 pb-3 ui-section-label">
        Contents
      </h2>
      {scenes.length > 0 && (
        <div className="px-4 pb-3">
          <h3 className="ui-subsection-label mb-1.5">Scenes</h3>
          <ul className="space-y-1">
            {scenes.map((scene) => (
              <li key={scene.id}>
                <button
                  type="button"
                  disabled={!scene.headingId}
                  onClick={() => onOpenScene?.(scene)}
                  className="w-full text-left px-2 py-1 rounded text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  <span className="block truncate">{scene.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {characters.length > 0 && (
        <div className="px-4 pb-3">
          <h3 className="ui-subsection-label mb-1.5">Characters</h3>
          <ul className="space-y-0.5">
            {characters.map((char) => (
              <li key={char.name}>
                <button
                  type="button"
                  onClick={() => onToggleCharacterFocus?.(char.name)}
                  className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${
                    focusedCharacter === char.name
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  }`}
                >
                  <span className="truncate">{char.name}</span>
                  <span className="text-text-muted shrink-0 ml-auto">{char.dialogueCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {headings.length === 0 ? (
        <p className="px-4 text-sm text-text-muted">No headings</p>
      ) : (
        <ul className="list-none m-0 p-0">
          {headings.map((heading) => (
            <TOCItem
              key={heading.id}
              heading={heading}
              isActive={heading.id === activeId}
              isBookmarked={isBookmarked?.(heading.id) ?? false}
              onToggleBookmark={onToggleBookmark}
              onClick={handleClick}
              activeRef={activeRef}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

export const TableOfContents = memo(TableOfContentsComponent);
