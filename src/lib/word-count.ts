/** Count whitespace-delimited words without allocating a word array. */
export function countWords(text: string): number {
  let count = 0;
  let insideWord = false;

  for (let index = 0; index < text.length; index += 1) {
    const whitespace = isWhitespaceCodeUnit(text.charCodeAt(index));
    if (whitespace) {
      insideWord = false;
    } else if (!insideWord) {
      count += 1;
      insideWord = true;
    }
  }

  return count;
}

export function isWhitespaceCodeUnit(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d)
    || code === 0x20
    || code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff
  );
}
