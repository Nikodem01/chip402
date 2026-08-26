// The enforcement proof. policy.ts deciding "no" is only worth something if no signature can
// be produced anyway, so this file drives the guarded signer with a stub underneath and asserts
// the stub is never reached on any deny path — and that the lane closes on the allow path.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentRequirements } from "@x402/fetch";
import { inspectHederaTransaction } from "@x402/hedera";
import type { Sighting } from "../src/fetch.ts";
import { Purse } from "../src/purse.ts";
import { denialReason, guard, refresh, settle } from "../src/wallet.ts";
import {
  FACILITATOR,
  OUR_ACCOUNT,
  OUR_EVM_ADDRESS,
  OUR_PUBLIC_KEY,
  SELLER,
  config,
  fakeMirror,
  labelStore,
  ledger,
  scratch,
  testSigner,
  testnet,
} from "./support.ts";

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: testnet.caip2 as PaymentRequirements["network"],
    asset: testnet.assets.usdc.id,
    amount: "10000",
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { feePayer: FACILITATOR },
    ...over,
  } as PaymentRequirements;
}

// A purse that would happily pay the invoice above, so each test breaks exactly one thing. The
// limits are policy and are set here; the balances and today's spending are the chain's answer
// and are handed in the same way the mirror node hands them to the daemon.
function readyPurse(over: Parameters<typeof ledger>[0] = {}): Purse {
  const purse = Purse.open(join(scratch(), "purse.json"));
  purse.setPaused(false);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.setLimit("usdc", "maxPayment", 250_000n);
  purse.setLimit("hbar", "allowance", 10_000_000_000n);
  purse.setLimit("hbar", "maxPayment", 1_000_000_000n);
  purse.observe(ledger(over, Date.now()), false);
  return purse;
}

function harness(purse: Purse, seen: Partial<Sighting> = {}) {
  const inner = testSigner();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2, ...seen };
  const charged: (string | null)[] = [];
  const labels = labelStore();
  // The guard no longer writes labels — payer() does, from the same callback — so the harness
  // stands in for that, and the assertion below is about where the host comes from either way.
  const signer = guard(inner, purse, config, sighting, (receipt) => {
    charged.push(receipt.txId);
    labels.record(receipt.txId, receipt.host);
  });
  return { signer, charged, calls: inner.calls, labels };
}

test("the transaction id on the receipt is ours, read out of the bytes we signed", async () => {
  const purse = readyPurse();
  const { signer, charged, calls, labels } = harness(purse);
  const payload = await signer.createPartiallySignedTransferTransaction(requirements());
  assert.equal(calls(), 1);
  assert.equal(charged.length, 1);
  // Not the seller's claim: the same id the SDK put in the body we signed, which the facilitator
  // cannot change and the seller never had a say in.
  assert.equal(charged[0], inspectHederaTransaction(payload).transactionId);
  assert.equal(purse.state.settling?.txId, charged[0], "the lane did not close on the signature");
  assert.equal(labels.hostFor(String(charged[0])), "api.example.com");
});

test("SECURITY: a second signature inside one payment throws", async () => {
  // The README used to argue this was safe because we register no onPaymentResponse hook and
  // because the sighting resets on the 200. Both were true and both were incidental. A signed
  // `exact` transfer is a bearer instrument; two of them is twice the money.
  const purse = readyPurse();
  const { signer, calls } = harness(purse);
  await signer.createPartiallySignedTransferTransaction(requirements());
  await assert.rejects(
    () => signer.createPartiallySignedTransferTransaction(requirements()),
    (error: unknown) => {
      assert.match(String(denialReason(error)), /second signature/);
      return true;
    },
  );
  assert.equal(calls(), 1, "the key was reached twice in one payment");
});

