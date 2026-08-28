// The purse: the limits, the kill switch, the day's figure, and the payments still in the air.
//
// The day's figure is a number this file keeps on disk, which is the sentence here that deserves
// the most suspicion — because the previous build kept one on disk too and got it wrong. It carried
// two HBAR payments made by a wallet this machine no longer held across a `setup --import` and
// charged a fresh account's allowance for them. Nothing was attacking it. So what changed is worth
// being exact about, and it is not "we stopped writing it down":
//
//   then                                     now
//   nothing said which account it was for     tagged with the account and the local day, checked
//                                             on the way in and again in policy.decide, and
//                                             discarded rather than carried when either changes
//   nothing ever re-derived it                every reading of the chain corrects it, and a
//                                             reading may only ever raise it, never talk it down
//   kept beside the limits                    kept beside the in-flight list, which is the other
//                                             half of the same fact and moves with it in one write
//
// Why it is written down at all. The figure is (everything settled today) + (everything in flight),
// and the second half was always durable; only the first was thrown away. That is what made a
// restart walk a whole local day before the purse could pay anything — unbounded work whose size is
// set by how busy the agent has been. The one thing that had to finish before the purse would open
// was the one thing a busy agent could make too big to finish. See `readSpent`.
//
// The chain is still what the figure answers to. This is a file corrected by the ledger, not a
// substitute for it.
//
// So there are three kinds of state here and each lives where it belongs:
//
//   purse.json     policy, and only policy — four numbers and a flag, set by root and changeable
//                  only over the admin socket. Unreadable ⇒ refuse to start.
//   memory         the chain's last answer — balances, the key check, the rows the panel draws.
//                  Thrown away on restart, and the next daemon asks the mirror node again.
//   inflight.json  what we have spent today, and what we have signed and not been shown yet. Every
//                  entry expires within a little over two minutes — see `Authorization`. Unreadable
//                  ⇒ assume the whole allowance is committed until then, and ask the chain for the
//                  figure rather than guessing at one.
//
// The host names used to be in this file too. They are in labels.ts now, because a file that must
// refuse to start when it cannot be read has no business also holding something that grows and is
// worthless if lost — see the table at the top of that file.

import type { AssetKey, NetworkRow } from "./networks.ts";
import { ASSET_KEYS } from "./networks.ts";
import type { Ledger, Payment } from "./chain.ts";
import { INDEXING_MARGIN_MS, VALID_DURATION_MS } from "./chain.ts";
import type { Label, Labels } from "./labels.ts";
import { committed, dayEnd, dayStart } from "./policy.ts";
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
//                                      any entry in it could possibly have lasted; and a figure we
//                                      cannot read is one we ask the chain for
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
// Read once, so that the two halves of the same fact are read from the same bytes. A payment moves
// out of `entries` and into `spent` in one write; reading the file twice could see it in neither.
type Persisted = { raw: unknown; unreadable: boolean };

function readPersisted(pursePath: string): Persisted {
  try {
    return { raw: readJson(inFlightPath(pursePath)), unreadable: false };
  } catch {
    return { raw: undefined, unreadable: true };
  }
}

