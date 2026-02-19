import { memo, useRef, useEffect } from "react";

interface SearchBarProps {
  visible: boolean;
  query: string;
  matchCount: number;
  currentIndex: number;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

function SearchBarComponent({
  visible,
  query,
  matchCount,
  currentIndex,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [visible]);

  if (!visible) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      onPrevious();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="search-bar print-hide absolute top-0 right-4 z-30 flex items-center gap-2 bg-bg-secondary border border-border rounded-b-lg px-3 py-2 shadow-sm"
      style={{ animation: "searchBarIn 150ms cubic-bezier(0.2, 0, 0, 1)" }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search in document..."
        aria-label="Search in document"
        className="w-[200px] bg-transparent text-sm font-ui text-text-primary placeholder-text-muted outline-none"
      />

      {query.trim() && (
        <span className="text-xs font-mono text-text-muted whitespace-nowrap" aria-live="polite">
          {matchCount > 0 ? `${currentIndex + 1} of ${matchCount}` : "No results"}
        </span>
      )}

      <button
        type="button"
        onClick={onPrevious}
        aria-label="Previous match"
        className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition-colors duration-120"
        disabled={matchCount === 0}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>

      <button
        type="button"
        onClick={onNext}
        aria-label="Next match"
        className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition-colors duration-120"
        disabled={matchCount === 0}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition-colors duration-120"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export const SearchBar = memo(SearchBarComponent);
