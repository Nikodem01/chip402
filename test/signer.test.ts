// The enforcement proof. policy.ts deciding "no" is only worth something if no signature can
// be produced anyway, so this file drives the guarded signer with a stub underneath and asserts
// the stub is never reached on any deny path — and that the allow path commits what it authorised
// before it reaches the key.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentRequirements } from "@x402/fetch";
import { PrivateKey, inspectHederaTransaction } from "@x402/hedera";
import type { Sighting } from "../src/fetch.ts";
import type { Authorization } from "../src/purse.ts";
import { Purse } from "../src/purse.ts";
import { denialReason, guard, openWallet, refresh, resolve } from "../src/wallet.ts";
import { dayStart } from "../src/policy.ts";
import { INDEXING_MARGIN_MS, VALID_DURATION_MS } from "../src/chain.ts";
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
  sleep,
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
  assert.equal(purse.state.inFlight[0]?.txId, charged[0], "the payment was not committed on the signature");
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

test("a second payment goes through while the first is unaccounted for, and both are counted", async () => {
  // This used to be a refusal. The chain had not shown the first transaction yet, so what had been
  // spent was not yet knowable, so nothing else could go out — one payment at a time, at the mirror
  // node's pace. Now the amount is committed before the key is reached, so the day already includes
  // the payment in the air and the next one is simply measured against it.
  const purse = readyPurse();
  await harness(purse).signer.createPartiallySignedTransferTransaction(requirements());
  const second = harness(purse);
  await second.signer.createPartiallySignedTransferTransaction(requirements());
  assert.equal(second.calls(), 1);
  assert.equal(purse.state.inFlight.length, 2);
  assert.equal(purse.state.inFlight.reduce((sum, entry) => sum + entry.amount, 0n), 20_000n);
});

test("SECURITY: payments in flight together cannot exceed the allowance between them", async () => {
  // The proof that the lane is gone and nothing was given up with it. The allowance covers two
  // payments; three are asked for with nothing answered for in between, and the third is refused by
  // figure the first two already raised rather than by anything waiting on the chain.
  const purse = readyPurse();
  purse.setLimit("usdc", "allowance", 20_000n);
  await harness(purse).signer.createPartiallySignedTransferTransaction(requirements());
  await harness(purse).signer.createPartiallySignedTransferTransaction(requirements());
  const third = harness(purse);
  await assert.rejects(
    () => third.signer.createPartiallySignedTransferTransaction(requirements()),
    (error: unknown) => {
      assert.match(String(denialReason(error)), /daily allowance/);
      return true;
    },
  );
  assert.equal(third.calls(), 0, "the key was reached past the allowance");
});

// Every denial policy.ts can reach, driven through the door rather than through the function.
//
// `chain` is the reading the purse is built with, for the cases that are about the reading itself;
// `purse` mutates the purse afterwards, for the cases that are about a limit or a flag. The split
// matters because `Purse.observe` now refuses a reading older than the one it holds, so a stale
// ledger has to be the purse's *first* answer rather than a second one handed to it later — which
// is the state the test names anyway.
const DENIALS: {
  name: string;
  chain?: Parameters<typeof ledger>[0];
  purse?: (p: Purse) => void;
  req?: Partial<PaymentRequirements>;
  seen?: Partial<Sighting>;
  reason: RegExp;
}[] = [
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
    chain: { balances: { usdc: 0n, hbar: 0n } },
    reason: /not enough/,
  },
  {
    name: "a reading taken for a different account",
    chain: { accountId: "0.0.999999" },
    reason: /read for a different account/,
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
    const purse = readyPurse(denial.chain ?? {});
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
    assert.equal(purse.state.inFlight.length, 0, "an amount was committed for a payment that never happened");
  });
}

// --- the two ways an authorisation is answered for, and no third -------------------------------

