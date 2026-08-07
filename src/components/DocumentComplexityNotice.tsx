import { memo } from "react";
import { DOCUMENT_COMPLEXITY_REASON } from "../lib/document-complexity";

interface DocumentComplexityNoticeProps {
  contentRef: React.RefObject<HTMLElement | null>;
  message: string;
}

function DocumentComplexityNoticeComponent({
  contentRef,
  message,
}: DocumentComplexityNoticeProps) {
  return (
    <article
      ref={contentRef}
      role="alert"
      className="markdown-body max-w-[65ch] mx-auto px-6 py-12"
    >
      <h1>Document {DOCUMENT_COMPLEXITY_REASON}</h1>
      <p>{message}</p>
    </article>
  );
}

export const DocumentComplexityNotice = memo(DocumentComplexityNoticeComponent);
