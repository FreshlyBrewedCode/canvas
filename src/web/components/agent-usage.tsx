import { Gauge } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { sessionTotals, type Turn } from "@/lib/thread";
import { cn } from "@/lib/utils";
import type { ContextUsage } from "../../shared/protocol";

/** A turn's time, live while it runs, and the tokens it took once it has. */
export function TurnFooter({ turn }: { turn: Turn }) {
  const now = useNow(!turn.end);
  const ended = turn.end?.at;
  if (turn.end && !ended && !turn.usage) return null;
  const time = turn.end ? (ended ? ended - turn.at : null) : now - turn.at;
  const usage = turn.usage;
  return (
    <p
      data-turn-footer={turn.end ? "done" : "running"}
      className={cn("text-muted-foreground font-mono text-[11px]", !turn.end && "animate-pulse")}
      title={
        usage &&
        [
          `${usage.input.toLocaleString()} in`,
          ...(usage.cached ? [`${usage.cached.toLocaleString()} cached`] : []),
          `${usage.output.toLocaleString()} out${usage.reasoning ? ` (${usage.reasoning.toLocaleString()} reasoning)` : ""}`,
        ].join(" · ")
      }
    >
      {[
        !turn.end && "working",
        time !== null && formatDuration(time),
        usage && `${formatTokens(usage.total)} tokens`,
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/** The time now, every second while `live`. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * How full the agent's context is, as a ring left of Send; a gauge instead
 * when the agent doesn't say. Hovering or clicking it shows the session's
 * usage. Nothing at all before there is any.
 */
export function UsageRing({
  usage,
  turns,
}: {
  usage: ContextUsage | undefined;
  turns: ReadonlyArray<Turn>;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const totals = sessionTotals(turns);
  if (!usage?.size && !totals.total) return null;

  const share = usage?.size ? Math.min(1, usage.used / usage.size) : null;
  const hover = {
    onPointerEnter: () => {
      clearTimeout(leave.current);
      setOpen(true);
    },
    onPointerLeave: () => {
      leave.current = setTimeout(() => !pinned.current && setOpen(false), 150);
    },
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        pinned.current = next;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-usage-ring={share === null ? "" : Math.round(share * 100)}
          aria-label="Session usage"
          className="text-muted-foreground hover:text-foreground grid size-7 shrink-0 place-items-center rounded-md"
          onClick={(event) => {
            // Ours, not the trigger's toggle: a click keeps it open past the hover; another closes it.
            event.preventDefault();
            pinned.current = !pinned.current || !open;
            setOpen(pinned.current);
          }}
          {...hover}
        >
          {share === null ? <Gauge className="size-4" /> : <Ring share={share} />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-64 p-3 text-xs"
        data-usage-popover=""
        onOpenAutoFocus={(event) => event.preventDefault()}
        {...hover}
      >
        {usage?.size ? (
          <section className="mb-3 space-y-1.5">
            <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
              Context
            </h3>
            <p className="font-mono">
              {formatTokens(usage.used)} / {formatTokens(usage.size)}{" "}
              <span className="text-muted-foreground">({Math.round(share! * 100)}%)</span>
            </p>
            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
              <div
                className={cn("h-full rounded-full", tone(share!))}
                style={{ width: `${share! * 100}%` }}
              />
            </div>
          </section>
        ) : null}
        <section className="space-y-1">
          <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
            Session
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-muted-foreground">prompts</dt>
            <dd>{totals.turns}</dd>
            {totals.time > 0 && (
              <>
                <dt className="text-muted-foreground">working</dt>
                <dd>{formatDuration(totals.time)}</dd>
              </>
            )}
            {totals.total > 0 && (
              <>
                <dt className="text-muted-foreground">input</dt>
                <dd>{formatTokens(totals.input)}</dd>
                {totals.cached > 0 && (
                  <>
                    <dt className="text-muted-foreground">cached</dt>
                    <dd>{formatTokens(totals.cached)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">output</dt>
                <dd>
                  {formatTokens(totals.output)}
                  {totals.reasoning > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {formatTokens(totals.reasoning)} reasoning
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">total</dt>
                <dd>{formatTokens(totals.total)} tokens</dd>
              </>
            )}
            {usage?.cost && (
              <>
                <dt className="text-muted-foreground">cost</dt>
                <dd>{formatCost(usage.cost.amount, usage.cost.currency)}</dd>
              </>
            )}
          </dl>
        </section>
      </PopoverContent>
    </Popover>
  );
}

const tone = (share: number) =>
  share > 0.85 ? "bg-status-blocked" : share > 0.6 ? "bg-status-ready" : "bg-status-pending";

function Ring({ share }: { share: number }) {
  const r = 7;
  const length = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90">
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        className="stroke-muted-foreground/25"
      />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.5, share * length)} ${length}`}
        className={cn(
          share > 0.85
            ? "stroke-status-blocked"
            : share > 0.6
              ? "stroke-status-ready"
              : "stroke-status-pending",
        )}
      />
    </svg>
  );
}
