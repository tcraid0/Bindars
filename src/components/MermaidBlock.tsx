import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SourcePositionAttributes } from "../lib/markdown-source-position";
import { createMathBudget } from "../lib/math-safety";

interface MermaidBlockProps {
  chart: string;
  sourcePosition?: SourcePositionAttributes;
}

const MAX_MERMAID_CHARS = 50_000;
export const MERMAID_RENDER_TIMEOUT_MS = 5_000;
const MERMAID_FONT_SIZE = "14px";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
/** Mermaid's own `katexRegex`: each `$$…$$` pair on a line goes to KaTeX. */
const DIAGRAM_MATH_RE = /\$\$(.*?)\$\$/g;
/** A dollar sign written as a Mermaid entity code or an HTML character reference. */
const CODED_DOLLAR_RE = /#0*36;|#x0*24;|&#0*36|&#x0*24|&dollar/i;
/** A dollar sign against a tag or comment; removing what follows can join two into `$$`. */
const DOLLAR_AT_TAG_RE = /\$<|>\$/;
/**
 * A tag start, a possible character reference (named references are never
 * shorter than two letters, so `\&D` and `a&b` stay legal), or a Mermaid
 * entity code.
 */
const REWRITABLE_RE = /<[a-z!\/?]|&(?:#|[a-z]{2})|#\w+;/i;
export const UNSUPPORTED_DIAGRAM_MATH_MESSAGE =
  "Math in this diagram is too long or uses unsupported commands.";

/**
 * Applies the shared math policy (math-safety.ts) to the math Mermaid would
 * hand its bundled KaTeX, which has no expansion or size limit, before Mermaid
 * is even loaded. On the way from the source to KaTeX, Mermaid decodes its
 * `#…;` entity codes, HTML-sanitizes each label (decoding character
 * references and removing tags, comments and the contents of elements such
 * as script, which can join the text around them), collapses `\\` to `\`,
 * and in markdown-string labels applies Markdown escapes, so `\$` becomes
 * `$`. Rather than predict that output, this refuses the only inputs that
 * can create or alter a `$$…$$` segment on the way, so every remaining
 * segment reaches KaTeX verbatim and can be checked as written. The
 * collapses run on this detection copy only, everywhere rather than inside
 * the label grammar, so they can only make the check stricter. Honest
 * diagrams rarely hit a rule; when one does it shows its source instead.
 */
export function unsupportedDiagramMath(chart: string): string | null {
  const source = chart.replace(/\\\\/g, "\\").replace(/\\\$/g, "$");
  if (CODED_DOLLAR_RE.test(source) || DOLLAR_AT_TAG_RE.test(source)) {
    return UNSUPPORTED_DIAGRAM_MATH_MESSAGE;
  }
  const budget = createMathBudget();
  for (const [, segment] of source.matchAll(DIAGRAM_MATH_RE)) {
    if (REWRITABLE_RE.test(segment) || !budget.accept(segment)) {
      return UNSUPPORTED_DIAGRAM_MATH_MESSAGE;
    }
  }
  return null;
}

let mermaidCounter = 0;
let lastInitializedConfig: string | null = null;
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;

function getMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid");
  return mermaidPromise;
}

function getMermaidLinkHref(anchor: Element): string | null {
  return anchor.getAttribute("href")
    ?? anchor.getAttributeNS(XLINK_NAMESPACE, "href")
    ?? anchor.getAttribute("xlink:href");
}

function handleMermaidLinkClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const anchor = target.closest("a");
  if (!anchor || !event.currentTarget.contains(anchor)) return;

  const href = getMermaidLinkHref(anchor);
  if (!href) return;

  // Mermaid can emit both same-frame anchors and target="_blank" anchors.
  // Cancel either browser behavior before delegating supported external URLs.
  event.preventDefault();
  if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
    void openUrl(href).catch(() => {
      // No-op: if the system opener fails, keep app stable.
    });
  }
}

interface MermaidSvgProps {
  svg: string;
  sourcePosition?: SourcePositionAttributes;
}

export function MermaidSvg({ svg, sourcePosition }: MermaidSvgProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    containerRef.current?.dispatchEvent(new Event("bindars:diagram-rendered", { bubbles: true }));
  }, [svg]);
  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      {...sourcePosition}
      onClickCapture={handleMermaidLinkClick}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export async function waitForDocumentFontsReady(doc: Document = document): Promise<void> {
  const fontSet = "fonts" in doc ? doc.fonts : undefined;
  if (!fontSet?.ready) {
    return;
  }

  try {
    await fontSet.ready;
  } catch {
    // Proceed with fallback metrics if the browser rejects font readiness.
  }
}

export function removeMermaidTempElements(id: string, doc: Document = document): void {
  doc.getElementById(`d${id}`)?.remove();
  doc.getElementById(`i${id}`)?.remove();
}

function getCurrentThemeName() {
  return document.documentElement.getAttribute("data-theme") || "light";
}

