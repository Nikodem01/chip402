// The product, on one screen. Given an invoice a seller just handed us and the purse as it
// stands, may we pay? Pure: no I/O, no clock of its own, no way to reach the key. Every check
// here is one of the limits in the README, and deleting any line widens the blast radius by
// exactly the failure named next to it.
//
// The two numbers this file bounds spending against — what is held and what has been spent —
// are not stored anywhere. They arrive on `purse.ledger`, read off the mirror node by chain.ts
// moments before this runs, and they go stale: a ledger this file will not trust is a denial,
// which is why an unreachable mirror node stops payment rather than freeing it.

import type { Asset, NetworkRow } from "./networks.ts";
import { assetFor } from "./networks.ts";
import type { PurseState } from "./purse.ts";

// What the seller asked for, already pulled out of the 402 by the caller. `finalUrl` is the URL
// that actually answered — not the one the agent typed — because the fetch may have followed a
// redirect. See fetch.ts for why that distinction is load-bearing.
export type Invoice = {
  readonly finalUrl: string;
  readonly x402Version: number;
  readonly network: string;
  readonly assetId: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly feePayer: unknown;
};

export type PolicyConfig = {
  readonly network: NetworkRow;
  readonly accountId: string;
};

export type Decision = { ok: true; asset: Asset } | { ok: false; reason: string };

// A reading of the chain older than this is not evidence. The daemon re-reads before every
// payment, so hitting this means the mirror node is unreachable — and paying against a stale
// balance, or a stale idea of what has already gone out today, is how a purse goes overdrawn
// without anyone lying.
export const LEDGER_MAX_AGE_MS = 90_000;

// Where the day starts and ends, in this machine's own timezone. This is policy — it is the one
// thing about "today" that is ours rather than the chain's — and it is computed from the clock
// it is handed rather than stored, so there is no saved midnight to fall out of step with the
// calendar.
export function dayStart(now: number): number {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}

export function dayEnd(now: number): number {
  const at = new Date(now);
  at.setHours(24, 0, 0, 0);
  return at.getTime();
}

// Hedera account and token ids look like 0.0.1234, and nothing else does.
const ENTITY_ID = /^\d+\.\d+\.\d+$/;

// The one exception to "https only": the demo seller runs on the loopback interface, where
// there is no network path for anyone to inject a 402 on.
function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

const deny = (reason: string): Decision => ({ ok: false, reason });

export function decide(invoice: Invoice, purse: PurseState, config: PolicyConfig, now: number): Decision {
  // The kill switch comes first so that a paused purse gives one reason and not a queue of them.
  if (purse.paused) return deny("paused");

  // SECURITY: is the account we are reading the chain *about* the account this key can spend
  // *from*? That is the whole question, and deriving spending from the chain made it matter more
  // rather than less. `config.accountId` is the id chain.ts queries, so a config naming somebody
  // else's account produces a purse that reads a stranger's balance, measures the day's allowance
  // against a stranger's transactions, and invites top-ups to an account it could never spend
  // from. Every payment it signs is refused at consensus for a bad signature, so nothing is
  // stolen — but nothing works either, and the panel says otherwise the whole time. Denying with
  // a reason that names the fix turns that from a mystery into an instruction.
  //
  // Only a positively-parsed, positively different key gets here, and only after three readings
  // a minute apart. Anything we could not read is `null` upstream and never denies, because
  // bricking a working purse over an unrecognised key shape is the larger failure.
  if (purse.mismatch) {
    return deny("the chain says a different key controls this account — re-import it with `sudo chip402ctl setup --import`");
  }

  // SECURITY: a transaction we signed has not appeared on the chain yet, so what has been spent
  // today is not yet knowable. Waiting is the whole mechanism — there is no in-flight counter to
  // add up, because a payment that never settles never appears in the sum at all.
  if (purse.settling !== null && now < purse.settling.deadline) return deny("a payment is still settling");

  // SECURITY: refuse anything but v2. The SDK falls back to a v1 body when the v2 header is
  // absent, and v1 requirements are a different shape with different fields — accepting one
  // would mean signing against a schema this file never checked.
  if (invoice.x402Version !== 2) return deny(`unsupported x402 version ${invoice.x402Version}`);

  // SECURITY: a plaintext seller can be impersonated by anyone on the network path, and paying
  // an impersonator is indistinguishable from paying the seller. Loopback has no path to sit on.
  let host: URL;
  try {
    host = new URL(invoice.finalUrl);
  } catch {
    return deny("unparseable resource url");
  }
  if (host.protocol !== "https:" && !isLoopback(host.hostname)) return deny("plaintext seller");

  // SECURITY: the network is pinned to the configured row. A seller offering hedera:mainnet to a
  // testnet purse is refused rather than translated — chip402 never converts anything.
  if (invoice.network !== config.network.caip2) return deny(`wrong network ${invoice.network}`);

  // The asset must be one of the two in that row. A look-alike token id simply fails to resolve,
  // which is why there is no allowlist to maintain.
  const asset = assetFor(config.network, invoice.assetId);
  if (asset === undefined) return deny(`unknown asset ${invoice.assetId}`);
  const budget = purse[asset.key];

  // SECURITY: extra.feePayer is chosen by the seller and becomes the transaction id's payer. If
  // it named us, the purse would pay the network fee out of its own HBAR — real money — for a
  // transaction we did not initiate. It is also what chain.ts reads to tell an agent's purchase
  // from something the owner did, so a seller naming us here would make a payment invisible to
  // the sum as well as expensive.
  if (typeof invoice.feePayer !== "string" || !ENTITY_ID.test(invoice.feePayer)) {
    return deny("missing or malformed feePayer");
  }
  if (invoice.feePayer === config.accountId) return deny("seller named us as fee payer");
  if (!ENTITY_ID.test(invoice.payTo)) return deny("malformed payTo");

  // SECURITY: and the seller may not name us as the recipient either. The transfer would net to
  // zero, the content would be delivered, and the day's allowance would be gone — a free lunch
  // paid for out of the agent's leash rather than out of the seller's pocket.
  if (invoice.payTo === config.accountId) return deny("seller named us as the recipient");

  if (invoice.amount <= 0n) return deny("non-positive amount");

  // Limit 1 — the per-payment cap bounds one bad invoice.
  if (invoice.amount > budget.maxPayment) return deny(`over the ${asset.symbol} per-payment cap`);

  // Limit 2 — the daily allowance bounds a runaway loop and every hostile seller combined. A
  // zero allowance denies everything, which is how an asset is switched off: there is no
  // separate enable flag to get out of step with this number.
  if (budget.allowance === 0n) return deny(`${asset.symbol} is switched off`);

  // Limits 2 and 3 both rest on the chain's answer, so the answer has to be one we can stand on.
  // Never read, too old, or measured from a midnight that has since passed: all three are a
  // refusal, and none of them is a zero.
  const ledger = purse.ledger;
  if (ledger === null) return deny("the chain has not answered yet");
  if (now - ledger.at > LEDGER_MAX_AGE_MS) return deny("what the chain says is too old to trust");
  if (ledger.since !== dayStart(now)) return deny("the day has rolled over since the chain was read");

  if (ledger.spent[asset.key] + invoice.amount > budget.allowance) {
    return deny(`over the ${asset.symbol} daily allowance`);
  }

  // Limit 3 — the on-chain balance. Nobody can raise this one; it is a fact, not a setting.
  if (invoice.amount > ledger.balances[asset.key]) return deny(`not enough ${asset.symbol} in the purse`);

  return { ok: true, asset };
}
