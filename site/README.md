# site

The landing page and docs for canvas. Astro 7 (static output), Tailwind v4, Expressive Code for
codeblocks, Pagefind for search. Copied from factory's site (`../factory/site`), without its 3D
landing page.

Its own package with its own `node_modules`, not part of the root package.

```bash
cd site
bun install

bun run dev      # http://localhost:4419 — no search, see below
bun run build    # astro build, then pagefind indexes dist/
bun run preview  # build + serve dist/ — the only way to test search locally
bun run build:channels  # what CI deploys: stable at /, main under /next — see Channels
bun run check    # astro check (types across .astro files)
```

On NixOS, run `build`, `preview` and `scripts/shots.ts` inside `nix develop` (from the repo root):
Astro's image pipeline, sharp, needs `libstdc++`.

## Layout

| Path                             | What it is                                                  |
| -------------------------------- | ----------------------------------------------------------- |
| `content/docs/*.md`              | Docs prose. Frontmatter: `title`, `description?`, `section`, `order` |
| `content/docs/screenshots/`      | Screenshots the docs embed, made by `scripts/shots.ts`      |
| `src/content.config.ts`          | The `docs` collection — glob loader + zod schema            |
| `src/pages/index.astro`          | Landing page: the board as hero, one session in four beats  |
| `src/components/landing/`        | Frames, cursors and frame contents rebuilt in HTML for it   |
| `src/styles/landing.css`, `src/scripts/landing.ts` | Its grid, animations, parallax, copy buttons |
| `src/pages/docs/[...slug].astro` | One route per markdown file                                 |
| `src/pages/docs/[...slug].md.ts` | The same pages as raw markdown at `/docs/<slug>.md`         |
| `src/pages/docs/index.md.ts`     | Unlisted markdown index of every doc                        |
| `src/lib/docs.ts`                | `sortedDocs()` — sidebar order, shared by the above         |
| `src/lib/sections.ts`            | The sidebar sections, in order                              |
| `src/lib/channel.ts`             | Which channel a build is: base path, versions, `href()`     |
| `src/lib/markdown-channel.ts`    | Points markdown's code and `/docs` links at the channel     |
| `src/components/VersionPicker.astro` | Stable/next badge and menu, above the page outline      |
| `scripts/build-channels.sh`      | Builds both channels into one `dist/`                       |
| `src/components/NavDrawer.astro` | Mobile nav: trigger bar + drawer, below `lg`                |
| `src/styles/global.css`          | Tailwind entry + design tokens + prose and Pagefind theming |
| `ec.config.mjs`                  | Expressive Code themes and style overrides                  |

## Adding a page

Drop a `.md` file in `content/docs/`. It appears at `/docs/<filename>` and in the sidebar, under its
`section`, sorted by `order`. Nothing else to register.

Keep titles to a word or two, and use the terms of the Glossary page (`content/docs/glossary.md`):
host, guest, guest access, approval, permission, agent frame, files frame, shared set, and so on.
Add a term there before using a new one.

## Screenshots

Taken from the real app, with a real Claude Code session, by `e2e/screenshots.ts` against a small
demo project, then cropped and converted by `scripts/shots.ts`:

```bash
bash e2e/screenshots-demo.sh /tmp/shop     # the demo project, from the repo root
# then the app: `bun run dev`, and `bun src/cli.ts serve --dir /tmp/shop --tls-host …`
nix develop --command bun e2e/screenshots.ts '<host link>'             # STEP=setup
STEP=shots nix develop --command bun e2e/screenshots.ts '<host link>'
STEP=snap nix develop --command bun e2e/screenshots.ts '<host link>'
nix develop --command bash -c 'cd site && bun scripts/shots.ts'
```

`setup` asks the agent to show the login code on the board; `shots` rebuilds the rest of the board
around the agent frame. A terminal frame keeps its shell after it is removed, so free the demo's
port (`:5199`) before running `shots` again.

## Raw markdown

Append `.md` to any docs URL — `/docs/introduction.md` — for the source without the chrome. The doc
header links it, and `src/pages/docs/[...slug].md.ts` generates it as a static file alongside the
HTML. Served as `text/plain` so browsers display it rather than downloading; frontmatter is stripped
and the `title` and `description` are reinstated as an H1 and a lead paragraph.

`/docs/index.md` lists every page in sidebar order with its description, each linking to its `.md`
source — fetch one URL to learn what exists, then fetch what you need. It is unlisted: not a
collection entry, so the sidebar never shows it, and Pagefind only indexes HTML, so search ignores
it. Its links are absolute, built from `site` in `astro.config.mjs` (`https://canvas.frebreco.de`),
so change that and `public/CNAME` together if the site ever moves.

## Channels

