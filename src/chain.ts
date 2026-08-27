// What the chain says, and the only place chip402 asks it. Five facts, and every one of them is
// Hedera's rather than ours: the balances, today's spending, who was paid, whether a transaction
// we signed ever happened, and whether the chain agrees this key controls the account we spend
// from. The last one is as much a fact off the chain as the other four, which is why it lives
// here and not beside the policy that reads it. This file reads them; nothing here writes
// anything anywhere.
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
import { MIRROR_TX_ID, SDK_TX_ID } from "./ids.ts";

// One page is a hundred transactions and a day of pocket money is a handful, so this bound is
// about the pathological case rather than the ordinary one. Past the bound we cannot say what was
// spent, and a purse that cannot count must not pay — the caller turns the throw into a denial.
// That is a denial of service on pocket money and not a loss of funds, which is the trade the
// fail-closed posture buys.
//
// What used to reach the bound was cheap for somebody else to arrange: every transaction that so
// much as *touches* the account counts against it, so 1,200 dust transfers *into* the account —
// free on testnet, about $0.12/day on mainnet — stopped payment until local midnight. Money
// arriving cannot cost us anything, and the filter already discarded every one of those rows
// after paying to fetch them. `readTransactions` now asks the narrower question when the wide one
// overflows; see there.
const PAGE_SIZE = 100;
const MAX_PAGES = 12;

// Hedera's own TransactionValidDuration. A signed transaction that has not reached consensus by
// validStart + this can never reach it. That is a fact about the *chain*.
export const VALID_DURATION_MS = 120_000;

// And this is the gap between that fact and the one the settling lane actually needs, which is
// "the mirror node can no longer start showing it". The two are not the same instant, and reading
// them as if they were is a way to hand back the allowance: a facilitator that submits at
// validStart + 119 s reaches consensus inside the window, so the payment is real and will be
// charged — but the mirror node is a second or three behind consensus, and a lane that opened at
// validStart + 120 s exactly would spend those seconds reading a ledger that does not contain it.
//
// So the lock is held for the deadline plus this. It is the same patience `SETTLE_WAIT_MS` already
// spends on the ordinary case, and it costs nothing but denial: too long is a payment refused for
// twenty extra seconds, too short is a payment made twice. If the mirror node is further behind
// than this, the purse is already inside the trust assumption the README states as the honest
// ceiling of the design — it cannot spend what the mirror will not show it.
export const INDEXING_MARGIN_MS = 20_000;

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
  const match = MIRROR_TX_ID.exec(id);
  return match === null ? null : `${match[1]}@${match[2]}.${match[3]}`;
}

