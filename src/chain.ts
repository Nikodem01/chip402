// What the chain says, and the only place chip402 asks it. Balances, today's spending, who was
// paid, and whether a transaction we signed ever happened — all four are facts, and facts live
// on Hedera. This file reads them; nothing here writes anything anywhere.
//
// It exists because of the rule the project turns on: chip402 stores policy, not facts. The
// limits, `paused` and where local midnight falls are ours and can come from nowhere else. The
// numbers below are not ours, and the moment we keep a copy of one we have two answers to the
// same question — which is how the old build came to charge this purse for two HBAR payments
// made by a wallet it no longer holds. There is no reconciliation in this file because there is
// nothing to reconcile.
//
// The mirror node is read-only and is the only host the daemon talks to that is not the seller.
// There is no write path to Hedera in this process at all.

import type { AssetKey, NetworkRow } from "./networks.ts";
import { ASSET_KEYS } from "./networks.ts";
import type { Sighting } from "./fetch.ts";
import { hardenedFetch } from "./fetch.ts";

// One page is a hundred transactions and a day of pocket money is a handful, so this bound is
// about the pathological case rather than the ordinary one: an account someone is dusting with
// tiny incoming transfers. Past the bound we cannot say what was spent, and a purse that cannot
// count must not pay — the caller turns the throw into a denial. That is a denial of service on
// pocket money and not a loss of funds, which is the trade the fail-closed posture buys.
const PAGE_SIZE = 100;
const MAX_PAGES = 12;

// Hedera's own TransactionValidDuration. A signed transaction that has not reached consensus by
// validStart + this can never reach it, so a transaction id that is still missing from the
// mirror at that point is one that will never appear.
export const VALID_DURATION_MS = 120_000;

// One payment, as the ledger has it. Every field is read off the chain except `host`, which the
// snapshot fills in from a label the purse kept — the chain knows the counterparty is
// 0.0.9584959, not that it was printwright.liftbyai.com.
export type Payment = {
  readonly txId: string;
  readonly at: number;
  readonly asset: AssetKey;
  readonly amount: bigint;
  readonly payTo: string;
};

// Everything the chain answered in one read, held with the moment it was true at and the day it
// was computed for. policy.ts refuses to pay against one that has gone stale or that was
// computed before local midnight rolled over.
export type Ledger = {
  readonly since: number;
  readonly at: number;
  readonly balances: Readonly<Record<AssetKey, bigint>>;
  readonly spent: Readonly<Record<AssetKey, bigint>>;
  readonly payments: readonly Payment[];
  // Does the chain agree this key controls the account we are configured to pay from? Three
  // states on purpose — see `readKeyMatch`.
  readonly verified: boolean | null;
};

// What we ask the mirror node for and what we read back. Only the fields we actually check.
type ChainTransfer = { account?: string; amount?: number; token_id?: string };
type ChainTransaction = {
  transaction_id?: string;
  consensus_timestamp?: string;
  result?: string;
  transfers?: ChainTransfer[];
  token_transfers?: ChainTransfer[];
};
export type ChainAccount = {
  evm_address?: string;
  key?: { _type?: string; key?: string } | null;
  balance?: { balance?: number; tokens?: { token_id?: string; balance?: number }[] };
};

