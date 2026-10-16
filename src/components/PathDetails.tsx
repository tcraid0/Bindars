import { fileName, locationLabel } from "../lib/paths";

/** Keyboard-accessible full paths without making them the primary label. */
export function PathDetails({ path, label }: { path: string; label?: string }) {
  const summary = label ?? locationLabel(path);
  return (
    <details className="document-location text-xs text-text-secondary">
      <summary aria-label={`Location of ${fileName(path)}: ${summary}`}>
        {summary}
      </summary>
      <p className="break-all my-1">{path}</p>
    </details>
  );
}