test("an authorisation is answered the moment the chain shows the transaction", async (t) => {
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const inner = testSigner(mirror);
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  let entry: Authorization | null = null;
  const signer = guard(inner, purse, walletConfig, sighting, (receipt, authorized) => {
    txId = receipt.txId;
    entry = authorized;
  });

  await signer.createPartiallySignedTransferTransaction(requirements());
  assert.equal(purse.state.inFlight.length, 1);
  assert.equal(await resolve(walletConfig, purse, entry!, 5_000), true);
  assert.equal(purse.state.inFlight.length, 0);
  // The amount did not move when it was answered for: it was already counted the moment it was
  // authorised, which is the whole reason nothing had to wait for this.
  assert.equal(purse.state.spent?.totals.usdc, 10_000n);

  // And the next reading of the chain contains it, which is what makes the figure checkable.
  const after = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(after.spent.usdc, 10_000n);
  assert.equal(after.payments[0]?.txId, txId);
});

test("an authorisation lapses when the transaction can no longer reach the chain, and nothing is counted", async (t) => {
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
  let entry: Authorization | null = null;
  const signer = guard(inner, purse, walletConfig, sighting, (receipt, authorized) => {
    txId = receipt.txId;
    entry = authorized;
  });

  await signer.createPartiallySignedTransferTransaction(requirements());
  const committed = entry as unknown as Authorization;
  // Giving up on patience is not an answer: the amount stays committed and policy.ts keeps counting
  // it. The asking continues in the background with the time the entry has left.
  assert.equal(await resolve(walletConfig, purse, committed, 0), false);
  assert.equal(purse.state.inFlight.length, 1);

  // Wind past the whole authorisation duration by pretending validStart already was — the deadline
  // is the only thing that ends this, so moving it is the same experiment as waiting.
  purse.identify(committed, txId, Date.now() - (VALID_DURATION_MS + INDEXING_MARGIN_MS + 1_000));
  assert.ok(committed.deadline < Date.now());
  assert.equal(await resolve(walletConfig, purse, committed, 0), false);
  assert.equal(purse.state.inFlight.length, 0, "an amount stayed committed past its own deadline");
  assert.equal(purse.state.spent?.totals.usdc, 0n, "a payment that never settled was counted");

  const after = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(after.spent.usdc, 0n, "a payment that never settled was counted");
});

test("the receipt says what the chain says, and asks the chain to find out", async (t) => {
  // `onChain` is a claim about the chain, so it is asked of the chain and never inferred from this
  // process's own bookkeeping. It used to be read off the lane — "the lane is open, so it cannot be
  // on the chain" — which put `onChain: false` on a receipt for a payment that had settled a moment
  // earlier, whenever anything else cleared the lane first. The ledger was right either way; the
  // receipt was not.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let entry: Authorization | null = null;
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, (_receipt, authorized) => {
    entry = authorized;
  });
  await signer.createPartiallySignedTransferTransaction(requirements());

  // Exactly what somebody else answering for it first does to the list.
  const committed = entry as unknown as Authorization;
  purse.settled(committed);
  assert.equal(purse.state.inFlight.length, 0);

  assert.equal(await resolve(walletConfig, purse, committed, 0), true, "a settled payment was reported as unsettled");
});

test("an entry somebody else answered for does not turn a payment that never happened into one that did", async (t) => {
  // The other side of the same question. The entry is gone from the list and the mirror node has
  // never heard of the transaction, so the honest answer is still "not seen" — and it is the mirror
  // node saying so rather than the absence of a record here.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  mirror.indexing = true;
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let entry: Authorization | null = null;
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, (_receipt, authorized) => {
    entry = authorized;
  });
  await signer.createPartiallySignedTransferTransaction(requirements());
  const committed = entry as unknown as Authorization;
  purse.abandon(committed);
  assert.equal(await resolve(walletConfig, purse, committed, 0), false, "a payment the chain never saw was reported as settled");
});

