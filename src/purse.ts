// The purse: the limits, the kill switch, and the settling lock. That is the whole of what this
// file keeps, and it is deliberately the whole of it.
//
// What is *not* here is the thing this file used to be about. There is no counter of what has
// gone out today, no list of what was bought, and no number that moves when we sign. Those are
// facts about the chain, and a hand-written copy of a fact drifts from it: the previous build
// carried two HBAR payments made by a wallet this machine no longer holds across a
// `setup --import` and charged today's allowance for them. Nothing was attacking it. A second
// copy is a second answer.
//
// So there are three kinds of state here and each lives where it belongs:
//
//   purse.json     policy, and only policy — four numbers and a flag, set by root and changeable
//                  only over the admin socket. Unreadable ⇒ refuse to start.
//   memory         the chain's last answer, held by `observe` and thrown away on restart. The
//                  next daemon asks the mirror node again, which is the point.
//   settling.json  the lock: a transaction id and the instant it can no longer reach consensus.
//                  No amount, so it is not a ledger — see `Settling`. Unreadable ⇒ assume held.
//
// The host names used to be in this file too. They are in labels.ts now, because a file that must
// refuse to start when it cannot be read has no business also holding something that grows and is
// worthless if lost — see the table at the top of that file.

import type { AssetKey, NetworkRow } from "./networks.ts";
import { ASSET_KEYS } from "./networks.ts";
import type { Ledger, Payment } from "./chain.ts";
import { INDEXING_MARGIN_MS, VALID_DURATION_MS } from "./chain.ts";
import type { Label, Labels } from "./labels.ts";
import { dayEnd } from "./policy.ts";
import { parseUnits } from "./money.ts";
import { readJson, removeFile, writeAtomic } from "./safe.ts";
import { dirname, join } from "node:path";

// The two numbers root sets per asset, and nothing else. Both are policy: an allowance of zero
// is how an asset is switched off, and there is no separate enable flag to fall out of step
// with it.
export type Budget = {
  allowance: bigint;
  maxPayment: bigint;
};

// A transaction we have signed and not yet seen on the chain. It holds no amount, because an
// amount here would be a second copy of a number the chain already has — it holds only enough
// to ask "has this happened yet?" and to know when the answer can no longer change. A null id
// means we could not read back the bytes we signed, so only the clock can end it.
//
// SECURITY: these two fields are the only thing chip402 writes down about a payment, and the
// reason it is not the local ledger this project refuses to keep is that neither of them is a
// number the chain owns. `txId` is what we authorised, not what happened; `deadline` is arithmetic
// on it. Nothing about how much moved, or whether it did, is here — those are still questions only
// the mirror node answers.
export type Settling = {
  readonly txId: string | null;
  readonly deadline: number;
};

// The lock lives beside purse.json and not in it, for the same reason labels.jsonl does: the three
// files want three different things when they cannot be read, and the shared failure mode would
// have to be the strictest one.
//
//   purse.json     refuse to start   — "I do not know the limits" must never become "no limits"
//   labels.jsonl   carry on          — losing every host name costs rows that show account ids
//   settling.json  assume held       — a lock we cannot read is a lock we honour, for as long as
//                                      one could possibly last
//
// A `settling` key inside purse.json would also have been a third writer on a file that already has
// two — root raising a limit over the admin socket, and anyone pressing PAUSE over the spend one —
// and it would write on the payment path, which is exactly when the other two are most likely to
// arrive. An atomic rewrite of the whole file by one of them a millisecond after the other is a
// lost update.
const LOCK_FILE = "settling.json";

// How long a lock lasts, at most: the last instant Hedera would accept the transaction, plus the
// longest we are willing to assume the mirror node is behind consensus. Both halves are chain.ts's
// to define and neither is ours to choose — see INDEXING_MARGIN_MS for why the second one is not
// zero, which is the whole difference between "it can never happen" and "it can never *show*".
const LOCK_DURATION_MS = VALID_DURATION_MS + INDEXING_MARGIN_MS;