The docs come in the package's two channels. The root (`/docs`) documents the stable release,
`@frebreco/canvas`; `/next/docs` documents `main`, the pre-release `@frebreco/canvas@next`. A
badge above the page outline says which, and its menu goes to the same page in the other channel
(or that channel's `/docs`, when the page does not exist there).

One build is one channel, set by environment variables that `src/lib/channel.ts` reads:

| Variable                                     | What it does                                              |
| -------------------------------------------- | --------------------------------------------------------- |
| `DOCS_CHANNEL`                               | `latest` (default, at `/`) or `next` (under `/next`)      |
| `DOCS_CONTENT`                               | Where the markdown is, instead of `content/docs`          |
| `DOCS_LATEST_VERSION`, `DOCS_NEXT_VERSION`   | The versions the badge shows; left out when unset         |

`scripts/build-channels.sh` builds both into one `dist/`. Only `content/` comes from the last
stable tag, extracted to `.stable/`; the site around it is the checkout's, so a fix to a layout or
a style reaches both channels at once. On `next`, `markdown-channel.ts` turns
`@frebreco/canvas` in code into `@frebreco/canvas@next` and the host link's web app into
`ui.canvas.frebreco.de/next/`, and points `/docs/…` links under `/next`; the raw `.md` pages get
the same. A root-relative link in a component goes through `href()`.

So a docs change merged to `main` shows under `/next` straight away and at the root with the next
stable release — including a fix to a page stable already has. Pages under `/next` are `noindex`.

## Deploying

`.github/workflows/site.yml` builds both channels and deploys `dist/` to the canvas repo's GitHub
Pages after every run of the release workflow — which every push to `main` starts, and which moves
the stable content when it publishes `latest` — or by hand from the Actions tab. The custom domain
comes from `public/CNAME`. The web app is not part of this site: it is served from
`ui.canvas.frebreco.de` by the release workflow.

## Things that will bite you

- **Rendered markdown is cached across channels.** The content layer cache (below) keys a page on
  its source, and the two channels render the same source differently, so `build-channels.sh`
  builds with `--force`. The next channel's Pagefind is its own index under `/next/pagefind/`;
  `Search.astro` names that bundle, as the component UI otherwise finds the root's.
- **Search is build-only.** Pagefind indexes rendered HTML in `dist/`, so `astro dev` has no index.
  The header shows a "build only" chip there instead of a dead search box. Use `bun run preview`.
- **Expressive Code options live in `ec.config.mjs`,** not `astro.config.mjs`. The `<Code>` component
  needs options it can serialise to JSON, and `themeCssSelector` is a function.
- **Tailwind v4 puts everything in `@layer`, and unlayered CSS beats every layer** regardless of
  specificity — and separately, two unlayered rules of _equal_ specificity still just fall to source
  order. Third-party stylesheets here are unlayered, so they quietly win either way. Four instances
  so far: the `.prose` token bindings (unlayered to beat `@layer utilities`), the Pagefind `--pf-*`
  block and the Expressive Code copy-button size (both `.foo.foo`-doubled, because Pagefind reuses
  `:root` and Expressive Code scopes its own plugin CSS under `.expressive-code` too — so a selector
  that looks more specific than theirs can turn out to be identical to theirs), and hiding
  `<pagefind-searchbox>` responsively (Tailwind's `hidden` loses to Pagefind's element selector, so
  the breakpoint classes live on a wrapper div instead). Each has a comment. When a utility class or
  an apparently-more-specific override inexplicably does nothing to a third-party element, this is
  why — check what selector the library actually emits before assuming yours wins.
- **Editing `ec.config.mjs` (or anything else that changes how markdown renders, without touching
  any `.md` file) can 404 the Expressive Code stylesheet — in dev _and_ in a build.** Astro's
  content layer caches each doc's rendered HTML, keyed only on the source markdown's digest. That
  digest doesn't change, so the cache reuses the old HTML, `<link>` to the old theme's hash and
  all, while Expressive Code emits only the new hash's file. Symptom in dev: a 404 for
  `/_astro/ec.<hash>.css` (or, if two restart triggers race — Astro's own config watcher and
  Expressive Code's `handleHotUpdate` both fire on the same save — a dev server that reports itself
  running but stops listening entirely; check `.astro/dev.log` for
  `Vite module runner has been closed`). Symptom in a build: a shipped page linking a CSS file that
  was never written to `dist/`.

  `bun run dev` now runs `dev:clean` first, so this cannot happen from a fresh `astro dev` — it can
  still happen if you edit `ec.config.mjs` while an _already-running_ dev server is up (the cache
  only clears at startup) or when running `bun run build` directly. In either case:

  ```bash
  bun run dev:clean   # or: rm -f .astro/data-store.json node_modules/.astro/data-store.json
  ```

- **`astro check` needs TypeScript 6.** TS 7 (tsgo, what the root package pins) does not expose the
  programmatic API the Astro language server uses, so this package pins `typescript@^6` locally.

## Not done yet

- Design tokens are copied from `src/web/styles.css` rather than shared. Lift them into one file
  once both surfaces settle.
- No `.astro` formatter. oxfmt does not parse the format, and the root `bun run check` does not
  cover this package.
- Nothing else. Icons come from `@lucide/astro`, imported one file at a time
  (`@lucide/astro/icons/search`) rather than through the barrel.
