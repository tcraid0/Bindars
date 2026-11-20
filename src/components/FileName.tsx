import { replaceOpenableDocumentExtension } from "../lib/openable-files";

/** A document's file name with its ending (".md", ".fountain") drawn quieter.
    The text stays whole, so copying and screen readers get the full name. */
export function FileName({ name }: { name: string }) {
  const stem = replaceOpenableDocumentExtension(name, "");
  if (!stem || stem === name) return <>{name}</>;
  return <>{stem}<span className="document-ext">{name.slice(stem.length)}</span></>;
}