const lockPath = (pursePath: string): string => join(dirname(pursePath), LOCK_FILE);

// SECURITY: what a restart is allowed to conclude. The old build kept `settling` in memory only,
// so a daemon that went down between a signature and the mirror node catching up came back with
// the lane open, read a ledger that did not yet contain the in-flight payment, and authorised a
// second one against it — one extra payment of up to `maxPayment`, for anyone who could restart
// the unit inside the indexing window. That was demonstrated end to end; this function is the
// half of the fix that runs at start-up.
//
// Three readings and all of them fail closed:
//
//   no file            no payment was in flight. The ordinary case.
//   unreadable file    hold the lane for as long as any real lock could last. It expires on the
//                      clock within LOCK_DURATION_MS, so a corrupt file costs a bounded stretch
//                      of denial — a little over two minutes — and never an extra payment.
//   a deadline         honour it — but never for longer than a genuine lock could have run.
//                      `deadline` is always `validStart + LOCK_DURATION_MS` and `validStart` is in
//                      the past by the time it is written, so a value beyond `now + that` is
//                      damage rather than data, and clamping it is what stops a garbled number
//                      from wedging the purse for ever.
function readLock(pursePath: string, now: number): Settling | null {
  let raw: unknown;
  try {
    raw = readJson(lockPath(pursePath));
  } catch {
    return { txId: null, deadline: now + LOCK_DURATION_MS };
  }
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return raw === undefined ? null : { txId: null, deadline: now + LOCK_DURATION_MS };
  }
  const row = raw as Record<string, unknown>;
  const written = row["deadline"];
  const ceiling = now + LOCK_DURATION_MS;
  // A record whose deadline will not read is a record we do not act on beyond holding the lane:
  // the id goes with it, because using an id we cannot date could end the wait for a payment that
  // is not the one in flight. Held on the clock alone, which is the fail-closed reading.
  if (typeof written !== "number" || !Number.isFinite(written)) return { txId: null, deadline: ceiling };
  const deadline = Math.min(written, ceiling);
  // Past it, the transaction can never reach consensus, so there is nothing left to wait for.
  // This is the same exit the running daemon takes on the clock, taken one boot later.
  if (now >= deadline) return null;
  return { txId: typeof row["txId"] === "string" ? row["txId"] : null, deadline };
}

// How many payment rows the status frame carries per asset. The panel draws six and the CLI five,
// so this is headroom rather than a constraint on either — what it bounds is the frame itself.
// Today's spending is summed from every row the chain returned before this cut, so the number is
// never affected; only the list a human reads is. Without it a busy day would push the whole
// day's transactions to every connected client on every change, which is a lot of bytes to move
// so that six of them can be drawn.
const PANEL_ROWS = 20;

export type PurseState = {
  paused: boolean;
  usdc: Budget;
  hbar: Budget;
  // --- nothing below this line is in purse.json ---
  // The chain's last answer: balances, what has been spent since local midnight, and the rows
  // behind that number. Null until the mirror node has answered once, which policy.ts treats
  // as a reason to refuse rather than as a zero. Memory only: a restart asks again.
  ledger: Ledger | null;
  // Three consecutive readings, a minute apart, that the account is controlled by a different
  // key. See wallet.ts for the counting and policy.ts for what it costs. Memory only, and the
  // warning it is counting survives a restart on its own — the very first reading after one sets
  // `verified` false again. What resets is the refusal, not the alarm.
  mismatch: boolean;
  // The lock, and the one field here with a file of its own — settling.json, not purse.json.
  // See `Settling` and `readLock`.
  settling: Settling | null;
};

