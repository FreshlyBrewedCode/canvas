/*
 * Turns the raw screenshots of `e2e/screenshots.ts` into the WebPs the docs
 * use: cropped where the raw shot is mostly empty, at most 2000 px wide.
 * Astro re-encodes them again at build; these are the committed sources.
 *
 *   bun scripts/shots.ts [/tmp/canvas-docs-shots]
 */
import sharp from "sharp";

const from = process.argv[2] ?? "/tmp/canvas-docs-shots";
const to = new URL("../content/docs/screenshots/", import.meta.url).pathname;

/** Raw name → crop in raw pixels (2× device scale), or `null` for the whole shot. */
type Crop = { left: number; top: number; width: number; height: number } | null;
const shots: Record<string, Crop> = {
  board: null,
  "board-guest": null,
  approval: { left: 1080, top: 0, width: 1800, height: 480 },
  "agent-picker": { left: 120, top: 590, width: 720, height: 450 },
  "agent-draft": { left: 0, top: 1060, width: 960, height: 500 },
  "agent-thread": { left: 0, top: 0, width: 960, height: 960 },
  "agent-settings": { left: 280, top: 180, width: 1520, height: 1000 },
  "agent-host-permission": null,
  "agent-guest-permission": null,
  "files-preview": null,
  "files-lines": null,
  "files-comments": { left: 700, top: 150, width: 1480, height: 1600 },
  terminal: null,
  browser: null,
  snap: { left: 280, top: 1140, width: 2320, height: 660 },
  "topbar-host": null,
  "topbar-guest": null,
};

for (const [name, crop] of Object.entries(shots)) {
  let image = sharp(`${from}/${name}.png`);
  if (crop) image = image.extract(crop);
  const info = await image
    .resize({ width: 2000, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(`${to}${name}.webp`);
  console.log(`${name}.webp ${info.width}×${info.height} ${Math.round(info.size / 1024)} KiB`);
}
