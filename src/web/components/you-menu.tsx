import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESENCE, saveIdentity, type Identity } from "@/lib/link";
import { useRoomState } from "@/lib/room-context";
import { cn } from "@/lib/utils";
import { readable, readableFull } from "../../shared/identity";
import type { GuestAccess } from "../../shared/protocol";

/** What each access lets a guest do, said once. */
const ACCESS: Record<GuestAccess, { label: string; says: string }> = {
  view: {
    label: "view only",
    says: "You see the board and everyone on it, but can't change it. The host can let you edit.",
  },
  edit: {
    label: "can edit",
    says: "You change the board. Prompts, agent settings and terminal input wait for the host to approve them.",
  },
  trusted: {
    label: "trusted",
    says: "You change the board, and your runs and terminal input go ahead without the host's approval, until their tab reloads.",
  },
};

/**
 * Us, at the top bar's end: our avatar, ringed, opening our name, colour and
 * fingerprint, and for a guest what the host lets us do. A view-only guest
 * also gets a chip beside it: it says why editing does nothing.
 */
export function YouMenu() {
  const room = useRoomState();
  // Ours alone: `rename` changes the room's in place, so this re-renders us.
  const [identity, setIdentity] = useState<Identity>(() => ({ ...room.identity }));
  const [name, setName] = useState(identity.name);
  const access = room.isHost ? null : room.access;

  const change = (next: Identity) => {
    setIdentity(next);
    saveIdentity(next);
    room.rename(next);
  };
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(identity.name);
    else if (trimmed !== identity.name) change({ ...identity, name: trimmed });
  };

  return (
    <div className="flex items-center gap-2">
      {access === "view" && (
        <span
          data-access-chip=""
          title={ACCESS.view.says}
          className="bg-secondary rounded-md px-2 py-1 font-mono text-[11px]"
        >
          view only
        </span>
      )}
      <Popover onOpenChange={(open) => !open && commitName()}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`You: ${identity.name}`}
            title={`You: ${identity.name} · ${readable(room.fingerprint)}`}
            data-you=""
            data-fingerprint-self={room.fingerprint}
            data-access={access ?? undefined}
            className="ring-foreground/70 ring-offset-card grid size-6 place-items-center rounded-full text-[10px] font-semibold ring-2 ring-offset-1"
            style={{ backgroundColor: identity.color, color: "oklch(0.2 0 0)" }}
          >
            {identity.name.slice(0, 1)}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-88 space-y-3 p-3 text-xs"
          data-you-menu=""
          // Opened as often to read the fingerprint as to rename: no field focused.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Field label="Your name">
            <input
              aria-label="Your name"
              className="bg-muted/60 w-full rounded-md border-l-[3px] px-2 py-1.5 outline-none"
              style={{ borderLeftColor: identity.color }}
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitName();
              }}
            />
          </Field>
          <Field label="Your colour">
            <div className="flex gap-1.5">
              {PRESENCE.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-pressed={color === identity.color}
                  aria-label={`Colour ${color}`}
                  data-color={color}
                  onClick={() => change({ ...identity, color })}
                  className={cn(
                    "size-5 rounded-full",
                    color === identity.color &&
                      "ring-foreground ring-offset-popover ring-2 ring-offset-1",
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </Field>
          <Field label="Your fingerprint">
            <Fingerprint fingerprint={room.fingerprint} />
            <p className="text-muted-foreground mt-1 leading-relaxed">
              This browser's, and the same on every board. The host sees it when you knock; others,
              on your pointer.
            </p>
          </Field>
          {access && (
            <Field label="What you may do">
              <p className="leading-relaxed" data-you-access={access}>
                <span className="bg-secondary mr-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px]">
                  {ACCESS[access].label}
                </span>
                {ACCESS[access].says}
              </p>
            </Field>
          )}
          {room.isHost && (
            <p className="text-muted-foreground border-t pt-3 leading-relaxed">
              You host this board: its agents, files and terminals are on your machine.
            </p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

function Fingerprint({ fingerprint }: { fingerprint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex-1 font-mono whitespace-nowrap" data-you-fingerprint="">
        {readableFull(fingerprint)}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Copy fingerprint"
        onClick={() => {
          void navigator.clipboard.writeText(readableFull(fingerprint));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