// bigint has no JSON representation, so the limits cross the file boundary as decimal strings of
// base units. parseUnits rejects anything that is not one, which is what turns a hand-edited
// purse.json into a refusal to start rather than a surprising limit.
function budgetToJson(budget: Budget): unknown {
  return { allowance: budget.allowance.toString(), maxPayment: budget.maxPayment.toString() };
}

// A fresh install is switched off, not switched on with a guess: absent limits read as zero, and
// a zero allowance denies every payment in both assets until a human sets one over the admin
// socket.
function budgetFromJson(raw: unknown): Budget {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    allowance: parseUnits(String(source["allowance"] ?? "0")),
    maxPayment: parseUnits(String(source["maxPayment"] ?? "0")),
  };
}

// --- one read of shapes this file no longer writes ------------------------------------------
//
// Host names used to live in purse.json: first on each receipt, later in a `labels` array. Both
// are lifted out once, handed to the label store on first start, and then gone — `persist` below
// writes neither, so the first write after an upgrade drops them for good. Only the two strings
// are taken. Not the amounts, not the counters, not whether the seller claimed it settled: the
// chain answers all three, and reading them back is exactly the mistake this rewrite removed.
function labelsFromJson(raw: unknown): Label[] {
  if (!Array.isArray(raw)) return [];
  const labels: Label[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    if (typeof entry?.["txId"] === "string" && typeof entry["host"] === "string") {
      labels.push({ txId: entry["txId"], host: entry["host"] });
    }
  }
  return labels;
}

function labelsFromLegacyReceipts(raw: Record<string, unknown> | undefined): Label[] {
  const labels: Label[] = [];
  for (const key of ASSET_KEYS) {
    const rows = (raw?.[key] as Record<string, unknown> | undefined)?.["receipts"];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      if (typeof row?.["txId"] === "string" && typeof row["host"] === "string") {
        labels.push({ txId: row["txId"], host: row["host"] });
      }
    }
  }
  return labels;
}

export class Purse {
  readonly #path: string;
  readonly #state: PurseState;
  // Host names carried out of an older purse.json, for the label store to adopt on first start.
  // Never written back, never read by anything here — see `legacyLabels`.
  readonly #carried: Label[];
  #onChange: (() => void) | undefined;

  constructor(path: string, state: PurseState, carried: Label[] = []) {
    this.#path = path;
    this.#state = state;
    this.#carried = carried;
  }

  // Missing file means a machine that has been installed but never configured: start paused with
  // nothing spendable. A file we cannot parse means something is wrong with the limits, and the
  // only safe reading of "I do not know the limits" is to refuse to run at all.
  static open(path: string): Purse {
    const raw = readJson(path) as Record<string, unknown> | undefined;
    const state: PurseState = {
      paused: raw === undefined ? true : raw["paused"] !== false,
      usdc: budgetFromJson(raw?.["usdc"]),
      hbar: budgetFromJson(raw?.["hbar"]),
      ledger: null,
      mismatch: false,
      // The one thing on this side of the line that a restart does not throw away — and the only
      // thing, which is what keeps "the chain is the ledger" true. See readLock.
      settling: readLock(path, Date.now()),
    };
    const labels = labelsFromJson(raw?.["labels"]);
    return new Purse(path, state, labels.length > 0 ? labels : labelsFromLegacyReceipts(raw));
  }

  get state(): PurseState {
    return this.#state;
  }

  // The daemon hands us a callback so every change pushes a fresh status frame to the panel.
  // That is why the panel never polls.
  watch(onChange: () => void): void {
    this.#onChange = onChange;
  }

