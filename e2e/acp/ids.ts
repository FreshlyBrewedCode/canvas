/**
 * A recording names the frames, comments, drawing elements and sessions of the
 * run it was made in; a replay's board has its own. `Ids` learns which is
 * which by comparing what the recording saw with what the replay sees in the
 * same place — the same request's params, the same MCP call's answer — and
 * puts the replay's in wherever the recording's would go.
 *
 * An id is a token that differs between the two and looks like one: canvas's
 * eight hex digits (`crypto.randomUUID().slice(0, 8)`) or UUIDs, Excalidraw's
 * nanoids — eight characters or more, letters and digits. Two texts are
 * compared token by token, or line by line when their tokens don't line up.
 */

const TOKEN = /[A-Za-z0-9_-]+/g;
const HEX_ID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g;

const isId = (token: string) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(token) ||
  (token.length >= 8 && /\d/.test(token) && /[A-Za-z]/.test(token));

export class Ids {
  private readonly map = new Map<string, string>();

  /** What the recording's `recorded` is in this run, `actual`: pair their ids. */
  learn(recorded: unknown, actual: unknown): void {
    if (typeof recorded === "string" && typeof actual === "string") {
      if (recorded === actual) return;
      const [from, to] = [recorded.match(TOKEN) ?? [], actual.match(TOKEN) ?? []];
      if (from.length === to.length) {
        from.forEach((token, i) => {
          const other = to[i]!;
          if (token !== other && isId(token) && isId(other) && !this.map.has(token))
            this.map.set(token, other);
        });
        return;
      }
      const [a, b] = [recorded.split("\n"), actual.split("\n")];
      if (a.length > 1 && a.length === b.length) a.forEach((line, i) => this.learn(line, b[i]));
      return;
    }
    if (Array.isArray(recorded) && Array.isArray(actual)) {
      recorded.forEach((value, i) => this.learn(value, actual[i]));
      return;
    }
    if (isObject(recorded) && isObject(actual))
      for (const key of Object.keys(recorded)) this.learn(recorded[key], actual[key]);
  }

  /** The recording's value, with this run's ids. */
  apply<T>(value: T): T {
    if (typeof value === "string")
      return value.replace(TOKEN, (token) => this.map.get(token) ?? token) as T;
    if (Array.isArray(value)) return value.map((v) => this.apply(v)) as T;
    if (isObject(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.apply(v)])) as T;
    return value;
  }
}

/** A text with canvas's ids blanked: two runs' prompts compare equal by it. */
export const withoutIds = (text: string) =>
  text.replace(HEX_ID, (id) => (/[a-f]/.test(id) ? "<id>" : id));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
