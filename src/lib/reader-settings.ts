import type { CSSProperties } from "react";
import type { FontFamily, ParagraphSpacing, PrintLayout, ReaderSettings } from "../types";

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

export const VALID_PRINT_LAYOUTS: readonly PrintLayout[] = [
  "standard",
  "book",
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

export function isPrintLayout(value: unknown): value is PrintLayout {
  return (
    typeof value === "string" &&
    (VALID_PRINT_LAYOUTS as readonly string[]).includes(value)
  );
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
