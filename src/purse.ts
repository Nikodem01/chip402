// The purse: the limits, the kill switch, the day's figure, and the payments still in the air.
//
// The day's figure is a number this file keeps, and the previous build kept one too and got it
// wrong — it carried two HBAR payments made by a wallet this machine no longer held across a
// `setup --import` and charged a fresh account's allowance for them. Nothing was attacking it. So
// the difference is worth being exact about, because "we keep a number again" is the sentence that
// deserves the most suspicion in this file:
//
//   then                                    now
//   in purse.json, written on every payment  in memory, gone on restart
//   nothing said which account it was for    tagged with the account and the local day, and
//                                            discarded rather than carried when either changes
//   nothing ever re-derived it               seeded from the chain at start-up and at midnight,
//                                            and raised by a chain reading, never by arithmetic
//                                            alone
//
// What is on disk is not that figure. It is the list of payments signed in the last two minutes
// that the chain has not answered for yet, and every entry in it expires — see `Authorization`.
//
// So there are three kinds of state here and each lives where it belongs:
//
//   purse.json     policy, and only policy — four numbers and a flag, set by root and changeable
//                  only over the admin socket. Unreadable ⇒ refuse to start.
//   memory         the chain's last answer and the day's running figure, thrown away on restart.
//                  The next daemon asks the mirror node again, which is the point.
//   inflight.json  payments we have signed and the chain has not yet shown us. Every entry dies
//                  within a little over two minutes of being written — see `Authorization`.
//                  Unreadable ⇒ assume the whole allowance is committed until then.
//
// The host names used to be in this file too. They are in labels.ts now, because a file that must
// refuse to start when it cannot be read has no business also holding something that grows and is
// worthless if lost — see the table at the top of that file.

import type { AssetKey, NetworkRow } from "./networks.ts";
import { ASSET_KEYS } from "./networks.ts";
import type { Ledger, Payment } from "./chain.ts";
import { INDEXING_MARGIN_MS, VALID_DURATION_MS } from "./chain.ts";
import type { Label, Labels } from "./labels.ts";
import { committed, dayEnd } from "./policy.ts";
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

// One payment we have authorised and the chain has not yet shown us. It is not a receipt and not
// a ledger entry: it is a claim about what *we did*, which is the one kind of fact this process is
// entitled to know before the mirror node does.
//
// SECURITY: this is the only thing chip402 writes to disk about a payment, and what makes it safe
// is that it cannot outlive its own question. `deadline` is `validStart` plus the last moment
// Hedera would accept the transaction plus the longest the mirror node may be behind consensus —
// so every entry here is resolved, one way or the other, within a little over two minutes of being
// written. Nothing in this file can walk into another day or another account, because nothing in
// it lives long enough to try. That is the exact failure the previous build had: a `spent` figure
// kept in purse.json with no account on it and nothing that ever re-derived it, which charged a
// freshly imported account for an older wallet's spending.
//
// A null `txId` means we could not read back the bytes we signed. Then only the deadline can end
// it, and wallet.ts re-reads the day before letting go — the fail-closed reading of "we do not know
// what we just signed".
export type Authorization = {
  readonly asset: AssetKey;
  readonly amount: bigint;
  txId: string | null;
  deadline: number;
};

// What has gone out today, as this daemon knows it — the chain's figure for the day, plus every
// payment of ours the chain has since confirmed and has not been asked about again.
//
// SECURITY: the two tags are not bookkeeping. A figure is only ever applied to the account and the
// local day it was measured for; anything else is discarded and re-read rather than carried over.
// policy.ts checks both again before it will spend against this, so the rule is visible in the
// pure function that makes the decision rather than only here.
export type Spent = {
  readonly accountId: string;
  readonly dayStart: number;
  readonly totals: Readonly<Record<AssetKey, bigint>>;
};

// The in-flight list lives beside purse.json and not in it, for the same reason labels.jsonl does:
// the three files want three different things when they cannot be read, and a shared file would
// have to take the strictest of them.
//
//   purse.json     refuse to start   — "I do not know the limits" must never become "no limits"
//   labels.jsonl   carry on          — losing every host name costs rows that show account ids
//   inflight.json  assume committed  — a list we cannot read is a list we honour, for as long as
//                                      any entry in it could possibly have lasted
//
// It would also have been a third writer on a file that already has two — root raising a limit over
// the admin socket, and anyone pressing PAUSE over the spend one — writing on the payment path,
// which is exactly when the other two are most likely to arrive. An atomic rewrite of the whole
// file by one of them a millisecond after the other is a lost update.
const INFLIGHT_FILE = "inflight.json";

