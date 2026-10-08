/** At most this many places in the top bar's presence stack, "+n" taking the last. */
export const MAX_AVATARS = 5;

/**
 * Which of `peers` get an avatar in the top bar, in their order, and which
 * go under "+n". Whoever we follow always gets one: their avatar is how we
 * stop.
 */
export function stack<T>(
  peers: ReadonlyArray<T>,
  followed: (peer: T) => boolean,
  max = MAX_AVATARS,
): { readonly shown: T[]; readonly rest: T[] } {
  if (peers.length <= max) return { shown: [...peers], rest: [] };
  const shown = peers.slice(0, max - 1);
  const lead = peers.slice(max - 1).find(followed);
  if (lead) shown[shown.length - 1] = lead;
  const kept = new Set(shown);
  return { shown, rest: peers.filter((peer) => !kept.has(peer)) };
}
