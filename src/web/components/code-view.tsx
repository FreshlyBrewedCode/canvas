import type { FileContents } from "@pierre/diffs";
import { File, Virtualizer, type FileOptions } from "@pierre/diffs/react";
import { useMemo } from "react";

const BASE: FileOptions<undefined, undefined> = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  disableFileHeader: true,
};
const SCROLL = { ...BASE, overflow: "scroll" } as const;
const WRAP = { ...BASE, overflow: "wrap" } as const;

const STYLE = {
  // The frame's colour, not the theme's.
  "--diffs-light-bg": "var(--card)",
  "--diffs-dark-bg": "var(--card)",
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
  "--diffs-line-height": "1.6",
} as React.CSSProperties;

/**
 * Not flush with the top: the virtualizer anchors scrolling to a file's
 * bottom while its top is at 0 and it has no height yet, so a new file
 * would open scrolled to its end.
 */
const CONTENT = { paddingBlock: 4 };

/**
 * A file's source, read-only: Shiki highlighting (language from the file
 * name), line numbers, and only the visible lines in the DOM. Prose (`wrap`)
 * wraps long lines; code scrolls.
 */
export function CodeView({ path, text, wrap }: { path: string; text: string; wrap: boolean }) {
  const file = useMemo<FileContents>(() => ({ name: path, contents: text }), [path, text]);

  return (
    <Virtualizer className="h-full overflow-auto" contentStyle={CONTENT}>
      <File file={file} options={wrap ? WRAP : SCROLL} style={STYLE} />
    </Virtualizer>
  );
}
