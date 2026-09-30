import { ChevronLeft, ChevronRight, X } from "lucide-react";

import type { Fullscreen } from "@/hooks/use-fullscreen";
import { usePeers } from "@/lib/room-context";
import { cn } from "@/lib/utils";

/**
 * Full screen's own bar, in the top bar: a dot for each frame of the row, the
 * one we are on filled, ringed in the colours of whoever else is in full
 * screen on it, and the way out.
 */
export function FullscreenBar({ fullscreen }: { fullscreen: Fullscreen }) {
  const peers = usePeers();
  const frames = fullscreen.row?.frames;
  if (!frames) return null;
  const { current } = fullscreen;
  const at = frames.findIndex((f) => f.id === current);
  const arrow = "text-muted-foreground hover:text-foreground rounded-md p-1 disabled:opacity-30";
  return (
    <div data-fullscreen-bar="" className="ml-auto flex shrink-0 items-center gap-1.5">
      <div className="flex items-center gap-1 rounded-lg border px-1 py-0.5">
        <button
          type="button"
          title="Frame before (A, H, Alt + ←)"
          className={arrow}
          disabled={at <= 0}
          onClick={() => fullscreen.step(-1)}
        >
          <ChevronLeft className="size-4" />
        </button>
        {frames.map((f) => {
          const here = peers.filter((peer) => peer.fullscreen === f.id).map((peer) => peer.user);
          return (
            <button
              key={f.id}
              type="button"
              title={[f.title, ...here.map((user) => `${user.name} is here`)].join(" · ")}
              aria-label={f.title}
              aria-current={f.id === current || undefined}
              data-fullscreen-dot={f.id}
              data-fullscreen-dot-peers={here.map((user) => user.name).join(",") || undefined}
              className="grid size-5 place-items-center"
              onClick={() => fullscreen.show(f.id)}
            >
              <span
                className={cn(
                  "size-2 rounded-full border border-current",
                  f.id === current ? "bg-foreground text-foreground" : "text-muted-foreground",
                )}
                style={{
                  // One ring per person, outwards.
                  boxShadow: here
                    .map((user, i) => `0 0 0 ${(i + 1) * 2}px ${user.color}`)
                    .join(", "),
                }}
              />
            </button>
          );
        })}
        <button
          type="button"
          title="Frame after (D, L, Alt + →)"
          className={arrow}
          disabled={at >= frames.length - 1}
          onClick={() => fullscreen.step(1)}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <button
        type="button"
        title="Leave full screen (F)"
        data-fullscreen-exit=""
        className="text-muted-foreground hover:text-foreground rounded-lg border p-1.5"
        onClick={fullscreen.exit}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
