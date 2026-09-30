import { Board } from "@/components/board";
import { allFrames } from "@/lib/board";
import { loadIdentity, readLink } from "@/lib/link";
import { Room } from "@/lib/room";
import { RoomContext } from "@/lib/room-context";

// One room per page load: the link cannot change without a navigation, and
// trystero hands back the same (possibly already left) room for a repeated
// `joinRoom` — so this must not live in an effect StrictMode can re-run.
const link = readLink();
const room = link ? new Room(link, loadIdentity()) : null;
// For e2e/drive.ts: the room, and the frames with their derived rects.
if (room && import.meta.env.DEV) Object.assign(window, { room, frames: () => allFrames(room.doc) });

export function App() {
  if (!room) return <Landing />;
  return (
    <RoomContext.Provider value={room}>
      <Board />
    </RoomContext.Provider>
  );
}

// The UI of a release channel speaks the protocol of that channel's CLI
// (`server/web-url.ts`); `ui.yml` builds `next` with the Vite base `/next/`.
const SERVE_COMMAND = import.meta.env.BASE_URL.startsWith("/next")
  ? "bunx @frebreco/canvas@next serve"
  : "bunx @frebreco/canvas serve";

const DOCS_URL = "https://canvas.frebreco.de";

function Landing() {
  return (
    <div className="bg-dot-grid grid h-full place-items-center p-6">
      <div className="bg-card max-w-lg space-y-4 border p-6 shadow-sm">
        <h1 className="font-mono text-lg font-semibold">canvas</h1>
        <p className="text-sm leading-relaxed">
          A multiplayer board for coding agents that run on your own machine. Start the local server
          in the project you want to work on, then open the link it prints:
        </p>
        <pre className="bg-muted/60 rounded-md p-3 font-mono text-xs">{SERVE_COMMAND}</pre>
        <p className="text-muted-foreground text-xs leading-relaxed">
          The board syncs peer to peer; only the host's browser talks to the local server. Joining
          someone else's board? Ask them for the guest link.
        </p>
        <p className="text-sm">
          <a
            href={`${DOCS_URL}/docs/quick-start`}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Quick start and docs at canvas.frebreco.de
          </a>
        </p>
      </div>
    </div>
  );
}
