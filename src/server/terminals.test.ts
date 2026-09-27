import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { Terminals } from "./terminals";

const until = async (what: string, test: () => boolean) => {
  const end = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
};

// Markers are computed by the shell, so the echo of what we type never matches.
describe.skipIf(!Bun.which("setsid"))("Terminals", () => {
  let output = "";
  let exited = false;
  const terminals = new Terminals(
    tmpdir(),
    (_, data) => (output += data),
    () => (exited = true),
    "sh",
  );
  terminals.open("t", 80, 24);

  test("the shell leads its own session, with the PTY as its terminal", async () => {
    terminals.input("t", `[ "$(ps -o sid= -p $$)" -eq $$ ] && echo leader-$((1+1))\n`);
    terminals.input("t", "(exec 3</dev/tty) && echo tty-$((1+1))\n");
    await until("session leader", () => output.includes("leader-2"));
    await until("/dev/tty opens", () => output.includes("tty-2"));
  });

  test("Ctrl-C reaches the foreground job", async () => {
    terminals.input("t", "sleep 30; echo slept-$((1+1))\n");
    await Bun.sleep(200);
    terminals.input("t", "\x03");
    terminals.input("t", "echo back-$((1+1))\n");
    await until("prompt after Ctrl-C", () => output.includes("back-2"));
    expect(output).not.toContain("slept-2");
    terminals.input("t", "exit\n");
    await until("exit", () => exited);
  });
});
