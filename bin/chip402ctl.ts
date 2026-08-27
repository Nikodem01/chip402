#!/usr/bin/env node
// The privileged CLI. It is installed root-owned to /usr/local/bin/chip402ctl and is the only
// thing sudo and polkit will run, so an agent cannot rewrite it and wait for me to type a
// password. Three kinds of thing live here and nothing else: the admin verbs, which reach the
// admin socket; `setup`, the one place in the whole project that submits a transaction to Hedera;
// and `start`, which execs `systemctl start chip402` and moves nothing — it is routed through this
// binary only so that the panel's START button raises a polkit dialog that names chip402 instead
// of the generic "run a program as another user". See the comment on that branch.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AccountId,
  Hbar,
  PrivateKey,
  TransactionId,
  TransferTransaction,
  createHederaClient,
} from "@x402/hedera";
import { networkFor } from "../src/networks.ts";
import type { NetworkRow } from "../src/networks.ts";
// SECURITY-adjacent, and mostly a kindness: importing a key that does not control the account
// you named produces a purse that looks fine and cannot pay for anything, with no explanation.
// Say so here instead. It lives beside the daemon's own key check, and the comment there sets
// out why the two answer an unrecognised key shape differently on purpose.
import { controlsAccount } from "../src/chain.ts";
import type { ChainAccount } from "../src/chain.ts";
import { adminSocket, open } from "../src/protocol.ts";

