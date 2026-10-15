import { useState } from "react";
import type { WorkspaceDocIndex } from "../types";
import { MAX_WORKSPACE_BODY_CHARS } from "../lib/workspace-limits";
import { PathDetails } from "./PathDetails";
import { revealDocument, revealDocumentLabel } from "../lib/reveal-document";
import { useToast } from "./ToastProvider";

export function DocumentList({
  docs,
  currentPath,
  onOpen,
  onRetry,
  onFindNotes,
  drafts = false,
}: {
  docs: WorkspaceDocIndex[];
  currentPath: string | null;
  onOpen: (path: string) => void;
  onRetry: () => void;
  onFindNotes?: (path: string) => void;
  drafts?: boolean;
}) {
  const [limit, setLimit] = useState(100);
  const { toast } = useToast();
  return (
    <>
      <ul className="document-list">
        {docs.slice(0, limit).map((doc) => (
          <li key={doc.path}>
            <button
              type="button"
              aria-current={doc.path === currentPath ? "page" : undefined}
              onClick={() => onOpen(doc.path)}
              className="document-open"
            >
              <strong>{drafts ? doc.draftLabel || doc.name : doc.name}</strong>
              {drafts && doc.draftLabel && doc.draftLabel !== doc.name && (
                <span>{doc.name}</span>
              )}
              {doc.coverage === "pending" && (
                <span>Preparing text search…</span>
              )}
              {doc.coverage === "partial" && (
                <span>
                  First {MAX_WORKSPACE_BODY_CHARS.toLocaleString()} characters
                  searchable
                </span>
              )}
            </button>
            {/* Folder rows sit under the folder's own location. */}
            {drafts && <PathDetails path={doc.path} label="Bindars Drafts" />}
            {doc.problem && (
              <div className="document-problem">
                <p>{doc.problem}</p>
                <button type="button" onClick={onRetry}>
                  Retry
                </button>{" "}
                {doc.coverage === "missing" && onFindNotes ? (
                  <button type="button" onClick={() => onFindNotes(doc.path)}>
                    Locate / reconnect notes…
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void revealDocument(
                        doc.path,
                        "Couldn't show this file. Check its location and permissions.",
                      ).catch((error: Error) => toast(error.message, "error"))
                    }
                  >
                    {revealDocumentLabel()}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {docs.length > limit && (
        <button
          className="navigation-action"
          onClick={() => setLimit((n) => n + 100)}
        >
          Show next {Math.min(100, docs.length - limit)} documents
        </button>
      )}
    </>
  );
}
