/*
 * The docs come in two channels, like the package and its web app: `latest`
 * at the root documents the stable release, `next` under `/next` documents
 * `main`, i.e. the pre-release. One build is one channel, picked by
 * `DOCS_CHANNEL`; `scripts/build-channels.sh` builds both and nests them.
 * Unset, a build is `latest` at the root, so `bun run dev` and `bun run build`
 * behave as they always have.
 *
 * Read at build time only (config, frontmatter, endpoints), never in the
 * browser, so plain `process.env` rather than Vite's `PUBLIC_` variables.
 */

export type Channel = "latest" | "next";

interface ChannelInfo {
  /** What the version picker calls it. */
  label: string;
  /** Path prefix, without a trailing slash; empty at the root. */
  base: string;
  /** The release it documents, e.g. `0.5.0`, when the build was told. */
  version?: string;
}

export const CHANNELS: Record<Channel, ChannelInfo> = {
  latest: { label: "Stable", base: "", version: process.env.DOCS_LATEST_VERSION || undefined },
  next: { label: "Next", base: "/next", version: process.env.DOCS_NEXT_VERSION || undefined },
};

export const CHANNEL: Channel = process.env.DOCS_CHANNEL === "next" ? "next" : "latest";

/** This build's path prefix, for every root-relative link it emits. */
export const BASE = CHANNELS[CHANNEL].base;

/** A root-relative path (`/docs/relay`) as this channel serves it. */
export const href = (path: string) => BASE + path;

/**
 * Docs text as this channel's reader should run it: on `next`, the package is
 * `@frebreco/canvas@next` and its host link opens the web app under `/next`.
 * Applied to code in the rendered pages (`markdown-channel.ts`) and to the raw
 * markdown, so a copied command installs what the page describes.
 */
export function forChannel(text: string): string {
  if (CHANNEL !== "next") return text;
  return text
    .replace(/@frebreco\/canvas(?![@\w/-])/g, "@frebreco/canvas@next")
    .replace(/ui\.canvas\.frebreco\.de\/\?/g, "ui.canvas.frebreco.de/next/?");
}

/** A root-relative link in docs markdown (`/docs/relay`), pointed into this channel. */
export function linkForChannel(url: string): string {
  return url.startsWith("/docs") ? href(url) : url;
}