// The mirror node spells a transaction id `0.0.9185802-1787717722-334755737`; the SDK, HashScan
// and every id we hand out spell it `0.0.9185802@1787717722.334755737`. One spelling in, one
// spelling out, converted at the two edges rather than carried around in both.
export function toMirrorId(txId: string): string {
  return txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

function fromMirrorId(id: string): string | null {
  const match = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(id);
  return match === null ? null : `${match[1]}@${match[2]}.${match[3]}`;
}

// The account that pays for a transaction is the one its id names. The facilitator sponsors
// every x402 payment, so an id beginning with our own account is something we initiated — an
// owner-driven transfer, a failed manual send — and never an agent's purchase.
function payerOf(txId: string): string | null {
  const match = /^(\d+\.\d+\.\d+)-\d+-\d+$/.exec(txId);
  return match?.[1] ?? null;
}

// "1787718572.451167104" is seconds and nanoseconds, which no JavaScript number holds without
// losing the tail. Split it rather than multiplying a float.
function millisOf(consensus: string): number {
  const [seconds = "0", nanos = "0"] = consensus.split(".");
  return Number(seconds) * 1000 + Math.floor(Number(nanos.padEnd(9, "0").slice(0, 9)) / 1e6);
}

// Everything one account did in one transaction, netted — a transfer list can name the same
// account twice, and the net is what actually moved.
function netFor(rows: ChainTransfer[] | undefined, account: string, tokenId: string | null): bigint {
  let total = 0n;
  for (const row of rows ?? []) {
    if (row.account !== account) continue;
    if (tokenId !== null && row.token_id !== tokenId) continue;
    total += BigInt(row.amount ?? 0);
  }
  return total;
}

// Who got the money. The exact counterpart of what we paid is the seller; the leftovers are the
// network's fee split, which the facilitator paid and which is not our business. Falling back to
// the largest positive entry keeps a row displayable if a seller ever splits its own take.
function receiverOf(rows: ChainTransfer[] | undefined, account: string, tokenId: string | null, paid: bigint): string {
  const net = new Map<string, bigint>();
  for (const row of rows ?? []) {
    if (tokenId !== null && row.token_id !== tokenId) continue;
    const id = row.account;
    if (typeof id !== "string" || id === account) continue;
    net.set(id, (net.get(id) ?? 0n) + BigInt(row.amount ?? 0));
  }
  let best: [string, bigint] | null = null;
  for (const entry of net) {
    if (entry[1] === paid) return entry[0];
    if (best === null || entry[1] > best[1]) best = entry;
  }
  return best !== null && best[1] > 0n ? best[0] : "unknown";
}

// SECURITY: the filter that says what an x402 payment is, and it is exact rather than heuristic.
// Three things have to hold at once, and each one drops a whole class on its own:
//
//   - the transaction succeeded, so a failure costs the allowance nothing;
//   - the fee payer is not us, so nothing the owner initiated — a top-up to another account, a
//     manual send, `chip402ctl setup`'s completion transfer — is ever charged to the agent;
//   - our account came out behind in this asset, so money arriving is not money spent.
//
// Verified against this account's real history: today's three purchases match, and the six
// owner-initiated transactions and two incoming transfers on the same page do not.
export function paymentsIn(
  rows: readonly ChainTransaction[],
  network: NetworkRow,
  accountId: string,
  since: number,
): Payment[] {
  const found: Payment[] = [];
  for (const row of rows) {
    const mirrorId = row.transaction_id;
    const consensus = row.consensus_timestamp;
    if (typeof mirrorId !== "string" || typeof consensus !== "string") continue;
    if (row.result !== "SUCCESS") continue;
    if (payerOf(mirrorId) === accountId) continue;
    const at = millisOf(consensus);
    if (at < since) continue;
    const txId = fromMirrorId(mirrorId);
    if (txId === null) continue;

    for (const key of ASSET_KEYS) {
      const asset = network.assets[key];
      const native = key === "hbar";
      const net = native
        ? netFor(row.transfers, accountId, null)
        : netFor(row.token_transfers, accountId, asset.id);
      if (net >= 0n) continue;
      const amount = -net;
      found.push({
        txId,
        at,
        asset: key,
        amount,
        payTo: receiverOf(native ? row.transfers : row.token_transfers, accountId, native ? null : asset.id, amount),
      });
    }
  }
  return found;
}

// SECURITY: three states, and the middle one is the whole point. `verified` used to be a
// boolean, so every shape this function does not recognise collapsed to "no" — and a threshold
// account or a ProtobufEncoded key would have bricked a perfectly healthy purse. Only a key we
// positively parsed and positively disagree with is a `false`.
//
//   true  — the EVM alias matches our key's alias, or a recognised simple key matches ours
//   null  — cannot tell: no key on record, a KeyList or threshold, ProtobufEncoded, any shape
//           we do not know. Shown as unverified, gates nothing.
//   false — a recognised simple key was parsed, it is a different key, and no alias agrees
export function readKeyMatch(
  account: ChainAccount,
  publicKeyHex: string,
  evmAddress: string | null,
): boolean | null {
  const alias = String(account.evm_address ?? "").toLowerCase().replace(/^0x/, "");
  if (evmAddress !== null && alias !== "" && alias === evmAddress.toLowerCase()) return true;

  const key = account.key;
  if (key === null || key === undefined) return null;
  // The two shapes the mirror node spells out as a single key. Anything else — ProtobufEncoded,
  // a KeyList, a threshold key, a field it grows later — we do not claim to understand.
  if (key._type !== "ECDSA_SECP256K1" && key._type !== "ED25519") return null;
  const onChain = String(key.key ?? "").toLowerCase();
  if (onChain === "") return null;
  return onChain === publicKeyHex.toLowerCase();
}

// A throwaway sighting per request: hardenedFetch records what answered, and for the mirror node
// nobody reads it back. What we want from it here is the deadline, the body cap and the
// refusal to follow a redirect off-origin.
function mirrorFetch(url: string): Promise<Response> {
  const seen: Sighting = { finalUrl: "", x402Version: 0 };
  return hardenedFetch(seen)(url);
}

async function mirrorJson(url: string): Promise<unknown> {
  const response = await mirrorFetch(url);
  if (!response.ok) throw new Error(`mirror node said ${response.status}`);
  return response.json();
}

export async function readAccount(network: NetworkRow, accountId: string): Promise<ChainAccount> {
  return (await mirrorJson(`${network.mirror}/api/v1/accounts/${accountId}`)) as ChainAccount;
}

// Has this transaction reached the chain at all? Answered for any outcome, not only success: a
// transaction that reached consensus and failed still cost us nothing and still stops being
// in flight, which is the only question this asks.
export async function transactionSeen(network: NetworkRow, txId: string): Promise<boolean> {
  const response = await mirrorFetch(`${network.mirror}/api/v1/transactions/${toMirrorId(txId)}`);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`mirror node said ${response.status}`);
  const body = (await response.json()) as { transactions?: unknown[] };
  return (body.transactions ?? []).length > 0;
}

