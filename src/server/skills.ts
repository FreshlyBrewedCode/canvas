/**
 * The skills canvas gives every agent session, shipped in `skills/` beside
 * `src/` (finding 12). The folder is a Claude Code plugin (its manifest points
 * `skills` at itself) and an opencode skills path at once; `agents.ts` hands
 * it to each agent, which lists the skills beside the host's own.
 *
 * Claude drops skill descriptions from its listing once the host has many
 * skills, so the board priming names them too (`boardInstructions`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SKILLS_DIR = resolve(import.meta.dir, "../../skills");

export interface Skill {
  readonly name: string;
  readonly description: string;
}

/** Every skill in `dir`, from its `SKILL.md` frontmatter. */
export function canvasSkills(dir: string = SKILLS_DIR): ReadonlyArray<Skill> {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const text = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      const field = (key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(frontmatter)?.[1];
      return { name: field("name") ?? entry.name, description: field("description") ?? "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
