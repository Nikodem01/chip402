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
import { controlsAccount, paymentsIn, readKeyMatch, readLedger, toMirrorId, validStartOf } from "../src/chain.ts";
import type { AssetKey } from "../src/networks.ts";
import { dayStart } from "../src/policy.ts";
import { OUR_ACCOUNT, OUR_EVM_ADDRESS, OUR_PUBLIC_KEY, SELLER, fakeMirror, testnet } from "./support.ts";

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

test("everything that is not an x402 payment is dropped", () => {
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

// The real x402 purchase out of the capture: the $1.60 to Printwright, facilitator-paid, our
// account down 1_600_000 micro-USDC. Every case below is this row with exactly one field moved.
const PURCHASE = rows.find((r: Record<string, unknown>) => r["transaction_id"] === "0.0.7162784-1787718561-825914914");

test("each of the three rules drops on its own, from a row that otherwise passes", () => {
  // The loop above can only inspect rows that survived, so it cannot tell a rule that fires from
  // a rule that is never reached: in this capture every failed transaction was also paid for by
  // us, so deleting the SUCCESS test left the whole suite green. Each rule is broken here on a
  // row that all three otherwise accept, which is the only way to see it fire alone.
  assert.equal(paymentsIn([PURCHASE], testnet, NOW_ACCOUNT, AUG_26).length, 1, "the baseline row is not counted");

  // Rule 1 — the transaction failed, so it moved nothing and costs the allowance nothing.
  const failed = { ...PURCHASE, result: "INSUFFICIENT_ACCOUNT_BALANCE" };
  assert.deepEqual(paymentsIn([failed], testnet, NOW_ACCOUNT, AUG_26), [], "a failed transaction was counted");

  // Rule 2 — the transaction id names us as its payer, so the owner initiated it.
  const ours = { ...PURCHASE, transaction_id: `${NOW_ACCOUNT}-1787718561-825914914` };
  assert.deepEqual(paymentsIn([ours], testnet, NOW_ACCOUNT, AUG_26), [], "something we initiated was counted");

  // Rule 3 — our leg is positive, so this is money arriving.
  const incoming = {
    ...PURCHASE,
    token_transfers: (PURCHASE["token_transfers"] as Record<string, unknown>[]).map((t) => ({ ...t, amount: -(t["amount"] as number) })),
  };
  assert.deepEqual(paymentsIn([incoming], testnet, NOW_ACCOUNT, AUG_26), [], "money arriving was counted as spending");
});

test("a transfer list that names our account twice is netted, not sampled", () => {
  // The mirror node may split one account's movement across several entries in the same list, and
  // what was spent is the net of them. Reading only the first entry would read a $1.60 purchase
  // that came with a $1.00 refund as $1.60 — or, with the entries the other way round, as nothing
  // at all. Both orders are asserted, because a sampling bug survives one of them.
  const split = (amounts: number[]): Record<string, unknown> => ({
    ...PURCHASE,
    token_transfers: [
      { token_id: testnet.assets.usdc.id, account: "0.0.9584959", amount: 600_000, is_approval: false },
      ...amounts.map((amount) => ({ token_id: testnet.assets.usdc.id, account: NOW_ACCOUNT, amount, is_approval: false })),
    ],
  });
  for (const order of [[-1_600_000, 1_000_000], [1_000_000, -1_600_000]]) {
    const [payment, ...rest] = paymentsIn([split(order)], testnet, NOW_ACCOUNT, AUG_26);
    assert.equal(rest.length, 0, JSON.stringify(order));
    assert.equal(payment?.amount, 600_000n, `the two entries were not netted: ${JSON.stringify(order)}`);
    // And the counterparty is still the account that came out ahead by exactly that net.
    assert.equal(payment?.payTo, "0.0.9584959", JSON.stringify(order));
  }
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

// --- the dust attack, and the narrower question that answers it -------------------------------

test("a thousand dust transfers in cannot stop the purse from counting what went out", async (t) => {
  // The denial of service the old bound bought for 1,200 free testnet transfers: every row that
  // so much as touches the account counted against MAX_PAGES × PAGE_SIZE, including money
  // *arriving*, which the filter then threw away after paying to fetch it. Past the bound the
  // chain read threw, `refresh()` threw, and every payment was denied until local midnight.
  //
  // The fix is not more pages. It is asking the mirror node the narrower question — what came
  // *out* of this account — which is the only half the sum was ever going to keep, and which
  // nobody but this daemon can add a row to.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const since = dayStart(Date.now());

  mirror.record("0.0.9185802@1800000001.0", "usdc", 10_000n, since + 10_000);
  mirror.record("0.0.9185802@1800000002.0", "usdc", 10_000n, since + 20_000);
  // Free on testnet, about $0.12/day on mainnet. Comfortably past 12 × 100.
  mirror.dust(1_500, "hbar", since + 1_000);

  const ledger = await readLedger(mirror.network, OUR_ACCOUNT, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS, since);
  assert.equal(ledger.spent.usdc, 20_000n, "the dust made spending uncomputable");
  assert.equal(ledger.spent.hbar, 0n, "dust arriving was counted as dust spent");
  assert.equal(ledger.payments.length, 2);
  // And it got there by asking the narrow question, not by reading more pages: one request, and
  // the fifteen hundred rows of dust were never fetched at all.
  const walks = mirror.requests.filter((path) => path.startsWith("/api/v1/transactions?"));
  assert.equal(walks.length, 1, `the day took ${walks.length} requests to read`);
  assert.ok(walks[0]!.includes("type=debit"), "the walk asked for anything but outgoing transactions");
});

test("the window that is read is the window that is summed", async (t) => {
  // `readLedger` used to take a second, wider `from` so that a transaction signed just before
  // midnight could "still be looked for". Nothing looked — every row before `since` is dropped
  // here, and the in-flight question is a direct lookup of one id — so the reach-back fetched rows
  // only to discard them, and every one counted against the page bound. The parameter is gone; what
  // this pins is the property that made it pointless, and the one that would matter if it came
  // back as a widened `since` instead: a row from before local midnight is neither asked for nor
  // counted. (The old widening was itself capped at `min(since, now - 120s)`, so its only visible
  // effect was inside the two minutes after midnight — which is why the removal rests on the
  // signature no longer having somewhere to put it, rather than on a test with a fake clock.)
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const since = dayStart(Date.now());
  mirror.record("0.0.9185802@1800000010.0", "usdc", 70_000n, since - 5_000);
  mirror.record("0.0.9185802@1800000011.0", "usdc", 10_000n, since + 5_000);

  const ledger = await readLedger(mirror.network, OUR_ACCOUNT, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS, since);
  assert.equal(ledger.spent.usdc, 10_000n, "yesterday's payment was counted against today");
  assert.equal(ledger.payments.length, 1);
  const floor = (since / 1000).toFixed(9);
  for (const path of mirror.requests.filter((p) => p.startsWith("/api/v1/transactions?"))) {
    assert.ok(path.includes(`timestamp=gte:${floor}`), `the chain was read past midnight: ${path}`);
  }
});

test("a day costs two requests, and one of them is not a page of rows", async (t) => {
  // What a whole day's reading is, measured rather than asserted. The account endpoint for the
  // balances and the key, and one walk of the outgoing transactions — and the account endpoint is
  // asked not to bundle a transaction list it would then be parsed out of and thrown away. Against
  // the public testnet node that one parameter is 23,072 bytes against 740.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const since = dayStart(Date.now());
  mirror.record("0.0.9185802@1800000003.0", "usdc", 10_000n, since + 10_000);

  const ledger = await readLedger(mirror.network, OUR_ACCOUNT, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS, since);
  assert.equal(ledger.spent.usdc, 10_000n);
  assert.equal(ledger.accountId, OUR_ACCOUNT, "a reading that cannot say whose it is");
  assert.equal(ledger.complete, true);
  assert.equal(mirror.requests.length, 2, mirror.requests.join(" "));
  const account = mirror.requests.find((path) => path.startsWith("/api/v1/accounts/"))!;
  assert.ok(account.includes("transactions=false"), "the account read still drags a page of rows behind it");
});

test("a reading that stopped at the page bound says so instead of pretending", async (t) => {
  // The walk is bounded, and the bound is generous because it runs once per daemon start rather
  // than twice per payment. What matters is that a walk which stopped short cannot be mistaken for
  // a day: `complete` is false, and `Purse.observe` refuses to seed a figure from it.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const since = dayStart(Date.now());
  for (let i = 0; i < 150; i++) mirror.record(`0.0.9185802@18000001${String(i).padStart(2, "0")}.0`, "usdc", 1n, since + i);

  const stopped = await readLedger(mirror.network, OUR_ACCOUNT, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS, since, 1);
  assert.equal(stopped.complete, false, "a walk that stopped at the bound called itself a day");
  assert.equal(stopped.payments.length, 100);

  const whole = await readLedger(mirror.network, OUR_ACCOUNT, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS, since);
  assert.equal(whole.complete, true);
  assert.equal(whole.payments.length, 150);
  assert.equal(whole.spent.usdc, 150n);
});

test("nobody but this daemon can add a row to the question that is asked", async (t) => {
  // Why the bound stopped being something an outsider could reach. Every row `type=debit` keeps is
  // a transaction that took money out of this account, and every one of those needs a signature only
  // this daemon can produce. Money arriving — the thing anyone can send, for nothing on testnet and
  // about $0.12 a day on mainnet — is not in the answer at all. So the walk is bounded by our own
  // spending, and the only way to reach the bound is to have made twenty thousand payments today.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const since = dayStart(Date.now());
  mirror.record("0.0.9185802@1800000001.0", "usdc", 10_000n, since + 10_000);
  mirror.dust(5_000, "usdc", since + 1_000);
  mirror.dust(5_000, "hbar", since + 20_000);

  const ledger = await readLedger(mirror.network, OUR_ACCOUNT, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS, since);
  assert.equal(ledger.complete, true, "ten thousand rows of somebody else's dust bounded our walk");
  assert.equal(ledger.spent.usdc, 10_000n);
  assert.equal(ledger.payments.length, 1);
  assert.equal(mirror.requests.filter((path) => path.startsWith("/api/v1/transactions?")).length, 1);
});

// --- "is this key ours?", asked at two doors ----------------------------------------------------

test("the import check and the daemon's key check differ on purpose, and only in the safe direction", () => {
  // `readKeyMatch` runs on every chain read and gates payment; `controlsAccount` runs once, inside
  // `chip402ctl setup --import`, before a key is sealed to this machine. They answer an
  // unrecognised key shape differently and that is the whole point: the daemon must not brick a
  // healthy purse over a KeyList, and the import must not accept an account it cannot prove the
  // key controls. Neither had a test, so nothing stopped one drifting into the other.
  const ours = { _type: "ECDSA_SECP256K1", key: OUR_PUBLIC_KEY };
  const theirs = { _type: "ECDSA_SECP256K1", key: "02" + "f".repeat(64) };
  const table: [string, Record<string, unknown>, boolean | null, boolean][] = [
    // account shape                                       | readKeyMatch | controlsAccount
    ["our key on record", { key: ours }, true, true],
    ["our EVM alias, no key yet (a hollow account)", { evm_address: `0x${OUR_EVM_ADDRESS}`, key: null }, true, true],
    ["a different key on record", { key: theirs }, false, false],
    ["no key at all", { key: null }, null, false],
    ["a KeyList", { key: { _type: "KeyList", key: "" } }, null, false],
    ["a threshold key", { key: { _type: "ThresholdKey", key: "abc" } }, null, false],
    ["ProtobufEncoded", { key: { _type: "ProtobufEncoded", key: "0a05" } }, null, false],
    ["a shape with no key field", { key: { _type: "ECDSA_SECP256K1" } }, null, false],
  ];
  for (const [name, account, daemon, importer] of table) {
    assert.equal(readKeyMatch(account, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS), daemon, `readKeyMatch: ${name}`);
    assert.equal(controlsAccount(account, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS), importer, `controlsAccount: ${name}`);
  }

  // And neither is fooled by an empty answer standing in for a match. A hollow account has no key
  // on record, so `key.key` reads as "" — if that were compared without a guard, a caller holding
  // an empty public key would be told it controls every hollow account there is. Nothing produces
  // an empty public key today; the guard is what keeps that from being load-bearing.
  const hollow = { key: null };
  assert.equal(controlsAccount(hollow, "", null), false, "an empty key controlled a hollow account");
  assert.equal(controlsAccount({ key: { _type: "ECDSA_SECP256K1", key: "" } }, "", null), false);
  assert.equal(readKeyMatch({ key: { _type: "ECDSA_SECP256K1", key: "" } }, "", null), null);
  assert.equal(controlsAccount({ evm_address: "0x" }, "", ""), false, "an empty alias matched an empty address");

  // Stated as the rule rather than only as a table: the two agree wherever the daemon is sure, and
  // where it is not, the import is the stricter of the two. It is never the other way round — an
  // import that accepted what the daemon denies would seal a key into a purse that cannot pay.
  for (const [name, account, daemon, importer] of table) {
    if (daemon !== null) assert.equal(importer, daemon, `they disagree where the daemon is sure: ${name}`);
    else assert.equal(importer, false, `the import is the looser of the two: ${name}`);
  }
});
