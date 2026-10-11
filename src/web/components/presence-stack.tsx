import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { stack } from "@/lib/presence-stack";
import type { Peer } from "@/lib/room";
import { readable } from "../../shared/identity";

/** Someone as a title names them: name, fingerprint if verified, host. */
export function who(peer: Peer) {
  const fingerprint = peer.fingerprint ? readable(peer.fingerprint) : "not verified";
  return `${peer.user.name} · ${fingerprint}${peer.user.host ? " (host)" : ""}`;
}

/**
 * Everyone else on the board, in the top bar: an avatar each, click to follow
 * their view; past a few, "+n" lists the rest.
 */
export function PresenceStack({
  peers,
  following,
  onFollow,
}: {
  peers: ReadonlyArray<Peer>;
  /** Whose view we follow. */
  following: string | null;
  onFollow: (peerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { shown, rest } = stack(peers, (peer) => peer.user.peerId === following);
  return (
    <div className="flex -space-x-1">
      {shown.map((peer) => {
        const on = peer.user.peerId === following;
        return (
          <button
            key={peer.user.peerId}
            type="button"
            aria-pressed={on}
            data-avatar={peer.user.name}
            data-fingerprint={peer.fingerprint ?? ""}
            title={`${on ? "Stop following" : "Follow"} ${who(peer)}`}
            onClick={() => onFollow(peer.user.peerId)}
            className="border-card grid size-6 place-items-center rounded-full border-2 text-[10px] font-semibold"
            style={{
              backgroundColor: peer.user.color,
              color: "oklch(0.2 0 0)",
              outline: on ? `2px solid ${peer.user.color}` : undefined,
              outlineOffset: 1,
            }}
          >
            {peer.user.name.slice(0, 1)}
          </button>
        );
      })}
      {rest.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-avatars-more={rest.length}
              aria-label={`${rest.length} more on the board`}
              className="border-card bg-secondary text-secondary-foreground grid h-6 min-w-6 place-items-center rounded-full border-2 px-1 font-mono text-[10px] font-semibold"
            >
              +{rest.length}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-1 text-xs" data-avatars-list="">
            <ul>
              {rest.map((peer) => (
                <li key={peer.user.peerId}>
                  <button
                    type="button"
                    data-avatar-row={peer.user.name}
                    title={`Follow ${who(peer)}`}
                    className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
                    onClick={() => {
                      setOpen(false);
                      onFollow(peer.user.peerId);
                    }}
                  >
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: peer.user.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {peer.user.name}
                      {peer.user.host && <span className="text-muted-foreground"> · host</span>}
                    </span>
                    <span className="text-muted-foreground font-mono">
                      {peer.fingerprint ? readable(peer.fingerprint) : "not verified"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
