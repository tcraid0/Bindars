import { memo, useEffect, useRef } from "react";
import { DialogFrame } from "./DialogFrame";
import type { WorkspaceSearchHit, WorkspaceStatus } from "../types";
import { locationLabel } from "../lib/paths";
import { MAX_WORKSPACE_BODY_CHARS } from "../lib/workspace-limits";
import { PathDetails } from "./PathDetails";
interface CommandPaletteProps {
  visible: boolean;
  query: string;
  pending: boolean;
  results: WorkspaceSearchHit[];
  selectedIndex: number;
  status: WorkspaceStatus;
  folderName?: string;
  folderOnly?: boolean;
  onFolderOnly?: (value: boolean) => void;
  totalDocuments?: number;
  incompleteCount?: number;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onOpenHit: (hit: WorkspaceSearchHit) => void;
  onHoverIndex: (index: number) => void;
}
function CommandPaletteComponent(props: CommandPaletteProps) {
  const {
    visible,
    query,
    pending,
    results,
    selectedIndex,
    status,
    onQueryChange,
    onClose,
    onOpenHit,
    onHoverIndex,
  } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (visible) inputRef.current?.select();
  }, [visible]);
  useEffect(() => {
    if (visible)
      document
        .getElementById(`document-result-${selectedIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [visible, selectedIndex]);
  const selected = results[selectedIndex];
  return (
    <DialogFrame
      appShortcuts
      visible={visible}
      title="Search documents"
      initialFocusRef={inputRef}
      onDismiss={onClose}
      backdropClassName="print-hide fixed inset-0 z-50 flex items-start justify-center bg-bg-primary/90"
      className="command-palette-shell mt-[5vh] w-full max-w-[720px] mx-3 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-y-auto max-h-[90vh]"
      renderHeader={(title) => (
        <div className="p-4 border-b border-border">
          {title}
          <button className="navigation-action float-right" onClick={onClose}>
            Close Search
          </button>
          <p
            id="document-search-scope"
            className="text-xs text-text-secondary my-2"
          >
            {props.folderOnly && props.folderName
              ? `Searching only ${props.folderName}.`
              : `Searching recent documents, drafts${props.folderName ? ` and ${props.folderName}` : ""}.`}{" "}
            Other locations on your computer are not searched.
          </p>
          {props.folderName && (
            <label className="text-sm block my-2">
              Scope{" "}
              <select
                value={props.folderOnly ? "folder" : "all"}
                onChange={(event) =>
                  props.onFolderOnly?.(event.target.value === "folder")
                }
              >
                <option value="all">All places</option>
                <option value="folder">{props.folderName}</option>
              </select>
            </label>
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search documents"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="document-search-results"
            aria-describedby="document-search-scope document-search-help"
            aria-activedescendant={
              selected ? `document-result-${selectedIndex}` : undefined
            }
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Find by name or words"
            autoCorrect="off"
            spellCheck={false}
            className="w-full p-2 border border-border rounded text-sm bg-bg-primary"
          />
          <p
            id="document-search-help"
            className="text-xs text-text-secondary mt-2"
          >
            Words match in any order. Use "double quotes" around a phrase. Arrow
            keys select a document; Enter opens it.
          </p>
          <p
            role="status"
            aria-live={status === "indexing" ? "off" : "polite"}
            className="text-sm mt-2"
          >
            {pending
              ? "Updating results…"
              : `${props.totalDocuments ?? results.length} document${(props.totalDocuments ?? results.length) === 1 ? "" : "s"}${(props.totalDocuments ?? 0) > results.length ? ` · showing first ${results.length}` : ""}`}
            {status === "indexing" ? " · Checking content…" : ""}
          </p>
        </div>
      )}
    >
      <ul
        id="document-search-results"
        role="listbox"
        aria-label="Matching documents"
        className="max-h-[40vh] overflow-y-auto"
      >
        {results.map((hit, index) => (
          <li
            key={hit.path}
            id={`document-result-${index}`}
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => onHoverIndex(index)}
            onClick={() => onOpenHit(hit)}
            className={`cursor-pointer px-4 py-3 border-b border-border text-sm ${index === selectedIndex ? "bg-bg-tertiary" : ""}`}
          >
            <strong className="break-words">
              {hit.kind === "title" && hit.title && hit.snippet === hit.title
                ? hit.title
                : hit.name || hit.relPath}
            </strong>
            <p className="text-xs text-text-secondary break-all">
              {hit.name} · {locationLabel(hit.path)}
            </p>
            {hit.snippet && <p className="my-1 break-words">{hit.snippet}</p>}
            {!hit.snippet && hit.title && (
              <p className="my-1 break-words">{hit.title}</p>
            )}
            {!!hit.passageCount && (
              <p className="text-xs text-text-secondary">
                {hit.passageCount} matching passage
                {hit.passageCount === 1 ? "" : "s"}
              </p>
            )}
            {hit.problem && <p className="text-xs">{hit.problem}</p>}
          </li>
        ))}
      </ul>
      {!results.length && (
        <p className="p-4 text-sm">
          {pending
            ? "Updating results…"
            : query
              ? "No matching documents."
              : "Open a document, create a draft, or add a folder to start."}
        </p>
      )}
      {selected && (
        <div className="px-4 py-2">
          <PathDetails
            key={selected.path}
            path={selected.path}
            label={`Location of ${selected.name || selected.relPath}`}
          />
        </div>
      )}
      {!!selected?.passages?.length && (
        <div
          className="p-3 border-t border-border"
          aria-label={`Passages in ${selected.name}`}
        >
          <p className="text-xs text-text-secondary">
            Open a passage in {selected.name}
            {(selected.passageCount ?? 0) > selected.passages.length
              ? ` · first ${selected.passages.length} shown`
              : ""}
          </p>
          {selected.passages.map((passage, index) => (
            <button
              className="block text-left text-sm w-full p-2 hover:bg-bg-tertiary"
              key={index}
              onClick={() => onOpenHit({ ...selected, passage })}
            >
              {index + 1}. {passage.snippet}
            </button>
          ))}
        </div>
      )}
      <details className="p-3 text-xs text-text-secondary">
        <summary tabIndex={0}>
          Search coverage
          {props.incompleteCount
            ? ` · ${props.incompleteCount} documents have incomplete content`
            : ""}
        </summary>
        <p>
          Search reads the first {MAX_WORKSPACE_BODY_CHARS.toLocaleString()}{" "}
          characters of prose per document. Code, math, diagrams and images are
          excluded. Find in Document searches the displayed document, including
          code and rendered math. Files that cannot be read remain searchable by filename.
        </p>
        <p>
          Both searches ignore case and ordinary prose whitespace. Straight and
          curly quotes, --/–, ---/— and .../… are equivalent in prose. Code
          keeps literal punctuation and whitespace.
        </p>
      </details>
    </DialogFrame>
  );
}
export const CommandPalette = memo(CommandPaletteComponent);
