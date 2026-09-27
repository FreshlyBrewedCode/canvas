import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { canvasSkills, SKILLS_DIR } from "./skills";

// Agents drop a skill whose frontmatter they can't read, without a word.
test("every skill names itself after its folder and says when to use it", () => {
  const folders = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const skills = canvasSkills();
  expect(skills.map((skill) => skill.name)).toEqual(folders);
  expect(folders).toContain("code-tour");
  for (const skill of skills) expect(skill.description).toMatch(/Use when/);
});

test("the skills folder is a Claude Code plugin whose skills are its own folders", async () => {
  const manifest = await Bun.file(join(SKILLS_DIR, ".claude-plugin", "plugin.json")).json();
  expect(manifest).toMatchObject({ name: "canvas", skills: "./" });
});
