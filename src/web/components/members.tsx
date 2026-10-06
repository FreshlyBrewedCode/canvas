import { Check, DoorOpen, Link2, RotateCcw, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import { LobbyConnection } from "@/components/connection-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { guestLink } from "@/lib/link";
import { useMembers, usePeers, useRoom, useRoomState, useTrusted } from "@/lib/room-context";
import { readable, readableFull } from "../../shared/identity";
import type { GuestAccess, MemberRole } from "../../shared/protocol";

/**
 * Members and the lobby (ADR 0011, decision 2): the guest link and the
 * host's member list, a guest's role, and the lobby a guest waits in. Trusted
 * (decision 4) is granted here for this host session, never saved.
 */

const ROLE: Record<MemberRole, string> = {
  view: "view only",
  edit: "can edit · runs need approval",
};

/**
 * Who comes onto the board, in one place: the guest link to invite with, and,
 * for the host, the members, their roles and trust, and resetting the link.
 * Knocks wait in the inbox (`inbox.tsx`).
 */
export function Share() {
  const room = useRoomState();
  const members = useMembers();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={room.isHost ? "default" : "outline"} data-share="">
          <UserPlus /> Share
          {room.isHost && members.length > 0 && (
            <span className="font-mono opacity-70" title="Members">
              {members.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 p-3 text-xs"
        data-share-popover=""
        // Not the link field: focused, it would show selected.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <InviteLink />
        {room.isHost && <MemberList />}
      </PopoverContent>
    </Popover>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wide uppercase">
      {children}
    </h3>
  );
}

/** The guest link: whoever opens it knocks. A fresh one each time: its relay token is. */
function InviteLink() {
  const room = useRoomState();
  const [link] = useState(() => guestLink(room.inviteRoom(), undefined, room.guestRelay()));
  const [copied, setCopied] = useState(false);
  return (
    <section>
      <Heading>Guest link</Heading>
      <p className="text-muted-foreground mb-2 leading-relaxed">
        Whoever opens it knocks, and {room.isHost ? "you let them in" : "the host lets them in"}.
      </p>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          aria-label="Guest link"
          value={link}
          className="bg-muted/60 min-w-0 flex-1 rounded-md px-2 py-1.5 font-mono text-[11px] outline-none"
          onFocus={(event) => event.target.select()}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy guest link"}
        </Button>
      </div>
    </section>
  );
}

/** Host: everyone admitted, whether they are here, their role, trusted now; remove them. */
function MemberList() {
  const room = useRoom();
  const members = useMembers();
  const trusted = new Set(useTrusted());
  const peers = usePeers();
  const here = new Set(peers.flatMap((p) => (p.fingerprint ? [p.fingerprint] : [])));
  return (
    <>
      <section className="mt-3 border-t pt-3" data-members="">
        <Heading>Members{members.length ? ` (${members.length})` : ""}</Heading>
        {members.length > 0 && (
          <p className="text-muted-foreground mb-2 leading-relaxed">
            Trusted runs without your approval and types into terminals, until this tab reloads.
          </p>
        )}
        {members.length === 0 ? (
          <p className="text-muted-foreground leading-relaxed">
            Nobody yet. Whoever you let in stays a member, and comes back without knocking.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {members.map((member) => {
              const isTrusted = trusted.has(member.fingerprint);
              return (
                <li
                  key={member.fingerprint}
                  data-member={member.name}
                  data-fingerprint={member.fingerprint}
                  data-trusted={isTrusted || undefined}
                  className="flex items-center gap-2"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${here.has(member.fingerprint) ? "bg-status-complete" : "bg-muted"}`}
                    title={here.has(member.fingerprint) ? "here now" : "not here"}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {member.name || "—"}{" "}
                    <span
                      className="text-muted-foreground font-mono"
                      title={readableFull(member.fingerprint)}
                    >
                      {readable(member.fingerprint)}
                    </span>
                    {isTrusted && (
                      <span className="bg-status-ready/15 text-status-ready ml-1.5 rounded-md px-1 py-0.5 font-mono text-[10px]">
                        trusted
                      </span>
                    )}
                  </span>
                  <select
                    aria-label={`Role of ${member.name}`}
                    className="bg-muted/60 rounded-md px-1.5 py-1 outline-none"
                    value={member.role}
                    onChange={(event) =>
                      room.setRole(member.fingerprint, event.target.value as MemberRole)
                    }
                  >
                    <option value="view">view</option>
                    <option value="edit">edit</option>
                  </select>
                  <Button
                    size="icon-sm"
                    variant={isTrusted ? "secondary" : "ghost"}
                    aria-label={
                      isTrusted ? `Take trusted back from ${member.name}` : `Trust ${member.name}`
                    }
                    aria-pressed={isTrusted}
                    title={
                      isTrusted
                        ? "Trusted for this session: take it back"
                        : "Trust for this session: runs without your approval, types into terminals"
                    }
                    onClick={() => room.trust(member.fingerprint, !isTrusted)}
                  >
                    <ShieldCheck className={isTrusted ? "text-status-ready" : undefined} />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${member.name}`}
                    title="Remove: cut off now, and the invite link is reset; with a new link they knock again"
                    onClick={() => room.removeMember(member.fingerprint)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        <p className="text-muted-foreground flex-1 leading-relaxed">
          A new guest link: members here move along, links from before lead to an empty board.
        </p>
        <Button
          size="sm"
          variant="outline"
          data-reset-link=""
          title="Members who aren't here need the new guest link; they come in without knocking"
          onClick={() => room.resetInviteLink()}
        >
          <RotateCcw /> Reset invite link
        </Button>
      </div>
    </>
  );
}

/** Guest: what the host lets us do. */
export function AccessBadge({ access }: { access: GuestAccess | null }) {
  if (!access) return null;
  return (
    <span data-access={access} className="bg-secondary rounded-md px-2 py-1 font-mono text-[11px]">
      {access === "trusted" ? "trusted" : ROLE[access]}
    </span>
  );
}

/** Guest: in place of the board until the host lets us in, or once it shut us out. */
export function Lobby() {
  const room = useRoomState();
  const { admission } = room;
  const text =
    admission === "denied"
      ? "The host didn't let you in."
      : admission === "removed"
        ? "The host removed you from this board. Reload to knock again."
        : !room.hostOnline
          ? "Waiting for the host. You knock once they're here."
          : admission === "lobby"
            ? "Waiting for the host to let you in."
            : "Knocking…";
  const shut = admission === "denied" || admission === "removed";
  return (
    <div data-lobby={admission} className="bg-dot-grid grid min-h-0 flex-1 place-items-center p-6">
      <div className="bg-card max-w-md space-y-3 border p-5 shadow-sm">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <DoorOpen className="size-4" /> {text}
        </p>
        {!shut && <LobbyConnection />}
        {!shut && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            The host sees your name and this browser's fingerprint,{" "}
            <span className="text-foreground font-mono" data-lobby-fingerprint="">
              {readableFull(room.fingerprint)}
            </span>
            . Tell them it's you.
          </p>
        )}
      </div>
    </div>
  );
}
