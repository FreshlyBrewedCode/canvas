import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { SECTIONS } from "./lib/sections";

/*
 * Markdown lives in `site/content/`, outside `src/`, so prose is editable
 * without touching the site's source tree. The glob loader's `base` is
 * resolved against the Astro project root (`site/`). `DOCS_CONTENT` points it
 * elsewhere: the stable channel's build reads the content of the last stable
 * release, extracted by `scripts/build-channels.sh`.
 */
const docs = defineCollection({
  loader: glob({ base: process.env.DOCS_CONTENT || "./content/docs", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    /** Sidebar group, one of `SECTIONS`. */
    section: z.enum(SECTIONS),
    /** Sidebar position; lower sorts first. */
    order: z.number().default(100),
  }),
});

export const collections = { docs };
