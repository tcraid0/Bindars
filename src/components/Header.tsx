import { memo, useState, useRef, useEffect, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Theme, FileType } from "../types";
import { buildExportHtml } from "../lib/export-html";
import { waitForMermaidDiagrams } from "../lib/print-export";
import { useToast } from "./ToastProvider";

interface HeaderProps {
  fileName: string | null;
  filePath: string | null;
  theme: Theme;
  onCycleTheme: () => void;
  onOpenFile: () => void;
  onToggleSidebar: () => void;
  onToggleToc: () => void;
  onToggleReaderControls: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  isEditing: boolean;
  isDirty: boolean;
  isSavedFlash: boolean;
  onToggleEdit: () => void;
  onSave: () => void;
  statsSummary: string | null;
  progressTextRef: React.RefObject<HTMLSpanElement | null>;
  onToggleAnnotations: () => void;
  hasAnnotations: boolean;
  onPrint: () => void;
  onPresent: () => void;
  fileType: FileType;
}

const themeLabels: Record<Theme, string> = {
  light: "Light",
  sepia: "Sepia",
  dark: "Dark",
  "deep-dark": "Midnight",
};

const EXPORT_CSS_VAR_NAMES = [
  "--bg-primary",
  "--bg-secondary",
  "--bg-tertiary",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--accent",
  "--accent-hover",
  "--border",
  "--code-bg",
];

