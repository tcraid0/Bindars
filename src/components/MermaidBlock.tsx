import { memo, useEffect, useRef, useState } from "react";

interface MermaidBlockProps {
  chart: string;
}

const MAX_MERMAID_CHARS = 50_000;
const MERMAID_RENDER_TIMEOUT_MS = 5_000;

let mermaidCounter = 0;
let lastInitializedConfig: string | null = null;
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;

function getMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid");
  return mermaidPromise;
}

function getCurrentThemeName() {
  return document.documentElement.getAttribute("data-theme") || "light";
}

function readThemeToken(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
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
    mainBkg: bgTertiary,
    nodeBorder: textSecondary,
    clusterBkg: bgSecondary,
    clusterBorder: textSecondary,
    defaultLinkColor: textSecondary,
    titleColor: textPrimary,
    edgeLabelBackground: bgPrimary,
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
      flowchart: {
        useMaxWidth: false,
        htmlLabels: false,
        padding: 10,
      },
      securityLevel: "strict" as const,
      fontFamily,
    },
  };
}

export const MermaidBlock = memo(function MermaidBlock({ chart }: MermaidBlockProps) {
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
      .then(({ default: mermaid }) => {
        if (cancelled) return;

        if (lastInitializedConfig !== configKey) {
          mermaid.initialize(mermaidConfig);
          lastInitializedConfig = configKey;
        }

        // Size guard — reject before rendering
        if (chart.length > MAX_MERMAID_CHARS) {
          throw new Error(`Diagram too large (${chart.length} chars, max ${MAX_MERMAID_CHARS})`);
        }

        // Timeout guard — abort if render hangs
        const renderPromise = mermaid.render(id, chart);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Diagram render timed out")), MERMAID_RENDER_TIMEOUT_MS)
        );
        return Promise.race([renderPromise, timeoutPromise]);
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
    };
  }, [chart, themeName]);

  if (error) {
    return (
      <div className="mermaid-error">
        <span className="mermaid-error-label">Diagram error</span>
        <pre><code>{chart}</code></pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-diagram mermaid-loading">
        <span className="text-text-muted text-sm">Rendering diagram...</span>
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