  // What the chain last said, and whether the key check has failed often enough to matter.
  // Nothing here is written to disk: on the next start the daemon asks the mirror node again,
  // which is the point.
  //
  // SECURITY: a reading that was issued before the one we already hold is refused, however late it
  // arrives, and the caller is told so. Three things call `refresh` and nothing orders them — the
  // chain-poll loop, which is deliberately outside the payment lane, and both ends of a payment —
  // so without this the *last to complete* wins rather than the last to start. A slow read issued
  // before a payment settled could then displace a fast one issued after it, and `decide` would see
  // a `spent` that predates the payment wearing an `at` that is seconds old: every check passes and
  // the day's allowance is charged once for two payments. That is the same invariant the settling
  // lock protects, reached after the lock has legitimately opened, so it needs its own guard.
  //
  // `Ledger.at` is stamped when the requests were issued, not when they landed — see readLedger,
  // which is the half of this that makes the comparison mean anything.
  observe(ledger: Ledger, mismatch: boolean): boolean {
    const held = this.#state.ledger;
    if (held !== null && ledger.at < held.at) return false;
    this.#state.ledger = ledger;
    this.#state.mismatch = mismatch;
    this.#onChange?.();
    return true;
  }

  // SECURITY: the lane closes here, and it closes *before* a signature exists — wallet.ts takes
  // the lock on the way to the key, not on the way back. Until it reopens policy.ts denies, so a
  // payment cannot be counted twice by being made twice in the seconds before the mirror node has
  // caught up. There is no in-flight amount to track and nothing to give back if it never settles:
  // a payment that never settles simply never appears in the sum.
  //
  // Two things reopen it, and only the first is the chain: the mirror node showing the transaction,
  // and the clock passing `validStart + LOCK_DURATION_MS` — the last instant Hedera would have
  // accepted it, plus the longest the mirror node is allowed to be behind (wallet.ts asks nothing
  // to conclude that). A restart used to be a third — this was memory — and is not one any more.
  //
  // The write happens before the field is set, and it is allowed to throw. A lock only this
  // process remembers is not a lock, because the daemon that has to honour it may be the next one;
  // so if it cannot be made durable the caller is told, and it is told early enough to refuse the
  // payment rather than to fail one it has already signed. Nothing is left half-taken either way:
  // a throw here leaves the lane exactly as it was, and a crash between the write and the
  // assignment leaves a lock the next start reads.
  beginSettling(txId: string | null, validStart: number): void {
    const settling: Settling = { txId, deadline: validStart + LOCK_DURATION_MS };
    writeAtomic(lockPath(this.#path), JSON.stringify(settling) + "\n");
    this.#state.settling = settling;
    this.#onChange?.();
  }

  // The lock is released in memory first and on disk second, because the ordering that matters is
  // the fail-closed one: a crash in between leaves a lock the next start honours for the seconds
  // it has left, which costs a denial. The reverse ordering would leave the lane open in a process
  // that thinks it is shut. Removal is best-effort for the same reason — a file we cannot delete
  // is a lane that reopens on the clock, which is where it was heading anyway.
  finishSettling(): void {
    if (this.#state.settling === null) return;
    this.#state.settling = null;
    removeFile(lockPath(this.#path));
    this.#onChange?.();
  }

  // What an older purse.json had in it, for labels.ts to adopt once. Reading this is the whole
  // of the migration; nothing writes it back, so the next `persist` drops the old shape.
  get legacyLabels(): readonly Label[] {
    return this.#carried;
  }

  // Pause is on the cheap side of the fence and resume is not — that asymmetry lives in
  // daemon.ts, which decides who may call which. Both land here.
  setPaused(paused: boolean): void {
    this.#state.paused = paused;
    this.persist();
  }

  setLimit(key: AssetKey, which: "allowance" | "maxPayment", units: bigint): void {
    this.#state[key][which] = units;
    this.persist();
  }

  persist(): void {
    writeAtomic(
      this.#path,
      JSON.stringify(
        {
          paused: this.#state.paused,
          usdc: budgetToJson(this.#state.usdc),
          hbar: budgetToJson(this.#state.hbar),
        },
        null,
        2,
      ) + "\n",
    );
    this.#onChange?.();
  }
}

// Who the purse is, as opposed to what is in it. Kept together because these four are only
// meaningful as a set: an address without the account it belongs to is a place to lose money,
// and either without `verified` is a claim rather than a fact.
export type Identity = {
  accountId: string | null;
  accountWithChecksum: string | null;
  evmAddress: string | null;
  // Three states: true, false, and "cannot tell" — see readKeyMatch. The panel shows all three
  // differently, because "we checked and it is wrong" and "we could not check" are not the
  // same warning.
  verified: boolean | null;
};

function paymentToJson(payment: Payment, host: string | null): Record<string, unknown> {
  return {
    txId: payment.txId,
    at: payment.at,
    amount: payment.amount.toString(),
    payTo: payment.payTo,
    host,
  };
}

// What the panel and the CLI get to see. Bigints become strings and the network row comes along
// for the ride, so the UI can render "$0.35" and the preset ladders without knowing any asset
// ids.
//
// SECURITY: there is no branch of this function that can reach the key — the wallet does not
// appear in it at all. And every number under `spent`, `balance` and `payments` came off the
// mirror node in this process's last read; none of them is stored anywhere.
export function snapshot(
  purse: Purse,
  labels: Labels,
  network: NetworkRow,
  identity: Identity,
  now: number,
): Record<string, unknown> {
  const state = purse.state;
  const ledger = state.ledger;
  const assets: Record<string, unknown> = {};
  for (const key of ASSET_KEYS) {
    const asset = network.assets[key];
    const budget = state[key];
    assets[key] = {
      symbol: asset.symbol,
      prefix: asset.prefix,
      decimals: asset.decimals,
      minDisplayDecimals: asset.minDisplayDecimals,
      allowancePresets: asset.allowancePresets,
      maxPresets: asset.maxPresets,
      allowance: budget.allowance.toString(),
      maxPayment: budget.maxPayment.toString(),
      // Both derived, both from the chain, both null-safe: before the first mirror read there is
      // no number to show, and "0" would be a claim we have not earned.
      spent: (ledger?.spent[key] ?? 0n).toString(),
      balance: (ledger?.balances[key] ?? 0n).toString(),
      payments: (ledger?.payments ?? [])
        .filter((payment) => payment.asset === key)
        .slice(0, PANEL_ROWS)
        .map((payment) => paymentToJson(payment, labels.hostFor(payment.txId))),
    };
  }
  return {
    type: "status",
    paused: state.paused,
    network: network.caip2,
    networkLabel: network.label,
    live: network.live,
    hashscan: network.hashscan,
    accountId: identity.accountId,
    accountWithChecksum: identity.accountWithChecksum,
    // Before an account exists this is all the panel can show: an address to fund. Afterwards it
    // is how you top up. Either way it is a public address, so it is safe on both sockets — the
    // question that matters is not who can read it but where it came from.
    //
    // It comes from the key whenever there is a wallet — `openWallet` derives it and never reads
    // it back from a file. `identity()` in daemon.ts supplies `config.evmAddress` instead for as
    // long as there is no wallet, which is two situations and not one: before `setup` has finished,
    // and afterwards if `openWallet` keeps throwing — an unreadable credential, say. Both are
    // states in which nothing can be paid anyway, and the config is `root:root 0644`, so the
    // fallback is out of reach of everything this project defends against. Not "the address is
    // always the key's": the address is the key's, or there is no key to spend with.
    evmAddress: identity.evmAddress,
    accountVerified: identity.verified,
    // The key check has failed three times running: payment is refused until the purse is
    // re-imported. Sent so the panel can say so rather than leaving a red badge that gates
    // nothing.
    keyMismatch: state.mismatch,
    // Local midnight, computed rather than stored — it is a question about this machine's
    // timezone, not a number anybody has to keep in sync.
    resetsAt: dayEnd(now),
    // When the chain last answered. 0 means it never has, which is a refusal to pay and not a
    // zero balance.
    chainAt: ledger?.at ?? 0,
    settling: state.settling !== null,
    assets,
  };
}
