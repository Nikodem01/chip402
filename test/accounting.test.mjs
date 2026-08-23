// The two money-safety bugs that single-request tests cannot see: a crash between settling
// and recording, and two /fetch calls racing the daily cap.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CHIP402_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-cfg-"));
process.env.CHIP402_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-state-"));
process.env.CHIP402_NO_MAIN = "1";

const { reconcilePending, reconcileAll, withLock } = await import("../daemon/chip402d.mjs");
const { DEFAULT_CONFIG, emptyState, todayStamp } = await import("../daemon/lib/state.mjs");
const { evaluateSpend } = await import("../daemon/lib/policy.mjs");

const CONFIG = {
  ...DEFAULT_CONFIG,
  accountId: "0.0.1111",
  asset: "0.0.429274",
  allowHosts: ["127.0.0.1"],
  caps: { dailyMicro: "10000", perRequestMicro: "10000" },
};

function stateWithPending({ amount = "10000", txId = "0.0.9@1.0", ageMs = 0 } = {}) {
  const now = Date.now();
  return {
    ...emptyState(),
    spentTodayMicro: amount,
    spentTodayDate: todayStamp(),
    ledger: [
      {
        id: "row-1",
        kind: "payment",
        status: "pending",
        amountMicro: amount,
        payTo: "0.0.2222",
        host: "127.0.0.1",
        txId,
        spentDate: todayStamp(),
        expiresAt: new Date(now - ageMs + 180_000).toISOString(),
      },
    ],
  };
}

const settledTx = {
  success: true,
  result: "SUCCESS",
  tokenTransfers: [
    { token_id: "0.0.429274", account: "0.0.1111", amount: -10000 },
    { token_id: "0.0.429274", account: "0.0.2222", amount: 10000 },
  ],
  transfers: [],
};

test("crash after settlement: the reservation is promoted, the spend stays counted", async () => {
  const state = stateWithPending();
  const outcome = await reconcilePending(CONFIG, state, state.ledger[0], { lookup: async () => settledTx });
  assert.equal(outcome, "settled");
  assert.equal(state.ledger[0].status, "settled");
  assert.equal(state.ledger[0].onChainMicro, "10000");
  assert.equal(state.spentTodayMicro, "10000", "a settled payment must stay on the daily counter");
  assert.equal(state.ledger[0].firstSight, true);
});

test("crash before settlement: released only once the transaction can no longer be submitted", async () => {
  const live = stateWithPending();
  assert.equal(
    await reconcilePending(CONFIG, live, live.ledger[0], { lookup: async () => null }),
    "pending",
    "a signed transaction inside its validity window can still be submitted by the seller",
  );
  assert.equal(live.spentTodayMicro, "10000");

  const expired = stateWithPending({ ageMs: 300_000 });
  assert.equal(
    await reconcilePending(CONFIG, expired, expired.ledger[0], { lookup: async () => null }),
    "released",
  );
  assert.equal(expired.spentTodayMicro, "0", "an expired reservation must be given back");
  assert.equal(expired.ledger[0].status, "denied");
});

test("a transaction that reached consensus and failed releases immediately", async () => {
  const state = stateWithPending();
  const outcome = await reconcilePending(CONFIG, state, state.ledger[0], {
    lookup: async () => ({ success: false, result: "INSUFFICIENT_TOKEN_BALANCE" }),
  });
  assert.equal(outcome, "released");
  assert.equal(state.spentTodayMicro, "0");
  assert.match(state.ledger[0].reason, /INSUFFICIENT_TOKEN_BALANCE/);
});

test("an unreachable mirror node never releases a reservation", async () => {
  const state = stateWithPending({ ageMs: 300_000 });
  const outcome = await reconcilePending(CONFIG, state, state.ledger[0], {
    lookup: async () => {
      throw new Error("Mirror node 503");
    },
  });
  assert.equal(outcome, "unknown", "unknown must never mean 'nothing settled'");
  assert.equal(state.spentTodayMicro, "10000");
  assert.equal(state.ledger[0].status, "pending");
});

test("a reservation with no transaction id was never submitted", async () => {
  const state = stateWithPending({ txId: "" });
  const outcome = await reconcilePending(CONFIG, state, state.ledger[0], { lookup: async () => null });
  assert.equal(outcome, "released");
  assert.equal(state.spentTodayMicro, "0");
});

test("startup reconcile walks every pending row left by a crash", async () => {
  const state = stateWithPending({ ageMs: 300_000 });
  state.ledger.push({ ...state.ledger[0], id: "row-2" });
  const outcomes = await reconcileAll(CONFIG, state, { lookup: async () => null });
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((entry) => entry.outcome === "released"));
});

// The cap check reads state, decides, and writes much later. Without a lock both callers
// evaluate against the same stale spentTodayMicro and both spend.
function attempt(shared, amount) {
  const decision = evaluateSpend({
    config: CONFIG,
    state: shared,
    url: "http://127.0.0.1:4403/x",
    requirement: {
      scheme: "exact",
      network: "hedera:testnet",
      amount: String(amount),
      asset: "0.0.429274",
      payTo: "0.0.2222",
      extra: { feePayer: "0.0.9185802" },
    },
    feePayer: "0.0.9185802",
  });
  if (!decision.ok) return decision;
  return { ok: true, commit: () => {
    shared.spentTodayMicro = (BigInt(shared.spentTodayMicro) + BigInt(amount)).toString();
  } };
}

function freshState() {
  return {
    ...emptyState(),
    spentTodayMicro: "0",
    spentTodayDate: todayStamp(),
    balanceMicro: "10000000",
    balanceAt: new Date().toISOString(),
  };
}

test("without the lock, parallel calls both pass a cap that allows one — this is the bug", async () => {
  const shared = freshState();
  const results = await Promise.all(
    [0, 1].map(async () => {
      const decision = attempt(shared, 10000);
      await new Promise((r) => setImmediate(r)); // the gap between deciding and writing
      if (decision.ok) decision.commit();
      return decision.ok;
    }),
  );
  assert.deepEqual(results, [true, true]);
  assert.equal(shared.spentTodayMicro, "20000", "two payments against a 10000 cap");
});

test("with the lock, parallel calls cannot exceed the daily cap", async () => {
  const shared = freshState();
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map(() =>
      withLock(async () => {
        const decision = attempt(shared, 10000);
        await new Promise((r) => setImmediate(r));
        if (decision.ok) decision.commit();
        return decision.ok ? "paid" : decision.code;
      }),
    ),
  );
  assert.equal(results.filter((r) => r === "paid").length, 1, `expected exactly one payment, got ${results}`);
  assert.ok(results.filter((r) => r === "daily_cap").length === 4);
  assert.equal(shared.spentTodayMicro, "10000", "the cap held");
});

test("the lock survives a throwing critical section", async () => {
  const order = [];
  const boom = withLock(async () => {
    order.push("a");
    throw new Error("boom");
  });
  const after = withLock(async () => {
    order.push("b");
    return "ok";
  });
  await assert.rejects(() => boom);
  assert.equal(await after, "ok");
  assert.deepEqual(order, ["a", "b"]);
});