// The single-payment lock this file used to keep. Read once on the way past, so that upgrading a
// daemon that had a payment in the air does not open a window; then deleted and never written.
const LEGACY_LOCK_FILE = "settling.json";

// How long an authorisation lasts, at most: the last instant Hedera would accept the transaction,
// plus the longest we are willing to assume the mirror node is behind consensus. Both halves are
// chain.ts's to define and neither is ours to choose — see INDEXING_MARGIN_MS for why the second
// one is not zero, which is the whole difference between "it can never happen" and "it can never
// *show*".
export const AUTHORIZATION_MS = VALID_DURATION_MS + INDEXING_MARGIN_MS;

const inFlightPath = (pursePath: string): string => join(dirname(pursePath), INFLIGHT_FILE);
const legacyLockPath = (pursePath: string): string => join(dirname(pursePath), LEGACY_LOCK_FILE);

// SECURITY: what a restart is allowed to conclude, and it is the half of the design that had to be
// demonstrated before it was believed. This used to live in memory only, so a daemon that went down
// between a signature and the mirror node catching up came back knowing nothing about it, read a
// day that did not yet contain it, and authorised a second payment against the same allowance —
// for anyone who could restart the unit inside the indexing window, which `Restart=on-failure`
// does unattended.
//
// Four readings and every one of them fails closed:
//
//   no file          nothing was in flight. The ordinary case, and the common one.
//   unreadable       commit the whole allowance, in both assets, for as long as any real entry
//                    could have lasted. A corrupt file costs a bounded stretch of denial — a
//                    little over two minutes — and never an extra payment.
//   another account  discard it. It cannot describe this purse, and applying somebody else's
//                    figure to this one is the precise shape of the bug this design exists to
//                    make impossible.
//   entries          honour them, each clamped to the longest a genuine one could have run.
//                    `deadline` is `validStart + AUTHORIZATION_MS` and `validStart` is already in
//                    the past when it is written, so a value beyond `now + that` is damage rather
//                    than data, and clamping is what stops a garbled number wedging the purse.
function readInFlight(pursePath: string, accountId: string | null, budgets: Record<AssetKey, Budget>, now: number): Authorization[] {
  const ceiling = now + AUTHORIZATION_MS;
  const everything = (deadline: number): Authorization[] =>
    ASSET_KEYS.map((asset) => ({ asset, amount: budgets[asset].allowance, txId: null, deadline }));

  // The lock the previous build kept, honoured once so that upgrading over a payment in the air is
  // not a window. It carried no amount, so the only safe reading of it is "all of it".
  const legacy = legacyLockPath(pursePath);
  let carried: Authorization[] = [];
  try {
    const raw = readJson(legacy) as Record<string, unknown> | undefined;
    if (raw !== undefined) {
      const written = typeof raw["deadline"] === "number" && Number.isFinite(raw["deadline"]) ? raw["deadline"] : ceiling;
      const deadline = Math.min(written, ceiling);
      if (now < deadline) carried = everything(deadline);
    }
  } catch {
    carried = everything(ceiling);
  }
  removeFile(legacy);

  let raw: unknown;
  try {
    raw = readJson(inFlightPath(pursePath));
  } catch {
    return everything(ceiling);
  }
  if (raw === undefined) return carried;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return everything(ceiling);
  const row = raw as Record<string, unknown>;
  // Written for somebody else's purse. Not ours to honour and not ours to act on.
  if (accountId !== null && row["accountId"] !== accountId) return carried;
  const entries = row["entries"];
  if (!Array.isArray(entries)) return everything(ceiling);

  const live: Authorization[] = [...carried];
  for (const entry of entries as Record<string, unknown>[]) {
    const asset = entry?.["asset"];
    if (asset !== "usdc" && asset !== "hbar") return everything(ceiling);
    let amount: bigint;
    try {
      amount = BigInt(String(entry["amount"]));
    } catch {
      return everything(ceiling);
    }
    if (amount < 0n) return everything(ceiling);
    const written = entry["deadline"];
    if (typeof written !== "number" || !Number.isFinite(written)) return everything(ceiling);
    const deadline = Math.min(written, ceiling);
    if (now >= deadline) continue;
    live.push({ asset, amount, txId: typeof entry["txId"] === "string" ? entry["txId"] : null, deadline });
  }
  return live;
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
  // The chain's last answer: balances, the key check, and the day's payments for the panel to
  // draw. Null until the mirror node has answered once, which policy.ts treats as a reason to
  // refuse rather than as a zero. Memory only: a restart asks again.
  ledger: Ledger | null;
  // What has gone out today. Seeded from the chain when the daemon starts and when the day rolls
  // over, raised by every payment of ours the chain confirms, and never lowered. Memory only, for
  // the same reason as above and for one more: a figure that cannot survive a restart cannot
  // survive an account change either.
  spent: Spent | null;
  // Three consecutive readings, a minute apart, that the account is controlled by a different
  // key. See wallet.ts for the counting and policy.ts for what it costs. Memory only, and the
  // warning it is counting survives a restart on its own — the very first reading after one sets
  // `verified` false again. What resets is the refusal, not the alarm.
  mismatch: boolean;
  // Payments authorised and not yet answered for, and the one field here with a file of its own —
  // inflight.json, not purse.json. See `Authorization` and `readInFlight`.
  inFlight: readonly Authorization[];
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
  // Which account this purse spends from, stamped onto the in-flight list so a later daemon can
  // tell whether the list it finds describes the purse it is. Null before `setup` has run.
  readonly #accountId: string | null;
  // Host names carried out of an older purse.json, for the label store to adopt on first start.
  // Never written back, never read by anything here — see `legacyLabels`.
  readonly #carried: Label[];
  #onChange: (() => void) | undefined;

  constructor(path: string, state: PurseState, carried: Label[] = [], accountId: string | null = null) {
    this.#path = path;
    this.#state = state;
    this.#carried = carried;
    this.#accountId = accountId;
  }

  // Missing file means a machine that has been installed but never configured: start paused with
  // nothing spendable. A file we cannot parse means something is wrong with the limits, and the
  // only safe reading of "I do not know the limits" is to refuse to run at all.
  // `accountId` is only ever used to refuse: an in-flight list written for another account is
  // discarded rather than applied. Null before `setup` has run, when nothing can be paid anyway.
  static open(path: string, accountId: string | null = null): Purse {
    const raw = readJson(path) as Record<string, unknown> | undefined;
    const usdc = budgetFromJson(raw?.["usdc"]);
    const hbar = budgetFromJson(raw?.["hbar"]);
    const state: PurseState = {
      paused: raw === undefined ? true : raw["paused"] !== false,
      usdc,
      hbar,
      ledger: null,
      spent: null,
      mismatch: false,
      // The one thing on this side of the line that a restart does not throw away — and the only
      // thing. See readInFlight for what a restart is allowed to conclude.
      inFlight: readInFlight(path, accountId, { usdc, hbar }, Date.now()),
    };
    const labels = labelsFromJson(raw?.["labels"]);
    return new Purse(path, state, labels.length > 0 ? labels : labelsFromLegacyReceipts(raw), accountId);
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
  // the day's allowance is charged once for two payments. `#absorb` below is the other half of the
  // answer: a reading of a day this purse already has a figure for may raise it and never lower it.
  //
  // `Ledger.at` is stamped when the requests were issued, not when they landed — see readLedger,
  // which is the half of this that makes the comparison mean anything.
  observe(ledger: Ledger, mismatch: boolean): boolean {
    const held = this.#state.ledger;
    if (held !== null && ledger.at < held.at) return false;
    this.#state.ledger = ledger;
    this.#state.mismatch = mismatch;
    this.#absorb(ledger);
    this.#onChange?.();
    return true;
  }

  // SECURITY: the day's figure is allowed to move in exactly two ways, and this is one of them.
  //
  // A reading of a different account, or of a different local day, replaces it outright — and only
  // if the walk reached the end of that day, because a partial sum is not a day's spending. A
  // reading of the same account and day may only ever *raise* it, never lower it, because by then
  // this purse knows about payments the mirror node has not indexed yet and forgetting one is how
  // an allowance gets spent twice. The chain is still what seeds and what corrects; what it may
  // not do is talk us down.
  #absorb(ledger: Ledger): void {
    const spent = this.#state.spent;
    if (spent === null || spent.accountId !== ledger.accountId || spent.dayStart !== ledger.since) {
      if (!ledger.complete) return;
      this.#state.spent = { accountId: ledger.accountId, dayStart: ledger.since, totals: { ...ledger.spent } };
      return;
    }
    const totals = { ...spent.totals };
    for (const key of ASSET_KEYS) if (ledger.spent[key] > totals[key]) totals[key] = ledger.spent[key];
    this.#state.spent = { ...spent, totals };
  }

  // SECURITY: a payment is committed against the allowance here, on the way to the key, and this
  // is what makes the lock the daemon used to hold unnecessary. `decide` reads the figure and this
  // raises it with no `await` between the two, so any number of payments running at once are
  // counted exactly — where a lock could only ever make them wait for a reading that lags.
  //
  // The write happens before the field is set, and it is allowed to throw. An authorisation only
  // this process remembers is no authorisation at all, because the daemon that has to honour it may
  // be the next one; so if it cannot be made durable the caller is told, and told early enough to
  // refuse the payment rather than to fail one it has already signed. Nothing is left half-taken
  // either way: a throw here leaves the list exactly as it was, and a crash between the write and
  // the assignment leaves an entry the next start reads.
  authorize(asset: AssetKey, amount: bigint, validStart: number): Authorization {
    const entry: Authorization = { asset, amount, txId: null, deadline: validStart + AUTHORIZATION_MS };
    const next = [...this.#state.inFlight, entry];
    this.#write(next);
    this.#state.inFlight = next;
    this.#onChange?.();
    return entry;
  }

  // Name it, so the chain can answer for it rather than only the clock, and move the deadline to
  // the one measured from the transaction's own validStart — which is *earlier* than the estimate
  // `authorize` was given, since the SDK dates a transaction a few seconds in the past. A failure
  // here therefore leaves an entry honoured for a few seconds longer than it needed to be, which
  // is a denial and never an extra payment. That is why this write may fail and the first may not.
  identify(entry: Authorization, txId: string | null, validStart: number): void {
    entry.txId = txId;
    entry.deadline = validStart + AUTHORIZATION_MS;
    try {
      this.#write(this.#state.inFlight);
    } catch {
      // Deliberately nothing. See above.
    }
    this.#onChange?.();
  }

  // The chain has it. The amount moves out of the in-flight list and into the day's figure, which
  // is the second and last way that figure is allowed to move — and it nets to nothing, because the
  // entry was already counted against the allowance while it was in flight.
  //
  // Counted exactly once, which needs saying because there are two ways for the chain to tell us
  // and they can arrive in either order. A reading that already contains this id has raised the
  // figure through `#absorb` and `policy.committed` has already stopped counting the entry, so
  // adding it here again would charge the day twice for one payment — nine payments out of an
  // allowance for ten, which is exactly how this was found. The same predicate governs both places.
  settled(entry: Authorization): void {
    const shown = this.#shown(entry);
    if (!this.#forget(entry)) return;
    const spent = this.#state.spent;
    if (spent !== null && !shown) {
      const totals = { ...spent.totals, [entry.asset]: spent.totals[entry.asset] + entry.amount };
      this.#state.spent = { ...spent, totals };
    }
    this.#onChange?.();
  }

  // Is this payment already in the figure by way of a chain reading? The mirror of the test in
  // `policy.committed`, and deliberately the same one.
  #shown(entry: Authorization): boolean {
    if (entry.txId === null) return false;
    return this.#state.ledger?.payments.some((payment) => payment.txId === entry.txId) === true;
  }

  // It can never reach consensus now, so it never happened and nothing is given back — because
  // nothing was taken. A payment that never settles simply never enters the figure.
  abandon(entry: Authorization): void {
    if (this.#forget(entry)) this.#onChange?.();
  }

  #forget(entry: Authorization): boolean {
    if (!this.#state.inFlight.includes(entry)) return false;
    const next = this.#state.inFlight.filter((row) => row !== entry);
    this.#state.inFlight = next;
    // Best effort, and the ordering is the fail-closed one: the list is already short in memory, so
    // a write that fails leaves the *next* daemon holding an entry for the seconds it has left —
    // a denial, never a second payment.
    try {
      this.#write(next);
    } catch {
      // Deliberately nothing. See above.
    }
    return true;
  }

  #write(entries: readonly Authorization[]): void {
    const path = inFlightPath(this.#path);
    if (entries.length === 0) {
      removeFile(path);
      return;
    }
    const body = {
      accountId: this.#accountId,
      entries: entries.map((entry) => ({
        asset: entry.asset,
        amount: entry.amount.toString(),
        txId: entry.txId,
        deadline: entry.deadline,
      })),
    };
    writeAtomic(path, JSON.stringify(body) + "\n");
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
// appear in it at all. Every number under `balance` and `payments` came off the mirror node in this
// process's last read, and `spent` is that read plus this process's own payments since; none of
// them is on disk.
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
      // What the day has cost so far, which is what the chain has confirmed *plus* what is still
      // in the air — the same figure the allowance is measured against, so the bar on the panel and
      // the decision behind it can never disagree. Null-safe: before the first mirror read there is
      // no number to show, and "0" would be a claim we have not earned.
      spent: (state.spent === null ? 0n : state.spent.totals[key] + committed(state, key, now)).toString(),
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
    // How many payments are signed and not yet answered for. Ordinary rather than exceptional now:
    // payments run alongside each other, so this is a count and not a lane.
    inFlight: state.inFlight.filter((entry) => now < entry.deadline).length,
    assets,
  };
}
