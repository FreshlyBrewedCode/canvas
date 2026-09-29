import { RotateCw } from "lucide-react";
import { useState } from "react";

import { FrameShell } from "@/components/frame-shell";
import { updateFrame, type Frame } from "@/lib/board";
import { browserTarget, typedUrl } from "@/lib/browser-url";
import { useRoom } from "@/lib/room-context";

type BrowserFrameData = Extract<Frame, { type: "browser" }>;

/**
 * A live preview of a URL. The URL is shared; the page is loaded by each
 * browser itself — so `localhost` means each viewer's own machine, and only
 * the host loads it (ADR 0004).
 */
export function BrowserFrame({ frame, readOnly }: { frame: BrowserFrameData; readOnly: boolean }) {
  const room = useRoom();
  const [reload, setReload] = useState(0);
  const target = browserTarget(frame.url);

  return (
    <FrameShell frame={frame} readOnly={readOnly}>
      <div className="flex h-full flex-col">
        <form
          className="flex items-center gap-1 border-b px-2 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            const draft = new FormData(event.currentTarget).get("url")?.toString() ?? "";
            updateFrame(room.doc, frame.id, { url: typedUrl(draft) });
          }}
        >
          <button
            type="button"
            title="Reload"
            className="text-muted-foreground hover:text-foreground p-1"
            onClick={() => setReload(reload + 1)}
          >
            <RotateCw className="size-3.5" />
          </button>
          {/* Keyed by the shared URL, so someone else navigating resets the draft. */}
          <input
            key={frame.url}
            name="url"
            aria-label="URL"
            className="bg-muted/60 min-w-0 flex-1 rounded-md px-2 py-1 font-mono text-xs outline-none"
            defaultValue={frame.url}
            readOnly={readOnly}
          />
        </form>
        {target.kind === "invalid" ? (
          <Notice>Only http and https URLs load.</Notice>
        ) : target.kind === "loopback" && !room.isHost ? (
          <Notice>
            <span className="font-mono">{target.host}</span> is on the host's machine, so only the
            host sees it here. Guests need a URL their browser can reach.
          </Notice>
        ) : (
          // Pointer events off while the board is being dragged, or the iframe swallows them.
          <iframe
            key={reload}
            title={frame.title}
            src={frame.url}
            className="min-h-0 flex-1 bg-white [[data-grabbing]_&]:pointer-events-none [[data-pan-ready]_&]:pointer-events-none"
          />
        )}
      </div>
    </FrameShell>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground p-4 text-xs">{children}</p>;
}
