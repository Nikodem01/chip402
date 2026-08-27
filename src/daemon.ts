// One process, one key, two listeners. Everything the agent can do arrives on one socket and
// everything only a human may do arrives on the other, and the daemon tells them apart by which
// listener accepted the connection. That is the entire authorization system.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import type { AssetKey, NetworkRow } from "./networks.ts";
import { networkFor } from "./networks.ts";
import { ENTITY_ID } from "./ids.ts";
import { parse } from "./money.ts";
import { dayEnd } from "./policy.ts";
import type { Plane } from "./protocol.ts";
import { MAX_LINE_BYTES, RUNTIME_DIR, fail, ok, parseLine, serialize, verbsFor } from "./protocol.ts";
import { Purse, snapshot } from "./purse.ts";
import { Labels } from "./labels.ts";
import { readJson } from "./safe.ts";
import type { Wallet } from "./wallet.ts";
import { denialReason, openWallet } from "./wallet.ts";

export type DaemonConfig = { network: NetworkRow; accountId: string | null; evmAddress: string | null };

export type DaemonOptions = {
  configPath: string;
  stateDir: string;
  runtimeDir: string;
  // Swapped for a stub in the tests, so the plane and concurrency proofs run from the checkout
  // with no install, no key and no network.
  makeWallet?: (config: { network: NetworkRow; accountId: string }, purse: Purse, labels: Labels) => Wallet;
};

export type Daemon = { spendPath: string; adminPath: string; close: () => Promise<void> };

// The first reading at boot routinely lands before DNS is up, so it is retried this often until it
// works. There is no interval after that: see the reading loop at the bottom of `start` for why an
// idle chip402 asks the mirror node nothing at all.
const CHAIN_RETRY_MS = 5_000;

// A panel, a shell, an agent or two. Anything past this is a client that has stopped closing its
// sockets or a process opening them on purpose, and either way the answer is to stop accepting
// rather than to grow the set — the daemon holding the key is not the place to run out of
// descriptors.
const MAX_CLIENTS = 64;

// Payments in the air at once. Generous — a metered API paying per request sustains this many
// divided by the seller's own latency, which is far more than a seller will serve — and it exists
// to bound fan-out and the in-flight file, not to bound spending. The allowance does that.
const MAX_IN_FLIGHT = 64;

// An unreadable, unknown-network or misshapen config is a refusal to start. "I could not tell
// which chain this purse is on" must never resolve to a guess, because the guess could be the
// real one.
export function loadConfig(path: string): DaemonConfig {
  const raw = readJson(path) as Record<string, unknown> | undefined;
  const name = typeof raw?.["network"] === "string" ? raw["network"] : "hedera:testnet";
  const network = networkFor(name);
  if (!network) throw new Error(`unknown network ${name} in ${path}`);
  const accountId = typeof raw?.["accountId"] === "string" ? raw["accountId"] : null;
  // The same shape policy.ts checks a seller's payTo against, out of ids.ts so there is one answer
  // to "what does an account id look like". Here it guards a mirror-node URL path segment:
  // /etc/chip402/config.json is root-owned, but "root wrote it" is not the same claim as "it is an
  // account id", and a path segment is the wrong place to find that out.
  if (accountId !== null && !ENTITY_ID.test(accountId)) {
    throw new Error(`accountId ${JSON.stringify(accountId)} in ${path} is not a Hedera account id`);
  }
  return {
    network,
    accountId,
    evmAddress: typeof raw?.["evmAddress"] === "string" ? raw["evmAddress"] : null,
  };
}

function assetKey(value: unknown): AssetKey {
  if (value === "usdc" || value === "hbar") return value;
  throw new Error(`unknown asset ${String(value)}`);
}

