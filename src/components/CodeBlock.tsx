import { memo, useState, useCallback, useRef, useEffect, type ReactNode } from "react";

interface CodeBlockProps {
  children: ReactNode;
  rawText: string;
  language?: string;
  className?: string;
  onCopyError?: (message: string) => void;
}

function fallbackCopy(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export const CodeBlock = memo(function CodeBlock({ children, rawText, language, className, onCopyError }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(() => {
    const markCopied = () => {
      setCopied(true);
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
      resetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimeoutRef.current = null;
      }, 2000);
    };

    const writeText = async () => {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(rawText);
        return;
      }

      if (!fallbackCopy(rawText)) {
        throw new Error("Clipboard API unavailable");
      }
    };

    void writeText()
      .then(markCopied)
      .catch(() => {
        setCopied(false);
        onCopyError?.("Copy failed. Clipboard access was blocked.");
      });
  }, [rawText, onCopyError]);

  return (
    <div className="code-block-wrapper">
      <div className={`code-block-toolbar ${language ? "has-language" : ""}`}>
        {language && (
          <span className="code-lang-chip ui-chip-label select-none">
            {language}
          </span>
        )}

        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code to clipboard"
          className="code-copy-button"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      <pre>
        <code className={["block code-block-content", className].filter(Boolean).join(" ")}>
          {children}
        </code>
      </pre>
    </div>
  );
});