function parseHexColor(color: string): [number, number, number] | null {
  const match = color.trim().match(/^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i);
  const hex = match?.groups?.hex;
  if (!hex) return null;

  const normalized = hex.length === 3
    ? hex.split("").map((char) => char + char).join("")
    : hex;

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function toHexChannel(value: number) {
  return Math.round(value).toString(16).padStart(2, "0");
}

function mixHexColor(baseColor: string, overlayColor: string, overlayRatio: number) {
  const base = parseHexColor(baseColor);
  const overlay = parseHexColor(overlayColor);
  if (!base || !overlay) return baseColor;

  const clampedRatio = Math.min(Math.max(overlayRatio, 0), 1);
  const mixed = base.map((baseChannel, index) =>
    baseChannel * (1 - clampedRatio) + overlay[index] * clampedRatio
  );

  return `#${mixed.map(toHexChannel).join("")}`;
}

function getMermaidThemeConfig(themeName: string) {
  const rootStyles = getComputedStyle(document.documentElement);
  const isDark = themeName === "dark" || themeName === "deep-dark";
  const bgPrimary = rootStyles.getPropertyValue("--bg-primary").trim();
  const bgSecondary = rootStyles.getPropertyValue("--bg-secondary").trim();
  const bgTertiary = rootStyles.getPropertyValue("--bg-tertiary").trim();
  const textPrimary = rootStyles.getPropertyValue("--text-primary").trim();
  const textSecondary = rootStyles.getPropertyValue("--text-secondary").trim();
  const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";

  const themeVariables = {
    darkMode: isDark,
    background: bgSecondary,
    fontFamily,
    fontSize: MERMAID_FONT_SIZE,
    primaryColor: bgTertiary,
    primaryTextColor: textPrimary,
    primaryBorderColor: textSecondary,
    secondaryColor: bgSecondary,
    secondaryTextColor: textPrimary,
    secondaryBorderColor: textSecondary,
    tertiaryColor: bgPrimary,
    tertiaryTextColor: textPrimary,
    tertiaryBorderColor: textSecondary,
    lineColor: textSecondary,
    textColor: textPrimary,
    mainBkg: mixHexColor(bgTertiary, textPrimary, isDark ? 0.08 : 0.04),
    nodeBorder: textSecondary,
    clusterBkg: bgSecondary,
    clusterBorder: textSecondary,
    defaultLinkColor: textSecondary,
    arrowheadColor: textSecondary,
    titleColor: textPrimary,
    edgeLabelBackground: bgSecondary,
    nodeTextColor: textPrimary,
    noteBkgColor: bgPrimary,
    noteTextColor: textPrimary,
    noteBorderColor: textSecondary,
    labelColor: textPrimary,
    actorBkg: bgTertiary,
    actorBorder: textSecondary,
    actorTextColor: textPrimary,
    actorLineColor: textSecondary,
    signalColor: textPrimary,
    signalTextColor: textPrimary,
    labelBoxBkgColor: bgTertiary,
    labelBoxBorderColor: textSecondary,
    labelTextColor: textPrimary,
    loopTextColor: textPrimary,
    activationBorderColor: textSecondary,
    activationBkgColor: bgSecondary,
    sequenceNumberColor: textSecondary,
    classText: textPrimary,
  };

  return {
    configKey: JSON.stringify({ themeName, fontFamily, themeVariables }),
    mermaidConfig: {
      startOnLoad: false,
      theme: "base" as const,
      themeVariables,
      htmlLabels: true,
      flowchart: {
        useMaxWidth: false,
        padding: 14,
      },
      securityLevel: "strict" as const,
      suppressErrorRendering: true,
      fontFamily,
    },
  };
}

export const MermaidBlock = memo(function MermaidBlock({ chart, sourcePosition }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(`mermaid-${++mermaidCounter}`);

  // Error output replaces searchable SVG labels too; consumers must refresh it.
  useEffect(() => {
    errorRef.current?.dispatchEvent(new Event("bindars:diagram-rendered", { bubbles: true }));
  }, [error, chart]);

  // Observe data-theme for Mermaid theme switching.
  const [themeName, setThemeName] = useState(getCurrentThemeName);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeName(getCurrentThemeName());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Reject before any rendering work. The source limit bounds Mermaid's own
    // parsing; the math policy bounds KaTeX, which Mermaid calls synchronously
    // on this thread. Neither can be stopped once started.
    const rejection = chart.length > MAX_MERMAID_CHARS
      ? `Diagram too large (${chart.length} chars, max ${MAX_MERMAID_CHARS})`
      : unsupportedDiagramMath(chart);
    if (rejection) {
      setError(rejection);
      setSvg("");
      return;
    }

    let cancelled = false;

    // Generate a fresh ID per render to avoid mermaid ID collisions
    const id = `${idRef.current}-${Date.now()}`;
    const { configKey, mermaidConfig } = getMermaidThemeConfig(themeName);

    getMermaid()
      .then(async ({ default: mermaid }) => {
        if (cancelled) return;
        await waitForDocumentFontsReady();
        if (cancelled) return;

        if (lastInitializedConfig !== configKey) {
          mermaid.initialize(mermaidConfig);
          lastInitializedConfig = configKey;
        }

        // Timeout: error handling for a render that never settles, not a
        // resource budget. It cannot interrupt work already on this thread.
        const renderPromise = mermaid.render(id, chart);
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Diagram render timed out")),
            MERMAID_RENDER_TIMEOUT_MS,
          );
        });
        try {
          return await Promise.race([renderPromise, timeoutPromise]);
        } finally {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          removeMermaidTempElements(id);
        }
      })
      .then((result) => {
        if (!cancelled && result) {
          setSvg(result.svg);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram");
          setSvg("");
        }
      });

    return () => {
      cancelled = true;
      removeMermaidTempElements(id);
    };
  }, [chart, themeName]);

  if (error) {
    return (
      <div ref={errorRef} className="mermaid-error" {...sourcePosition}>
        <span className="mermaid-error-label">Diagram error</span>
        <p className="mermaid-error-message">{error}</p>
        <pre><code>{chart}</code></pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-diagram mermaid-loading" {...sourcePosition}>
        <span className="text-text-muted text-sm">Rendering diagram...</span>
      </div>
    );
  }

  return <MermaidSvg svg={svg} sourcePosition={sourcePosition} />;
});