test("the window the chain is read over is local midnight, in flight or not", async (t) => {
  // `refresh()` used to widen the window to `now - 120 s` whenever a payment was in flight, on the
  // theory that a transaction signed just before midnight had to be looked for in yesterday too.
  // Nothing looked: `paymentsIn` drops every row before local midnight, and the in-flight question
  // is a direct lookup of one id. So the reach-back only fetched rows to throw them away — and
  // every one of them counted against the page bound chain.ts still has for the one walk it does.
  // This pins the floor at midnight in both states, so it cannot come back by accident.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const midnight = (dayStart(Date.now()) / 1000).toFixed(9);

  await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, () => {});
  await signer.createPartiallySignedTransferTransaction(requirements());
  assert.equal(purse.state.inFlight.length, 1, "nothing was committed, so this proves nothing");
  await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);

  const windows = mirror.requests.filter((path) => path.startsWith("/api/v1/transactions?"));
  assert.ok(windows.length >= 2, "the chain was not read on both sides of the signature");
  for (const path of windows) {
    assert.ok(path.includes(`timestamp=gte:${midnight}`), `the read reached back past midnight: ${path}`);
  }
});

test("a signer that refuses does not shut the lane behind it", async () => {
  // The lock is taken on the way to the key, so that a lock which cannot be written is a refusal
  // rather than a payment that has already been signed failing on a file operation. That ordering
  // must not turn a signer error into two minutes of denial: the signer builds and signs locally
  // and returns the bytes, so a throw means nothing was produced and nothing can have left this
  // process.
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  const signer = guard(
    {
      accountId: OUR_ACCOUNT,
      createPartiallySignedTransferTransaction: async () => {
        throw new Error("the key said no");
      },
    },
    purse,
    config,
    sighting,
    () => {},
  );
  await assert.rejects(() => signer.createPartiallySignedTransferTransaction(requirements()), /the key said no/);
  assert.equal(purse.state.inFlight.length, 0, "a payment that was never signed stayed committed");
});

test("an authorisation outlasts the mirror node's lag, not just the chain's window", async (t) => {
  // "It can never reach consensus" and "it can never start showing up" are different instants, and
  // an authorisation has to last until the second one. A facilitator that submits at
  // validStart + 119 s gets consensus inside the window — the payment is real and will be charged —
  // but the mirror node is a second or three behind it. Letting go at validStart + 120 s exactly
  // would stop counting a payment that has already happened, for the seconds it takes to appear.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  mirror.indexing = true;                       // consensus reached; the mirror has not caught up
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  let entry: Authorization | null = null;
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, (receipt, authorized) => {
    txId = receipt.txId;
    entry = authorized;
  });
  await signer.createPartiallySignedTransferTransaction(requirements());

  // Three seconds past the chain's own deadline, which is inside the margin and nowhere near past
  // it. Moving validStart is the same experiment as waiting, and it does not need a clock.
  const committed = entry as unknown as Authorization;
  purse.identify(committed, txId, Date.now() - (VALID_DURATION_MS + 3_000));
  assert.equal(await resolve(walletConfig, purse, committed, 0), false);
  assert.equal(purse.state.inFlight.length, 1, "the amount lapsed inside the mirror node's lag");
  const early = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(early.spent.usdc, 0n, "the ledger showed a payment the mirror was still holding");

  // And then the mirror catches up, which is the whole reason the margin is not zero: the payment
  // is answered for by the chain rather than lapsing on the clock, and it is counted.
  mirror.catchUp();
  assert.equal(await resolve(walletConfig, purse, committed, 0), true);
  assert.equal(purse.state.inFlight.length, 0, "the chain showed it and it stayed in the air");
  assert.equal(purse.state.spent?.totals.usdc, 10_000n, "the payment was not counted");
  const late = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(late.spent.usdc, 10_000n, "the payment was not counted");
});

