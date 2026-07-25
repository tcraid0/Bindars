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

  const rawPath = trimmedSrc.split(/[?#]/, 1)[0];
  const decodedPath = decodeUriComponentSafe(rawPath);
  if (!decodedPath || decodedPath.includes("\0")) {
    return "";
  }

  // Block all URI schemes (http, https, data, javascript, asset, file, etc).
  // Revalidate after decoding so encoded schemes cannot bypass the check.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decodedPath)) {
    return "";
  }

  const relativeSrc = toPosixPath(decodedPath);
  if (relativeSrc.startsWith("/") || relativeSrc === ".") {
    return "";
  }

  const normalizedFilePath = toPosixPath(filePath);
  const fileDir = getDirectoryPath(normalizedFilePath);
  if (!fileDir) {
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
 * Returns `{ path, anchor }` if valid, or `null` if the link is not navigable.
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
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return null;
  }

  const normalizedHrefForAbsoluteCheck = toPosixPath(trimmed);
  if (normalizedHrefForAbsoluteCheck.startsWith("/")) {
    return null;
  }

  // Block fragment-only links (handled by in-page scroll)
  if (trimmed.startsWith("#")) return null;

  // Split into path and anchor
  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const rawAnchor = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  const anchor = rawAnchor ? decodeUriComponentSafe(rawAnchor) : null;

  // Strip query string from path portion
  const pathOnly = rawPath.split("?", 1)[0];
  if (!pathOnly) return null;
  const decodedPath = decodeUriComponentSafe(pathOnly);

  // Only match supported reader file extensions.
  if (!/\.(md|markdown|fountain)$/i.test(decodedPath)) return null;

  const normalizedFilePath = toPosixPath(currentFilePath);
  const fileDir = getDirectoryPath(normalizedFilePath);
  if (!fileDir) return null;

  const baseDir = normalizePath(fileDir);
  const resolved = normalizePath(`${baseDir}/${toPosixPath(decodedPath)}`);

  return { path: resolved, anchor };
}

export function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  let uncLike = false;

  // Strip Windows verbatim path prefix (e.g. \\?\C:\...).
  if (normalized.startsWith("//?/")) {
    normalized = normalized.slice(4);
  }

  // Normalize UNC to an absolute pseudo-root for stable comparisons.
  if (/^UNC\//i.test(normalized)) {
    normalized = `//${normalized.slice(4)}`;
    uncLike = true;
  } else if (normalized.startsWith("//")) {
    uncLike = true;
  }

  // Accept legacy keys produced before drive-letter normalization was fixed.
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }

  let identity = normalizePath(normalized);
  if (uncLike && identity.startsWith("//")) {
    identity = `/unc/${identity.slice(2)}`;
  }

  // Windows paths are case-insensitive.
  if (windowsLike || identity.startsWith("/unc/") || /^[A-Za-z]:\//.test(identity)) {
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
  const posixPath = toPosixPath(path);
  const isDriveAbsolute = /^[A-Za-z]:\//.test(posixPath);
  const isUncAbsolute = posixPath.startsWith("//");
  const isPosixAbsolute = posixPath.startsWith("/") && !isUncAbsolute;
  let root = "/";
  let pathWithoutRoot = posixPath;

  if (isDriveAbsolute) {
    root = posixPath.slice(0, 2);
    pathWithoutRoot = posixPath.slice(2);
  } else if (isUncAbsolute) {
    const { uncRoot, rest } = splitUncRoot(posixPath);
    root = uncRoot;
    pathWithoutRoot = rest;
  } else if (isPosixAbsolute) {
    pathWithoutRoot = posixPath.slice(1);
  }

  const parts = pathWithoutRoot.split("/");
  const normalized: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (normalized.length > 0) {
        normalized.pop();
      }
    } else {
      normalized.push(part);
    }
  }

  const body = normalized.join("/");
  if (!body) {
    if (isDriveAbsolute) {
      return `${root}/`;
    }
    return root === "//" ? "//" : root;
  }
  if (root === "/") {
    return `/${body}`;
  }
  if (root === "//") {
    return `//${body}`;
  }
  return `${root}/${body}`;
}

function splitUncRoot(path: string): { uncRoot: string; rest: string } {
  const parts = path.slice(2).split("/");
  const server = parts[0] ?? "";
  const share = parts[1] ?? "";
  if (!server || !share) {
    return { uncRoot: "//", rest: parts.join("/") };
  }

  return {
    uncRoot: `//${server}/${share}`,
    rest: parts.slice(2).join("/"),
  };
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
