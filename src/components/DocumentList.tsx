import { useState } from "react";
import type { WorkspaceDocIndex } from "../types";
import { PathDetails } from "./PathDetails";
import { revealDocument, revealDocumentLabel } from "../lib/reveal-document";
import { useToast } from "./ToastProvider";
import { FileName } from "./FileName";

/** A draft's own label, when it says more than its file name. A blank draft's label is its file name. */
function distinctDraftLabel(doc: WorkspaceDocIndex, drafts: boolean): string | null {
  return drafts && doc.draftLabel && doc.draftLabel !== doc.name ? doc.draftLabel : null;
}

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
              className="document-open document-row"
            >
              <strong>{distinctDraftLabel(doc, drafts) ?? <FileName name={doc.name} />}</strong>
              {distinctDraftLabel(doc, drafts) && (
                <span>{doc.name}</span>
              )}
            </button>
            {doc.problem && (
              <div className="document-problem">
                <p>{doc.problem}</p>
                {drafts && <PathDetails path={doc.path} label="File location" />}
                <button type="button" onClick={onRetry}>
                  Retry
                </button>{" "}
                {doc.coverage === "missing" && onFindNotes ? (
                  <button type="button" onClick={() => onFindNotes(doc.path)}>
                    Reconnect notes…
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void revealDocument(
                        doc.path,
                        "Couldn't show this file. It may have been moved or deleted.",
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
