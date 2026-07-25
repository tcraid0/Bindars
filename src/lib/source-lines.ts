export interface SourcePoint {
  /** One-based logical line number. */
  line: number;
  /** One-based UTF-16 column, matching JavaScript and CodeMirror string offsets. */
  column: number;
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function countLogicalLines(value: string): number {
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\r") {
      if (value[index + 1] === "\n") index += 1;
      lines += 1;
    } else if (value[index] === "\n") {
      lines += 1;
    }
  }
  return lines;
}

export function sourcePointAtOffset(content: string, targetOffset: number): SourcePoint {
  const clampedOffset = Math.max(0, Math.min(finiteInteger(targetOffset, 0), content.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < clampedOffset; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") index += 1;
      line += 1;
      lineStart = index + 1;
    } else if (content[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: clampedOffset - lineStart + 1 };
}

export function offsetAtSourcePoint(content: string, point: SourcePoint): number {
  const targetLine = Math.max(1, finiteInteger(point.line, 1));
  let line = 1;
  let lineStart = 0;

  for (let index = 0; index < content.length && line < targetLine; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") index += 1;
      line += 1;
      lineStart = index + 1;
    } else if (content[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }

  if (line < targetLine) return content.length;
  let lineEnd = lineStart;
  while (lineEnd < content.length && content[lineEnd] !== "\r" && content[lineEnd] !== "\n") {
    lineEnd += 1;
  }
  const columnOffset = Math.max(0, finiteInteger(point.column, 1) - 1);
  return lineStart + Math.min(columnOffset, lineEnd - lineStart);
}
