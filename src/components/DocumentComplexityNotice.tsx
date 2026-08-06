import { memo } from "react";
import { DOCUMENT_COMPLEXITY_MESSAGE } from "../lib/document-complexity";

interface DocumentComplexityNoticeProps {
  contentRef: React.RefObject<HTMLElement | null>;
}

function DocumentComplexityNoticeComponent({
  contentRef,
}: DocumentComplexityNoticeProps) {
  return (
    <article
      ref={contentRef}
      role="alert"
      className="markdown-body max-w-[65ch] mx-auto px-6 py-12"
    >
      <h1>Document too complex</h1>
      <p>{DOCUMENT_COMPLEXITY_MESSAGE}</p>
    </article>
  );
}

export const DocumentComplexityNotice = memo(DocumentComplexityNoticeComponent);
