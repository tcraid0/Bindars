/** Search-only normalization. Never use this for persisted annotation identity. */
export interface NormalizedText {
  text: string;
  starts: number[];
  ends: number[];
  invalidBreaks: Set<number>;
  offsetsChanged: boolean;
}
export function normalizeSearchText(
  input: string,
  prose = true,
  positions = true,
): NormalizedText {
  if (!positions && /^[\x00-\x7f]*$/.test(input)) {
    const text = prose
      ? input.toLowerCase().replace(/\s+/g, " ")
      : input.toLowerCase();
    return {
      text,
      starts: [],
      ends: [],
      invalidBreaks: new Set(),
      offsetsChanged: text.length !== input.length,
    };
  }
  let text = "";
  const starts: number[] = [],
    ends: number[] = [];
  const invalidBreaks = new Set<number>();
  let offsetsChanged = false;
  let offset = 0;
  for (const char of input) {
    const end = offset + char.length;
    let value = char.toLowerCase();
    if (prose) {
      if (/\s/u.test(char)) value = " ";
      else if (char === "’" || char === "‘") value = "'";
      else if (char === "“" || char === "”") value = '"';
      else if (char === "–") value = "--";
      else if (char === "—") value = "---";
      else if (char === "…") value = "...";
    }
    if (value.length !== char.length) offsetsChanged = true;
    if (prose && value === " " && text.endsWith(" ")) {
      offsetsChanged = true;
      if (positions) ends[ends.length - 1] = end;
    } else {
      for (let i = 1; i < value.length; i++) invalidBreaks.add(text.length + i);
      text += value;
      if (positions)
        for (let i = 0; i < value.length; i++) {
          starts.push(offset);
          ends.push(end);
        }
    }
    offset = end;
  }
  return { text, starts, ends, invalidBreaks, offsetsChanged };
}
export function searchText(input: string): string {
  return normalizeSearchText(input, true, false).text.trim();
}
export function normalizedIndexOf(
  field: Pick<NormalizedText, "text" | "invalidBreaks">,
  query: string,
  from = 0,
): number {
  while (query && from < field.text.length) {
    const index = field.text.indexOf(query, from);
    if (index < 0) return -1;
    if (
      !field.invalidBreaks.has(index) &&
      !field.invalidBreaks.has(index + query.length)
    )
      return index;
    from = index + 1;
  }
  return -1;
}
export function phraseMatches(
  text: string,
  query: string,
  prose = true,
  maxMatches = Infinity,
): { start: number; end: number }[] {
  const normalized = normalizeSearchText(text, prose);
  const q = normalizeSearchText(query, prose).text.trim();
  if (!q) return [];
  const matches = [];
  let from = 0;
  while (from < normalized.text.length && matches.length < maxMatches) {
    const index = normalized.text.indexOf(q, from);
    if (index < 0) break;
    // Never select only part of a case-fold or punctuation expansion.
    const endIndex = index + q.length;
    if (
      (index === 0 ||
        normalized.starts[index - 1] !== normalized.starts[index]) &&
      (endIndex === normalized.text.length ||
        normalized.starts[endIndex] !== normalized.starts[endIndex - 1])
    ) {
      matches.push({
        start: normalized.starts[index],
        end: normalized.ends[endIndex - 1],
      });
    }
    from = index + q.length;
  }
  return matches;
}
export function searchTerms(query: string): string[] {
  // Quotes delimit phrases; other punctuation is literal, not an operator.
  return [...query.matchAll(/"([^"]+)"|([^\s"]+)/g)]
    .map((match) => searchText(match[1] ?? match[2]))
    .filter(Boolean);
}
export function textFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
