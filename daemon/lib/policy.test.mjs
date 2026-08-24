import test from "node:test";
import assert from "node:assert/strict";
import {
  balanceIsFresh,
  checkHost,
  describeSkipped,
  evaluateSpend,
  floatWarning,
  hostAllowed,
  isFirstSight,
  normalizeAllowEntry,
  pickHederaRequirement,
} from "./policy.mjs";
import { DEFAULT_CONFIG } from "./state.mjs";
import { NETWORKS } from "./networks.mjs";

const FEE_PAYER = "0.0.9185802";
const MAINNET = NETWORKS["hedera:mainnet"];

const requirement = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "10000",
  asset: "0.0.429274",
  payTo: "0.0.1234",
  maxTimeoutSeconds: 180,
  extra: { feePayer: FEE_PAYER },
};

function base({ config, state, requirement: req, feePayer = FEE_PAYER } = {}) {
  return {
    config: {
      ...DEFAULT_CONFIG,
      accountId: "0.0.1111",
      paused: false,
      allowHosts: ["127.0.0.1", "localhost"],
      caps: { dailyMicro: "10000000", perRequestMicro: "1000000" },
      ...config,
    },
    state: {
      paused: false,
      hollow: false,
      spentTodayMicro: "0",
      spentTodayDate: "2099-01-01",
      balanceMicro: "10000000",
      balanceAt: new Date().toISOString(),
      ...state,
    },
    url: "http://127.0.0.1:4403/secret",
    requirement: req === undefined ? requirement : req,
    feePayer,
  };
}

test("allowlist matches loopback and refuses everything else", () => {
  assert.equal(hostAllowed("127.0.0.1", ["localhost", "127.0.0.1"]), true);
  assert.equal(hostAllowed("evil.example", ["localhost"]), false);
});

test("a literal * is refused on every network, testnet included", () => {
  const testnet = checkHost({ url: "https://api.example/x", allowHosts: ["*"] });
  assert.equal(testnet.ok, false);
  assert.match(testnet.reason, /not honoured on hedera:testnet/);
  const denied = checkHost({ url: "https://api.example/x", allowHosts: ["*"], profile: MAINNET });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /not honoured on hedera:mainnet/);
});

test("a remote host must be https, loopback may be cleartext", () => {
  const cleartext = checkHost({ url: "http://api.example/x", allowHosts: ["api.example"] });
  assert.equal(cleartext.ok, false);
  assert.equal(cleartext.code, "insecure_host");
  assert.equal(checkHost({ url: "https://api.example/x", allowHosts: ["api.example"] }).ok, true);
  assert.equal(checkHost({ url: "http://127.0.0.1:4403/x", allowHosts: ["127.0.0.1"] }).ok, true);
});

test("an allowlist entry with a port matches only that port", () => {
  assert.deepEqual(normalizeAllowEntry("https://api.example:8443/path"), {
    wildcard: false,
    host: "api.example",
    port: "8443",
  });
  const list = ["api.example:8443"];
  assert.equal(checkHost({ url: "https://api.example:8443/x", allowHosts: list }).ok, true);
  assert.equal(checkHost({ url: "https://api.example/x", allowHosts: list }).ok, false);
  // A bare entry still matches any port.
  assert.equal(checkHost({ url: "https://api.example:9999/x", allowHosts: ["api.example"] }).ok, true);
});

test("picks hedera testnet USDC exact", () => {
  const picked = pickHederaRequirement({
    accepts: [
      { scheme: "exact", network: "eip155:84532", amount: "1", asset: "0x1", payTo: "0x2" },
      requirement,
    ],
  });
  assert.equal(picked.network, "hedera:testnet");
  assert.equal(picked.asset, "0.0.429274");
});

test("an HBAR exact option is skipped — caps are denominated in micro-USDC", () => {
  const hbar = {
    scheme: "exact",
    network: "hedera:testnet",
    amount: "1000",
    asset: "0.0.0",
    payTo: "0.0.1234",
    extra: { feePayer: FEE_PAYER },
  };
  assert.equal(pickHederaRequirement({ accepts: [hbar] }), null);
  assert.equal(pickHederaRequirement({ accepts: [hbar, requirement] }).asset, "0.0.429274");
});

test("upfront and escrow flows are skipped, and the denial says why", () => {
  for (const flow of ["upfront", "escrow", "something-new"]) {
    const offer = { ...requirement, extra: { ...requirement.extra, paymentFlow: flow } };
    assert.equal(pickHederaRequirement({ accepts: [offer] }), null, flow);
    assert.match(describeSkipped({ accepts: [offer] }), new RegExp(flow));
  }
  const explicit = { ...requirement, extra: { ...requirement.extra, paymentFlow: "authorization" } };
  assert.equal(pickHederaRequirement({ accepts: [explicit] }).amount, "10000");
});

