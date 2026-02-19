import { convertFileSrc } from "@tauri-apps/api/core";

export interface AssetScopeRoots {
  homePath: string | null;
  tempPath: string | null;
}

/**
 * Resolve a relative image path against the directory of the currently open file.
 * Returns an asset:// URL that Tauri can serve locally.
 */
export function resolveImageSrc(src: string, filePath: string): string {
  const resolved = resolveImagePath(src, filePath);
  if (!resolved) {
    return "";
  }
  return convertFileSrc(resolved);
}

/**
 * Resolve a relative image path against the directory of the currently open file.
 * Returns a normalized absolute path, or an empty string if blocked/invalid.
 */
export function resolveImagePath(src: string, filePath: string): string {
  const trimmedSrc = src.trim();
  if (!trimmedSrc) {
    return "";
  }

  // Block all URI schemes (http, https, data, javascript, asset, file, etc).
  // Only relative paths are allowed.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmedSrc) || trimmedSrc.startsWith("//")) {
    return "";
  }

  // Block absolute filesystem paths to keep image access relative to current file directory.
  if (trimmedSrc.startsWith("/")) {
    return "";
  }

  const normalizedFilePath = toPosixPath(filePath);
  const fileDir = getDirectoryPath(normalizedFilePath);
  if (!fileDir) {
    return "";
  }

  const relativeSrc = toPosixPath(trimmedSrc.split(/[?#]/, 1)[0]);
  if (!relativeSrc || relativeSrc === ".") {
    return "";
  }

  const baseDir = normalizePath(fileDir);
  const resolved = normalizePath(`${baseDir}/${relativeSrc}`);

  if (!isPathInsideBase(resolved, baseDir)) {
    return "";
  }

  return resolved;
}

/**
 * Check whether a normalized absolute path is inside the Tauri asset protocol
 * scope configured by default in this app ($HOME and $TEMP).
 */
export function isPathAllowedByAssetScope(path: string, scope: AssetScopeRoots): boolean {
  const normalizedPath = normalizePath(toPosixPath(path));
  const home = normalizeScopeRoot(scope.homePath);
  if (home && isPathInsideBase(normalizedPath, home)) {
    return true;
  }

  const temp = normalizeScopeRoot(scope.tempPath);
  if (temp && isPathInsideBase(normalizedPath, temp)) {
    return true;
  }

  return false;
}

/**
 * Resolve a relative markdown link (e.g. `./other.md#section`) against the current file.
 * Returns `{ path, anchor }` if valid, or `null` if the link is not a navigable .md link.
 *
 * Unlike resolveImageSrc, this does NOT restrict traversal with `..` — navigating to
 * `../README.md` is legitimate. The Rust backend validates the resolved path on open.
 */
export function resolveMarkdownLink(
  href: string,
  currentFilePath: string,
): { path: string; anchor: string | null } | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  // Block URI schemes
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) || trimmed.startsWith("//")) {
    return null;
  }

  // Block absolute paths
  if (trimmed.startsWith("/")) return null;

  // Block fragment-only links (handled by in-page scroll)
  if (trimmed.startsWith("#")) return null;

  // Split into path and anchor
  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const anchor = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) || null : null;

  // Strip query string from path portion
  const pathOnly = rawPath.split("?", 1)[0];
  if (!pathOnly) return null;

  // Only match .md / .markdown extensions
  if (!/\.(md|markdown)$/i.test(pathOnly)) return null;

  const normalizedFilePath = toPosixPath(currentFilePath);
  const fileDir = getDirectoryPath(normalizedFilePath);
  if (!fileDir) return null;

  const baseDir = normalizePath(fileDir);
  const resolved = normalizePath(`${baseDir}/${toPosixPath(pathOnly)}`);

  return { path: resolved, anchor };
}

/**
 * Convert any filesystem path string into a stable identity key so workspace
 * links and currently opened files can be compared across path formats.
 */
export function toPathIdentityKey(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";

  const windowsLike = looksWindowsPath(trimmed);
  let normalized = toPosixPath(trimmed);

  // Strip Windows verbatim path prefix (e.g. \\?\C:\...).
  if (normalized.startsWith("//?/")) {
    normalized = normalized.slice(4);
  }

  // Normalize UNC to an absolute pseudo-root for stable comparisons.
  if (/^UNC\//i.test(normalized)) {
    normalized = `/unc/${normalized.slice(4)}`;
  } else if (normalized.startsWith("//")) {
    normalized = `/unc/${normalized.slice(2)}`;
  }

  // Normalize drive-letter paths to align with resolveMarkdownLink output.
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = `/${normalized}`;
  }

  const identity = normalizePath(normalized);

  // Windows paths are case-insensitive.
  if (windowsLike || identity.startsWith("/unc/") || /^\/[A-Za-z]:\//.test(identity)) {
    return identity.toLowerCase();
  }

  return identity;
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function getDirectoryPath(path: string): string {
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = withoutTrailingSlash.lastIndexOf("/");

  if (lastSlash === 0) {
    return "/";
  }
  if (lastSlash < 0) {
    return "";
  }

  return withoutTrailingSlash.slice(0, lastSlash);
}

export function normalizePath(path: string): string {
  const parts = path.split("/");
  const normalized: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return "/" + normalized.join("/");
}

function isPathInsideBase(path: string, basePath: string): boolean {
  if (basePath === "/") {
    return path.startsWith("/");
  }

  const baseWithSlash = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return path === basePath || path.startsWith(baseWithSlash);
}

function normalizeScopeRoot(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }
  return normalizePath(toPosixPath(trimmed));
}

function looksWindowsPath(path: string): boolean {
  return (
    /\\/.test(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//?/") ||
    /^UNC[\\/]/i.test(path)
  );
}
