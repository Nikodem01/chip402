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
  const row = { amountMicro: "10000", status: "settled", ts: "2026-08-23T20:22:04.000Z" };
  assert.equal(Model.ledgerAmount(row), "0.01 USDC");
  // A settled payment needs no second line at all: the tick, the payee, the time and the
  // amount carry it.
  assert.equal(Model.ledgerNote(row), "");
  assert.equal(Model.ledgerNote({ status: "pending", amountMicro: "10000" }), "in flight");
  // The pre-USDC field is gone; a row that still carries one shows nothing, not 1.23 USDC.
  assert.equal(Model.ledgerAmount({ amountTinybars: "12345678", status: "settled", ts: "" }), "");
  // A blocked row moved no money, so it gets no figure at all.
  assert.equal(Model.ledgerAmount({ amountMicro: "0", status: "denied", ts: "" }), "");
});

test("the ledger clock is local, so it agrees with the local day the panel counts", () => {
  // 2026-08-23T19:27:48Z is 04:57 the next morning in Australia/Darwin. Substringing the ISO
  // text used to print 19:27 next to a "today" counted in local days.
  const row = { ts: "2026-08-23T19:27:48.861Z", status: "settled", amountMicro: "10000" };
  const at = new Date(row.ts);
  const expected = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  assert.equal(Model.ledgerTime(row), expected);
  assert.equal(Model.ledgerTime({ ts: "not a date" }), "");
  assert.equal(Model.ledgerTime(null), "");
});

test("the panel ledger keeps payments and leaves the rest to chip402 log", () => {
  const ledger = [
    { kind: "payment", status: "denied", ts: "2026-08-23T19:27:48Z", code: "host_denied" },
    { kind: "audit", status: "audit", ts: "2026-08-23T19:27:48Z", action: "caps" },
    { kind: "payment", status: "pending", ts: "2026-08-23T19:27:40Z", amountMicro: "5000" },
    { kind: "payment", status: "settled", ts: "2026-08-23T19:27:39Z", amountMicro: "10000" },
  ];
  const payments = Model.paymentRows(ledger);
  assert.equal(payments.length, 2, "only money rows belong in the receipt book");
  assert.deepEqual(payments.map((r) => r.status), ["pending", "settled"], "newest first is preserved");
  assert.equal(Model.paymentRows(null).length, 0);
  assert.equal(Model.paymentRows(undefined).length, 0);
  // Nothing is lost: the footer says how many rows the panel is not showing.
  assert.equal(Model.hiddenCount(ledger, payments.length), 2);
  assert.match(Model.hiddenLabel(2), /2 older entries · chip402 log/);
  assert.match(Model.hiddenLabel(1), /^1 older entry /);
  assert.equal(Model.hiddenLabel(0), "");
  assert.equal(Model.hiddenCount(ledger, 99), 0, "showing more than exists never goes negative");
});

test("only the newest few payments render, the rest are counted", () => {
  const many = [];
  for (let i = 0; i < 12; i += 1) {
    many.push({ kind: "payment", status: "settled", ts: "2026-08-23T19:00:00Z", amountMicro: "1000" });
  }
  assert.equal(Model.visiblePayments(many).length, Model.ledgerVisible);
  assert.equal(Model.visiblePayments(many, 3).length, 3);
  assert.equal(Model.hiddenCount(many, Model.ledgerVisible), 12 - Model.ledgerVisible);
});

test("blocked payments collapse into one line that does not read as an alarm", () => {
  const now = Date.parse("2026-08-23T19:30:00Z");
  const today = "2026-08-23T19:27:00Z";
  const denied = (code, ts) => ({ kind: "payment", status: "denied", code, ts: ts || today });
  const ledger = [
    denied("daily_cap"),
    denied("daily_cap"),
    denied("host_denied"),
    { kind: "payment", status: "settled", ts: today, amountMicro: "10000" },
  ];
  const rows = Model.deniedToday(ledger, now);
  assert.equal(rows.length, 3);
  const summary = Model.denialSummary(rows);
  // One reason on the line: at 380px anything longer elides mid-reason, and the expansion
  // is where the rest belongs.
  assert.equal(summary, "3 not paid today · 2 over cap +1 more");
  // "not paid" rather than "blocked": the daemon files a seller that never answered under the
  // same denied status as a cap refusal, and only one of those is chip402 deciding something.
  assert.match(Model.denialSummary([denied("failed")]), /^1 not paid today · failed$/);
  // One reason needs no breakdown after the count.
  assert.equal(Model.denialSummary([denied("daily_cap")]), "1 not paid today · over cap");
  // The line has to survive a 380px panel, so it stays short even with every reason at once.
  const everything = ["daily_cap", "per_request_cap", "host_denied", "insecure_host", "failed"]
    .map((code) => denied(code));
  const wide = Model.denialSummary(everything);
  assert.ok(wide.length <= 48, wide);
  assert.match(wide, /\+4 more$/, "what did not fit has to be counted, not silently dropped");
  // Commonest reason first, so the two that make the line are the two worth naming.
  const lopsided = [denied("host_denied"), denied("daily_cap"), denied("daily_cap"), denied("failed")];
  assert.match(Model.denialSummary(lopsided), /^4 not paid today · 2 over cap \+2 more$/);
  assert.equal(Model.denialSummary([]), "");
  assert.equal(Model.denialSummary(null), "");
});

