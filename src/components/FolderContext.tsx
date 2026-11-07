import { useId, useLayoutEffect, useRef, useState } from "react";
import { useDismissiblePopover } from "../hooks/useDismissiblePopover";
import { fileName, toPosixPath } from "../lib/paths";
import { PathDetails } from "./PathDetails";

/** The browsing location and its infrequent maintenance actions. */
export function FolderContext({ root, directory, onNavigate, onChoose, onRemove }: {
  root: string;
  directory: string;
  onNavigate: (path: string) => void;
  onChoose: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const id = useId();
  const dismiss = useDismissiblePopover({ open, triggerRef, panelRef, initialFocusRef: chooseRef, onClose: () => setOpen(false) });
  const parts = toPosixPath(directory).split("/").filter(Boolean);
  const currentPath = directory ? `${toPosixPath(root).replace(/\/$/, "")}/${directory}` : root;

  useLayoutEffect(() => {
    // Keep the current segment visible on deep paths; Tab reaches every ancestor.
    const crumbs = crumbsRef.current;
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
  }, [directory]);

  return (
    <div className="navigation-folder-context">
      <div className="navigation-folder-heading">
        <h2 id="navigation-folder-name" className="navigation-folder-name" title={root} aria-current={!directory ? "location" : undefined}>{fileName(root)}</h2>
        <button ref={triggerRef} type="button" className="navigation-action"
          aria-expanded={open} aria-controls={open ? id : undefined}
          onClick={() => open ? dismiss(true) : setOpen(true)}>
          Folder options
        </button>
      </div>
      {open && (
        <div ref={panelRef} id={id} role="group" aria-label="Folder options"
          className="folder-options bg-bg-secondary border border-border rounded-lg shadow-lg py-1 z-50">
          <button ref={chooseRef} type="button" className="navigation-action"
            onClick={() => { dismiss(true); onChoose(); }}>Choose another folder…</button>
          <div className="navigation-help"><PathDetails path={root} label="Folder location" /></div>
          {directory && <div className="navigation-help"><PathDetails path={currentPath} label="Current location" /></div>}
          <button type="button" className="navigation-action"
            onClick={() => { dismiss(false); onRemove(); }}>Remove from Sidebar</button>
        </div>
      )}
      {!!parts.length && (
        <nav id="navigation-folder-breadcrumbs" ref={crumbsRef} className="navigation-breadcrumbs" aria-label="Folder location" title={currentPath}>
          <button type="button" onClick={() => onNavigate("")} title={root}>{fileName(root)}</button>
          {parts.map((part, index) => {
            const path = parts.slice(0, index + 1).join("/");
            return <span className="navigation-crumb" key={path}>
              <span aria-hidden="true">›</span>
              {index === parts.length - 1
                ? <span aria-current="location" title={part}>{part}</span>
                : <button type="button" onClick={() => onNavigate(path)} title={part}>{part}</button>}
            </span>;
          })}
        </nav>
      )}
    </div>
  );
}
