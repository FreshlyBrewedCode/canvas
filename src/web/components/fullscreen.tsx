import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { FRAME_KINDS } from "@/components/frame-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Fullscreen } from "@/hooks/use-fullscreen";
import { addFrame, allFrames, DEFAULT_SIZE, newFrame, own, type FrameType } from "@/lib/board";
import { usePeers, useRoom } from "@/lib/room-context";
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
          title="Frame before (h, Alt + ←)"
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
          title="Frame after (l, Alt + →)"
          className={arrow}
          disabled={at >= frames.length - 1}
          onClick={() => fullscreen.step(1)}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <button
        type="button"
        title="Leave full screen (Esc)"
        data-fullscreen-exit=""
        className="text-muted-foreground hover:text-foreground rounded-lg border p-1.5"
        onClick={fullscreen.exit}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * On the edges of the frame under the mouse, shared with its neighbours, a
 * "+" that adds a frame of the row there (those after it make room) and goes to it.
 * Board space: full screen is at 100%.
 */
export function FullscreenInserts({ fullscreen }: { fullscreen: Fullscreen }) {
  const room = useRoom();
  const [hovered, setHovered] = useState<string | null>(null);
  const [menu, setMenu] = useState<"left" | "right" | null>(null);
  const { row, height } = fullscreen;

  // The last frame of the row the mouse was over: moving on to a "+" keeps it.
  useEffect(() => {
    const onOver = (event: PointerEvent) => {
      const id = (event.target as Element).closest<HTMLElement>("[data-frame]")?.dataset.frame;
      if (id) setHovered(id);
    };
    document.addEventListener("pointerover", onOver);
    return () => document.removeEventListener("pointerover", onOver);
  }, []);

  const frame = row?.frames.find((f) => f.id === hovered);
  if (!row || !frame) return null;
  const middle = row.top + (frame.type === "terminal" ? (frame.height ?? frame.h) : height) / 2;

  const insert = (side: "left" | "right", type: FrameType) => {
    setMenu(null);
    const frames = allFrames(room.doc);
    const size = { w: DEFAULT_SIZE[type].w, h: frame.h };
    const id = own(room.doc, () =>
      addFrame(room.doc, newFrame(type, frames), { anchor: frame.id, side }, size),
    );
    fullscreen.show(id);
  };

  return (
    <>
      {(["left", "right"] as const).map((side) => (
        <Popover
          key={side}
          open={menu === side}
          onOpenChange={(open) => setMenu(open ? side : null)}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-hud=""
              data-fullscreen-insert={side}
              title={`Add a frame ${side === "left" ? "before" : "after"} this one`}
              className={cn(
                "bg-card text-muted-foreground hover:text-foreground absolute z-[99998] grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border shadow-sm",
                menu === side && "text-foreground",
              )}
              style={{
                left: side === "left" ? frame.x : frame.x + frame.w,
                top: middle,
              }}
            >
              <Plus className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side={side}
            align="center"
            className="flex w-36 flex-col p-1"
            data-fullscreen-menu=""
          >
            {FRAME_KINDS.map(({ type, label, Icon }) => (
              <button
                key={type}
                type="button"
                className="hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                onClick={() => insert(side, type)}
              >
                <Icon className="text-muted-foreground size-3.5" /> {label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ))}
    </>
  );
}