test("bytes we cannot read back stay committed on the deadline alone", async () => {
  // If inspectHederaTransaction cannot tell us what we just signed, we cannot ask the chain about
  // it either. Fail closed: the amount is committed anyway, and only the deadline can end it.
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
  assert.equal(purse.state.inFlight.length, 1);
  assert.equal(purse.state.inFlight[0]?.txId, null);
  assert.equal(purse.state.inFlight[0]?.amount, 10_000n);
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

// --- openWallet's anti-brick counter, with a real key and a real closure -----------------------

// A key on a tmpfs-shaped path, so `openWallet` can read one without an install. Nothing here is
// this machine's key: it is generated for the test and thrown away with the directory.
function credentialsFor(t: { after: (fn: () => unknown) => void }): { publicKeyHex: string } {
  const dir = scratch();
  const key = PrivateKey.generateECDSA();
  writeFileSync(join(dir, "chip402-key"), key.toStringDer(), { mode: 0o600 });
  const before = process.env["CREDENTIALS_DIRECTORY"];
  process.env["CREDENTIALS_DIRECTORY"] = dir;
  t.after(() => {
    if (before === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
    else process.env["CREDENTIALS_DIRECTORY"] = before;
  });
  return { publicKeyHex: key.publicKey.toStringRaw() };
}

test("SECURITY: three readings deny, and a reading the purse refused is not one of them", async (t) => {
  // The counter is `openWallet`'s and lives in a closure, so this is the only test that builds a
  // real wallet — key, derived address, guarded signer and all. The gap is injected because a test
  // that had to wait two real minutes for the third reading would not be written.
  //
  // The property is the one a mutation found unguarded: a reading the purse refuses as overtaken
  // must change nothing in the wallet either. The dangerous direction is not an extra strike — the
  // gap check already rejects a reading older than the last one — it is a stale *agreement*
  // clearing a count that three newer readings built. Bricking is this counter's failure mode in
  // one direction and forgetting is its failure mode in the other, and an answer that arrived late
  // may not do either.
  const wrongKey = { _type: "ECDSA_SECP256K1", key: "02" + "f".repeat(64) };
  const mirror = await fakeMirror({ key: wrongKey, evmAddress: null });
  t.after(() => mirror.close());
  const { publicKeyHex } = credentialsFor(t);
  const purse = readyPurse();
  const wallet = openWallet({ network: mirror.network, accountId: OUR_ACCOUNT }, purse, labelStore(), 0);

  // One reading in flight with its balances leg held back, so it lands last — and answers with
  // whatever the account says at the moment it is served, which is the point.
  mirror.accountsDelayMs = 500;
  const overtaken = wallet.refresh();
  await sleep(50);
  mirror.accountsDelayMs = 0;

  await wallet.refresh();                                   // strike 1: a different key on record
  await wallet.refresh();                                   // strike 2
  assert.equal(purse.state.mismatch, false, "two readings were enough to stop payment");

  // The account is put right — but the reading still in the air was issued before any of this, and
  // it is about to arrive saying so.
  mirror.key = { _type: "ECDSA_SECP256K1", key: publicKeyHex };
  await overtaken;
  assert.equal(wallet.verified, false, "an overtaken reading became the wallet's answer");

  // Put it back, and the third real reading must still be the third.
  mirror.key = wrongKey;
  await wallet.refresh();                                   // strike 3
  assert.equal(purse.state.mismatch, true, "an overtaken agreement cleared a count three readings built");
});

test("a key the chain agrees with never strikes at all", async (t) => {
  // The other direction, and the one that must not regress: a wallet whose key the mirror node
  // confirms is never counted against, however many times it is read.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const { publicKeyHex } = credentialsFor(t);
  const purse = readyPurse();
  // The account's key on record is this wallet's, and the alias is cleared — so `verified` comes
  // from the recorded public key rather than from an alias that happens to match.
  mirror.key = { _type: "ECDSA_SECP256K1", key: publicKeyHex };
  mirror.evmAddress = null;
  const wallet = openWallet({ network: mirror.network, accountId: OUR_ACCOUNT }, purse, labelStore(), 0);
  for (let i = 0; i < 4; i++) await wallet.refresh();
  assert.equal(purse.state.mismatch, false);
  // A shape we do not claim to understand is `null` — "cannot tell" — and must not deny either.
  mirror.key = { _type: "ProtobufEncoded", key: "0a05" };
  for (let i = 0; i < 4; i++) await wallet.refresh();
  assert.equal(purse.state.mismatch, false, "ANTI-BRICK: an unreadable key shape stopped payment");
  assert.equal(wallet.verified, null);
});
