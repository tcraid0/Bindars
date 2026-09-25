export const OPENABLE_FILE_EXTENSIONS = ["md", "markdown", "fountain"] as const;

const OPENABLE_FILE_EXTENSION_PATTERN = new RegExp(
  `\\.(?:${OPENABLE_FILE_EXTENSIONS.join("|")})$`,
  "i",
);

function describeExtensions(extensions: readonly string[]): string {
  const labels = extensions.map((extension) => `.${extension}`);
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

export const OPENABLE_FILE_TYPES_DESCRIPTION = describeExtensions(OPENABLE_FILE_EXTENSIONS);

export function isOpenableDocumentExtension(extension: string): boolean {
  const normalized = (extension.startsWith(".") ? extension.slice(1) : extension).toLowerCase();
  return OPENABLE_FILE_EXTENSIONS.some(
    (supported) => supported === normalized,
  );
}

export function isOpenableDocumentPath(path: string): boolean {
  return OPENABLE_FILE_EXTENSION_PATTERN.test(path);
}

export function replaceOpenableDocumentExtension(path: string, replacement: string): string {
  return path.replace(OPENABLE_FILE_EXTENSION_PATTERN, replacement);
}
