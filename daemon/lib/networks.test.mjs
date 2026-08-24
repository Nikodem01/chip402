import test from "node:test";
import assert from "node:assert/strict";
import {
  HBAR,
  MAINNET_SHIPPED,
  NETWORKS,
  TESTNET,
  describeNetwork,
  isKnownAsset,
  isSpendAsset,
  mainnetBlockedMessage,
  requestedNetworkId,
  resolveNetwork,
} from "./networks.mjs";

test("mainnet is not shipped", () => {
  assert.equal(MAINNET_SHIPPED, false);
});

test("testnet profile", () => {
  const profile = resolveNetwork("hedera:testnet");
  assert.equal(profile.id, "hedera:testnet");
  assert.equal(profile.usdc, "0.0.429274");
  assert.equal(profile.feePayer, "0.0.9185802");
  assert.match(profile.hashscan, /testnet/);
  assert.equal(profile.allowWildcardHosts, false);
});

test("only USDC is a spend asset; HBAR is known but not spendable", () => {
  assert.equal(isSpendAsset(TESTNET.usdc, TESTNET), true);
  assert.equal(isSpendAsset(HBAR, TESTNET), false, "HBAR amounts are tinybars, caps are micro-USDC");
  assert.equal(isKnownAsset(HBAR, TESTNET), true);
  assert.equal(isSpendAsset("0.0.1", TESTNET), false);
});

test("the mainnet profile is complete and ready for the switch", () => {
  const mainnet = NETWORKS["hedera:mainnet"];
  assert.equal(mainnet.usdc, "0.0.456858");
  assert.equal(mainnet.facilitator, "https://api.blocky402.com");
  assert.equal(mainnet.feePayer, "", "the fee payer is discovered from /supported, never pinned");
  assert.equal(mainnet.mirror, "https://mainnet.mirrornode.hedera.com");
  assert.equal(mainnet.allowWildcardHosts, false);
  assert.equal(mainnet.defaultDailyMicro, "1000000");
  assert.equal(mainnet.defaultPerRequestMicro, "100000");
  assert.equal(mainnet.defaultMaxFloatUsdcMicro, "5000000");
});

test("resolveNetwork refuses mainnet while MAINNET_SHIPPED is false", () => {
  assert.throws(() => resolveNetwork("hedera:mainnet"), (err) => {
    assert.equal(err.code, "mainnet_disabled");
    assert.equal(err.message, mainnetBlockedMessage());
    return true;
  });
  assert.throws(() => resolveNetwork("mainnet"), (err) => err.code === "mainnet_disabled");
  // describeNetwork is the read-only view that documentation and the panel use.
  assert.equal(describeNetwork("mainnet").id, "hedera:mainnet");
});

test("requestedNetworkId aliases", () => {
  assert.equal(requestedNetworkId(""), TESTNET.id);
  assert.equal(requestedNetworkId("testnet"), "hedera:testnet");
  assert.equal(requestedNetworkId("hedera:testnet"), "hedera:testnet");
  assert.equal(requestedNetworkId("mainnet"), "hedera:mainnet");
});

test("unknown network throws", () => {
  assert.throws(() => resolveNetwork("hedera:previewnet"), /Unknown network/);
});

test("CHIP402_NETWORK=mainnet wins over stored testnet", async () => {
  const { configuredNetworkId } = await import("./state.mjs");
  const previous = process.env.CHIP402_NETWORK;
  process.env.CHIP402_NETWORK = "hedera:mainnet";
  try {
    assert.equal(configuredNetworkId({ network: "hedera:testnet" }), "hedera:mainnet");
  } finally {
    if (previous === undefined) delete process.env.CHIP402_NETWORK;
    else process.env.CHIP402_NETWORK = previous;
  }
});
