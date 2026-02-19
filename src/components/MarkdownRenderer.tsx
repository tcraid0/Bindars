import React, { memo, useMemo, useState, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import { remarkPlugins, rehypePlugins } from "../lib/markdown-plugins";
import { convertFileSrc } from "@tauri-apps/api/core";
import { homeDir, tempDir } from "@tauri-apps/api/path";
import {
  isPathAllowedByAssetScope,
  resolveImagePath,
  resolveMarkdownLink,
  type AssetScopeRoots,
} from "../lib/paths";
import { extractFrontmatter, formatFrontmatterDate } from "../lib/frontmatter";
import { extractCodeText } from "../lib/code-text";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { useToast } from "./ToastProvider";
import { openUrl } from "@tauri-apps/plugin-opener";
import { resolveFontCss, resolveParagraphSpacingCss } from "../lib/reader-settings";
import type { ReaderSettings } from "../types";
import type { Components } from "react-markdown";

interface MarkdownRendererProps {
  content: string;
  filePath: string;
  settings: ReaderSettings;
  contentRef: React.RefObject<HTMLElement | null>;
  onNavigateToFile?: (path: string, anchor: string | null) => void;
}

/* ------------------------------------------------------------------ */
/*  MarkdownImage — self-contained error state per image               */
/* ------------------------------------------------------------------ */

function MarkdownImage({
  src,
  alt,
  filePath,
  assetScopeRoots,
  assetScopeResolved,
  ...props
}: {
  src?: string;
  alt?: string;
  filePath: string;
  assetScopeRoots: AssetScopeRoots;
  assetScopeResolved: boolean;
  [key: string]: unknown;
}) {
  const [failed, setFailed] = useState(false);

  if (!src) return <span className="text-text-muted">[missing image]</span>;

  const resolvedPath = resolveImagePath(src, filePath);
  if (!resolvedPath) {
    return (
      <span className="inline-block px-3 py-2 bg-bg-tertiary rounded text-sm text-text-muted">
        [image blocked: {alt || src}]
      </span>
    );
  }

  const blockedByScope =
    assetScopeResolved &&
    !isPathAllowedByAssetScope(resolvedPath, assetScopeRoots);
  if (blockedByScope) {
    return (
      <span className="inline-block px-3 py-2 bg-bg-tertiary rounded text-sm text-text-muted">
        [image blocked by app scope: {alt || src}]
      </span>
    );
  }

  const resolved = convertFileSrc(resolvedPath);
  if (failed) {
    return (
      <span className="inline-block px-3 py-2 bg-bg-tertiary rounded text-sm text-text-muted">
        [image not found or unreadable: {alt || src}]
      </span>
    );
  }

  return (
    <img
      {...props}
      src={resolved}
      alt={alt || ""}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  MarkdownContent — memoized expensive rendering                     */
/* ------------------------------------------------------------------ */

interface MarkdownContentProps {
  content: string;
  filePath: string;
  onNavigateToFile?: (path: string, anchor: string | null) => void;
}

const MarkdownContent = memo(function MarkdownContent({
  content,
  filePath,
  onNavigateToFile,
}: MarkdownContentProps) {
  const { toast } = useToast();
  const [assetScopeRoots, setAssetScopeRoots] = useState<AssetScopeRoots>({
    homePath: null,
    tempPath: null,
  });
  const [assetScopeResolved, setAssetScopeResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [homePath, tempPath] = await Promise.all([
        homeDir().catch(() => null),
        tempDir().catch(() => null),
      ]);

      if (cancelled) {
        return;
      }

      setAssetScopeRoots({ homePath, tempPath });
      setAssetScopeResolved(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCodeCopyError = useCallback((message: string) => {
    toast(message, "error");
  }, [toast]);

  // Extract frontmatter before rendering
  const { frontmatter, body } = useMemo(() => extractFrontmatter(content), [content]);

  const components: Components = useMemo(
    () => ({
      img: ({ src, alt, ...props }) => (
        <MarkdownImage
          src={src}
          alt={alt}
          filePath={filePath}
          assetScopeRoots={assetScopeRoots}
          assetScopeResolved={assetScopeResolved}
          {...props}
        />
      ),
      a: ({ href, children, ...props }) => {
        const isFragment = Boolean(href?.startsWith("#"));
        const isExternal = Boolean(href && /^https?:\/\//i.test(href));
        const isMailto = Boolean(href && /^mailto:/i.test(href));

        const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (!href) return;

          if (isFragment) {
            e.preventDefault();
            const targetId = href.slice(1);
            const el = document.getElementById(targetId);
            if (el) {
              el.scrollIntoView({ behavior: "auto" });
            } else {
              toast(`Heading "${targetId}" not found in this document`, "error");
            }
            return;
          }

          e.preventDefault();
          if (isExternal || isMailto) {
            void openUrl(href).catch(() => {
              // No-op: if system opener fails, keep app stable.
            });
            return;
          }

          // Try resolving as a relative .md link
          if (onNavigateToFile) {
            const resolved = resolveMarkdownLink(href, filePath);
            if (resolved) {
              onNavigateToFile(resolved.path, resolved.anchor);
              return;
            }
          }

          toast(`Cannot open "${href}" — only .md and .markdown links are supported`, "error");
        };

        return (
          <a {...props} href={href} onClick={handleClick}>
            {children}
          </a>
        );
      },
      pre: ({ children }) => {
        const codeChild = React.Children.toArray(children).find(
          (child): child is React.ReactElement<{
            className?: string;
            children?: React.ReactNode;
            node?: { tagName?: string };
          }> => {
            if (!React.isValidElement<{
              className?: string;
              children?: React.ReactNode;
              node?: { tagName?: string };
            }>(child)) {
              return false;
            }

            if (child.type === "code") {
              return true;
            }

            return child.props.node?.tagName === "code";
          },
        );
        if (!codeChild) {
          return <pre>{children}</pre>;
        }

        const className = codeChild.props.className;
        const codeChildren = codeChild.props.children;
        const match = /language-([^\s]+)/.exec(className || "");
        const language = match ? match[1] : undefined;
        const rawCode = extractCodeText(codeChildren).replace(/\n$/, "");

        // Mermaid diagrams: render as diagram instead of a fenced code block.
        if (language === "mermaid") {
          return <MermaidBlock chart={rawCode} />;
        }

        return (
          <CodeBlock
            language={language}
            className={className}
            rawText={rawCode}
            onCopyError={handleCodeCopyError}
          >
            {codeChildren}
          </CodeBlock>
        );
      },

      table: ({ children, ...props }) => (
        <div style={{ overflowX: "auto" }}>
          <table {...props}>{children}</table>
        </div>
      ),

      code: ({ className, children }) => {
        // Inline code and any code that is not wrapped in <pre>.
        return (
          <code className={className}>
            {children}
          </code>
        );
      },
    }),
    [filePath, onNavigateToFile, assetScopeRoots, assetScopeResolved, handleCodeCopyError],
  );

  return (
    <>
      {frontmatter && <FrontmatterHeader frontmatter={frontmatter} />}
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {body}
      </Markdown>
    </>
  );
});

/* ------------------------------------------------------------------ */
/*  MarkdownRenderer — thin style shell                                */
/* ------------------------------------------------------------------ */

function MarkdownRendererComponent({ content, filePath, settings, contentRef, onNavigateToFile }: MarkdownRendererProps) {
  return (
    <article
      ref={contentRef}
      className="markdown-body file-content-enter"
      style={{
        maxWidth: `${settings.contentWidth}ch`,
        fontSize: `${settings.fontSize}px`,
        lineHeight: settings.lineHeight,
        fontFamily: resolveFontCss(settings.fontFamily),
        "--paragraph-spacing": resolveParagraphSpacingCss(settings.paragraphSpacing),
        margin: "0 auto",
        padding: "48px 24px 80px",
      } as React.CSSProperties}
    >
      <MarkdownContent
        content={content}
        filePath={filePath}
        onNavigateToFile={onNavigateToFile}
      />
    </article>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererComponent);

function FrontmatterHeader({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const title = typeof frontmatter.title === "string" ? frontmatter.title : null;
  const author = typeof frontmatter.author === "string" ? frontmatter.author : null;
  const date = typeof frontmatter.date === "string" ? frontmatter.date : null;
  const description = typeof frontmatter.description === "string"
    ? frontmatter.description
    : typeof frontmatter.subtitle === "string"
      ? frontmatter.subtitle
      : null;
  const tags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : null;

  // Don't render if there's nothing meaningful to show
  if (!title && !author && !date && !description && (!tags || tags.length === 0)) return null;

  return (
    <header className="frontmatter-header">
      {title && <h1 className="frontmatter-title">{title}</h1>}
      {(author || date) && (
        <div className="frontmatter-meta">
          {author && <span className="frontmatter-author">{author}</span>}
          {author && date && <span className="frontmatter-separator">&middot;</span>}
          {date && <time className="frontmatter-date">{formatFrontmatterDate(date)}</time>}
        </div>
      )}
      {description && <p className="frontmatter-description">{description}</p>}
      {tags && tags.length > 0 && (
        <div className="frontmatter-tags">
          {tags.map((tag, i) => (
            <span key={`${tag}-${i}`} className="frontmatter-tag">{tag}</span>
          ))}
        </div>
      )}
    </header>
  );
}
