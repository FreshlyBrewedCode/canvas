import { Check, ChevronDown, SquarePen } from "lucide-react";
import { useState } from "react";

import { StatusDot } from "@/components/frame-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatAgo } from "@/lib/format";
import type { Conversation } from "@/lib/sessions";
import { cn } from "@/lib/utils";

/**
 * The agent frame's header chip: its agent, opening its conversations (ADR
 * 0012) — a new one, and those it had. Switching is the frame's for
 * everyone, and not while the shown one runs: the first version doesn't keep
 * a conversation going in the background.
 */
export function ConversationMenu({
  label,
  list,
  readOnly,
  busy,
  onNew,
  onShow,
}: {
  /** The agent's name. */
  label: string;
  list: ReadonlyArray<Conversation>;
  /** May not change the board: the list only. */
  readOnly: boolean;
  /** The shown conversation runs, or a prompt is on its way. */
  busy: boolean;
  onNew: () => void;
  onShow: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const locked = readOnly || busy;
  // How long ago, as of opening.
  const [now, setNow] = useState(0);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setNow(Date.now());
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-conversations=""
          title="Conversations"
          className="bg-secondary text-secondary-foreground hover:bg-accent flex shrink-0 items-center gap-0.5 rounded-md py-0.5 pr-1 pl-1.5 font-mono text-[11px] whitespace-nowrap"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {label}
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" data-conversations-popover="">
        <button
          type="button"
          data-new-conversation=""
          disabled={locked}
          className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium disabled:pointer-events-none disabled:opacity-50"
          onClick={() => {
            onNew();
            setOpen(false);
          }}
        >
          <SquarePen className="size-3.5" /> New conversation
        </button>
        {locked && (
          <p className="text-muted-foreground px-2 pb-1 text-[11px]">
            {readOnly ? "Read-only: you can't switch conversations." : "Stop the agent to switch."}
          </p>
        )}
        <div className="my-1 border-t" />
        <h3 className="text-muted-foreground px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide uppercase">
          Conversations
        </h3>
        <ul className="max-h-72 overflow-y-auto">
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-conversation={c.id}
                data-shown={c.shown ? "" : undefined}
                disabled={c.shown || locked}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  "hover:bg-accent disabled:pointer-events-none",
                  !c.shown && locked && "opacity-50",
                )}
                onClick={() => {
                  onShow(c.id);
                  setOpen(false);
                }}
              >
                <Check className={cn("size-3.5 shrink-0", !c.shown && "invisible")} />
                <span className={cn("min-w-0 flex-1 truncate", c.title === undefined && "italic")}>
                  {c.title ?? "New conversation"}
                </span>
                {c.status !== "idle" && <StatusDot status={c.status} />}
                {c.lastAt !== undefined && (
                  <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                    {formatAgo(c.lastAt, now)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
