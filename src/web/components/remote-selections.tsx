import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { usePeers } from "@/lib/room-context";
import { selectionBoxes, type Box } from "@/lib/selection";

/**
 * Other people's text selections in a `data-sel-root`, drawn in their
 * colour. Place it inside the root (which must be `relative`); `version`
 * changes whenever the content does, to re-measure.
 */
export function RemoteSelections({
  frameId,
  path,
  version,
}: {
  frameId: string;
  /** For a file frame: only selections made in this file. */
  path?: string;
  version: unknown;
}) {
  const peers = usePeers();
  const anchor = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<
    Array<{ peerId: string; name: string; color: string; boxes: Box[] }>
  >([]);
  const [tick, setTick] = useState(0);

  // Frame resizes re-flow the text; re-measure.
  useEffect(() => {
    const root = anchor.current?.parentElement;
    if (!root) return;
    const observer = new ResizeObserver(() => setTick((t) => t + 1));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const root = anchor.current?.parentElement;
    if (!root) return;
    setBoxes(
      peers.flatMap((peer) => {
        const selection = peer.selection;
        if (selection?.kind !== "text" || selection.frameId !== frameId) return [];
        if (selection.path !== path) return [];
        return [
          {
            peerId: peer.user.peerId,
            name: peer.user.name,
            color: peer.user.color,
            boxes: selectionBoxes(root, selection),
          },
        ];
      }),
    );
  }, [peers, frameId, path, version, tick]);

  return (
    <div ref={anchor} className="pointer-events-none absolute inset-0" aria-hidden="true">
      {boxes.map((peer) =>
        peer.boxes.map((box, index) => (
          <div
            key={`${peer.peerId}:${index}`}
            className="absolute mix-blend-multiply dark:mix-blend-screen"
            style={{
              ...box,
              backgroundColor: `${peer.color}40`,
              borderBottom: `2px solid ${peer.color}`,
            }}
          >
            {index === 0 && (
              <span
                className="absolute -top-4 left-0 rounded-sm px-1 text-[10px] font-semibold whitespace-nowrap"
                style={{ backgroundColor: peer.color, color: "oklch(0.2 0 0)" }}
              >
                {peer.name}
              </span>
            )}
          </div>
        )),
      )}
    </div>
  );
}
