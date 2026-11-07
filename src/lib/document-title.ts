import { replaceOpenableDocumentExtension } from "./openable-files";

/** Use the index's title, ignoring its filename fallback, then an optional draft label. */
export function documentTitle(name: string, title?: string | null, draftLabel?: string): string | null {
  const stem = replaceOpenableDocumentExtension(name, "");
  return [title, draftLabel].find(value => value && value !== name && value !== stem) || null;
}
