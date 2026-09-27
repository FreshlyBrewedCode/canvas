/**
 * What drawings need Excalidraw for (ADR 0008), loaded the first time a board
 * needs it: it is large (with mermaid), so boards without drawings never
 * load it. Its fonts come from this app (`vite.config.ts` copies them), not
 * from Excalidraw's CDN.
 *
 * For agents, in the host's browser: turning the elements an agent describes
 * (Excalidraw's element skeletons) or a mermaid diagram into elements, before
 * the board tool writes them (`board-tools.ts`), and rendering a drawing as
 * the image `view_frame` shows the agent.
 */

import type * as Y from "yjs";

import type { ToolImage } from "../../shared/protocol";
import {
  boundIds,
  checkSkeletons,
  readElements,
  routeArrows,
  visible,
  type DrawingElement,
} from "./drawing";

type Excalidraw = typeof import("@excalidraw/excalidraw");
type Elements = Parameters<Excalidraw["exportToSvg"]>[0]["elements"];

let loading: Promise<Excalidraw> | null = null;

export function loadExcalidraw(): Promise<Excalidraw> {
  const w = window as { EXCALIDRAW_ASSET_PATH?: string };
  w.EXCALIDRAW_ASSET_PATH ??= new URL(`${import.meta.env.BASE_URL}excalidraw/`, location.href).href;
  return (loading ??= import("@excalidraw/excalidraw"));
}

/** Room around a drawing's content, in the frame and in images. */
export const PADDING = 24;

/** The box around what is drawn, in the drawing's coordinates; null for nothing. */
export async function contentBounds(
  elements: ReadonlyArray<DrawingElement>,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const live = visible(elements);
  if (!live.length) return null;
  const { getCommonBounds } = await loadExcalidraw();
  const [x1, y1, x2, y2] = getCommonBounds(live as unknown as Elements);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The drawing as SVG, `PADDING` around its content. */
export async function renderSvg(
  elements: ReadonlyArray<DrawingElement>,
  dark: boolean,
): Promise<SVGSVGElement> {
  const { exportToSvg } = await loadExcalidraw();
  return exportToSvg({
    elements: visible(elements) as unknown as Elements,
    appState: { exportBackground: false, exportWithDarkMode: dark },
    files: null,
    exportPadding: PADDING,
  });
}

/** Host: a drawing frame as the agent sees it, light, at most 1600 px a side. */
export async function drawingImage(doc: Y.Doc, frameId: string): Promise<ToolImage> {
  const { exportToBlob } = await loadExcalidraw();
  const blob = await exportToBlob({
    elements: visible(readElements(doc, frameId)) as unknown as Elements,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
    files: null,
    mimeType: "image/png",
    maxWidthOrHeight: 1600,
    exportPadding: PADDING,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), mimeType: "image/png" };
}

// ---------------------------------------------------------------------------
// Agents' elements

/**
 * Host: a board tool call with an agent's `elements` or `mermaid` turned into
 * Excalidraw elements (`elements`). Other calls pass as they are.
 */
export async function prepareDrawCall(doc: Y.Doc, tool: string, args: unknown): Promise<unknown> {
  const input = (args ?? {}) as Record<string, unknown>;
  const drawing = tool === "draw" || (tool === "open_frame" && input.type === "drawing");
  if (!drawing || (input.elements === undefined && input.mermaid === undefined)) return args;
  const existing =
    tool === "draw" && typeof input.frame === "string"
      ? visible(readElements(doc, input.frame))
      : [];
  const made: DrawingElement[] = [];
  if (input.elements !== undefined)
    made.push(...(await fromSkeletons(checkSkeletons(input.elements), existing)));
  if (input.mermaid !== undefined)
    made.push(...(await fromMermaid(input.mermaid, [...existing, ...made])));
  const { mermaid: _, ...rest } = input;
  return { ...rest, elements: made };
}

/**
 * Excalidraw's elements for skeletons. Arrows may bind to shapes already
 * drawn: those go through the conversion too, and come back as they were,
 * with the new arrows among their bound elements.
 */
async function fromSkeletons(
  skeletons: Array<Record<string, unknown>>,
  existing: ReadonlyArray<DrawingElement>,
): Promise<DrawingElement[]> {
  const { convertToExcalidrawElements } = await loadExcalidraw();
  const byId = new Map(existing.map((e) => [e.id, e]));
  const targets = boundIds(skeletons).flatMap((id) => {
    const e = byId.get(id);
    if (!e) throw new Error(`an arrow binds to ${id}, which isn't drawn — view_frame lists ids`);
    return [{ type: e.type, id: e.id, x: e.x, y: e.y, width: e.width, height: e.height }];
  });
  type Skeletons = Parameters<typeof convertToExcalidrawElements>[0];
  const routed = routeArrows(skeletons, existing);
  const made = convertToExcalidrawElements([...targets, ...routed] as unknown as Skeletons, {
    regenerateIds: false,
  }) as unknown as DrawingElement[];
  const bound = new Set(targets.map((t) => t.id));
  return made.map((e) =>
    bound.has(e.id) ? { ...byId.get(e.id)!, boundElements: e.boundElements ?? null } : e,
  );
}

/** A mermaid diagram as elements, below what is drawn. */
async function fromMermaid(
  definition: unknown,
  existing: ReadonlyArray<DrawingElement>,
): Promise<DrawingElement[]> {
  if (typeof definition !== "string" || !definition.trim())
    throw new Error("mermaid must be a diagram's text");
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements }] = await Promise.all([
    import("@excalidraw/mermaid-to-excalidraw"),
    loadExcalidraw(),
  ]);
  let parsed: Awaited<ReturnType<typeof parseMermaidToExcalidraw>>;
  try {
    parsed = await parseMermaidToExcalidraw(definition, { themeVariables: { fontSize: "20px" } });
  } catch (error) {
    throw new Error(`mermaid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Object.keys(parsed.files ?? {}).length || parsed.elements.some((e) => e.type === "image"))
    throw new Error(
      "only mermaid flowcharts, sequence and class diagrams become shapes; draw others with elements",
    );
  // Mermaid breaks labels with <br>; Excalidraw with newlines.
  const breaks = (text: unknown) =>
    typeof text === "string" ? text.replace(/<br\s*\/?>/gi, "\n") : text;
  const skeletons = parsed.elements.map((e) => {
    const element = { ...e } as Record<string, unknown>;
    if ("text" in element) element.text = breaks(element.text);
    const label = element.label as { text?: unknown } | undefined;
    if (label) element.label = { ...label, text: breaks(label.text) };
    return element;
  }) as typeof parsed.elements;
  const made = convertToExcalidrawElements(skeletons, {
    regenerateIds: true,
  }) as unknown as DrawingElement[];
  const [here, there] = await Promise.all([contentBounds(existing), contentBounds(made)]);
  if (!here || !there) return made;
  const dx = here.x - there.x;
  const dy = here.y + here.h + 80 - there.y;
  return made.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
}
