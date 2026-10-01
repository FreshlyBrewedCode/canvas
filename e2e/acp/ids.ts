/**
 * A recording names the frames, comments and sessions of the run it was made
 * in; a replay's board has its own. `Ids` learns which is which by comparing
 * what the recording saw with what the replay sees in the same place — the
 * same request's params, the same MCP call's answer — and puts the replay's
 * in wherever the recording's would go.
 *
 * An id is canvas's: eight hex digits (`crypto.randomUUID().slice(0, 8)`) or
 * a whole UUID. Eight hex digits without a letter are left alone: a number.
 */

const ID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g;

const tokens = (text: string) => (text.match(ID) ?? []).filter((t) => /[a-f]/.test(t));

export class Ids {
  private readonly map = new Map<string, string>();

  /** What the recording's `recorded` is in this run, `actual`: pair their ids. */
  learn(recorded: unknown, actual: unknown): void {
    if (typeof recorded === "string" && typeof actual === "string") {
      if (recorded === actual) return;
      const [from, to] = [tokens(recorded), tokens(actual)];
      if (from.length !== to.length) return;
      from.forEach((id, i) => {
        if (id !== to[i] && !this.map.has(id)) this.map.set(id, to[i]!);
      });
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
    if (typeof value === "string") return value.replace(ID, (id) => this.map.get(id) ?? id) as T;
    if (Array.isArray(value)) return value.map((v) => this.apply(v)) as T;
    if (isObject(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.apply(v)])) as T;
    return value;
  }
}

/** A text with its ids blanked: two runs' prompts compare equal by it. */
export const withoutIds = (text: string) =>
  text.replace(ID, (id) => (/[a-f]/.test(id) ? "<id>" : id));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
