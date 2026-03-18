import { memo, useRef, useCallback } from "react";
import type { ReaderSettings, FontFamily, ParagraphSpacing, PrintLayout, Theme } from "../types";

const FONT_OPTIONS: { value: FontFamily; label: string; style: string }[] = [
  { value: "newsreader", label: "Newsreader", style: "'Newsreader Variable', Georgia, serif" },
  { value: "source-sans-3", label: "Source Sans", style: "'Source Sans 3 Variable', system-ui, sans-serif" },
  { value: "dm-sans", label: "DM Sans", style: "'DM Sans Variable', system-ui, sans-serif" },
  { value: "roboto-slab", label: "Roboto Slab", style: "'Roboto Slab Variable', Georgia, serif" },
  { value: "atkinson", label: "Atkinson", style: "'Atkinson Hyperlegible Next Variable', system-ui, sans-serif" },
  { value: "opendyslexic", label: "OpenDyslexic", style: "'OpenDyslexic', system-ui, sans-serif" },
];

const SPACING_OPTIONS: { value: ParagraphSpacing; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "spacious", label: "Spacious" },
];

const PRINT_LAYOUT_OPTIONS: { value: PrintLayout; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "book", label: "Book" },
];

const THEME_SWATCHES: { value: Theme; label: string; bg: string; border: string; checkDark: boolean }[] = [
  { value: "light",     label: "Light",    bg: "#FAFAF8", border: "#E8E7E6", checkDark: true },
  { value: "sepia",     label: "Sepia",    bg: "#F3EACE", border: "#D9CEBC", checkDark: true },
  { value: "dark",      label: "Dark",     bg: "#1A1816", border: "#352F2B", checkDark: false },
  { value: "deep-dark", label: "Midnight", bg: "#0C0A09", border: "#292524", checkDark: false },
];

