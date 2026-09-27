/**
 * Comments on the lines of a file (ADR 0006). A comment keeps the lines it
 * was written on as text, its quote: files change under it — agents edit them
 * live — and the quote is how it finds its lines again, or knows it can't.
 * Pure, so `canvas serve` (which quotes agents' comments) and the browser
 * agree on what a line is.
 */

/** A file's lines as the frames number them: a final newline ends the last line. */
export function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** Lines `start`–`end` (1-based, inclusive) of `text`; null if the file hasn't got them. */
export function quoteOf(text: string, start: number, end: number): string | null {
  const lines = linesOf(text);
  if (start < 1 || end < start || end > lines.length) return null;
  return lines.slice(start - 1, end).join("\n");
}

/**
 * Where a quote is now: its old place if the lines there still read the same,
 * else the nearest place they do. null if they're gone — the comment is
 * outdated. A quote of blank lines only stays where it was: blank lines are
 * everywhere, finding "them" elsewhere would be a guess.
 */
export function relocate(
  text: string,
  quote: string,
  start: number,
): { start: number; end: number } | null {
  const lines = linesOf(text);
  const wanted = quote.split("\n");
  const at = (s: number) => wanted.every((line, i) => lines[s - 1 + i] === line);
  const found = (s: number) => ({ start: s, end: s + wanted.length - 1 });
  const last = lines.length - wanted.length + 1;
  if (start >= 1 && start <= last && at(start)) return found(start);
  if (!quote.trim()) return null;
  for (let distance = 1; distance < Math.max(start, last); distance++) {
    if (start - distance >= 1 && start - distance <= last && at(start - distance))
      return found(start - distance);
    if (start + distance >= 1 && start + distance <= last && at(start + distance))
      return found(start + distance);
  }
  return null;
}
