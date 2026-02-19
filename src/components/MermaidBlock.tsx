import { memo, useEffect, useRef, useState } from "react";

interface MermaidBlockProps {
  chart: string;
}

const MAX_MERMAID_CHARS = 50_000;
const MERMAID_RENDER_TIMEOUT_MS = 5_000;

let mermaidCounter = 0;
let lastInitializedTheme: string | null = null;
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;

function getMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid");
  return mermaidPromise;
}

export const MermaidBlock = memo(function MermaidBlock({ chart }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${++mermaidCounter}`);

  // Observe data-theme for dark/light mermaid theme switching
  const [isDark, setIsDark] = useState(() => {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "dark" || t === "deep-dark";
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const t = document.documentElement.getAttribute("data-theme");
      setIsDark(t === "dark" || t === "deep-dark");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Generate a fresh ID per render to avoid mermaid ID collisions
    const id = `${idRef.current}-${Date.now()}`;
    const mermaidTheme = isDark ? "dark" : "default";

    getMermaid()
      .then(({ default: mermaid }) => {
        if (cancelled) return;

        if (lastInitializedTheme !== mermaidTheme) {
          mermaid.initialize({
            startOnLoad: false,
            theme: mermaidTheme,
            securityLevel: "strict",
            fontFamily: "var(--font-ui)",
          });
          lastInitializedTheme = mermaidTheme;
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
  }, [chart, isDark]);

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
