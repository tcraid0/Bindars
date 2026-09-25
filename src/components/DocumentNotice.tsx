import { memo } from "react";

interface DocumentNoticeProps {
  contentRef: React.RefObject<HTMLElement | null>;
  title: string;
  message: string;
}

function DocumentNoticeComponent({
  contentRef,
  title,
  message,
}: DocumentNoticeProps) {
  return (
    <article
      ref={contentRef}
      role="alert"
      className="markdown-body max-w-[65ch] mx-auto px-6 py-12"
    >
      <h1>{title}</h1>
      <p>{message}</p>
    </article>
  );
}

export const DocumentNotice = memo(DocumentNoticeComponent);
