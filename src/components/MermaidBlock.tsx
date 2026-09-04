import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SourcePositionAttributes } from "../lib/markdown-source-position";

interface MermaidBlockProps {
  chart: string;
  sourcePosition?: SourcePositionAttributes;
}

const MAX_MERMAID_CHARS = 50_000;
export const MERMAID_RENDER_TIMEOUT_MS = 5_000;
const MERMAID_FONT_SIZE = "14px";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

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
  return (
    <div
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

function readThemeToken(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
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
  const bgPrimary = readThemeToken(rootStyles, "--bg-primary", isDark ? "#1A1816" : "#FAFAF8");
  const bgSecondary = readThemeToken(rootStyles, "--bg-secondary", isDark ? "#231F1C" : "#F5F4F2");
  const bgTertiary = readThemeToken(rootStyles, "--bg-tertiary", isDark ? "#2C2724" : "#EDECEB");
  const textPrimary = readThemeToken(rootStyles, "--text-primary", isDark ? "#EEEBE6" : "#1C1917");
  const textSecondary = readThemeToken(rootStyles, "--text-secondary", isDark ? "#A39E98" : "#57534E");
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
  const idRef = useRef(`mermaid-${++mermaidCounter}`);

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

        // Size guard — reject before rendering
        if (chart.length > MAX_MERMAID_CHARS) {
          throw new Error(`Diagram too large (${chart.length} chars, max ${MAX_MERMAID_CHARS})`);
        }

        // Timeout guard — stop waiting if Mermaid hangs.
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
      <div className="mermaid-error" {...sourcePosition}>
        <span className="mermaid-error-label">Diagram error</span>
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
