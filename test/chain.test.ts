// The ledger, read rather than kept. This is the file that has to be right for any of the rest
// to mean anything: if the filter below is wrong, every limit in the project is measured against
// the wrong number.
//
// So it is tested against real data. `fixtures/transactions.json` is a verbatim capture of
// `/api/v1/transactions?account.id=0.0.10193689&timestamp=gte:…` from the public testnet mirror
// node on 2026-08-26 — three x402 purchases, two incoming transfers, six transactions this
// machine's owner initiated by hand, four of which failed, and an account creation. Nothing in
// it was written for a test.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { paymentsIn, readKeyMatch, toMirrorId, validStartOf } from "../src/chain.ts";
import type { AssetKey } from "../src/networks.ts";
import { OUR_EVM_ADDRESS, OUR_PUBLIC_KEY, testnet } from "./support.ts";

const rows = JSON.parse(readFileSync(new URL("fixtures/transactions.json", import.meta.url), "utf8")).transactions;

// This machine's account, and the wallet it replaced. Both appear in the capture, which is the
// whole point of the regression at the bottom of this file.
const NOW_ACCOUNT = "0.0.10193689";
const OLD_WALLET = "0.0.10228269";

// Local midnight on the two days the capture spans, in milliseconds. Fixed numbers rather than
// a clock, so this file says the same thing next year as it does today.
const AUG_26 = 1_787_668_200_000;
const AUG_25 = 1_787_581_800_000;

function spent(account: string, since: number): Record<AssetKey, bigint> {
  const total: Record<AssetKey, bigint> = { usdc: 0n, hbar: 0n };
  for (const payment of paymentsIn(rows, testnet, account, since)) total[payment.asset] += payment.amount;
  return total;
}

test("today's spending is what the chain says it is, to the unit", () => {
  // The figure the plan was written against, and the figure the panel must show: $1.62 of USDC
  // and no HBAR at all. Three purchases: $1.60 to Printwright and two of a cent.
  assert.equal(spent(NOW_ACCOUNT, AUG_26).usdc, 1_620_000n);
  assert.equal(spent(NOW_ACCOUNT, AUG_26).hbar, 0n);
  assert.equal(paymentsIn(rows, testnet, NOW_ACCOUNT, AUG_26).length, 3);
});

test("REGRESSION: spending follows the account, so swapping the wallet moves the ℏ0.02", () => {
  // This is the bug that started the rewrite, in one assertion. The old build's purse.json
  // carried ℏ0.02 of "spent today" across a `setup --import` and charged this account's
  // allowance for it. The capture shows where those two payments really belong: seen from
  // 0.0.10193689 they are money arriving and count for nothing; seen from 0.0.10228269 — the
  // wallet that made them — they are exactly ℏ0.02 going out.
  assert.equal(spent(NOW_ACCOUNT, AUG_26).hbar, 0n, "the ℏ0.02 the old build invented");
  assert.equal(spent(OLD_WALLET, AUG_26).hbar, 2_000_000n, "and where it actually belongs");
  // Nothing is shared: the account id is the only thing that changed.
  assert.equal(spent(OLD_WALLET, AUG_26).usdc, 0n);
});

test("yesterday's spending does not reach today, and today's window is the only thing that sets that", () => {
  // Same rows, one different number. There is no counter to zero at midnight and nothing to
  // roll over — "today" is a bound on a query.
  assert.equal(spent(NOW_ACCOUNT, AUG_25).usdc, 1_690_000n);
  assert.ok(spent(NOW_ACCOUNT, AUG_25).hbar > 0n, "yesterday had HBAR payments");
  assert.equal(spent(NOW_ACCOUNT, AUG_26).hbar, 0n, "and today has none");
});

test("everything that is not an x402 payment is dropped, and each rule drops on its own", () => {
  const payments = paymentsIn(rows, testnet, NOW_ACCOUNT, AUG_25);
  for (const payment of payments) {
    const row = rows.find((r: Record<string, string>) => r["transaction_id"] === toMirrorId(payment.txId)) as Record<string, string>;
    assert.equal(row["result"], "SUCCESS", "a failed transaction was counted as spending");
    assert.notEqual(row["transaction_id"]!.split("-")[0], NOW_ACCOUNT, "something we initiated was counted");
    assert.ok(payment.amount > 0n);
  }
  // Four INSUFFICIENT_*_BALANCE rows, an account creation and the transfers the owner signed are
  // all in the capture, and none of them is in the answer.
  assert.ok(rows.some((r: Record<string, string>) => r["result"] !== "SUCCESS"), "the capture has failures in it");
  assert.ok(
    rows.some((r: Record<string, string>) => String(r["transaction_id"]).startsWith(NOW_ACCOUNT)),
    "the capture has owner-initiated transactions in it",
  );
  assert.ok(payments.length < rows.length);
});