// A daemon that is not running, or a socket this uid cannot reach, is an ordinary answer.
process.on("unhandledRejection", (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const CONFIG = process.env["CHIP402_CONFIG"] ?? "/etc/chip402/config.json";
const STATE = "/var/lib/chip402";
// Hedera's fee-collection account. Completion needs the new account to pay for one transaction
// and sign it; one tinybar to an account that certainly exists is the smallest such transaction.
const TREASURY = "0.0.98";

// SECURITY: without this, an agent could run chip402ctl as itself and reach the admin verbs.
// The socket mode would still stop it, but a tool that only works as root is one fewer thing to
// reason about — and it is the reason `sudo chip402ctl` is a boundary rather than a habit.
if (process.geteuid?.() !== 0) {
  console.error("chip402ctl must run as root: try `sudo chip402ctl …`");
  process.exit(1);
}

const [verb, ...rest] = process.argv.slice(2);

async function admin(frame: Record<string, unknown>): Promise<void> {
  const session = await open(adminSocket());
  try {
    const reply = await session.ask(frame);
    if (reply["ok"] !== true) {
      console.error(`refused: ${reply["reason"]}`);
      process.exitCode = 1;
    } else {
      console.log("done.");
    }
  } finally {
    session.close();
  }
}

function readNetwork(): NetworkRow {
  const name = process.env["CHIP402_NETWORK"] ?? "hedera:testnet";
  const network = networkFor(name);
  if (!network) throw new Error(`unknown network ${name}`);
  return network;
}

// The key crosses exactly one process boundary, on a pipe, and lands as ciphertext. Never argv
// — that is world-readable in /proc — never an environment variable, and never a file I own.
function seal(keyDer: string): void {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  execFileSync(
    "systemd-creds",
    ["encrypt", "--name=chip402-key", "--with-key=host+tpm2", "-", `${STATE}/key.cred`],
    { input: keyDer, stdio: ["pipe", "inherit", "inherit"] },
  );
  execFileSync("chmod", ["0400", `${STATE}/key.cred`]);
}

async function mirror(network: NetworkRow, id: string): Promise<Record<string, any> | null> {
  const response = await fetch(`${network.mirror}/api/v1/accounts/${id}`, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`mirror node said ${response.status}`);
  return (await response.json()) as Record<string, any>;
}

// root:root 0644 — readable so the panel and CLI can see which network they are on, writable by
// nobody but root, because the network is the difference between play money and real money.
function writeConfig(network: string, accountId: string | null, evmAddress: string): void {
  mkdirSync("/etc/chip402", { recursive: true, mode: 0o755 });
  writeFileSync(CONFIG, JSON.stringify({ network, accountId, evmAddress }, null, 2) + "\n", { mode: 0o644 });
}

// A private key must never land in terminal scrollback, so this reads it with the echo off.
// A pipe is the scripted path — `sudo chip402ctl setup --import < key.txt` — and has nothing to
// hide, so it is read straight through.
function readKeyQuietly(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (data += chunk));
      stdin.on("end", () => resolve(data.trim()));
      stdin.on("error", reject);
    });
  }
  // SECURITY: raw mode, and nothing is echoed. readline would print the key into the scrollback
  // of a terminal that is very likely being recorded by something.
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let typed = "";
    const finish = (value: string | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (value === null) reject(new Error("cancelled"));
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(typed);
        if (ch === "\u0003") return finish(null);
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// People paste whatever their wallet gave them, which is DER hex about half the time and a raw
// key the rest. Try each spelling rather than making them find out which one this is.
function parseKey(text: string): PrivateKey {
  const spellings = [
    (t: string) => PrivateKey.fromStringDer(t),
    (t: string) => PrivateKey.fromStringECDSA(t),
    (t: string) => PrivateKey.fromStringED25519(t),
  ];
  for (const parse of spellings) {
    try {
      return parse(text);
    } catch {
      // Try the next spelling.
    }
  }
  throw new Error("that is not a private key I can read (DER hex, or a raw ECDSA/ED25519 key)");
}

// Only an ECDSA key has one. ED25519 accounts are perfectly usable here, they just have no EVM
// address to fund from a wallet.
function evmAddressOf(key: PrivateKey): string | null {
  try {
    return key.publicKey.toEvmAddress();
  } catch {
    return null;
  }
}

async function mirrorAccountsByKey(network: NetworkRow, publicKeyHex: string): Promise<Record<string, any>[]> {
  const response = await fetch(`${network.mirror}/api/v1/accounts?account.publickey=${publicKeyHex}&limit=5`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  return ((await response.json()) as { accounts?: Record<string, any>[] }).accounts ?? [];
}

// Find the account this key already controls. Given an id, verify it; given none, discover it —
// so "I think I still have that testnet account somewhere" is one command and no homework.
async function resolveImported(network: NetworkRow, key: PrivateKey, wanted: string | null): Promise<string> {
  const publicKeyHex = key.publicKey.toStringRaw();
  const evmAddress = evmAddressOf(key);
  const found = new Map<string, Record<string, any>>();
  for (const account of await mirrorAccountsByKey(network, publicKeyHex)) {
    found.set(String(account["account"]), account);
  }
  if (evmAddress) {
    const byAlias = await mirror(network, `0x${evmAddress}`);
    if (byAlias) found.set(String(byAlias["account"]), byAlias);
  }

  if (wanted) {
    const account = found.get(wanted) ?? (await mirror(network, wanted));
    if (!account) throw new Error(`${wanted} does not exist on ${network.label}`);
    if (!controlsAccount(account as ChainAccount, publicKeyHex, evmAddress)) {
      throw new Error(`that key does not control ${wanted} — chip402 would never be able to pay from it`);
    }
    return wanted;
  }

  const ids = [...found.keys()];
  if (ids.length === 0) {
    throw new Error(`no account on ${network.label} uses that key — pass the id explicitly with --import <accountId>`);
  }
  if (ids.length > 1) {
    throw new Error(`that key controls ${ids.join(", ")} — say which one: --import <accountId>`);
  }
  return ids[0]!;
}

// The one transaction this project ever submits, and only when the account still needs it. An
// auto-created account is hollow — an id and an EVM address, no key on record — and the
// facilitator refuses every payment until the key is on file. Completion is: be the fee payer,
// and sign with your own key.
async function completeAccount(network: NetworkRow, key: PrivateKey, accountId: string): Promise<void> {
  const client = createHederaClient(network.caip2);
  try {
    const payer = AccountId.fromString(accountId);
    const transaction = new TransferTransaction()
      .addHbarTransfer(payer, Hbar.fromTinybars(-1))
      .addHbarTransfer(AccountId.fromString(TREASURY), Hbar.fromTinybars(1))
      .setTransactionId(TransactionId.generate(payer))
      .freezeWith(client);
    const signed = await transaction.sign(key);
    const response = await signed.execute(client);
    await response.getReceipt(client);
  } finally {
    client.close();
  }
}

function reportBalances(network: NetworkRow, account: Record<string, any>): void {
  const tinybars = BigInt(account["balance"]?.balance ?? 0);
  const usdc = (account["balance"]?.tokens ?? []).find((t: Record<string, any>) => t["token_id"] === network.assets.usdc.id);
  console.log(`  holds .................. ${Hbar.fromTinybars(tinybars.toString()).toString()}`);
  if (usdc) console.log(`  and .................... ${Number(usdc["balance"]) / 1e6} USDC`);
}

async function setup(): Promise<void> {
  const network = readNetwork();
  const importAt = rest.indexOf("--import");
  const importing = importAt !== -1;
  // `--import` on its own is allowed: the account is discovered from the key.
  const wanted = importing ? (rest[importAt + 1] ?? null) : null;

  let key: PrivateKey;
  let accountId: string;
  let evmAddress: string;

  if (importing) {
    // An account you already have, with money already in it. No key is generated and nothing is
    // transmitted — the key you paste is sealed to this machine's TPM and then forgotten.
    key = parseKey(await readKeyQuietly("paste the private key for that account (nothing is echoed): "));
    accountId = await resolveImported(network, key, wanted);
    evmAddress = evmAddressOf(key) ?? "";
    seal(key.toStringDer());
    console.log(`  key      imported, sealed to the TPM at ${STATE}/key.cred`);
    console.log(`  account  ${accountId}${evmAddress ? `  (0x${evmAddress})` : ""}`);
  } else {
    // SECURITY: generated here, on this machine, and never transmitted. A portal-generated key
    // is a key a web server has seen; that is fine for a throwaway demo and disqualifying for
    // anything that will ever hold real money. Uniqueness per install falls out of it for free.
    key = PrivateKey.generateECDSA();
    evmAddress = evmAddressOf(key) ?? "";
    accountId = "";
    seal(key.toStringDer());
    console.log(`  key      generated locally, sealed to the TPM at ${STATE}/key.cred`);
    console.log(`  address  0x${evmAddress}`);
  }

  // Written before the wait, not after it, so the panel can show the address and its QR while
  // you are still funding — which is the whole point of putting a QR on screen.
  writeConfig(network.caip2, accountId || null, evmAddress);

  if (!importing) {
    console.log("");
    // A QR because funding happens on a phone, at the faucet or from an exchange. Same flow on
    // mainnet — a different funding source, not a different command.
    spawnSync("qrencode", ["-t", "UTF8", "-m", "2", `0x${evmAddress}`], { stdio: "inherit" });
    console.log(`\n  fund this address on ${network.label}, then leave this running`);
    process.stdout.write("  waiting for funds ");
    let account: Record<string, any> | null = null;
    while (account === null) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      process.stdout.write(".");
      account = await mirror(network, `0x${evmAddress}`);
    }
    accountId = String(account["account"]);
    console.log(` found`);
  }

  const account = await mirror(network, accountId);
  if (account && (account["key"] === null || account["key"] === undefined)) {
    process.stdout.write("  completing account ");
    await completeAccount(network, key, accountId);
    console.log(`... ${accountId}`);
  }

  const settled = await mirror(network, accountId);
  if (settled) {
    reportBalances(network, settled);
    console.log(`  auto-association ....... ${settled["max_automatic_token_associations"] ?? "unknown"}`);
  }

  writeConfig(network.caip2, accountId, evmAddress);
  console.log(`\n  ready — ${accountId} on ${network.label}.`);
  // The purse deliberately starts paused with a zero allowance: an install that could spend
  // before anyone chose an amount would be the wrong default in the one direction that costs
  // money. The panel is where those two taps happen.
  console.log("  the purse is paused with no allowance yet — set both from the chip402 panel.");
  console.log("  then: sudo systemctl restart chip402");
}

if (verb === "setup") {
  await setup();
} else if (verb === "start") {
  // The panel's START button, routed through this binary rather than straight at systemd. It
  // moves nothing and changes no limit; what it buys is the polkit dialog. `pkexec systemctl
  // start chip402` matches no action of ours, so polkit falls back to
  // org.freedesktop.policykit.exec and asks "Authentication is required to run a program as
  // another user" — which explains nothing, and reads exactly the same as `pkexec` of anything
  // else. Going through chip402ctl means the prompt names what it is for, and it means every
  // privileged thing the panel can ask for is bound by exec.path to this one root-owned file.
  // The generic prompt is then always anomalous, instead of being the normal case for START.
  execFileSync("systemctl", ["start", "chip402"], { stdio: "inherit" });
  console.log("done.");
} else if (verb === "resume") {
  await admin({ cmd: "resume" });
} else if (verb === "allowance" || verb === "max") {
  const [asset, amount] = rest;
  if (!asset || !amount) {
    console.error(`usage: chip402ctl ${verb} <usdc|hbar> <amount>`);
    process.exit(2);
  }
  // Setting an allowance to 0 is how an asset is switched off. There is no separate enable
  // flag, so there is no way for the two to disagree.
  await admin({ cmd: verb, asset, amount });
} else {
  console.error("usage: chip402ctl setup [--import [<accountId>]] | start | resume | allowance <usdc|hbar> <amt> | max <usdc|hbar> <amt>");
  process.exit(2);
}