test("yesterday's denials do not count toward today", () => {
  // Compare against the same local day the daemon's todayStamp() uses, not UTC's.
  const now = Date.now();
  const today = new Date(now).toISOString();
  const twoDaysAgo = new Date(now - 2 * 86400000).toISOString();
  const ledger = [
    { kind: "payment", status: "denied", code: "daily_cap", ts: today },
    { kind: "payment", status: "denied", code: "daily_cap", ts: twoDaysAgo },
  ];
  assert.equal(Model.deniedToday(ledger, now).length, 1);
});

test("every denial code reads as a description rather than a raw code", () => {
  const codes = [
    "host_denied", "insecure_host", "daily_cap", "per_request_cap", "insufficient_funds",
    "fee_payer_mismatch", "unsupported", "paused", "unconfigured",
    "stale_balance", "fee_payer_unknown", "hollow_account",
  ];
  for (const code of codes) {
    const label = Model.denialCodeLabel(code);
    assert.doesNotMatch(label, /_/, `${code} leaked an underscore into the panel`);
    assert.ok(label.length > 0, `${code} has no label`);
  }
  // The three hold codes say the same thing; the hold line above the ledger names which.
  assert.equal(Model.denialCodeLabel("stale_balance"), "held");
  assert.equal(Model.denialCodeLabel("fee_payer_unknown"), "held");
  assert.equal(Model.denialCodeLabel("hollow_account"), "held");
  // An unknown code still renders as words, never as a bare identifier.
  assert.equal(Model.denialCodeLabel("some_new_code"), "some new code");
  assert.equal(Model.denialCodeLabel(""), "blocked");
  assert.equal(Model.denialCodeLabel(undefined), "blocked");
});

test("cap changes are summarised beside the caps, not listed with payments", () => {
  const now = Date.parse("2026-08-23T19:30:00Z");
  const ledger = [
    { kind: "audit", action: "caps", ts: "2026-08-23T19:27:48Z" },
    { kind: "audit", action: "caps", ts: "2026-08-23T19:27:13Z" },
    { kind: "payment", status: "settled", ts: "2026-08-23T19:27:39Z", amountMicro: "10000" },
  ];
  const summary = Model.auditSummary(ledger, now);
  assert.match(summary, /^Changed 2× today/);
  // Newest first, so the latest audit row supplies the time.
  assert.match(summary, new RegExp(`last ${Model.ledgerTime(ledger[0])}$`));
  assert.match(Model.auditSummary([ledger[0]], now), /^Changed once today/);
  assert.equal(Model.auditSummary([ledger[2]], now), "", "a payment is not a setting change");
  assert.equal(Model.auditSummary([], now), "");
  assert.equal(Model.auditSummary(null, now), "");
});

test("a first-sight payee is marked without interrupting anything", () => {
  const note = Model.ledgerNote({ amountMicro: "10000", status: "settled", firstSight: true, ts: "" });
  assert.equal(note, "new payee");
  assert.equal(Model.ledgerNote({ amountMicro: "10000", status: "settled", ts: "" }), "");
  // A first payment to an unknown payee that is still settling says both things.
  assert.equal(Model.ledgerNote({ status: "pending", firstSight: true }), "in flight · new payee");
  assert.equal(Model.ledgerNote({ status: "denied", code: "daily_cap" }), "over cap");
});

test("audit rows read as settings changes, not payments", () => {
  const row = { kind: "audit", action: "caps", detail: "daily cap 10000000 to 50000000 micro-USDC", ts: "" };
  assert.equal(Model.ledgerTitle(row), "Cap changed");
  assert.match(Model.ledgerNote(row), /daily cap/);
  assert.doesNotMatch(Model.ledgerNote(row), /0\.00 USDC/, "an audit row is not a zero-value payment");
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
