import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const Model = createRequire(import.meta.url)("./Model.js");

test("setupPhase names the hollow step instead of showing a stuck spinner", () => {
  assert.equal(Model.setupPhase("", "", false, false, "0"), "need_key");
  assert.equal(Model.setupPhase("0xabc", "", false, false, "0"), "need_hbar");
  assert.equal(Model.setupPhase("0xabc", "0.0.1", true, false, "0"), "completing");
  assert.equal(Model.setupPhase("0xabc", "0.0.1", false, false, "0"), "associating");
  assert.equal(Model.setupPhase("0xabc", "0.0.1", false, true, "0"), "need_usdc");
  assert.equal(Model.setupPhase("0xabc", "0.0.1", false, true, "1000"), "ready");
  // A completed account never falls back into the hollow step.
  assert.equal(Model.setupPhase("0xabc", "0.0.1", true, true, "1000"), "completing");
});

test("the stepper lists the phases in the order they happen", () => {
  assert.deepEqual(
    Model.setupSteps().map((step) => step.phase),
    ["need_key", "need_hbar", "completing", "associating", "need_usdc"],
  );
  assert.match(Model.setupHint("completing"), /key on record/);
  assert.equal(Model.setupHint("ready"), "");
});

test("remainingMicro and spendRatio", () => {
  assert.equal(Model.remainingMicro("10000000", "10000"), "9990000");
  assert.equal(Model.spendRatio("10000000", "2500000"), 0.25);
  assert.equal(Model.spendRatio("0", "1"), 0);
});

test("humanError maps policy codes and strips garbage", () => {
  assert.equal(Model.humanError("chip402 is paused"), "chip402 is paused — flip the switch to let agents spend");
  assert.match(Model.humanError("Host not on the allowlist: api.example.com"), /not allowed/);
  assert.equal(Model.humanError('{"error":"nope"}'), "Request failed — is the daemon running?");
  assert.match(Model.humanError("stale_balance"), /Cannot read the balance/);
  assert.match(Model.humanError("fee_payer_unknown"), /who sponsors payments/);
  assert.match(Model.humanError("redirect_denied: off-origin"), /redirected/);
  assert.match(Model.humanError("ECONNREFUSED"), /socket/);
  assert.doesNotMatch(Model.humanError("ECONNREFUSED"), /4402/);
});

test("explorer links follow the network the daemon reports", () => {
  assert.match(Model.hashscanAccount("0.0.1", "https://hashscan.io/testnet"), /testnet\/account/);
  assert.match(Model.hashscanAccount("0.0.1", "https://hashscan.io/mainnet"), /mainnet\/account/);
  assert.match(Model.hashscanTx("0.0.1@1.2", "https://hashscan.io/mainnet"), /mainnet\/transaction/);
  // No base means no link, rather than a link to the wrong network.
  assert.equal(Model.hashscanAccount("0.0.1"), "");
  assert.equal(Model.hashscanTx("0.0.1@1.2", ""), "");
});

test("a ledger row never renders an HBAR amount as USDC", () => {
  assert.equal(Model.ledgerStatusLabel("settled"), "paid");
  assert.equal(Model.ledgerStatusLabel("denied"), "blocked");
  assert.equal(Model.ledgerStatusLabel("pending"), "in flight");
  const meta = Model.ledgerMeta({ amountMicro: "10000", status: "settled", ts: "2026-08-23T20:22:04.000Z" });
  assert.match(meta, /paid/);
  assert.match(meta, /0\.01 USDC/);
  assert.doesNotMatch(meta, /settled/);
  // The pre-USDC field is gone; a row that still carries one shows 0, not 1.23 USDC.
  const legacy = Model.ledgerMeta({ amountTinybars: "12345678", status: "settled", ts: "" });
  assert.match(legacy, /0\.00 USDC/);
});

test("a first-sight payee is marked without interrupting anything", () => {
  const meta = Model.ledgerMeta({ amountMicro: "10000", status: "settled", firstSight: true, ts: "" });
  assert.match(meta, /new payee/);
  assert.doesNotMatch(Model.ledgerMeta({ amountMicro: "10000", status: "settled", ts: "" }), /new payee/);
});

test("audit rows read as settings changes, not payments", () => {
  const row = { kind: "audit", action: "caps", detail: "daily cap 10000000 to 50000000 micro-USDC", ts: "" };
  assert.equal(Model.ledgerTitle(row), "Cap changed");
  assert.match(Model.ledgerMeta(row), /daily cap/);
  assert.doesNotMatch(Model.ledgerMeta(row), /0\.00 USDC/, "an audit row is not a zero-value payment");
  assert.equal(Model.ledgerTitle({ kind: "audit", action: "pause" }), "Paused");
});

test("a balance nobody could read is not presented as a balance of zero", () => {
  const now = Date.parse("2026-08-24T00:00:00.000Z");
  assert.equal(Model.balanceIsFresh("2026-08-23T23:59:30.000Z", now), true);
  assert.equal(Model.balanceIsFresh("2026-08-23T23:50:00.000Z", now), false);
  assert.equal(Model.balanceIsFresh("", now), false);
});

test("parseState derives freshness and in-flight money from the state file", () => {
  const state = Model.parseState(
    JSON.stringify({
      accountId: "0.0.1",
      hollow: true,
      balanceAt: new Date().toISOString(),
      hashscan: "https://hashscan.io/mainnet",
      ledger: [
        { id: "a", status: "pending", amountMicro: "10000" },
        { id: "b", status: "settled", amountMicro: "50000" },
        { id: "c", status: "pending", amountMicro: "5000" },
      ],
    }),
  );
  assert.equal(state.hollow, true);
  assert.equal(state.balanceFresh, true);
  assert.equal(state.pendingMicro, "15000");
  assert.equal(state.hashscan, "https://hashscan.io/mainnet");
  assert.equal(state.configured, true);
});

test("an unreadable state file yields an empty state, not a crash", () => {
  assert.equal(Model.parseState("not json").accountId, "");
  assert.equal(Model.parseState("").balanceMicro, "0");
  assert.equal(Model.parseState(null).hashscan, "");
});