test("money arriving is not money spent", () => {
  // Two incoming ℏ0.01 transfers today, sponsored by the facilitator exactly like a purchase is.
  // The only thing separating them from spending is the sign, which is why the filter tests it.
  const incoming = rows.filter(
    (r: Record<string, any>) =>
      r["result"] === "SUCCESS" &&
      (r["transfers"] ?? []).some((t: Record<string, any>) => t["account"] === NOW_ACCOUNT && t["amount"] > 0),
  );
  assert.ok(incoming.length >= 2, "the capture has incoming transfers in it");
  for (const row of incoming) {
    assert.ok(
      !paymentsIn([row], testnet, NOW_ACCOUNT, AUG_25).some((p) => p.asset === "hbar"),
      `an incoming transfer was counted as spending: ${row["transaction_id"]}`,
    );
  }
});

test("a payment names the seller the chain says it paid, not the fee accounts", () => {
  const [printwright] = paymentsIn(rows, testnet, NOW_ACCOUNT, AUG_26);
  assert.equal(printwright?.amount, 1_600_000n);
  assert.equal(printwright?.payTo, "0.0.9584959");
  assert.equal(printwright?.txId, "0.0.7162784@1787718561.825914914");
});

// --- the key check, in all three of its states ------------------------------------------------

test("verified is true when a recognised key matches, or when the alias does", () => {
  assert.equal(
    readKeyMatch({ key: { _type: "ECDSA_SECP256K1", key: OUR_PUBLIC_KEY } }, OUR_PUBLIC_KEY, null),
    true,
  );
  // The alias is cryptographic and format-stable, so it settles it even when the key on record
  // is one we would not otherwise recognise.
  assert.equal(
    readKeyMatch({ evm_address: `0x${OUR_EVM_ADDRESS}`, key: { _type: "ProtobufEncoded", key: "0a05..." } }, "ff", OUR_EVM_ADDRESS),
    true,
  );
});

test("verified is false only for a key we positively parsed and positively disagree with", () => {
  const other = "03aaaa508826d133c2f84ef423aaea6f9ae25b523d1f71dda76c10a90b7c9a60e0";
  assert.equal(readKeyMatch({ key: { _type: "ECDSA_SECP256K1", key: other } }, OUR_PUBLIC_KEY, null), false);
  assert.equal(readKeyMatch({ key: { _type: "ED25519", key: other } }, OUR_PUBLIC_KEY, null), false);
  // And an alias that agrees outranks a key that does not — an account can be reached by either.
  assert.equal(
    readKeyMatch({ evm_address: `0x${OUR_EVM_ADDRESS}`, key: { _type: "ECDSA_SECP256K1", key: other } }, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS),
    true,
  );
});

test("ANTI-BRICK: anything we do not recognise is null, never false", () => {
  // The old build's `verified` was a boolean, so every one of these collapsed to "no". A
  // threshold account or a ProtobufEncoded key would have stopped a working purse dead. None of
  // these may ever return false; policy.ts allows on null and denies on false.
  const shapes: Record<string, unknown>[] = [
    {},
    { key: null },
    { key: {} },
    { key: { _type: "ProtobufEncoded", key: "0a05..." } },
    { key: { _type: "KeyList", key: "" } },
    { key: { _type: "ThresholdKey", key: "abc" } },
    { key: { _type: "ECDSA_SECP256K1" } },
    { key: { _type: "ECDSA_SECP256K1", key: "" } },
    { evm_address: null, key: null },
  ];
  for (const account of shapes) {
    assert.equal(readKeyMatch(account, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS), null, JSON.stringify(account));
  }
});

// --- the two id spellings ---------------------------------------------------------------------

test("a transaction id survives the round trip between the SDK's spelling and the mirror's", () => {
  assert.equal(toMirrorId("0.0.9185802@1787717722.334755737"), "0.0.9185802-1787717722-334755737");
  // And back again, through the filter, off a real row.
  const [first] = paymentsIn(rows, testnet, NOW_ACCOUNT, AUG_26);
  assert.match(String(first?.txId), /^\d+\.\d+\.\d+@\d+\.\d+$/);
});

test("validStart comes out of the id, which is what turns 'not yet' into 'never'", () => {
  assert.equal(validStartOf("0.0.9185802@1787717722.334755737"), 1_787_717_722_334);
  assert.equal(validStartOf("nonsense"), null);
  assert.equal(validStartOf("0.0.9185802-1787717722-334755737"), null);
});
