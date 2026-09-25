import { Board } from "@/components/board";
import { loadIdentity, readLink } from "@/lib/link";
import { Room } from "@/lib/room";
import { RoomContext } from "@/lib/room-context";

// One room per page load: the link cannot change without a navigation, and
// trystero hands back the same (possibly already left) room for a repeated
// `joinRoom` — so this must not live in an effect StrictMode can re-run.
const link = readLink();
const room = link ? new Room(link, loadIdentity()) : null;
if (room && import.meta.env.DEV) Object.assign(window, { room });

export function App() {
  if (!room) return <Landing />;
  return (
    <RoomContext.Provider value={room}>
      <Board />
    </RoomContext.Provider>
  );
}

function Landing() {
  return (
    <div className="bg-dot-grid grid h-full place-items-center p-6">
      <div className="bg-card max-w-lg space-y-4 border p-6 shadow-sm">
        <h1 className="font-mono text-lg font-semibold">canvas</h1>
        <p className="text-sm leading-relaxed">
          A multiplayer board for coding agents that run on your own machine. Start the local server
          in the project you want to work on, then open the link it prints:
        </p>
        <pre className="bg-muted/60 rounded-md p-3 font-mono text-xs">
          bunx canvas serve --dir .
        </pre>
        <p className="text-muted-foreground text-xs leading-relaxed">
          The board syncs peer to peer; only the host's browser talks to the local server. Joining
          someone else's board? Ask them for the guest link.
        </p>
      </div>
    </div>
  );
}
