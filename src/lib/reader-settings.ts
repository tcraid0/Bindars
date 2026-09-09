import type { CSSProperties } from "react";
import type { FontFamily, ParagraphSpacing, ReaderSettings } from "../types";

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 17,
  contentWidth: 65,
  lineHeight: 1.7,
  fontFamily: "newsreader",
  paragraphSpacing: "comfortable",
  sceneLensEnabled: false,
  reducedEffects: false,
};

export const READER_SETTINGS_LIMITS = {
  fontSize: { min: 14, max: 24 },
  contentWidth: { min: 50, max: 80 },
  lineHeight: { min: 1.4, max: 2.0 },
} as const;

type ReaderSurfaceStyle = Pick<
  CSSProperties,
  "maxWidth" | "fontSize" | "lineHeight" | "fontFamily" | "margin" | "padding"
>;

export const VALID_FONTS: readonly FontFamily[] = [
  "newsreader",
  "source-sans-3",
  "dm-sans",
  "roboto-slab",
  "atkinson",
  "opendyslexic",
];

export const VALID_SPACINGS: readonly ParagraphSpacing[] = [
  "compact",
  "comfortable",
  "spacious",
];

export const FONT_CSS_MAP: Record<FontFamily, string> = {
  newsreader: "var(--font-reading-newsreader)",
  "source-sans-3": "var(--font-reading-source-sans-3)",
  "dm-sans": "var(--font-reading-dm-sans)",
  "roboto-slab": "var(--font-reading-roboto-slab)",
  atkinson: "var(--font-reading-atkinson)",
  opendyslexic: "var(--font-reading-opendyslexic)",
};

export const PARAGRAPH_SPACING_MAP: Record<ParagraphSpacing, string> = {
  compact: "0.6em",
  comfortable: "1.25em",
  spacious: "1.5em",
};

export function isFontFamily(value: unknown): value is FontFamily {
  return (
    typeof value === "string" &&
    (VALID_FONTS as readonly string[]).includes(value)
  );
}

export function isParagraphSpacing(value: unknown): value is ParagraphSpacing {
  return (
    typeof value === "string" &&
    (VALID_SPACINGS as readonly string[]).includes(value)
  );
}

// Null means this source has no usable settings, so a backup may be tried.
// Updates use current settings as the fallback instead of hydration defaults.
export function normalizeReaderSettings(
  value: unknown,
  fallback: ReaderSettings = DEFAULT_READER_SETTINGS,
): ReaderSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const valid: Partial<ReaderSettings> = {};
  if (typeof record.fontSize === "number" && Number.isFinite(record.fontSize)) {
    valid.fontSize = clamp(record.fontSize, READER_SETTINGS_LIMITS.fontSize.min, READER_SETTINGS_LIMITS.fontSize.max);
  }
  if (typeof record.contentWidth === "number" && Number.isFinite(record.contentWidth)) {
    valid.contentWidth = clamp(record.contentWidth, READER_SETTINGS_LIMITS.contentWidth.min, READER_SETTINGS_LIMITS.contentWidth.max);
  }
  if (typeof record.lineHeight === "number" && Number.isFinite(record.lineHeight)) {
    valid.lineHeight = clamp(
      Math.round(record.lineHeight * 10) / 10,
      READER_SETTINGS_LIMITS.lineHeight.min,
      READER_SETTINGS_LIMITS.lineHeight.max,
    );
  }
  if (isFontFamily(record.fontFamily)) valid.fontFamily = record.fontFamily;
  if (isParagraphSpacing(record.paragraphSpacing)) valid.paragraphSpacing = record.paragraphSpacing;
  if (typeof record.sceneLensEnabled === "boolean") valid.sceneLensEnabled = record.sceneLensEnabled;
  if (typeof record.reducedEffects === "boolean") valid.reducedEffects = record.reducedEffects;
  return Object.keys(valid).length > 0 ? { ...fallback, ...valid } : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveFontCss(value: unknown): string {
  return isFontFamily(value)
    ? FONT_CSS_MAP[value]
    : FONT_CSS_MAP.newsreader;
}

export function resolveReaderSurfaceStyle(
  settings: Pick<ReaderSettings, "contentWidth" | "fontSize" | "lineHeight" | "fontFamily">,
): ReaderSurfaceStyle {
  return {
    maxWidth: `${settings.contentWidth}ch`,
    fontSize: `${settings.fontSize}px`,
    lineHeight: settings.lineHeight,
    fontFamily: resolveFontCss(settings.fontFamily),
    margin: "0 auto",
    padding: "48px 24px 80px",
  };
}

export function resolveParagraphSpacingCss(value: unknown): string {
  return isParagraphSpacing(value)
    ? PARAGRAPH_SPACING_MAP[value]
    : PARAGRAPH_SPACING_MAP.comfortable;
}