test("a second payment is refused while the first is still unaccounted for", async () => {
  // Not a counter: the lane. The chain has not shown the first transaction yet, so what has been
  // spent today is not yet knowable, so nothing else may go out.
  const purse = readyPurse();
  await harness(purse).signer.createPartiallySignedTransferTransaction(requirements());
  const second = harness(purse);
  await assert.rejects(
    () => second.signer.createPartiallySignedTransferTransaction(requirements()),
    (error: unknown) => {
      assert.match(String(denialReason(error)), /still settling/);
      return true;
    },
  );
  assert.equal(second.calls(), 0);
});

// Every denial policy.ts can reach, driven through the door rather than through the function.
const DENIALS: { name: string; purse?: (p: Purse) => void; req?: Partial<PaymentRequirements>; seen?: Partial<Sighting>; reason: RegExp }[] = [
  { name: "paused", purse: (p) => p.setPaused(true), reason: /paused/ },
  { name: "a confirmed key mismatch", purse: (p) => p.observe(ledger({}, Date.now()), true), reason: /different key controls/ },
  { name: "a v1 downgrade", seen: { x402Version: 1 }, reason: /unsupported x402 version/ },
  { name: "no v2 offer at all", seen: { x402Version: 0 }, reason: /unsupported x402 version/ },
  { name: "a plaintext seller", seen: { finalUrl: "http://api.example.com/x" }, reason: /plaintext/ },
  { name: "the wrong chain", req: { network: "hedera:mainnet" as PaymentRequirements["network"] }, reason: /wrong network/ },
  { name: "a look-alike token", req: { asset: "0.0.429275" }, reason: /unknown asset/ },
  { name: "over the per-payment cap", req: { amount: "300000" }, reason: /per-payment cap/ },
  {
    name: "over the daily allowance",
    purse: (p) => p.setLimit("usdc", "allowance", 5_000n),
    reason: /daily allowance/,
  },
  { name: "an asset switched off", purse: (p) => p.setLimit("usdc", "allowance", 0n), reason: /switched off/ },
  {
    name: "an empty purse",
    purse: (p) => p.observe(ledger({ balances: { usdc: 0n, hbar: 0n } }, Date.now()), false),
    reason: /not enough/,
  },
  {
    name: "a stale reading of the chain",
    purse: (p) => p.observe(ledger({ at: Date.now() - 200_000 }, Date.now()), false),
    reason: /too old to trust/,
  },
  { name: "us as fee payer", req: { extra: { feePayer: OUR_ACCOUNT } }, reason: /named us as fee payer/ },
  { name: "no fee payer", req: { extra: {} }, reason: /missing or malformed feePayer/ },
  { name: "a malformed payTo", req: { payTo: "0xabc" }, reason: /malformed payTo/ },
  { name: "us as the recipient", req: { payTo: OUR_ACCOUNT }, reason: /named us as the recipient/ },
  { name: "an amount that is not an integer", req: { amount: "0.25" }, reason: /unparseable amount/ },
  { name: "a zero amount", req: { amount: "0" }, reason: /non-positive amount/ },
];

for (const denial of DENIALS) {
  test(`no signature is produced for ${denial.name}`, async () => {
    const purse = readyPurse();
    denial.purse?.(purse);
    const { signer, charged, calls } = harness(purse, denial.seen ?? {});
    await assert.rejects(
      () => signer.createPartiallySignedTransferTransaction(requirements(denial.req ?? {})),
      (error: unknown) => {
        assert.match(String(denialReason(error)), denial.reason);
        return true;
      },
    );
    // The three things that must all be true on every deny path.
    assert.equal(calls(), 0, "the key was reached");
    assert.equal(charged.length, 0, "a payment was recorded");
    assert.equal(purse.state.settling, null, "the lane closed for a payment that never happened");
  });
}

// --- the two ways the lane reopens, and no third ----------------------------------------------

