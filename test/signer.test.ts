// The enforcement proof. policy.ts deciding "no" is only worth something if no signature can
// be produced anyway, so this file drives the guarded signer with a stub underneath and asserts
// the stub is never reached on any deny path — and that the lane closes on the allow path.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentRequirements } from "@x402/fetch";
import { PrivateKey, inspectHederaTransaction } from "@x402/hedera";
import type { Sighting } from "../src/fetch.ts";
import { Purse } from "../src/purse.ts";
import { denialReason, guard, openWallet, refresh, settle } from "../src/wallet.ts";
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
    name: "a stale reading of the chain",
    chain: { at: Date.now() - 200_000 },
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

  // Wind the clock past the whole lock duration by pretending validStart already was — the
  // deadline is the only thing that ends this, so moving it is the same experiment as waiting.
  purse.beginSettling(txId, Date.now() - (VALID_DURATION_MS + INDEXING_MARGIN_MS + 1_000));
  assert.ok(purse.state.settling!.deadline < Date.now());
  assert.equal(await settle(walletConfig, purse, txId, 0), false);
  assert.equal(purse.state.settling, null, "the lane never reopened");
  assert.ok(deadline > 0);

  const after = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(after.spent.usdc, 0n, "a payment that never settled was counted");
});

test("the receipt says what the chain says, even when the poll loop got there first", async (t) => {
  // `pollChain` runs every 60 s and is not serialized against a payment in flight — `inLane` wraps
  // `pay`, not the poll. So a refresh landing between the signature and `settle()` clears the lane
  // first, and `settle()` used to read "the lane is open" as "not on the chain" and stamp
  // `onChain: false` on a receipt for a payment that had settled a moment earlier. The ledger was
  // right either way; the receipt was not. It is a claim about the chain, so it is asked of the
  // chain.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, (receipt) => {
    txId = receipt.txId;
  });
  await signer.createPartiallySignedTransferTransaction(requirements());

  // Exactly what a refresh that saw the transaction does, a millisecond before settle() runs.
  purse.finishSettling();
  assert.equal(purse.state.settling, null);

  assert.equal(await settle(walletConfig, purse, txId, 0), true, "a settled payment was reported as unsettled");
});

test("a lane somebody else opened does not turn a payment that never happened into one that did", async (t) => {
  // The other side of the same question. The lane is open and the mirror node has never heard of
  // the transaction — because the clock ended the wait, not the chain — so the honest answer is
  // still "not seen", and it is the mirror node saying so rather than the lock.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  mirror.indexing = true;
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, (receipt) => {
    txId = receipt.txId;
  });
  await signer.createPartiallySignedTransferTransaction(requirements());
  purse.finishSettling();

  assert.equal(await settle(walletConfig, purse, txId, 0), false);
  // And an unreachable mirror node is not evidence either way, which reads as "not seen".
  await mirror.close();
  assert.equal(await settle(walletConfig, purse, txId, 0), false);
});

test("the window the chain is read over is local midnight, settling or not", async (t) => {
  // `refresh()` used to widen the window to `now - 120 s` whenever a payment was in flight, on the
  // theory that a transaction signed just before midnight had to be looked for in yesterday too.
  // Nothing looked: `paymentsIn` drops every row before local midnight, and the in-flight question
  // is a direct lookup of one id. So the reach-back only fetched rows to throw them away — and
  // every one of them counted against the page bound the fallback in chain.ts exists to keep us
  // under. This pins the floor at midnight in both states, so it cannot come back by accident.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const midnight = (dayStart(Date.now()) / 1000).toFixed(9);

  await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, () => {});
  await signer.createPartiallySignedTransferTransaction(requirements());
  assert.notEqual(purse.state.settling, null, "the lane did not close, so this proves nothing");
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
  assert.equal(purse.state.settling, null, "a payment that was never signed held the lane shut");
});

test("the lane stays shut through the mirror node's lag, not just the chain's window", async (t) => {
  // "It can never reach consensus" and "it can never start showing up" are different instants, and
  // the lane needs the second one. A facilitator that submits at validStart + 119 s gets consensus
  // inside the window — the payment is real and will be charged — but the mirror node is a second
  // or three behind it. A lane that opened at validStart + 120 s exactly would spend those seconds
  // reading a ledger that does not contain a payment that has already happened, which is the same
  // extra payment B12 was about with a slow facilitator in place of a restart.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  mirror.indexing = true;                       // consensus reached; the mirror has not caught up
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = readyPurse();
  const sighting: Sighting = { finalUrl: "https://api.example.com/secret", x402Version: 2 };
  let txId: string | null = null;
  const signer = guard(testSigner(mirror), purse, walletConfig, sighting, (receipt) => {
    txId = receipt.txId;
  });
  await signer.createPartiallySignedTransferTransaction(requirements());

  // Three seconds past the chain's own deadline, which is inside the margin and nowhere near past
  // it. Moving validStart is the same experiment as waiting, and it does not need a clock.
  purse.beginSettling(txId, Date.now() - (VALID_DURATION_MS + 3_000));
  assert.equal(await settle(walletConfig, purse, txId, 0), false);
  assert.notEqual(purse.state.settling, null, "the lane opened inside the mirror node's lag");
  const early = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.notEqual(purse.state.settling, null, "a refresh opened the lane inside the lag");
  assert.equal(early.spent.usdc, 0n, "the ledger showed a payment the mirror was still holding");

  // And then the mirror catches up, which is the whole reason for waiting: the payment is counted
  // and the lane opens on the chain rather than on the clock.
  mirror.catchUp();
  const late = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(purse.state.settling, null, "the lane never reopened once the chain showed it");
  assert.equal(late.spent.usdc, 10_000n, "the payment was not counted");
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