export async function start(options: DaemonOptions): Promise<Daemon> {
  const config = loadConfig(options.configPath);
  // The account goes in so the purse can tell whether the in-flight list it finds on disk was
  // written for the purse it is. `setup --import` changes that account under a running install.
  const purse = Purse.open(join(options.stateDir, "purse.json"), config.accountId);
  // Three files in this directory and three answers to "what if it cannot be read": purse.json is
  // the limits and a bad one stops the daemon (above); labels.jsonl is host names and a bad one
  // costs names; inflight.json is what we have signed and not been answered for, and a bad one is
  // assumed to commit everything until it could not possibly still be true. The table is in
  // purse.ts. On the first start after an upgrade the label store adopts whatever purse.json used
  // to carry, and purse.json stops carrying it on its next write.
  const labels = Labels.open(join(options.stateDir, "labels.jsonl"), () => purse.legacyLabels);
  const clients = new Set<Socket>();

  // Built on the first payment, not at start-up, so a machine that has been installed but not
  // yet set up still serves the panel and still answers `purse`.
  let wallet: Wallet | null = null;
  function open(): Wallet {
    if (!config.accountId) throw new Error("no account yet — run `sudo chip402ctl setup`");
    if (!wallet) {
      const make = options.makeWallet ?? openWallet;
      wallet = make({ network: config.network, accountId: config.accountId }, purse, labels);
    }
    return wallet;
  }

  // The address comes from the wallet — that is, from the key — as soon as there is one. Config
  // only supplies it in the gap before setup has finished, where setup itself derived it from
  // the key moments earlier and there is nothing yet to pay with anyway.
  const identity = () => ({
    accountId: config.accountId,
    accountWithChecksum: wallet ? wallet.accountWithChecksum : config.accountId,
    evmAddress: wallet ? wallet.evmAddress : config.evmAddress,
    verified: wallet ? wallet.verified : null,
  });
  const statusFrame = (): string => serialize(snapshot(purse, labels, config.network, identity(), Date.now()));

  // Every change pushes a fresh frame to everyone connected, which is why the panel has no
  // refresh interval and no polling loop.
  purse.watch(() => {
    const frame = statusFrame();
    for (const socket of clients) socket.write(frame);
  });

  // SECURITY: payments run alongside one another, and what makes that safe is where the day's
  // figure lives rather than anything here. `policy.decide` reads it and `Purse.authorize` raises
  // it with no `await` in between, so two payments cannot both pass against the same figure — the
  // race is closed at the only place it could open. This daemon used to run payments one at a time
  // instead, because the figure came from a mirror-node reading that lagged them; that bought
  // safety with a hard ceiling of roughly one payment every few seconds, which is not a purse that
  // can pay per request for a metered API.
  //
  // What is bounded here is fan-out, not safety: this many payments may be in the air at once, and
  // past it a caller is told so rather than queued. It keeps inflight.json small and keeps a
  // runaway agent from opening an unbounded number of sockets to sellers.
  let inFlight = 0;

  async function run(plane: Plane, command: ReturnType<typeof parseLine>): Promise<string> {
    const { id, cmd, args } = command;
    switch (cmd) {
      case "purse":
        // The same frame the panel is pushed, but carrying the request id so a client that
        // asked for it can tell it apart from an unsolicited update. Somebody asking is the other
        // signal that a reading is worth taking; the answer goes out with what we have and the
        // reading, if one is taken, arrives as a push a moment later.
        look();
        return serialize({ id, ...snapshot(purse, labels, config.network, identity(), Date.now()) });

      case "pause":
        purse.setPaused(true);
        return ok(id, { paused: true });

      case "pay": {
        const url = args["url"];
        if (typeof url !== "string") return fail(id, "pay needs a url");
        const init: RequestInit = {};
        if (typeof args["method"] === "string") init.method = args["method"];
        if (typeof args["body"] === "string") init.body = args["body"];
        if (inFlight >= MAX_IN_FLIGHT) return fail(id, `too many payments in flight — retry in a moment`);
        inFlight++;
        try {
          const result = await open().pay(url, init);
          return ok(id, {
            status: result.status,
            contentType: result.contentType,
            body: result.body,
            paid: result.paid,
            receipt: result.receipt,
          });
        } catch (error) {
          // A policy denial gets its own reason back verbatim; anything else is reported as
          // what it is, because a payment that failed for a network reason is not a denial.
          return fail(id, denialReason(error) ?? (error instanceof Error ? error.message : String(error)));
        } finally {
          inFlight--;
        }
      }

      case "resume":
        purse.setPaused(false);
        return ok(id, { paused: false });

      case "allowance":
      case "max": {
        const key = assetKey(args["asset"]);
        const asset = config.network.assets[key];
        const units = parse(String(args["amount"]), asset.decimals);
        purse.setLimit(key, cmd === "allowance" ? "allowance" : "maxPayment", units);
        return ok(id, { asset: key, amount: units.toString() });
      }

      default:
        // Unreachable: the verb was checked against the plane before we got here. Kept so that
        // adding a verb to protocol.ts without handling it fails loudly.
        return fail(id, `unhandled verb ${cmd} on the ${plane} plane`);
    }
  }

  function attach(socket: Socket, plane: Plane): void {
    // Refused rather than queued: a client that cannot be served should find that out at connect
    // time, and the set stays bounded whatever is on the other end.
    if (clients.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    const allowed = verbsFor(plane);
    clients.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    // The panel gets the current state the instant it connects, so its first paint is real — and
    // somebody connecting is the signal that a reading is now worth taking.
    socket.write(statusFrame());
    look();

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let cut: number;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line.trim() === "") continue;
        let command;
        try {
          command = parseLine(line);
        } catch {
          socket.write(fail(null, "unparseable command"));
          continue;
        }
        // SECURITY: the verb set comes from the listener that accepted this connection, never
        // from a field in the message. `{"cmd":"resume","plane":"admin"}` arriving on the spend
        // socket is an unknown verb, because on that socket "resume" simply does not exist.
        if (!allowed.includes(command.cmd)) {
          socket.write(fail(command.id, `unknown verb ${command.cmd}`));
          continue;
        }
        void run(plane, command).then(
          (reply) => socket.write(reply),
          (error) => socket.write(fail(command.id, error instanceof Error ? error.message : String(error))),
        );
      }
    });
  }

  // 0750 on the directory: the group can walk in to reach the sockets, but cannot create or
  // unlink anything, so nobody can delete the socket to force a fallback path.
  //
  // The chmod is not redundant. `mkdirSync`'s mode is subject to the umask, and the unit sets
  // `UMask=0077`, so the mkdir alone would produce 0700 — the group could not reach spend.sock at
  // all, and the panel would sit on "not permitted" for ever. In production it never gets that
  // far, because `RuntimeDirectory=chip402` with `RuntimeDirectoryMode=0750` has already created
  // the directory before node starts and the mkdir is a no-op; the chmod is what makes the
  // sentence above true off that path too, and a no-op on it. The socket modes five lines below
  // reason about the umask in exactly the same way and always did.
  mkdirSync(options.runtimeDir, { recursive: true, mode: 0o750 });
  chmodSync(options.runtimeDir, 0o750);

  function bind(name: string, mode: number, plane: Plane): Promise<Server> {
    const path = join(options.runtimeDir, name);
    rmSync(path, { force: true });
    const server = createServer((socket) => attach(socket, plane));
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(path, () => {
        // Set the mode after listen, because the umask applies at bind time. 0660 lets the
        // chip402 group spend; 0600 means uid 1000 cannot even open the admin socket.
        chmodSync(path, mode);
        resolve(server);
      });
    });
  }

  // No TCP anywhere, on purpose. A unix socket's permission bits are the whole authorization
  // scheme, and a port would replace file modes with a token system to get wrong.
  const spend = await bind("spend.sock", 0o660, "spend");
  const admin = await bind("admin.sock", 0o600, "admin");

  // When this daemon reads the chain, and — more to the point — when it does not.
  //
  // It used to ask every sixty seconds, for ever, plus twice per payment. Measured against the
  // public mirror node that is about 98 MB a day to sit idle and around 320 MB on a busy one, all
  // of it spent re-deriving a figure this process could already state: it signed every transaction
  // that moves the day's spending, and only its own key can make the balance smaller. So the
  // reading is event-driven, and the events are the ones this process cannot cause itself.
  //
  //   at start-up   what a *previous* daemon spent today, which is the one thing this one cannot
  //                 know. Retried until it lands; nothing may be paid before it does.
  //   at midnight   the day it is measured for has changed, so the figure is taken again for the
  //                 new one. One scheduled reading per day.
  //   when looked   a panel connecting or a `purse` command asks for a page, so what a human sees
  //     at          is current. Dropped by the wallet if the last reading was seconds ago.
  //   after paying  one page, so the payment shows up as a row the chain returned. Not awaited,
  //                 and not needed for any decision.
  //
  // Idle, that is nothing at all.
  let chainTimer: ReturnType<typeof setTimeout> | undefined;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;

  async function seed(): Promise<void> {
    try {
      await open().refresh();
    } catch (error) {
      console.error("chip402: chain read failed, retrying:", error instanceof Error ? error.message : error);
      chainTimer = setTimeout(() => void seed(), CHAIN_RETRY_MS);
      chainTimer.unref();
      return;
    }
    // Whatever the last daemon signed and did not stay alive to hear the answer for. Asked once
    // each here and then chased in the background until the chain answers or the deadline passes.
    await open().resume().catch(() => undefined);
  }

  function atMidnight(): void {
    // A second past it, so the reading is unambiguously taken in the new day rather than on the
    // boundary of it. `dayEnd` is local midnight, which is policy.ts's to define.
    dayTimer = setTimeout(() => {
      if (config.accountId) void open().refresh().catch(() => undefined);
      atMidnight();
    }, Math.max(1_000, dayEnd(Date.now()) + 1_000 - Date.now()));
    dayTimer.unref();
  }

  // For the display only, and safe to call as often as anything likes: the wallet drops it if the
  // last reading is recent, and no decision waits on it.
  function look(): void {
    if (!config.accountId) return;
    void open()
      .refresh(1)
      .catch(() => undefined);
  }

  if (config.accountId) {
    void seed();
    atMidnight();
  }

  return {
    spendPath: join(options.runtimeDir, "spend.sock"),
    adminPath: join(options.runtimeDir, "admin.sock"),
    close: async () => {
      if (chainTimer) clearTimeout(chainTimer);
      if (dayTimer) clearTimeout(dayTimer);
      for (const socket of clients) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => spend.close(() => resolve())),
        new Promise<void>((resolve) => admin.close(() => resolve())),
      ]);
    },
  };
}

// Started by systemd, which supplies STATE_DIRECTORY and RUNTIME_DIRECTORY along with the
// decrypted credential. Nothing here reads a path an unprivileged process could have written.
if (import.meta.main) {
  const daemon = await start({
    configPath: process.env["CHIP402_CONFIG"] ?? "/etc/chip402/config.json",
    stateDir: process.env["STATE_DIRECTORY"] ?? "/var/lib/chip402",
    runtimeDir: process.env["RUNTIME_DIRECTORY"] ?? RUNTIME_DIR,
  });
  console.error(`chip402: listening on ${daemon.spendPath} and ${daemon.adminPath}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void daemon.close().then(() => process.exit(0));
    });
  }
}

