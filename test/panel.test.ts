// The panel, against a daemon that goes away and comes back.
//
// This is the one test that runs QML, and it exists because the bug it guards was invisible to
// every other file here and cost a real afternoon: a Quickshell Socket that has once failed to
// connect stays wedged, so the panel's retry — which re-asserted `connected = true` — never
// reconnected. A single `systemctl restart chip402` left the panel showing START until the shell
// itself was restarted, and pressing START then spent a password starting a daemon that was
// already running.
//
// It drives `ui/Purse.qml` itself rather than a copy of its socket block, because a copy would
// have been written from the same wrong assumption as the bug.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { scratch, sleep } from "./support.ts";

// Quickshell is the panel's runtime, not chip402's, so a checkout without it still runs the rest
// of the suite — loudly skipped rather than silently passed.
const QS = ["/usr/local/bin/qs", "/usr/bin/qs", "/usr/local/bin/quickshell", "/usr/bin/quickshell"].find((path) =>
  existsSync(path),
);

// A stand-in for the daemon: pushes one status frame on connect, and can be taken away the way
// `systemctl stop` takes it away — live connections dropped, runtime directory removed.
function fakeDaemon(path: string, round: number): { stop: () => Promise<void> } {
  const live = new Set<Socket>();
  const server: Server = createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.write(JSON.stringify({ type: "status", round }) + "\n");
  });
  mkdirSync(join(path, ".."), { recursive: true });
  rmSync(path, { force: true });
  server.listen(path);
  return {
    stop: () =>
      new Promise((resolve) => {
        for (const socket of live) socket.destroy();
        server.close(() => {
          // systemd's RuntimeDirectory= takes the whole directory with it, so the socket file is
          // not merely dead — it is absent, which is a different error code to the panel.
          rmSync(join(path, ".."), { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

test("the panel reconnects after the daemon restarts", { skip: QS ? false : "quickshell is not installed" }, async (t) => {
  const dir = scratch();
  const runtime = join(dir, "run");
  const sock = join(runtime, "spend.sock");

  // Quickshell refuses a module path outside its config folder, so the shipping file is copied in
  // beside the harness. Copied, never reimplemented: a hand-written stand-in would have been
  // written from the same wrong assumption as the bug it is here to catch.
  const config = join(dir, "panel");
  mkdirSync(config, { recursive: true });
  copyFileSync(new URL("panel/shell.qml", import.meta.url).pathname, join(config, "shell.qml"));
  copyFileSync(new URL("../ui/Purse.qml", import.meta.url).pathname, join(config, "Purse.qml"));

  let daemon = fakeDaemon(sock, 1);
  t.after(() => daemon.stop());

  const lines: string[] = [];
  const child = spawn(QS!, ["-p", config], {
    env: { ...process.env, CHIP402_TEST_SOCK: sock },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  for (const stream of [child.stdout, child.stderr]) {
    stream!.setEncoding("utf8");
    // Quickshell colours its log output, and the escapes would otherwise be inside every match.
    stream!.on("data", (chunk: string) => lines.push(...chunk.replace(/\[[0-9;]*m/g, "").split("\n")));
  }

  const waitFor = async (match: RegExp, within: number, what: string): Promise<string> => {
    const until = Date.now() + within;
    for (;;) {
      const hit = lines.find((line) => match.test(line));
      if (hit) return hit;
      if (Date.now() > until) {
        assert.fail(`${what} — never saw ${match} in ${within}ms.\nPanel said:\n${lines.filter(Boolean).slice(-25).join("\n")}`);
      }
      await sleep(200);
    }
  };

  // 1. It connects, and the first frame is real.
  await waitFor(/PANEL live=true round=1/, 20_000, "the panel never connected at all");

  // 2. The daemon goes away. The panel must notice — a panel that keeps drawing a purse that is
  //    no longer there is worse than one that says nothing.
  await daemon.stop();
  await waitFor(/PANEL live=false/, 15_000, "the panel did not notice the daemon leaving");

  //    And it must stay away long enough for at least one retry to find nothing there. This is
  //    the whole point of the test and it took two goes to get right: with a gap shorter than the
  //    five-second retry, even the broken build reconnects, because the Socket had not yet failed
  //    a connect attempt. Error 2 is QLocalSocket::ServerNotFoundError — the socket file is gone,
  //    which is exactly what systemd's RuntimeDirectory= does on stop, and it is the state that
  //    wedges the Socket for good. A real restart is minutes; this waits for one failed attempt.
  await waitFor(/PANEL socketError=2/, 15_000, "no retry ran while the daemon was away");
  lines.length = 0;

  // 3. The daemon comes back on a fresh socket, exactly as `systemctl start` brings it back.
  //    THIS is the regression: before the fix the retry timer fired every five seconds forever
  //    and never reconnected, because re-asserting `connected` on a failed Socket does nothing.
  //    The panel sat on START — for a working daemon — until the shell was restarted.
  daemon = fakeDaemon(sock, 2);
  const back = await waitFor(/PANEL live=true round=2/, 30_000, "the panel never reconnected after the daemon came back");
  assert.match(back, /round=2/, "the panel reconnected but to a stale frame");

  // And it is genuinely linked again, not merely holding an old status object.
  await waitFor(/PANEL tick live=1 linked=1/, 10_000, "the panel shows a purse it is not connected to");
});
