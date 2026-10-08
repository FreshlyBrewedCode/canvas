import { Check, ChevronRight, ClipboardCopy, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { probeNetwork, useConnection, type ConnectionView } from "@/hooks/use-connection";
import {
  classifyJoinError,
  describeRoute,
  diagnose,
  readProbe,
  type Candidate,
  type ConnectionEvent,
  type Headline,
  type PeerInfo,
  type ProbeResult,
  type Tone,
} from "@/lib/connection";
import { useRoomState } from "@/lib/room-context";
import { cn } from "@/lib/utils";
import { PAGE_VERSION } from "@/lib/version";

/**
 * The top bar's connection indicator, and the dialog it opens: what's wrong
 * (if anything) first, then relays, peers, errors and a network test, then
 * everything else under Details — and a report to copy for whoever debugs it.
 */
export function ConnectionIndicator() {
  const room = useRoomState();
  const [open, setOpen] = useState(false);
  const view = useConnection(open);
  const headline = diagnose(view);
  const errors = view.log.filter((e) => e.level === "error");
  // Errors since the dialog was last opened.
  const [seen, setSeen] = useState(0);
  const unseen = errors.filter((e) => e.at > seen).length;

  const label = room.isHost
    ? room.serverStatus === "open"
      ? "connected to canvas serve"
      : room.serverStatus === "replaced"
        ? "host in another tab"
        : room.serverStatus === "refused"
          ? "not paired with canvas serve"
          : `canvas serve ${room.serverStatus ?? "…"}`
    : room.hostOnline
      ? "host online"
      : "waiting for host…";
  // The label says what we reach; the dot, whether anything is wrong.
  const tone: Tone =
    headline.tone === "blocked" ? "blocked" : headline.tone === "complete" ? "complete" : "ready";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setSeen(Date.now());
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          data-connection-indicator=""
          data-status={tone}
          title="Connection details"
          className="hover:bg-muted/60 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs"
        >
          <span className="size-1.5 rounded-full bg-[var(--status)]" />
          <span className="text-muted-foreground">{label}</span>
          {unseen > 0 && (
            <span
              data-status="blocked"
              className="rounded-md border border-[color-mix(in_oklch,var(--status)_45%,transparent)] bg-[color-mix(in_oklch,var(--status)_16%,transparent)] px-1.5 font-mono text-[10px] text-[var(--status)]"
            >
              {unseen} {unseen === 1 ? "error" : "errors"}
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent data-connection-dialog="">
        <ConnectionDetails view={view} headline={headline} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Guests in the lobby: what keeps us from the host, when something does, and
 * the dialog to look closer — the top bar's dot is easy to miss there.
 */
export function LobbyConnection() {
  const [open, setOpen] = useState(false);
  const view = useConnection(open);
  const headline = diagnose(view);
  if (headline.tone !== "blocked") return null;
  return (
    <div
      data-status="blocked"
      data-lobby-connection=""
      className="space-y-2 border border-l-[3px] border-[color-mix(in_oklch,var(--status)_45%,transparent)] border-l-[var(--status)] bg-[color-mix(in_oklch,var(--status)_8%,transparent)] p-3"
    >
      <p className="text-xs font-medium">{headline.title}</p>
      {headline.detail && (
        <p className="text-muted-foreground text-xs leading-relaxed">{headline.detail}</p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            Connection details
          </Button>
        </DialogTrigger>
        <DialogContent data-connection-dialog="">
          <ConnectionDetails view={view} headline={headline} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionDetails({ view, headline }: { view: ConnectionView; headline: Headline }) {
  const room = useRoomState();
  // Once per opening, and again on request: it takes a few seconds and says
  // the most about this network.
  const [probe, setProbe] = useState<ProbeResult | "running">("running");
  const [probes, setProbes] = useState(0);
  useEffect(() => {
    let current = true;
    void probeNetwork().then((result) => current && setProbe(result));
    return () => {
      current = false;
    };
  }, [probes]);
  const runProbe = () => {
    setProbe("running");
    setProbes((n) => n + 1);
  };

  const openRelays = view.relays.filter((r) => r.state === "open").length;
  const errors = view.log.filter((e) => e.level === "error").reverse();

  return (
    <>
      <div className="border-b p-4 pr-10">
        <DialogTitle className="text-sm font-semibold">Connection</DialogTitle>
        <DialogDescription className="sr-only">
          How this browser reaches canvas serve, the signalling relays and the other peers.
        </DialogDescription>
      </div>
      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        <div
          data-status={headline.tone}
          data-connection-headline={headline.tone}
          className="border border-l-[3px] border-[color-mix(in_oklch,var(--status)_45%,transparent)] border-l-[var(--status)] bg-[color-mix(in_oklch,var(--status)_8%,transparent)] p-3"
        >
          <p className="text-sm font-medium">{headline.title}</p>
          {headline.detail && (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{headline.detail}</p>
          )}
        </div>

        <Section title="Overview">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
            {view.isHost && (
              <Row label="canvas serve">
                <Pill tone={view.serveStatus === "open" ? "complete" : "blocked"}>
                  {view.serveStatus ?? "…"}
                </Pill>
              </Row>
            )}
            {!view.isHost && (
              <Row label="Host">
                <Pill tone={view.hostOnline ? "complete" : "ready"}>
                  {view.hostOnline ? "online, verified" : "not connected"}
                </Pill>
              </Row>
            )}
            <Row label={view.transport === "relay" ? "Relay" : "Signalling relays"}>
              <Pill tone={openRelays > 0 ? "complete" : view.joinedAt ? "blocked" : "pending"}>
                {openRelays} of {view.relays.length} open
              </Pill>
            </Row>
            <Row label="Network test">
              <ProbeLine probe={probe} onRun={runProbe} />
            </Row>
          </dl>
        </Section>

        <Section title={`Peers (${view.peers.length})`}>
          {view.peers.length === 0 ? (
            <p className="text-muted-foreground text-xs">Nobody connected.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-xs">
              {view.peers.map((peer) => (
                <PeerLine key={peer.peerId} peer={peer} />
              ))}
            </ul>
          )}
        </Section>

        {errors.length > 0 && (
          <Section title={`Errors (${errors.length})`}>
            <ul className="flex flex-col gap-2 text-xs">
              {errors.slice(0, 5).map((event, i) => (
                <ErrorLine key={i} event={event} />
              ))}
            </ul>
            {errors.length > 5 && (
              <p className="text-muted-foreground mt-2 text-xs">
                {errors.length - 5} more in the log under Details.
              </p>
            )}
          </Section>
        )}

        <details className="group border-t pt-3">
          <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-xs font-medium select-none">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            Details
          </summary>
          <div className="mt-3 flex flex-col gap-5">
            <Details view={view} probe={probe === "running" ? null : probe} />
          </div>
        </details>
      </div>
      <div className="flex items-center justify-between gap-3 border-t p-3">
        <p className="text-muted-foreground text-[11px]">
          The report has no keys or tokens, but has IP addresses.
        </p>
        <CopyReport
          report={() =>
            report(view, headline, probe === "running" ? null : probe, room.roomState?.version)
          }
        />
      </div>
    </>
  );
}

function Details({ view, probe }: { view: ConnectionView; probe: ProbeResult | null }) {
  const room = useRoomState();
  return (
    <>
      <Section title={view.transport === "relay" ? "Relay" : "Signalling relays"}>
        {view.relays.length === 0 ? (
          <p className="text-muted-foreground text-xs">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-[11px]">
            {view.relays.map((relay) => (
              <li key={relay.url} className="flex items-center gap-2">
                <Pill tone={relay.state === "open" ? "complete" : "blocked"}>{relay.state}</Pill>
                <span className="truncate">{relay.url}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Peer connections">
        {view.peers.length === 0 ? (
          <p className="text-muted-foreground text-xs">None.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {view.peers.map((peer) => (
              <dl
                key={peer.peerId}
                className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]"
              >
                <Row label="peer">
                  {peer.name ?? "?"} · {peer.peerId}
                  {peer.host && " (host)"}
                </Row>
                <Row label="state">
                  {peer.connectionState}, ICE {peer.iceConnectionState}
                </Row>
                {peer.route ? (
                  <>
                    <Row label="this side">{candidateText(peer.route.local)}</Row>
                    <Row label="their side">{candidateText(peer.route.remote)}</Row>
                    <Row label="round trip">{peer.route.rtt ?? "?"} ms</Row>
                    <Row label="sent / received">
                      {bytes(peer.route.bytesSent)} / {bytes(peer.route.bytesReceived)}
                    </Row>
                  </>
                ) : (
                  <Row label="route">
                    {peer.relayed ? "through canvas relay" : "no selected candidate pair yet"}
                  </Row>
                )}
              </dl>
            ))}
          </div>
        )}
      </Section>

      {probe && (
        <Section title="Network test">
          <p className="font-mono text-[11px]">
            {Object.entries(probe.candidates)
              .map(([type, n]) => `${type} ${n}`)
              .join(" · ")}{" "}
            · {probe.durationMs} ms{probe.error && ` · ${probe.error}`}
          </p>
          <p className="text-muted-foreground mt-1 text-[11px]">
            Candidates gathered against public STUN servers: host = this machine's own addresses,
            srflx = its address as the internet sees it (UDP gets out), relay = through TURN (none
            configured).
          </p>
        </Section>
      )}

      <Section title="Environment">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
          <Row label="role">{view.isHost ? "host" : "guest"}</Row>
          <Row label="transport">{view.transport ?? "not joined"}</Row>
          <Row label="peer id">{room.selfId}</Row>
          <Row label="page">{PAGE_VERSION ?? "dev"}</Row>
          <Row label="canvas serve">{room.roomState?.version ?? "?"}</Row>
          <Row label="joined">
            {view.joinedAt ? `${Math.round((view.now - view.joinedAt) / 1000)} s ago` : "not yet"}
          </Row>
          <Row label="online">{String(navigator.onLine)}</Row>
          <Row label="browser">{navigator.userAgent}</Row>
        </dl>
      </Section>

      <Section title={`Log (${view.log.length})`}>
        <ol className="flex max-h-64 flex-col gap-0.5 overflow-y-auto font-mono text-[11px]">
          {[...view.log].reverse().map((event, i) => (
            <li
              key={i}
              className={cn(
                "flex gap-2",
                event.level === "error" && "text-destructive",
                event.level === "warn" && "text-status-ready",
              )}
            >
              <span className="text-muted-foreground shrink-0">{time(event.at)}</span>
              <span className="shrink-0">{event.source}</span>
              <span className="break-all">
                {event.text}
                {event.peerId && !event.text.includes(event.peerId) && ` (${event.peerId})`}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function ProbeLine({ probe, onRun }: { probe: ProbeResult | "running"; onRun: () => void }) {
  if (probe === "running")
    return <span className="text-muted-foreground">testing whether WebRTC gets out…</span>;
  const { tone, text } = readProbe(probe);
  return (
    <span className="flex items-start gap-2" data-network-test={tone}>
      <Pill tone={tone}>{tone === "complete" ? "ok" : "blocked"}</Pill>
      <span className="text-muted-foreground">{text}</span>
      <button
        type="button"
        title="Test again"
        className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
        onClick={onRun}
      >
        <RotateCw className="size-3.5" />
      </button>
    </span>
  );
}

function PeerLine({ peer }: { peer: PeerInfo }) {
  const tone: Tone = peer.connectionState === "connected" ? "complete" : "ready";
  return (
    <li className="flex items-center gap-2">
      <Pill tone={tone}>{peer.connectionState}</Pill>
      <span className="font-medium">{peer.name ?? peer.peerId.slice(0, 6)}</span>
      {peer.host && <span className="text-muted-foreground">host</span>}
      <span className="text-muted-foreground ml-auto">
        {peer.relayed
          ? "through canvas relay"
          : peer.route
            ? `${describeRoute(peer.route)}${peer.route.rtt === undefined ? "" : ` · ${peer.route.rtt} ms`}`
            : "…"}
      </span>
    </li>
  );
}

const FAILURE: Record<ReturnType<typeof classifyJoinError>, string> = {
  password: "different room key",
  ice: "no network path",
  handshake: "handshake failed",
  other: "",
};

function ErrorLine({ event }: { event: ConnectionEvent }) {
  const kind = event.source === "peer" ? FAILURE[classifyJoinError(event.text)] : "";
  return (
    <li className="flex flex-col gap-0.5">
      <span className="text-muted-foreground font-mono text-[11px]">
        {time(event.at)} · {event.source === "serve" ? "canvas serve" : event.source}
        {kind && ` · ${kind}`}
      </span>
      <span className="text-destructive break-words">{event.text}</span>
    </li>
  );
}

function CopyReport({ report }: { report: () => unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <ClipboardCopy />} {copied ? "Copied" : "Copy report"}
    </Button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wider uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      data-status={tone}
      className="inline-block shrink-0 rounded-md border border-[color-mix(in_oklch,var(--status)_45%,transparent)] bg-[color-mix(in_oklch,var(--status)_16%,transparent)] px-2 py-0.5 font-mono text-[11px] leading-none text-[var(--status)] lowercase"
    >
      {children}
    </span>
  );
}

function candidateText(c: Candidate): string {
  const via = c.relayProtocol ? ` via ${c.relayProtocol}` : "";
  const at = c.address ? ` ${c.address}${c.port ? `:${c.port}` : ""}` : "";
  return `${c.type} ${c.protocol}${via}${at}`;
}

function bytes(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

/** Everything above as JSON, minus the link's secrets. */
function report(
  view: ConnectionView,
  headline: Headline,
  probe: ProbeResult | null,
  serveVersion: string | null | undefined,
) {
  return {
    at: new Date(view.now).toISOString(),
    headline,
    role: view.isHost ? "host" : "guest",
    transport: view.transport,
    page: PAGE_VERSION ?? "dev",
    serve: serveVersion ?? null,
    serveStatus: view.serveStatus,
    hostOnline: view.hostOnline,
    joinedSecondsAgo: view.joinedAt ? Math.round((view.now - view.joinedAt) / 1000) : null,
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    relays: view.relays,
    peers: view.peers,
    probe,
    log: view.log.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    stats: view.stats,
  };
}
