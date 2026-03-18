import { invoke } from "@tauri-apps/api/core";

const IMG_SRC_RE = /(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/gi;
// Keep embedded image payload below the backend HTML export size cap.
const DEFAULT_MAX_EMBEDDED_BASE64_BYTES = 20 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

export interface EmbedImagesResult {
  html: string;
  embeddedCount: number;
  failedCount: number;
}

interface EmbedImagesOptions {
  readImageAsBase64?: (path: string) => Promise<string>;
  maxEmbeddedBase64Bytes?: number;
}

export function assetUrlToPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const isAssetProtocol = parsed.protocol === "asset:" && parsed.hostname === "localhost";
  const isAssetHost =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hostname === "asset.localhost";

  if (!isAssetProtocol && !isAssetHost) {
    return null;
  }

  const decodedPath = decodeURIComponent(parsed.pathname);
  if (!decodedPath) {
    return null;
  }

  if (/^\/[A-Za-z]:[\\/]/.test(decodedPath) || /^\/\\\\/.test(decodedPath)) {
    return decodedPath.slice(1);
  }

  if (decodedPath.startsWith("//") && !decodedPath.startsWith("//?/")) {
    return decodedPath.slice(1);
  }

  return decodedPath;
}

export function mimeTypeForPath(path: string): string | null {
  const match = /\.([^.\\/]+)$/.exec(path);
  if (!match) {
    return null;
  }

  return MIME_TYPES[`.${match[1].toLowerCase()}`] ?? null;
}

export async function embedImages(
  html: string,
  {
    readImageAsBase64 = readImageFileAsBase64,
    maxEmbeddedBase64Bytes = DEFAULT_MAX_EMBEDDED_BASE64_BYTES,
  }: EmbedImagesOptions = {},
): Promise<EmbedImagesResult> {
  const assetSources = new Set<string>();
  for (const match of html.matchAll(IMG_SRC_RE)) {
    const src = match[3];
    if (assetUrlToPath(src)) {
      assetSources.add(src);
    }
  }

  if (assetSources.size === 0) {
    return { html, embeddedCount: 0, failedCount: 0 };
  }

  const replacements = new Map<string, string>();
  let embeddedCount = 0;
  let failedCount = 0;
  let totalEmbeddedBase64Bytes = 0;

  for (const src of assetSources) {
    const path = assetUrlToPath(src);
    if (!path) {
      failedCount += 1;
      continue;
    }

    const mimeType = mimeTypeForPath(path);
    if (!mimeType) {
      failedCount += 1;
      continue;
    }

    try {
      const base64 = await readImageAsBase64(path);
      if (totalEmbeddedBase64Bytes + base64.length > maxEmbeddedBase64Bytes) {
        failedCount += 1;
        continue;
      }

      totalEmbeddedBase64Bytes += base64.length;
      replacements.set(src, `data:${mimeType};base64,${base64}`);
      embeddedCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  if (replacements.size === 0) {
    return { html, embeddedCount, failedCount };
  }

  const nextHtml = html.replace(IMG_SRC_RE, (full, prefix: string, quote: string, src: string) => {
    const replacement = replacements.get(src);
    if (!replacement) {
      return full;
    }
    return `${prefix}${quote}${replacement}${quote}`;
  });

  return { html: nextHtml, embeddedCount, failedCount };
}

async function readImageFileAsBase64(path: string): Promise<string> {
  return invoke<string>("read_image_file_as_base64", { path });
}
