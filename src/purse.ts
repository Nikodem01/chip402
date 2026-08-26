// The purse: the limits, the kill switch, and a handful of labels. That is the whole of what
// chip402 keeps, and it is deliberately the whole of it.
//
// What is *not* here is the thing this file used to be about. There is no counter of what has
// gone out today, no list of what was bought, and no number that moves when we sign. Those are
// facts about the chain, and a hand-written copy of a fact drifts from it: the previous build
// carried two HBAR payments made by a wallet this machine no longer holds across a
// `setup --import` and charged today's allowance for them. Nothing was attacking it. A second
// copy is a second answer.
//
// So: what is on disk is policy — set by root, changeable only over the admin socket. What is in
// memory is the chain's last answer, held by `observe` and thrown away on restart. And `settling`
// is neither: it is a lock, held only while a transaction we signed has not yet shown up.

import type { AssetKey, NetworkRow } from "./networks.ts";
import { ASSET_KEYS } from "./networks.ts";
import type { Ledger, Payment } from "./chain.ts";
import { VALID_DURATION_MS } from "./chain.ts";
import { dayEnd } from "./policy.ts";
import { parseUnits } from "./money.ts";
import { readJson, writeAtomic } from "./safe.ts";

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
export type Settling = {
  readonly txId: string | null;
  readonly deadline: number;
};

// The chain knows we paid 0.0.9584959; it does not know that was printwright.liftbyai.com. This
// is the one piece of local memory that survives, and it is decoration: it is written after the
// signature, it is read only by the snapshot, and there is no path from it to a decision.
//
// Decoration that earns its place, though. "$1.60 to printwright.liftbyai.com" is a line you can
// read; "$1.60 to 0.0.9584959" is a line you have to go and look up. Being able to see where the
// agent's money went at a glance is most of why the panel exists, so the label map is kept
// generously and carried across an upgrade rather than treated as disposable.
export type Label = { readonly txId: string; readonly host: string };

// Comfortably more than the payment rows one day can produce and still show — chain.ts will read
// at most twelve pages of a hundred transactions, and a day of pocket money is a handful. At
// roughly seventy bytes a row this is a few tens of kilobytes, well inside the cap readJson puts
// on the file.
const LABEL_LIMIT = 500;

export type PurseState = {
  paused: boolean;
  usdc: Budget;
  hbar: Budget;
  // --- nothing below this line is written to disk, or survives a restart ---
  // The chain's last answer: balances, what has been spent since local midnight, and the rows
  // behind that number. Null until the mirror node has answered once, which policy.ts treats
  // as a reason to refuse rather than as a zero.
  ledger: Ledger | null;
  // Three consecutive readings, a minute apart, that the account is controlled by a different
  // key. See wallet.ts for the counting and policy.ts for what it costs.
  mismatch: boolean;
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

function labelsFromJson(raw: unknown): Label[] {
  if (!Array.isArray(raw)) return [];
  const labels: Label[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    if (typeof entry?.["txId"] === "string" && typeof entry["host"] === "string") {
      labels.push({ txId: entry["txId"], host: entry["host"] });
    }
  }
  return labels.slice(-LABEL_LIMIT);
}

// One read of a shape this file no longer writes. The build before this one kept a list of
// receipts per asset, and every row carried the host it had paid — the single part of that list
// worth keeping, because it is the part the chain cannot answer. Losing it on upgrade would turn
// a purse's whole history from names into account numbers for no reason.
//
// What is taken is exactly the two strings. Not the amounts, not the counters, not whether the
// seller claimed it settled — those are the chain's to answer now, and the first write after this
// drops the old shape from the file for good. So this is a migration of labels, not of a ledger:
// nothing it returns can reach a number, because nothing reads a label but the snapshot.
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
  return labels.slice(-LABEL_LIMIT);
}

export class Purse {
  readonly #path: string;
  readonly #state: PurseState;
  #labels: Label[];
  #onChange: (() => void) | undefined;

  constructor(path: string, state: PurseState, labels: Label[] = []) {
    this.#path = path;
    this.#state = state;
    this.#labels = labels;
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
      settling: null,
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
  observe(ledger: Ledger, mismatch: boolean): void {
    this.#state.ledger = ledger;
    this.#state.mismatch = mismatch;
    this.#onChange?.();
  }

  // SECURITY: the lane closes here, the instant a signature exists, and reopens only when the
  // chain has been asked. Until then policy.ts denies — so a payment cannot be counted twice by
  // being made twice in the seconds before the mirror node has caught up. There is no in-flight
  // amount to track and nothing to give back if it never settles: a payment that never settles
  // simply never appears in the sum.
  beginSettling(txId: string | null, validStart: number): void {
    this.#state.settling = { txId, deadline: validStart + VALID_DURATION_MS };
    this.#onChange?.();
  }

  finishSettling(): void {
    if (this.#state.settling === null) return;
    this.#state.settling = null;
    this.#onChange?.();
  }

  // The host behind a transaction id, written after the signature. It is a label and never an
  // input: no number, no limit and no decision can be reached from this map.
  label(txId: string, host: string): void {
    this.#labels = this.#labels.filter((entry) => entry.txId !== txId);
    this.#labels.push({ txId, host });
    if (this.#labels.length > LABEL_LIMIT) this.#labels = this.#labels.slice(-LABEL_LIMIT);
    this.persist();
  }

  hostFor(txId: string): string | null {
    return this.#labels.find((entry) => entry.txId === txId)?.host ?? null;
  }

  get labels(): readonly Label[] {
    return this.#labels;
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
          labels: this.#labels,
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
export function snapshot(purse: Purse, network: NetworkRow, identity: Identity, now: number): Record<string, unknown> {
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
        .map((payment) => paymentToJson(payment, purse.hostFor(payment.txId))),
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
    // question that matters is not who can read it but where it came from, and it comes from the
    // key. See openWallet.
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
