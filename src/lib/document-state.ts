export function isDocumentOpen(content: string | null): content is string {
  return content !== null;
}