function readInFlight(
  pursePath: string,
  accountId: string | null,
  budgets: Record<AssetKey, Budget>,
  now: number,
  file: Persisted,
): Authorization[] {
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

  if (file.unreadable) return everything(ceiling);
  const raw = file.raw;
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

// SECURITY: the day's figure, recovered from disk rather than re-derived from the chain — and the
// reason the boot walk is no longer the thing everything waits on.
//
// The figure is (everything settled today) + (everything in flight). The second half has always
// been durable; the first was thrown away on every restart, which is the *only* reason a daemon had
// to walk a whole local day before it could pay anything. Walking a day is unbounded work whose size
// is set by how busy the agent has been, so the one thing that had to finish before the purse opened
// was the one thing a busy agent could make too big. Writing the number down deletes that.
//
// This is the copy the old build got wrong, so the difference is worth stating rather than assuming:
// that one said nothing about *whose* spending it was, so `setup --import` carried an older wallet's
// figure onto a fresh account. This one is tagged with the account and the local day, both are
// checked here and checked again in `policy.decide`, and a figure that does not match this purse and
// this day is discarded rather than reinterpreted.
//
// What makes it safe to trust is not the file, it is who can write one. Nothing but this daemon can
// spend against this allowance: the key is sealed to this machine, the signer never leaves
// wallet.ts, and `paymentsIn` excludes anything the owner initiated. So an absent figure means this
// purse has spent nothing today, not that we cannot know. And the state directory is 0700
// chip402:chip402 — the agent's uid cannot read it, let alone forge it, and root could raise the
// allowance directly rather than bother.
//
// Five readings, and the two that cannot be trusted fall back to the chain rather than to a guess:
//
//   no file          nothing has been spent today. See above for why that is a fact and not a hope.
//   unreadable       no figure — let the boot walk seed it. Deliberately *not* "assume the whole
//                    allowance": `#absorb` may only ever raise a figure, so a pessimistic guess
//                    here could never be corrected back down and would deny all day.
//   another account  the same, and for the same reason `readInFlight` discards those entries.
//   another day      nothing has been spent *today*. A payment today would have written today.
//   a figure         use it, and let every later reading of the chain raise it.
function readSpent(accountId: string | null, now: number, file: Persisted): Spent | null {
  if (accountId === null) return null;
  const today = dayStart(now);
  const nothing: Spent = { accountId, dayStart: today, totals: { usdc: 0n, hbar: 0n } };

  if (file.unreadable) return null;
  if (file.raw === undefined) return nothing;
  if (file.raw === null || typeof file.raw !== "object" || Array.isArray(file.raw)) return null;
  const row = file.raw as Record<string, unknown>;
  if (row["accountId"] !== accountId) return null;

  // A file written before this field existed. The entries in it are still honoured by
  // `readInFlight`; what it cannot tell us is a figure, and not having spent anything is what an
  // upgrade over a running purse actually means for every day but the one it happens on.
  const written = row["spent"];
  if (written === undefined || written === null) return nothing;
  if (typeof written !== "object" || Array.isArray(written)) return null;
  const held = written as Record<string, unknown>;

  const day = held["dayStart"];
  if (typeof day !== "number" || !Number.isFinite(day)) return null;
  if (day !== today) return nothing;

  const source = (held["totals"] ?? {}) as Record<string, unknown>;
  const totals: Record<AssetKey, bigint> = { usdc: 0n, hbar: 0n };
  for (const key of ASSET_KEYS) {
    try {
      totals[key] = BigInt(String(source[key] ?? "0"));
    } catch {
      return null;
    }
    // A negative figure is damage, and damage that would hand back allowance.
    if (totals[key] < 0n) return null;
  }
  return { accountId, dayStart: today, totals };
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
  // What has gone out today: recovered from inflight.json when the daemon starts, raised by every
  // payment of ours the chain confirms, corrected upward by every reading, and never lowered. Null
  // only when the file could not be trusted — a foreign account, damage — and then the boot walk is
  // what seeds it. `policy.decide` reads null as a refusal to pay, not as a zero.
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
    const now = Date.now();
    // Both halves of what a restart is allowed to remember, out of one read of one file. See
    // `readInFlight` and `readSpent` for the tables of what each is allowed to conclude.
    const file = readPersisted(path);
    const state: PurseState = {
      paused: raw === undefined ? true : raw["paused"] !== false,
      usdc,
      hbar,
      ledger: null,
      spent: readSpent(accountId, now, file),
      mismatch: false,
      inFlight: readInFlight(path, accountId, { usdc, hbar }, now, file),
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
    // The chain is what corrects the figure, so a correction has to outlive the process that heard
    // it — otherwise a restart drops back to what this daemon counted itself, which is lower.
    // Best effort: a failed write here costs the raise until the next reading, and the next reading
    // makes it again. Nothing about the decision in memory waits on the disk.
    try {
      this.#write(this.#state.inFlight, this.#state.spent);
    } catch {
      // Deliberately nothing. See above.
    }
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
    this.#write(next, this.#state.spent);
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
      this.#write(this.#state.inFlight, this.#state.spent);
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
    const spent = this.#state.spent;
    // Worked out before the entry is forgotten, so that leaving the list and entering the figure is
    // one change to persist rather than two. See `#write`.
    const raised =
      spent === null || shown
        ? spent
        : { ...spent, totals: { ...spent.totals, [entry.asset]: spent.totals[entry.asset] + entry.amount } };
    if (!this.#forget(entry, raised)) return;
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

  // `spent` is what the figure becomes as this entry leaves the list — the same figure for
  // `abandon`, which gives nothing back, and a raised one for `settled`. Both move in one write.
  #forget(entry: Authorization, spent: Spent | null = this.#state.spent): boolean {
    if (!this.#state.inFlight.includes(entry)) return false;
    const next = this.#state.inFlight.filter((row) => row !== entry);
    this.#state.inFlight = next;
    this.#state.spent = spent;
    // Best effort, and the ordering is the fail-closed one: the list is already short in memory, so
    // a write that fails leaves the *next* daemon holding an entry for the seconds it has left —
    // a denial, never a second payment. It leaves that daemon the *lower* figure too, which is the
    // same trade in the same direction: the entry it is still holding covers the amount, and the
    // first reading of the chain raises the figure for good.
    try {
      this.#write(next, spent);
    } catch {
      // Deliberately nothing. See above.
    }
    return true;
  }

  // SECURITY: both halves of the day's figure, in one write, on purpose. A payment leaves `entries`
  // and enters `spent` in the same instant, and writing those separately would leave a window in
  // which a crash loses it from both — an undercount, which is the direction that spends an
  // allowance twice. There is one file and one write, so the transition is either taken or not.
  //
  // The file now outlives the list in it: an empty `entries` used to mean "delete this", and it no
  // longer can, because the figure has to survive an idle purse with nothing in the air. It is
  // removed only when there is nothing left to remember at all.
  #write(entries: readonly Authorization[], spent: Spent | null): void {
    const path = inFlightPath(this.#path);
    if (entries.length === 0 && spent === null) {
      removeFile(path);
      return;
    }
    const body = {
      accountId: this.#accountId,
      spent:
        spent === null
          ? null
          : {
              dayStart: spent.dayStart,
              // Base units as decimal strings, for the same reason the limits are: bigint has no
              // JSON of its own, and a float would round money.
              totals: Object.fromEntries(ASSET_KEYS.map((key) => [key, spent.totals[key].toString()])),
            },
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
    // When the chain last answered *with a day this purse could use*. 0 means it never has, which
    // is a refusal to pay and not a zero balance.
    //
    // Gated on the figure rather than on a reply having arrived, because those are not the same
    // thing and the panel is documented on this field. `observe` publishes a reading before
    // `#absorb` decides whether a day's figure can be seeded from it, so a walk that stopped short
    // used to leave `ledger` set and `spent` null: the panel drew a balance and said the chain had
    // answered, while `policy.decide` denied every payment with "the chain has not answered yet".
    // Two claims about one fact, disagreeing. This is the claim `decide` makes.
    chainAt: state.spent === null ? 0 : (ledger?.at ?? 0),
    // How many payments are signed and not yet answered for. Ordinary rather than exceptional now:
    // payments run alongside each other, so this is a count and not a lane.
    inFlight: state.inFlight.filter((entry) => now < entry.deadline).length,
    assets,
  };
}
