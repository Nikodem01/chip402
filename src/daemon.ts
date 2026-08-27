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

// Often enough that an idle panel is never stale, rarely enough that the mirror node does not
// notice us. The retry is faster because the usual cause is a boot that beat the network up.
const CHAIN_REFRESH_MS = 60_000;
const CHAIN_RETRY_MS = 5_000;

// A panel, a shell, an agent or two. Anything past this is a client that has stopped closing its
// sockets or a process opening them on purpose, and either way the answer is to stop accepting
// rather than to grow the set — the daemon holding the key is not the place to run out of
// descriptors.
const MAX_CLIENTS = 64;

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
  const purse = Purse.open(join(options.stateDir, "purse.json"));
  // Three files in this directory and three answers to "what if it cannot be read": purse.json is
  // the limits and a bad one stops the daemon (above); labels.jsonl is host names and a bad one
  // costs names; settling.json is the lock and a bad one is assumed to be held. The table is in
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

  // SECURITY: payments run one at a time through this chain. Every payment begins by reading the
  // chain and ends by waiting for its own transaction to appear there, and both of those happen
  // inside this lane — so two concurrent `pay` calls against an allowance that only covers one
  // cannot both read a ledger taken before either of them signed. The race is structurally
  // impossible rather than merely unlikely.
  let lane: Promise<unknown> = Promise.resolve();
  function inLane<T>(work: () => Promise<T>): Promise<T> {
    const next = lane.then(work, work);
    lane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function run(plane: Plane, command: ReturnType<typeof parseLine>): Promise<string> {
    const { id, cmd, args } = command;
    switch (cmd) {
      case "purse":
        // The same frame the panel is pushed, but carrying the request id so a client that
        // asked for it can tell it apart from an unsolicited update.
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
        try {
          const result = await inLane(() => open().pay(url, init));
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
    // The panel gets the current state the instant it connects, so its first paint is real.
    socket.write(statusFrame());

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

  // Nothing in this process knows what is held or what has been spent until the chain says so,
  // and the first read at boot routinely lands before DNS is up. Retry until it works, then keep
  // reading, so the panel never sits showing a zero it read once during a network outage. A
  // payment reads it too; this is what keeps an idle purse honest — and what reopens the lane
  // when a payment was signed and then never turned up.
  let chainTimer: ReturnType<typeof setTimeout> | undefined;
  async function pollChain(): Promise<void> {
    let delay = CHAIN_REFRESH_MS;
    try {
      await open().refresh();
    } catch (error) {
      delay = CHAIN_RETRY_MS;
      console.error("chip402: chain read failed, retrying:", error instanceof Error ? error.message : error);
    }
    chainTimer = setTimeout(() => void pollChain(), delay);
    chainTimer.unref();
  }
  if (config.accountId) void pollChain();

  return {
    spendPath: join(options.runtimeDir, "spend.sock"),
    adminPath: join(options.runtimeDir, "admin.sock"),
    close: async () => {
      if (chainTimer) clearTimeout(chainTimer);
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

