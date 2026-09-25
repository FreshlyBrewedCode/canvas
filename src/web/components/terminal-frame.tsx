import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import { FrameShell } from "@/components/frame-shell";
import type { Frame } from "@/lib/board";
import { useRoomState } from "@/lib/room-context";

type TerminalFrameData = Extract<Frame, { type: "terminal" }>;

/**
 * A shell on the host's machine. Output is mirrored to everyone; typing is
 * the host's, or a trusted guest's (input is relayed through the host).
 * The PTY follows the host's frame size.
 */
export function TerminalFrame({
  frame,
  readOnly,
}: {
  frame: TerminalFrameData;
  readOnly: boolean;
}) {
  const room = useRoomState();
  const host = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canType = room.isHost || room.roomState?.access === "trusted";

  useEffect(() => {
    if (!host.current) return;
    const style = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: "JetBrains Mono Variable, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: "#161616",
        foreground: style.getPropertyValue("--color-neutral-200") || "#e5e5e5",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);

    let written = 0;
    const flush = () => {
      const data = room.terminal(frame.id);
      // Scrollback is trimmed from the front; if we fell behind, redraw.
      if (data.length < written) {
        term.reset();
        written = 0;
      }
      term.write(data.slice(written));
      written = data.length;
    };
    flush();
    const unsubscribe = room.subscribe(`term:${frame.id}`, flush);

    const input = term.onData((data) => {
      if (readOnly) return;
      room
        .act({ t: "term-input", id: frame.id, data })
        .catch((error: Error) => setNotice(error.message));
    });

    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (room.isHost) room.resizeTerminal(frame.id, term.cols, term.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);

    return () => {
      unsubscribe();
      input.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [room, frame.id, readOnly]);

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      status={
        !canType && <span className="text-muted-foreground font-mono text-[11px]">view only</span>
      }
    >
      <div data-frame-body="" className="h-full bg-[#161616] p-1.5">
        <div ref={host} className="h-full" />
      </div>
      {notice && (
        <button
          type="button"
          className="bg-card/90 absolute right-2 bottom-2 rounded-md border px-2 py-1 text-xs shadow-sm"
          onClick={() => setNotice(null)}
        >
          {notice}
        </button>
      )}
    </FrameShell>
  );
}