// Every transaction touching this account back to `from`, newest first. Paged by asking for
// everything older than the last row we saw, rather than by following the `links.next` the
// server hands us: the bound stays ours, and there is no server-supplied URL to fetch.
async function readTransactions(network: NetworkRow, accountId: string, from: number): Promise<ChainTransaction[]> {
  const floor = (from / 1000).toFixed(9);
  const rows: ChainTransaction[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query =
      `account.id=${encodeURIComponent(accountId)}&timestamp=gte:${floor}` +
      (before === null ? "" : `&timestamp=lt:${before}`) +
      `&order=desc&limit=${PAGE_SIZE}`;
    const body = (await mirrorJson(`${network.mirror}/api/v1/transactions?${query}`)) as {
      transactions?: ChainTransaction[];
    };
    const page_rows = body.transactions ?? [];
    rows.push(...page_rows);
    if (page_rows.length < PAGE_SIZE) return rows;
    const last = page_rows[page_rows.length - 1]?.consensus_timestamp;
    if (typeof last !== "string" || last === before) return rows;
    before = last;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} transactions today — cannot say what was spent`);
}

// One read of everything the chain has to say about us. `since` is local midnight, which is what
// today's spending is measured from; `from` may reach further back so that a transaction signed
// just before midnight can still be looked for. Two requests in the ordinary case.
export async function readLedger(
  network: NetworkRow,
  accountId: string,
  publicKeyHex: string,
  evmAddress: string | null,
  since: number,
  from: number = since,
): Promise<Ledger> {
  const [account, rows] = await Promise.all([
    readAccount(network, accountId),
    readTransactions(network, accountId, Math.min(since, from)),
  ]);

  const usdcRow = (account.balance?.tokens ?? []).find((row) => row.token_id === network.assets.usdc.id);
  const balances = {
    usdc: BigInt(usdcRow?.balance ?? 0),
    hbar: BigInt(account.balance?.balance ?? 0),
  };

  const payments = paymentsIn(rows, network, accountId, since);
  const spent = { usdc: 0n, hbar: 0n };
  for (const payment of payments) spent[payment.asset] += payment.amount;

  return {
    since,
    at: Date.now(),
    balances,
    spent,
    payments,
    verified: readKeyMatch(account, publicKeyHex, evmAddress),
  };
}

// The moment a transaction id says it was signed for. Hedera stops accepting a transaction at
// validStart + TransactionValidDuration, so this is what turns "not on the chain yet" into "not
// on the chain ever" without anyone having to guess a timeout.
export function validStartOf(txId: string): number | null {
  const match = /^\d+\.\d+\.\d+@(\d+)\.(\d+)$/.exec(txId);
  if (match === null) return null;
  return Number(match[1]) * 1000 + Math.floor(Number(String(match[2]).padEnd(9, "0").slice(0, 9)) / 1e6);
}