test("the lane reopens the moment the chain shows the transaction", async (t) => {
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const inner = testSigner(mirror);
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  const signer = guard(inner, purse, walletConfig, sighting, (receipt) => {
    txId = receipt.txId;
  });

  await signer.createPartiallySignedTransferTransaction(requirements());
  assert.notEqual(purse.state.settling, null);
  assert.equal(await settle(walletConfig, purse, txId, 5_000), true);
  assert.equal(purse.state.settling, null);

  // And the next reading of the chain contains it, which is the point of having waited.
  const after = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(after.spent.usdc, 10_000n);
  assert.equal(after.payments[0]?.txId, txId);
});

test("the lane reopens when the transaction can no longer reach the chain, and nothing is counted", async (t) => {
  // The other exit: validStart + TransactionValidDuration has passed with the mirror node never
  // having seen it. Nothing is given back because nothing was taken — a payment that never
  // settled simply never appears in the sum.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  mirror.indexing = true;
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const inner = testSigner(mirror);
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  const signer = guard(inner, purse, walletConfig, sighting, (receipt) => {
    txId = receipt.txId;
  });

  await signer.createPartiallySignedTransferTransaction(requirements());
  const deadline = purse.state.settling!.deadline;
  // Giving up on patience is not an exit: the lane stays shut and policy.ts keeps denying.
  assert.equal(await settle(walletConfig, purse, txId, 0), false);
  assert.notEqual(purse.state.settling, null);

  // Wind the clock past validStart + 120s by pretending it already was — the deadline is the
  // only thing that ends this, so moving it is the same experiment as waiting two minutes.
  purse.beginSettling(txId, Date.now() - 121_000);
  assert.ok(purse.state.settling!.deadline < Date.now());
  assert.equal(await settle(walletConfig, purse, txId, 0), false);
  assert.equal(purse.state.settling, null, "the lane never reopened");
  assert.ok(deadline > 0);

  const after = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(after.spent.usdc, 0n, "a payment that never settled was counted");
});

test("bytes we cannot read back close the lane on the clock alone", async () => {
  // If inspectHederaTransaction cannot tell us what we just signed, we cannot ask the chain
  // about it either. Fail closed: the lane still shuts, and only the deadline opens it.
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  const signer = guard(
    { accountId: OUR_ACCOUNT, createPartiallySignedTransferTransaction: async () => "not-a-transaction" },
    purse,
    config,
    sighting,
    () => {},
  );
  await signer.createPartiallySignedTransferTransaction(requirements());
  assert.notEqual(purse.state.settling, null);
  assert.equal(purse.state.settling?.txId, null);
});

// --- the structural guarantees -----------------------------------------------------------------

test("createClientHederaSigner appears exactly once in src/, inside the guard", () => {
  // SECURITY: this is the assertion that stops a second path to the key being added. If someone
  // builds another signer anywhere in src/, this fails before the review does.
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));
  let total = 0;
  for (const name of files) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    const hits = (source.match(/createClientHederaSigner\(/g) ?? []).length;
    if (hits > 0) assert.equal(name, "wallet.ts", `${name} builds a signer`);
    total += hits;
  }
  assert.equal(total, 1);
});

test("nothing outside wallet.ts imports the Hedera SDK or reads the credential", () => {
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));
  for (const name of files) {
    if (name === "wallet.ts" || name === "safe.ts") continue;
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "@x402\/hedera|from "@hiero-ledger|readSecret\(/, `${name} can reach the key`);
  }
});

test("the seller's settlement header is not read anywhere", () => {
  // It used to supply the transaction id on a receipt. The id in the bytes we signed is the same
  // id and is not the seller's to write, so a whole class of seller-controlled input is gone —
  // and this asserts it stays gone rather than coming back as a convenience.
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));
  for (const name of files) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /decodePaymentResponseHeader/, `${name} decodes the seller's claim`);
    assert.doesNotMatch(source, /headers\.get\(\s*["'][^"']*payment-response/i, `${name} reads the seller's claim`);
  }
});
