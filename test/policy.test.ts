// The security proof. Every denial chip402 can produce is here, run once per asset, plus the
// cross-asset cases that show the two budgets never touch each other. If this file passes, the
// claims in the README about what an agent can and cannot spend are true.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { LEDGER_MAX_AGE_MS, dayStart, decide } from "../src/policy.ts";
import type { AssetKey } from "../src/networks.ts";
import { NOW, OUR_ACCOUNT, config, invoice, ledger, purseState, testnet } from "./support.ts";

// Both assets get the identical table, so a check that only ever fired for USDC would show up
// here as an HBAR failure rather than as silence.
const ASSETS: { key: AssetKey; assetId: string; small: bigint; overCap: bigint }[] = [
  { key: "usdc", assetId: testnet.assets.usdc.id, small: 10_000n, overCap: 300_000n },
  { key: "hbar", assetId: testnet.assets.hbar.id, small: 100_000_000n, overCap: 2_000_000_000n },
];

for (const asset of ASSETS) {
  const inv = (over = {}) => invoice({ assetId: asset.assetId, amount: asset.small, ...over });
  // A purse whose chain reading says a given amount has already gone out today.
  const spent = (amount: bigint) => purseState({ ledger: ledger({ spent: { usdc: 0n, hbar: 0n, [asset.key]: amount } }) });

  test(`${asset.key}: a normal invoice inside every limit is paid`, () => {
    const result = decide(inv(), purseState(), config, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.asset.key, asset.key);
  });

  test(`${asset.key}: a paused purse denies before anything else is even looked at`, () => {
    const result = decide(inv({ amount: 1n }), purseState({ paused: true }), config, NOW);
    assert.deepEqual(result, { ok: false, reason: "paused" });
  });

  test(`${asset.key}: a v1 downgrade is refused`, () => {
    const result = decide(inv({ x402Version: 1 }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /unsupported x402 version 1/);
  });

  test(`${asset.key}: a plaintext seller on a public host is refused`, () => {
    const result = decide(inv({ finalUrl: "http://api.example.com/secret" }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /plaintext seller/);
  });

  test(`${asset.key}: plaintext on loopback is allowed, because nobody can sit on that path`, () => {
    for (const url of ["http://127.0.0.1:4403/secret", "http://localhost:4403/secret"]) {
      assert.equal(decide(inv({ finalUrl: url }), purseState(), config, NOW).ok, true, url);
    }
  });

  test(`${asset.key}: a URL we cannot even parse is a denial, not a crash`, () => {
    const result = decide(inv({ finalUrl: "not a url" }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /unparseable resource url/);
  });

  test(`${asset.key}: another chain is refused rather than translated`, () => {
    const result = decide(inv({ network: "hedera:mainnet" }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /wrong network hedera:mainnet/);
  });

  test(`${asset.key}: over the per-payment cap`, () => {
    const result = decide(inv({ amount: asset.overCap }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /per-payment cap/);
  });

  test(`${asset.key}: exactly the per-payment cap is allowed — the boundary is inclusive`, () => {
    const purse = purseState();
    const result = decide(inv({ amount: purse[asset.key].maxPayment }), purse, config, NOW);
    assert.equal(result.ok, true);
  });

  test(`${asset.key}: over the daily allowance once the chain's figure is counted`, () => {
    const purse = spent(purseState()[asset.key].allowance - asset.small + 1n);
    const result = decide(inv(), purse, config, NOW);
    assert.match(result.ok ? "" : result.reason, /daily allowance/);
  });

  test(`${asset.key}: exactly the daily allowance is allowed`, () => {
    const purse = spent(purseState()[asset.key].allowance - asset.small);
    assert.equal(decide(inv(), purse, config, NOW).ok, true);
  });

  test(`${asset.key}: a reading taken before local midnight is refused, not reused`, () => {
    // There is no counter to zero at midnight. The chain's answer carries the day it was
    // measured from, and a reading from yesterday is not a reading of today's spending — so it
    // is a refusal until the next read, which pay() always does first.
    const purse = purseState({ ledger: ledger({ since: dayStart(NOW) - 86_400_000 }) });
    const result = decide(inv(), purse, config, NOW);
    assert.match(result.ok ? "" : result.reason, /day has rolled over/);
  });

  test(`${asset.key}: a zero allowance is how the asset is switched off`, () => {
    const purse = purseState();
    purse[asset.key].allowance = 0n;
    const result = decide(inv({ amount: 1n }), purse, config, NOW);
    assert.match(result.ok ? "" : result.reason, /switched off/);
  });

  test(`${asset.key}: not enough in the purse`, () => {
    const purse = purseState({ ledger: ledger({ balances: { usdc: 0n, hbar: 0n, [asset.key]: asset.small - 1n } }) });
    const result = decide(inv(), purse, config, NOW);
    assert.match(result.ok ? "" : result.reason, /not enough/);
  });

  test(`${asset.key}: a reading of the chain that has gone stale is not evidence`, () => {
    const purse = purseState({ ledger: ledger({ at: NOW - LEDGER_MAX_AGE_MS - 1 }) });
    const result = decide(inv(), purse, config, NOW);
    assert.match(result.ok ? "" : result.reason, /too old to trust/);
  });

  test(`${asset.key}: a chain that has never answered is a refusal, not a zero`, () => {
    const result = decide(inv(), purseState({ ledger: null }), config, NOW);
    assert.match(result.ok ? "" : result.reason, /chain has not answered/);
  });

  test(`${asset.key}: nothing is paid while a signed transaction is still unaccounted for`, () => {
    const purse = purseState({ settling: { txId: "0.0.9185802@1.0", deadline: NOW + 1 } });
    const result = decide(inv(), purse, config, NOW);
    assert.match(result.ok ? "" : result.reason, /still settling/);
  });

  test(`${asset.key}: once the transaction can no longer settle, the lane is open again`, () => {
    // validStart + 120s has passed, so Hedera will never accept it. Nothing is given back
    // because nothing was taken: it simply never appears in the chain's sum.
    const purse = purseState({ settling: { txId: "0.0.9185802@1.0", deadline: NOW } });
    assert.equal(decide(inv(), purse, config, NOW).ok, true);
  });

  test(`${asset.key}: the seller may not name us as fee payer`, () => {
    const result = decide(inv({ feePayer: OUR_ACCOUNT }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /named us as fee payer/);
  });

  test(`${asset.key}: a missing or malformed feePayer is refused`, () => {
    for (const bad of [undefined, null, "", "0.0", "not-an-id", 42, { id: "0.0.1" }]) {
      const result = decide(inv({ feePayer: bad }), purseState(), config, NOW);
      assert.match(result.ok ? "" : result.reason, /missing or malformed feePayer/, String(bad));
    }
  });

  test(`${asset.key}: a malformed payTo is refused`, () => {
    const result = decide(inv({ payTo: "0xdeadbeef" }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /malformed payTo/);
  });

  test(`${asset.key}: the seller may not name us as the recipient either`, () => {
    // The transfer would net to zero, the content would arrive, and the day's allowance would be
    // gone — a free lunch billed to the agent's leash rather than to the seller.
    const result = decide(inv({ payTo: OUR_ACCOUNT }), purseState(), config, NOW);
    assert.match(result.ok ? "" : result.reason, /named us as the recipient/);
  });

  test(`${asset.key}: a zero or negative amount is refused`, () => {
    for (const amount of [0n, -1n]) {
      const result = decide(inv({ amount }), purseState(), config, NOW);
      assert.match(result.ok ? "" : result.reason, /non-positive amount/, String(amount));
    }
  });
}

// --- the key check, which now costs something ------------------------------------------------

test("a confirmed key mismatch denies, and says how to fix it", () => {
  const result = decide(invoice(), purseState({ mismatch: true }), config, NOW);
  assert.match(result.ok ? "" : result.reason, /different key controls this account/);
  assert.match(result.ok ? "" : result.reason, /chip402ctl setup --import/);
});

test("ANTI-BRICK: a chain we could not read still pays", () => {
  // `verified === null` is every shape readKeyMatch does not claim to understand — an
  // unreachable mirror node, an account with no key on record, a KeyList, a threshold key, a
  // ProtobufEncoded key. The old `verified` was a boolean and collapsed all of them to "no". If
  // this test ever fails, a working purse has been bricked by a check that was meant to protect
  // it. `mismatch` is what denies, and it is only ever set by three positive readings.
  assert.equal(decide(invoice(), purseState({ ledger: ledger({ verified: null }) }), config, NOW).ok, true);
  assert.equal(decide(invoice(), purseState({ ledger: ledger({ verified: false }) }), config, NOW).ok, true);
});

// --- the rest ---------------------------------------------------------------------------------

test("a look-alike token id simply does not resolve", () => {
  // One digit off the real testnet USDC id. There is no allowlist to be missing from — the
  // asset is refused because it is not in the network row at all.
  const result = decide(invoice({ assetId: "0.0.429275" }), purseState(), config, NOW);
  assert.match(result.ok ? "" : result.reason, /unknown asset 0\.0\.429275/);
});

test("switching HBAR off leaves USDC paying normally", () => {
  const purse = purseState();
  purse.hbar.allowance = 0n;
  const hbarResult = decide(invoice({ assetId: testnet.assets.hbar.id, amount: 1n }), purse, config, NOW);
  assert.match(hbarResult.ok ? "" : hbarResult.reason, /switched off/);
  assert.equal(decide(invoice(), purse, config, NOW).ok, true);
});

test("spending USDC never touches the HBAR budget", () => {
  // The two budgets are separate limits over separate chain figures, which is the whole reason
  // chip402 can hold two assets without ever needing to know a price.
  const purse = purseState({ ledger: ledger({ spent: { usdc: 2_000_000n, hbar: 0n } }) });
  assert.equal(decide(invoice(), purse, config, NOW).ok, false);
  assert.equal(decide(invoice({ assetId: testnet.assets.hbar.id, amount: 100_000_000n }), purse, config, NOW).ok, true);
});

test("policy.ts does no I/O and keeps no clock of its own", () => {
  // Purity is what makes this file readable as the security argument: there is nothing to mock,
  // nothing to be stale, and no order of operations to get wrong. `new Date(now)` is allowed —
  // it is how local midnight is worked out from the clock this function is handed, and it reads
  // no clock of its own.
  const impure = /Date\.now|require\(|node:fs|node:net|node:crypto|node:child_process|fetch\(/;
  const source = readFileSync(new URL("../src/policy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, impure);

  // And it is purity by construction rather than by inspection of one file: whatever this one
  // imports for its values has to be pure too, or the property is only true of the lines you can
  // see. `import type` does not count — a type cannot do I/O — which is how it can name PurseState
  // without taking purse.ts, and the split is checked here rather than trusted.
  const value = [...source.matchAll(/^import (?!type )[^;]*from "\.\/([a-z]+\.ts)";$/gm)].map((m) => m[1]!);
  assert.ok(value.length > 0, "policy.ts stopped importing anything, so this test proves nothing");
  for (const name of value) {
    const imported = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(imported, impure, `policy.ts takes values from ${name}, which is not pure`);
  }
});
