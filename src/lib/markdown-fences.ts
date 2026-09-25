export type MarkdownFenceMarker = "`" | "~";

export interface MarkdownFenceState {
  marker: MarkdownFenceMarker;
  length: number;
}

const FENCE_START_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;

export function updateMarkdownFenceState(
  line: string,
  current: MarkdownFenceState | null,
): MarkdownFenceState | null {
  if (current) {
    const closeMatch = FENCE_CLOSE_RE.exec(line);
    if (!closeMatch) {
      return current;
    }

    const markerRun = closeMatch[1];
    if (markerRun[0] !== current.marker || markerRun.length < current.length) {
      return current;
    }

    return null;
  }

  const openMatch = FENCE_START_RE.exec(line);
  if (!openMatch) {
    return null;
  }

  const markerRun = openMatch[1];
  const marker = markerRun[0] as MarkdownFenceMarker;
  const infoString = openMatch[2] ?? "";
  if (marker === "`" && infoString.includes("`")) {
    return null;
  }

  return {
    marker,
    length: markerRun.length,
  };
}
