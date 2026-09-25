/**
 * Shell sessions on a PTY (`Bun.Terminal`). Output is kept in a bounded
 * scrollback so a browser that reconnects, or a guest who joins late, can
 * replay the screen.
 */

const SCROLLBACK = 200_000;

interface Term {
  terminal: Bun.Terminal;
  scrollback: string;
}

export class Terminals {
  private readonly terms = new Map<string, Term>();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly dir: string,
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, code: number | null) => void,
  ) {}

  /** Open (or re-attach to) a terminal; returns the scrollback to replay. */
  open(id: string, cols: number, rows: number): string {
    const existing = this.terms.get(id);
    if (existing) {
      existing.terminal.resize(cols, rows);
      return existing.scrollback;
    }

    const term: Term = {
      scrollback: "",
      terminal: new Bun.Terminal({
        cols,
        rows,
        data: (_, bytes) => {
          const data = this.decoder.decode(bytes, { stream: true });
          term.scrollback = (term.scrollback + data).slice(-SCROLLBACK);
          this.onData(id, data);
        },
      }),
    };
    this.terms.set(id, term);
    const shell = process.env.SHELL ?? "bash";
    const proc = Bun.spawn([shell, "-l"], { cwd: this.dir, terminal: term.terminal, env: { ...process.env, TERM: "xterm-256color" } });
    void proc.exited.then((code) => {
      this.terms.delete(id);
      this.onExit(id, code);
    });
    return "";
  }

  input(id: string, data: string): void {
    this.terms.get(id)?.terminal.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terms.get(id)?.terminal.resize(cols, rows);
  }
}