// The account that pays for a transaction is the one its id names. The facilitator sponsors
// every x402 payment, so an id beginning with our own account is something we initiated — an
// owner-driven transfer, a failed manual send — and never an agent's purchase.
function payerOf(txId: string): string | null {
  return MIRROR_TX_ID.exec(txId)?.[1] ?? null;
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
//
// Nothing here de-duplicates by transaction id, and two rows can share one: a child transaction
// carries its parent's id, and the real capture contains exactly such a pair. Two things keep
// that from double-counting, and both are elsewhere, so they are written down here rather than
// left to be rediscovered. A child carries its parent's *payer* too, so the second rule covers
// both rows or neither. And the only child a payment of ours could spawn is an auto-creation
// from paying to an alias, which `decide` cannot reach: it requires `payTo` to be an entity id
// (see policy.ts and ids.ts). If either of those ever changes, this loop needs a `seen` set.
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

// The same question `readKeyMatch` asks, answered for the other door — and deliberately not the
// same way. `setup --import` is about to seal a key to this machine and write an account id into
// the config; `readKeyMatch` is about to decide whether a running purse may keep paying. So the
// asymmetry is on purpose and runs in the safe direction for each:
//
//                       | a shape we do not recognise | why
//   --------------------|-----------------------------|--------------------------------------
//   readKeyMatch        | null — "cannot tell", allows| bricking a healthy purse over a
//   (the daemon)        |                             | KeyList or a mirror having a bad
//                       |                             | minute is the larger failure
//   controlsAccount     | false — refuse the import   | refusing at import time costs one
//   (chip402ctl setup)  |                             | command; discovering it at runtime
//                       |                             | costs a purse that cannot pay and
//                       |                             | says nothing about why
//
// The consequence, stated so it is not a surprise: `--import` will refuse an account the daemon
// would happily run against — a threshold key, a KeyList, anything but a plain ECDSA/ED25519 key
// on record or a matching EVM alias. That is the intended direction. `test/chain.test.ts` pins
// the pair against the same table of account shapes, so neither can drift into the other.
export function controlsAccount(account: ChainAccount, publicKeyHex: string, evmAddress: string | null): boolean {
  const onChain = String(account.key?.key ?? "").toLowerCase();
  if (onChain !== "" && onChain === publicKeyHex.toLowerCase()) return true;
  // A hollow account has no key on record yet; its alias is the proof instead.
  const alias = String(account.evm_address ?? "").toLowerCase().replace(/^0x/, "");
  return evmAddress !== null && alias !== "" && alias === evmAddress.toLowerCase();
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

// The walk ran out of pages before it ran out of rows. Its own class, because `readTransactions`
// has to tell this apart from a mirror node that is simply down: one is worth asking a narrower
// question about, the other is not.
class TooManyRows extends Error {}

// One walk back to `from`, newest first. Paged by asking for everything older than the last row we
// saw, rather than by following the `links.next` the server hands us: the bound stays ours, and
// there is no server-supplied URL to fetch.
//
// `filter` is appended to the query verbatim and is never derived from anything outside this file.
async function walk(
  network: NetworkRow,
  accountId: string,
  from: number,
  filter: string,
  what: string,
): Promise<ChainTransaction[]> {
  const floor = (from / 1000).toFixed(9);
  const rows: ChainTransaction[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query =
      `account.id=${encodeURIComponent(accountId)}&timestamp=gte:${floor}` +
      (before === null ? "" : `&timestamp=lt:${before}`) +
      filter +
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
  // "At least", not "more than": the last page may have been the last rows there are, and a full
  // page is indistinguishable from a full page with more behind it. And the window is named by
  // the instant it starts at rather than called "today", because `from` reaches back past local
  // midnight whenever a transaction signed just before it is still in flight — see readLedger.
  throw new TooManyRows(
    `at least ${MAX_PAGES * PAGE_SIZE} ${what} since ${new Date(from).toISOString()} — cannot say what was spent`,
  );
}

// Every transaction touching this account back to `from`, newest first — and, when there are too
// many of those to read, every transaction that took money *out* of it.
//
// SECURITY: the second walk is a fallback and never the first answer, which is the whole of why
// it is safe. The wide query is what the three filter rules were verified against and what runs
// every ordinary day; the narrow one runs only where the alternative is refusing to pay at all,
// so the worst a wrong belief about `type=debit` could cost is a payment in a state that today
// denies every payment. It cannot be provoked, either: `type=debit` drops exactly the rows an
// attacker can create — money arriving — and every row it keeps needs our signature to exist, so
// nobody but us can put a payment of ours on the far side of the filter. If it too overflows, the
// throw stands and the purse still refuses to pay.
//
// Verified against the public testnet mirror node on 2026-08-27 with this account's real history:
// `type=debit` keeps every one of its four x402 payments — all of them token-only debits with no
// HBAR entry for us at all — and drops both incoming HBAR credits and the incoming 20 USDC
// transfer. See test/chain.test.ts and `npm run test:live`.
async function readTransactions(network: NetworkRow, accountId: string, from: number): Promise<ChainTransaction[]> {
  try {
    return await walk(network, accountId, from, "", "transactions");
  } catch (error) {
    if (!(error instanceof TooManyRows)) throw error;
  }
  return walk(network, accountId, from, "&type=debit", "outgoing transactions");
}

// One read of everything the chain has to say about us. `since` is local midnight, and it is both
// the window that is read and the window that is summed — there used to be a second, wider `from`
// for looking back past midnight, and nothing looked: every row before `since` is dropped by
// `paymentsIn`, and the only question that reaches back is `transactionSeen`, which asks about one
// id and has no window. Two requests in the ordinary case.
export async function readLedger(
  network: NetworkRow,
  accountId: string,
  publicKeyHex: string,
  evmAddress: string | null,
  since: number,
): Promise<Ledger> {
  // SECURITY: stamped before the requests go out, not after they come back. `at` is the only thing
  // policy.ts measures staleness against, so it has to be a claim the rows can support. A read
  // issued now and served eight seconds later describes the chain at some instant in between;
  // stamping it on arrival calls that reading eight seconds fresher than it is, which is how a slow
  // answer gets to overtake a fast one and displace it — a ledger whose `spent` predates a payment
  // that has already settled, wearing a timestamp two seconds old. Taken at the start it is a lower
  // bound instead: the data is never *older* than this, which is the direction a deny-on-stale
  // check needs, and it is the ordering `Purse.observe` uses to refuse a reading that was overtaken.
  const at = Date.now();
  const [account, rows] = await Promise.all([
    readAccount(network, accountId),
    readTransactions(network, accountId, since),
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
    at,
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
  const match = SDK_TX_ID.exec(txId);
  if (match === null) return null;
  return Number(match[2]) * 1000 + Math.floor(Number(String(match[3]).padEnd(9, "0").slice(0, 9)) / 1e6);
}