function HeaderComponent({
  fileName,
  filePath,
  theme,
  onCycleTheme,
  onOpenFile,
  onToggleSidebar,
  onToggleToc,
  onToggleReaderControls,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  isEditing,
  isDirty,
  isSavedFlash,
  onToggleEdit,
  onSave,
  statsSummary,
  progressTextRef,
  onToggleAnnotations,
  hasAnnotations,
  onPrint,
  onPresent,
  fileType,
}: HeaderProps) {
  const { toast } = useToast();
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExportOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [exportOpen]);

  const handlePrint = useCallback(() => {
    setExportOpen(false);
    onPrint();
  }, [onPrint]);

  const handlePresent = useCallback(() => {
    setExportOpen(false);
    onPresent();
  }, [onPresent]);

  const handleOpenExternal = useCallback(async () => {
    if (!filePath) return;
    try {
      await openPath(filePath);
    } catch (err) {
      console.warn("[open-external] Failed to open in external editor:", err);
      toast("Couldn't open external editor", "error");
    }
  }, [filePath, toast]);

  const handleExportHtml = useCallback(async () => {
    setExportOpen(false);
    const el = document.querySelector(".markdown-body, .fountain-body");
    if (!el) return;

    const defaultName = fileName ? fileName.replace(/\.(md|markdown|fountain)$/i, ".html") : "export.html";
    try {
      const savePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!savePath) return;

      await waitForMermaidDiagrams(el);

      const themeAttr = document.documentElement.getAttribute("data-theme") || "light";
      const computedStyles = getComputedStyle(document.documentElement);
      const cssVars = EXPORT_CSS_VAR_NAMES
        .map((name) => `${name}: ${computedStyles.getPropertyValue(name)};`)
        .join("\n      ");

      const bodyHtml = el.outerHTML;
      const hasMath = el.querySelector(".katex") !== null;
      const katexCss = hasMath
        ? (await import("../lib/generated/katex-css-embedded")).katexCssEmbedded
        : null;
      const html = buildExportHtml({
        title: fileName || "Exported Document",
        themeAttr,
        cssVars,
        bodyHtml,
        katexCss,
      });

      await invoke("export_html_file", { path: savePath, content: html });
    } catch (err) {
      console.warn("[export] Failed to export HTML:", err);
      toast("Couldn't export HTML", "error");
    }
  }, [fileName, toast]);

  return (
    <header
      className="print-hide flex items-center px-4 border-b border-border bg-bg-secondary shrink-0 select-none"
      style={{ height: "var(--header-height, 52px)" }}
      data-tauri-drag-region
    >
      {/* Left: sidebar toggle, back/forward, wordmark */}
      <div className="flex items-center gap-1 min-w-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
          className="p-1.5 rounded-md hover:bg-bg-tertiary text-text-secondary transition-colors duration-120"
          title="Toggle sidebar (Ctrl+B)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onGoBack}
          disabled={!canGoBack}
          aria-label="Go back"
          className="p-1.5 rounded-md hover:bg-bg-tertiary text-text-secondary transition-colors duration-120 disabled:opacity-30 disabled:pointer-events-none"
          title="Go back (Alt+Left)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onGoForward}
          disabled={!canGoForward}
          aria-label="Go forward"
          className="p-1.5 rounded-md hover:bg-bg-tertiary text-text-secondary transition-colors duration-120 disabled:opacity-30 disabled:pointer-events-none"
          title="Go forward (Alt+Right)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
        <span className="font-ui font-semibold text-[15px] text-text-primary tracking-tight ml-2">
          Bindars
        </span>
      </div>

      {/* Center: file name + edit toggle */}
      <div className="flex-1 flex items-center justify-center gap-1.5 px-4 min-w-0" data-tauri-drag-region>
        {fileName && (
          <>
            {isDirty && (
              <span className="text-accent text-sm shrink-0" aria-label="Unsaved changes">●</span>
            )}
            {isSavedFlash && (
              <span
              className="text-sm text-accent shrink-0"
              style={{ animation: "fadeOut 1.5s ease forwards" }}
            >Saved</span>
            )}
            <span className="text-sm text-text-muted truncate max-w-[400px]">
              {fileName}
            </span>
            {statsSummary && !isEditing && (
              <span className="text-[11px] text-text-muted shrink-0 hidden sm:inline">
                <span ref={progressTextRef} className="inline-block min-w-[2.5ch] text-right">0%</span>
                {" · "}
                {statsSummary}
              </span>
            )}
            <button
              type="button"
              onClick={onToggleEdit}
              aria-label={isEditing ? "Switch to read mode" : "Switch to edit mode"}
              className="p-1 rounded-md hover:bg-bg-tertiary text-text-muted transition-colors duration-120 shrink-0"
              title={isEditing ? "Read mode (Ctrl+E)" : "Edit mode (Ctrl+E)"}
            >
              {isEditing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              )}
            </button>
            {!isEditing && filePath && (
              <button
                type="button"
                onClick={handleOpenExternal}
                aria-label="Open in external editor"
                className="p-1 rounded-md hover:bg-bg-tertiary text-text-muted transition-colors duration-120 shrink-0"
                title="Open in external editor"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      {/* Right: controls */}
      <div className="flex items-center gap-1">
        {isEditing && isDirty && (
          <button
            type="button"
            onClick={onSave}
            className="px-2.5 py-1.5 rounded-md text-sm font-medium text-accent hover:bg-bg-tertiary transition-colors duration-120"
            title="Save (Ctrl+S)"
          >
            Save
          </button>
        )}
        <button
          type="button"
          onClick={onOpenFile}
          className="px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
          title="Open file (Ctrl+O)"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onToggleReaderControls}
          aria-label="Toggle reader settings"
          className="p-1.5 rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
          title="Reader settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7V4h16v3" />
            <path d="M9 20h6" />
            <path d="M12 4v16" />
          </svg>
        </button>
        {!isEditing && (
          <>
            {/* Export dropdown */}
            {fileName && (
              <div ref={exportRef} className="relative">
                <button
                  type="button"
                  onClick={() => setExportOpen((v) => !v)}
                  aria-label="Export options"
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                  aria-controls="export-menu"
                  className={`p-1.5 rounded-md hover:bg-bg-tertiary transition-colors duration-120 ${
                    exportOpen ? "text-accent" : "text-text-secondary hover:text-text-primary"
                  }`}
                  title="Export (Ctrl+P)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 6 2 18 2 18 9" />
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                    <rect x="6" y="14" width="12" height="8" />
                  </svg>
                </button>
                {exportOpen && (
                  <div
                    id="export-menu"
                    role="menu"
                    className="absolute right-0 mt-1 w-[220px] bg-bg-secondary border border-border rounded-lg shadow-lg py-1 z-50"
                    style={{ animation: "fadeIn 100ms ease" }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handlePrint}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary transition-colors duration-120 flex items-center gap-2"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 6 2 18 2 18 9" />
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                        <rect x="6" y="14" width="12" height="8" />
                      </svg>
                      Print to PDF
                      <kbd className="ml-auto text-[10px] text-text-muted font-mono">Ctrl+P</kbd>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleExportHtml}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary transition-colors duration-120 flex items-center gap-2"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                        <polyline points="13 2 13 9 20 9" />
                      </svg>
                      Export as HTML
                    </button>
                    {fileType !== "fountain" && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={handlePresent}
                        className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary transition-colors duration-120 flex items-center gap-2"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="14" rx="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                        Present as Slides
                        <kbd className="ml-auto text-[10px] text-text-muted font-mono">F5</kbd>
                      </button>
                    )}
                    <div className="border-t border-border mt-1 pt-1 px-3 py-1.5">
                      <p className="text-[11px] text-text-muted leading-tight">
                        Tip: Uncheck "Headers and footers" in the print dialog for clean output.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={onToggleAnnotations}
              aria-label="Toggle annotations panel"
              className={`p-1.5 rounded-md hover:bg-bg-tertiary transition-colors duration-120 ${
                hasAnnotations ? "text-accent" : "text-text-secondary hover:text-text-primary"
              }`}
              title="Annotations (Ctrl+M)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onToggleToc}
              aria-label="Toggle table of contents"
              className="p-1.5 rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
              title="Toggle table of contents (Ctrl+J)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onCycleTheme}
          aria-label={`Switch theme (current: ${themeLabels[theme]})`}
          className="px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-120"
          title={`Theme: ${themeLabels[theme]} (Ctrl+Shift+T)`}
        >
          {theme === "light" ? (
            /* Sun — full sun with rays */
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : theme === "sepia" ? (
            /* Sunset — sun half-below horizon */
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 18a5 5 0 0 0-10 0" />
              <line x1="12" y1="9" x2="12" y2="3" />
              <line x1="4.22" y1="10.22" x2="5.64" y2="11.64" />
              <line x1="1" y1="18" x2="3" y2="18" />
              <line x1="21" y1="18" x2="23" y2="18" />
              <line x1="18.36" y1="11.64" x2="19.78" y2="10.22" />
              <line x1="23" y1="22" x2="1" y2="22" />
            </svg>
          ) : theme === "dark" ? (
            /* Moon — crescent */
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            /* Stars — deep night sky */
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l1.09 3.26L16 6l-2.91.74L12 10l-1.09-3.26L8 6l2.91-.74L12 2z" />
              <path d="M5 13l.72 2.17L8 16l-2.28.83L5 19l-.72-2.17L2 16l2.28-.83L5 13z" />
              <path d="M19 14l.6 1.8L21.4 16.6l-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}

export const Header = memo(HeaderComponent);
