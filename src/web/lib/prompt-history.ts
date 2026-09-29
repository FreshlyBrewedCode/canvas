/**
 * ↑ and ↓ in the composer go through our own prompts of the frame, oldest
 * first in `history`. `at` is the one shown, null while not browsing; the
 * draft is shared, so browsing only starts from an empty one and goes on
 * only while the draft is still the prompt it showed.
 */

export type HistoryStep = { readonly at: number | null; readonly text: string } | null;

export function browse(
  history: ReadonlyArray<string>,
  at: number | null,
  draft: string,
  direction: "older" | "newer",
): HistoryStep {
  const browsing = at !== null && history[at] === draft;
  if (direction === "older") {
    if (!browsing && draft !== "") return null;
    if (!history.length) return null;
    // Past the oldest, it stays there.
    const next = browsing ? Math.max(0, at - 1) : history.length - 1;
    return { at: next, text: history[next]! };
  }
  if (!browsing) return null;
  return at + 1 < history.length ? { at: at + 1, text: history[at + 1]! } : { at: null, text: "" };
}