interface ReaderControlsProps {
  visible: boolean;
  settings: ReaderSettings;
  theme: Theme;
  fileType?: "markdown" | "fountain";
  onSetTheme: (theme: Theme) => void;
  onUpdate: (updates: Partial<ReaderSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

function ReaderControlsComponent({ visible, settings, theme, fileType, onSetTheme, onUpdate, onReset, onClose }: ReaderControlsProps) {
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleSwatchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = THEME_SWATCHES.findIndex((s) => s.value === theme);
      let next = idx;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        next = (idx + 1) % THEME_SWATCHES.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        next = (idx - 1 + THEME_SWATCHES.length) % THEME_SWATCHES.length;
      } else {
        return;
      }
      onSetTheme(THEME_SWATCHES[next].value);
      swatchRefs.current[next]?.focus();
    },
    [theme, onSetTheme],
  );

  if (!visible) return null;

  return (
    <div
      className="print-hide absolute right-4 z-50 w-[272px] bg-bg-secondary border border-border rounded-xl shadow-lg p-4 mt-2"
      style={{
        top: "var(--header-height, 52px)",
        animation: "fadeIn 150ms ease",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-text-primary">Reader Settings</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reader settings"
          className="p-1 rounded hover:bg-bg-tertiary text-text-muted"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Font size */}
      <ControlRow
        label="Font size"
        value={`${settings.fontSize}px`}
        onDecrease={() => onUpdate({ fontSize: settings.fontSize - 1 })}
        onIncrease={() => onUpdate({ fontSize: settings.fontSize + 1 })}
      />

      {/* Content width */}
      <ControlRow
        label="Width"
        value={`${settings.contentWidth}ch`}
        onDecrease={() => onUpdate({ contentWidth: settings.contentWidth - 5 })}
        onIncrease={() => onUpdate({ contentWidth: settings.contentWidth + 5 })}
      />

      {/* Line height */}
      <ControlRow
        label="Line height"
        value={settings.lineHeight.toFixed(1)}
        onDecrease={() => onUpdate({ lineHeight: settings.lineHeight - 0.1 })}
        onIncrease={() => onUpdate({ lineHeight: settings.lineHeight + 0.1 })}
      />

      {/* Font family */}
      <div className="mt-3 pt-3 border-t border-border">
        <span className="text-xs text-text-secondary block mb-1.5">Font</span>
        <div className="grid grid-cols-2 gap-1">
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onUpdate({ fontFamily: opt.value })}
              className={`px-2 py-1.5 text-[11px] rounded-md transition-colors duration-120 text-left leading-tight ${
                settings.fontFamily === opt.value
                  ? "bg-accent text-white font-medium"
                  : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
              }`}
              style={{ fontFamily: opt.style }}
              title={opt.label}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Paragraph spacing */}
      <div className="mt-3 pt-3 border-t border-border">
        <span className="text-xs text-text-secondary block mb-1.5">Paragraph spacing</span>
        <div className="flex gap-1">
          {SPACING_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onUpdate({ paragraphSpacing: opt.value })}
              className={`flex-1 px-2 py-1.5 text-[11px] rounded-md transition-colors duration-120 ${
                settings.paragraphSpacing === opt.value
                  ? "bg-accent text-white font-medium"
                  : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {fileType !== "fountain" && (
        <div className="mt-3 pt-3 border-t border-border">
          <span className="text-xs text-text-secondary block mb-1.5">Print layout</span>
          <div className="flex gap-1">
            {PRINT_LAYOUT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onUpdate({ printLayout: opt.value })}
                className={`flex-1 px-2 py-1.5 text-[11px] rounded-md transition-colors duration-120 ${
                  settings.printLayout === opt.value
                    ? "bg-accent text-white font-medium"
                    : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-border space-y-2">
        <ToggleRow
          label="Scene lens"
          checked={settings.sceneLensEnabled}
          onToggle={() => onUpdate({ sceneLensEnabled: !settings.sceneLensEnabled })}
        />
        <ToggleRow
          label="Reduced effects"
          checked={settings.reducedEffects}
          onToggle={() => onUpdate({ reducedEffects: !settings.reducedEffects })}
        />
        {fileType !== "fountain" && (
          <ToggleRow
            label="Print with theme"
            checked={settings.printWithTheme}
            onToggle={() => onUpdate({ printWithTheme: !settings.printWithTheme })}
          />
        )}
      </div>

      {/* Theme swatches */}
      <div className="mt-3 pt-3 border-t border-border">
        <span className="text-xs text-text-secondary block mb-2">Theme</span>
        <div
          className="flex items-center justify-center gap-3"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_SWATCHES.map((swatch, i) => {
            const selected = theme === swatch.value;
            return (
              <button
                key={swatch.value}
                ref={(el) => { swatchRefs.current[i] = el; }}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${swatch.label} theme`}
                title={swatch.label}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSetTheme(swatch.value)}
                onKeyDown={handleSwatchKeyDown}
                className="w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent cursor-pointer"
                style={{
                  backgroundColor: swatch.bg,
                  borderColor: swatch.border,
                  boxShadow: selected ? "0 0 0 2px var(--color-accent)" : "none",
                }}
              >
                {selected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={swatch.checkDark ? "#1C1917" : "#E7E5E4"}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="w-full mt-3 py-1.5 text-xs text-text-muted hover:text-text-primary hover:bg-bg-tertiary rounded-md transition-colors duration-120"
      >
        Reset to defaults
      </button>
    </div>
  );
}

export const ReaderControls = memo(ReaderControlsComponent);

function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-xs text-text-secondary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-150 ${
          checked ? "bg-accent" : "bg-bg-tertiary"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg-primary transition-transform duration-150 ${
            checked ? "translate-x-5" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
}

function ControlRow({
  label,
  value,
  onDecrease,
  onIncrease,
}: {
  label: string;
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDecrease}
          aria-label={`Decrease ${label.toLowerCase()}`}
          className="w-6 h-6 flex items-center justify-center rounded bg-bg-tertiary text-text-secondary hover:text-text-primary text-sm font-medium transition-colors duration-120"
        >
          -
        </button>
        <span className="text-xs text-text-primary w-10 text-center font-mono">{value}</span>
        <button
          type="button"
          onClick={onIncrease}
          aria-label={`Increase ${label.toLowerCase()}`}
          className="w-6 h-6 flex items-center justify-center rounded bg-bg-tertiary text-text-secondary hover:text-text-primary text-sm font-medium transition-colors duration-120"
        >
          +
        </button>
      </div>
    </div>
  );
}
