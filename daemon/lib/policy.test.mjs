import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSpend, hostAllowed, pickHederaRequirement } from "./policy.mjs";
import { DEFAULT_CONFIG } from "./state.mjs";

const requirement = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1000",
  asset: "0.0.0",
  payTo: "0.0.1234",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.9185802" },
};

function base({ config, state } = {}) {
  return {
    config: {
      ...DEFAULT_CONFIG,
      accountId: "0.0.1111",
      paused: false,
      allowHosts: ["127.0.0.1", "localhost"],
      caps: { dailyTinybars: "100000000", perRequestTinybars: "10000000" },
      ...config,
    },
    state: {
      paused: false,
      spentTodayTinybars: "0",
      spentTodayDate: "2099-01-01",
      balanceTinybars: "100000000",
      ...state,
    },
    url: "http://127.0.0.1:4403/secret",
    requirement,
  };
}

test("allowlist matches localhost", () => {
  assert.equal(hostAllowed("127.0.0.1", ["localhost", "127.0.0.1"]), true);
  assert.equal(hostAllowed("evil.example", ["localhost"]), false);
  assert.equal(hostAllowed("api.example", ["*"]), true);
});

test("picks hedera testnet HBAR exact", () => {
  const picked = pickHederaRequirement({
    accepts: [
      { scheme: "exact", network: "eip155:84532", amount: "1", asset: "0x1", payTo: "0x2" },
      requirement,
    ],
  });
  assert.equal(picked.network, "hedera:testnet");
});

test("kill switch denies", () => {
  const result = evaluateSpend(base({ config: { paused: true } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "paused");
});

test("daily cap denies overflow", () => {
  const result = evaluateSpend(
    base({
      state: { spentTodayTinybars: "999999000", spentTodayDate: new Date().toISOString().slice(0, 10) },
      config: { caps: { dailyTinybars: "1000000000", perRequestTinybars: "10000000" } },
    }),
  );
  // 999999000 + 1000 is still under 1e9; force overflow:
  const overflow = evaluateSpend(
    base({
      state: { spentTodayTinybars: "100000000", spentTodayDate: new Date().toISOString().slice(0, 10) },
      config: { caps: { dailyTinybars: "100000000", perRequestTinybars: "10000000" } },
    }),
  );
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, "daily_cap");
  assert.equal(result.ok, true);
});

test("per-request cap denies", () => {
  const result = evaluateSpend(
    base({
      config: { caps: { dailyTinybars: "100000000", perRequestTinybars: "500" } },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "per_request_cap");
});

test("host allowlist denies", () => {
  const result = evaluateSpend(base({ config: { allowHosts: ["only.example"] } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "host_denied");
});

test("happy path", () => {
  const result = evaluateSpend(base());
  assert.equal(result.ok, true);
  assert.equal(result.amount, 1000n);
});
