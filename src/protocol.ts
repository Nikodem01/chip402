// The whole contract between the daemon and everything that talks to it: newline-delimited
// JSON, and two frozen lists of verbs. There is no auth field in any frame, because authority
// is which socket accepted the connection — see daemon.ts.

import { connect } from "node:net";

// Anything running as me reaches these: my shell, my agents, the panel. Read the purse, buy
// something inside the caps, and hit the big red button.
export const SPEND_VERBS = Object.freeze(["pay", "purse", "pause"] as const);

// Only root reaches these. Every one of them changes what the spend plane is allowed to do,
// which is exactly why they are on the other side of a password.
export const ADMIN_VERBS = Object.freeze(["resume", "allowance", "max"] as const);

export type SpendVerb = (typeof SPEND_VERBS)[number];
export type AdminVerb = (typeof ADMIN_VERBS)[number];
export type Plane = "spend" | "admin";

// SECURITY: the two lists are disjoint, and `pause` sits on the cheap side alone. An agent that
// pauses the purse has only denied itself; an agent that could resume it would be the whole
// attack. Anyone can hit the button, only a human with a password restarts the line.
export function verbsFor(plane: Plane): readonly string[] {
  return plane === "admin" ? ADMIN_VERBS : SPEND_VERBS;
}

// A line long enough to be a problem is a client bug or an attack, and either way the answer is
// to drop the connection rather than to grow a buffer.
export const MAX_LINE_BYTES = 64 * 1024;

export type Command = { id: number | null; cmd: string; args: Record<string, unknown> };

export function parseLine(line: string): Command {
  const frame = JSON.parse(line) as Record<string, unknown>;
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) throw new Error("not a command object");
  const cmd = frame["cmd"];
  if (typeof cmd !== "string") throw new Error("missing cmd");
  const id = typeof frame["id"] === "number" ? frame["id"] : null;
  // SECURITY: everything except `id` and `cmd` is data for the verb. Nothing here reads a
  // "plane" field — a client that could name its own plane would be its own administrator, so
  // the field is not merely ignored, it has no code path at all.
  return { id, cmd, args: frame };
}

export function serialize(frame: unknown): string {
  return JSON.stringify(frame) + "\n";
}

export const ok = (id: number | null, extra: Record<string, unknown> = {}): string =>
  serialize({ id, ok: true, ...extra });

export const fail = (id: number | null, reason: string): string => serialize({ id, ok: false, reason });

// --- the client side of the same contract ----------------------------------------------------

export type Session = {
  // Send one command and wait for the reply with the matching id.
  ask: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>;
  // Unsolicited status frames — one on connect, one after every change. This is what makes the
  // panel live without a refresh interval.
  onStatus: (handler: (status: Record<string, unknown>) => void) => void;
  close: () => void;
};

// The CLI, the MCP server and the tests all talk to the daemon through this. It is deliberately
// tiny: correlate replies by id, hand everything else to the status handler.
export function open(path: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    // ENOENT means the daemon is not running; EACCES means this uid may not reach that plane.
    // Both are ordinary answers a CLI should print as one line, not as a stack trace.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") reject(new Error(`chip402 is not running (${path})`));
      else if (error.code === "EACCES") reject(new Error(`not permitted to reach ${path}`));
    });
    const waiting = new Map<number, (frame: Record<string, unknown>) => void>();
    const listeners: ((status: Record<string, unknown>) => void)[] = [];
    let buffer = "";
    let next = 1;
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let cut: number;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        const id = typeof frame["id"] === "number" ? frame["id"] : null;
        const pending = id === null ? undefined : waiting.get(id);
        if (pending) {
          waiting.delete(id as number);
          pending(frame);
        } else {
          for (const listener of listeners) listener(frame);
        }
      }
    });
    socket.on("connect", () =>
      resolve({
        ask: (frame) =>
          new Promise((done) => {
            const id = next++;
            waiting.set(id, done);
            socket.write(serialize({ id, ...frame }));
          }),
        onStatus: (handler) => listeners.push(handler),
        close: () => socket.destroy(),
      }),
    );
  });
}