test("any assetTransferMethod is unrecognized on hedera — the binding defines none", () => {
  const offer = { ...requirement, extra: { ...requirement.extra, assetTransferMethod: "eip3009" } };
  assert.equal(pickHederaRequirement({ accepts: [offer] }), null);
  assert.match(describeSkipped({ accepts: [offer] }), /assetTransferMethod: eip3009/);
});

test("the fee payer is compared against the discovered value, never a constant", () => {
  const mismatch = evaluateSpend(base({ requirement: { ...requirement, extra: { feePayer: "0.0.1" } } }));
  assert.equal(mismatch.code, "fee_payer_mismatch");

  const unknown = evaluateSpend(base({ feePayer: "" }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "fee_payer_unknown", "discovery failure must deny, not fall back");

  const rotated = evaluateSpend(
    base({ requirement: { ...requirement, extra: { feePayer: "0.0.7162784" } }, feePayer: "0.0.7162784" }),
  );
  assert.equal(rotated.ok, true, "a rotated fee payer both sides agree on is fine");
});

test("kill switch denies", () => {
  assert.equal(evaluateSpend(base({ config: { paused: true } })).code, "paused");
  assert.equal(evaluateSpend(base({ state: { paused: true } })).code, "paused");
});

test("a hollow operator account denies before signing", () => {
  assert.equal(evaluateSpend(base({ state: { hollow: true } })).code, "hollow_account");
});

test("daily and per-request caps deny", () => {
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.equal(evaluateSpend(base({ state: { spentTodayMicro: "1000", spentTodayDate: stamp } })).ok, true);
  assert.equal(
    evaluateSpend(base({ state: { spentTodayMicro: "10000000", spentTodayDate: stamp } })).code,
    "daily_cap",
  );
  assert.equal(
    evaluateSpend(base({ config: { caps: { dailyMicro: "10000000", perRequestMicro: "500" } } })).code,
    "per_request_cap",
  );
});

test("host allowlist denies", () => {
  assert.equal(evaluateSpend(base({ config: { allowHosts: ["only.example"] } })).code, "host_denied");
});

test("an unreadable balance denies instead of counting as unlimited", () => {
  assert.equal(balanceIsFresh({ balanceAt: "" }), false);
  assert.equal(balanceIsFresh({ balanceAt: new Date(Date.now() - 600_000).toISOString() }), false);
  assert.equal(evaluateSpend(base({ state: { balanceAt: "" } })).code, "stale_balance");
  assert.equal(
    evaluateSpend(base({ state: { balanceAt: new Date(Date.now() - 600_000).toISOString() } })).code,
    "stale_balance",
  );
  // A genuinely empty account is a different answer from an unknown one.
  assert.equal(evaluateSpend(base({ state: { balanceMicro: "0" } })).code, "insufficient_funds");
});

test("a malformed invoice is refused before it reaches the network", () => {
  assert.equal(evaluateSpend(base({ requirement: null })).code, "unsupported");
  assert.equal(evaluateSpend(base({ requirement: { ...requirement, amount: "0" } })).code, "invalid_requirement");
  assert.equal(evaluateSpend(base({ requirement: { ...requirement, amount: "-5" } })).code, "invalid_requirement");
  assert.equal(evaluateSpend(base({ requirement: { ...requirement, amount: "1e6" } })).code, "invalid_requirement");
  assert.equal(evaluateSpend(base({ requirement: { ...requirement, payTo: "0xabc" } })).code, "invalid_requirement");
  assert.equal(evaluateSpend(base({ requirement: { ...requirement, payTo: "0.0.1111" } })).code, "invalid_requirement");
});

test("the float warning fires only above the configured float", () => {
  assert.equal(floatWarning({ maxFloatMicro: "20000000" }, { balanceMicro: "20000000" }), "");
  assert.match(floatWarning({ maxFloatMicro: "5000000" }, { balanceMicro: "9000000" }), /move the excess/);
});

test("a payee is first-sight until it has been seen", () => {
  assert.equal(isFirstSight({ seenPayees: [] }, "api.example", "0.0.9"), true);
  assert.equal(isFirstSight({ seenPayees: ["api.example|0.0.9"] }, "api.example", "0.0.9"), false);
  assert.equal(isFirstSight({ seenPayees: ["api.example|0.0.9"] }, "api.example", "0.0.8"), true);
});

test("happy path", () => {
  const result = evaluateSpend(base());
  assert.equal(result.ok, true);
  assert.equal(result.amount, 10000n);
  assert.equal(result.feePayer, FEE_PAYER);
});
