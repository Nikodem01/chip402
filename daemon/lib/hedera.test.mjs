import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VALID_DURATION_SECONDS,
  MAX_VALID_DURATION_SECONDS,
  isHollowKey,
  mirrorTxId,
  pickNodeAccountIds,
  settledAmount,
  validDurationFor,
} from "./hedera.mjs";

test("a hollow account is the one with no key on record", () => {
  // Captured from the live testnet mirror node.
  assert.equal(isHollowKey(null), true);
  assert.equal(isHollowKey({ _type: "ECDSA_SECP256K1", key: "02bef8508826d133c2f84ef423aaea6f9ae25b523d1f71dda76c10a90b7c9a60e0" }), false);
  assert.equal(isHollowKey({ _type: "ECDSA_SECP256K1", key: "0".repeat(66) }), true);
  assert.equal(isHollowKey({ _type: "ProtobufEncoded", key: "" }), true);
});

test("the mirror node's transaction id form is dashed, not the SDK's @ form", () => {
  assert.equal(mirrorTxId("0.0.5@1700000000.000000000"), "0.0.5-1700000000-000000000");
  assert.equal(mirrorTxId("0.0.5-1700000000-000000000"), "0.0.5-1700000000-000000000");
  // Child and scheduled ids must resolve to the parent rather than silently becoming "".
  assert.equal(mirrorTxId("0.0.5@1700000000.000000000/1"), "0.0.5-1700000000-000000000");
  assert.equal(mirrorTxId("0.0.5@1700000000.000000000?scheduled"), "0.0.5-1700000000-000000000");
  assert.equal(mirrorTxId("nonsense"), "");
});

test("valid duration defaults to the SDK's 120s and clamps to the network's 180s", () => {
  assert.equal(validDurationFor(undefined), DEFAULT_VALID_DURATION_SECONDS);
  assert.equal(validDurationFor(0), DEFAULT_VALID_DURATION_SECONDS);
  assert.equal(validDurationFor(180), 180);
  assert.equal(validDurationFor(300), MAX_VALID_DURATION_SECONDS);
  assert.equal(validDurationFor(5), 15, "below the network minimum");
});

test("node fanout never picks the same consensus node twice", () => {
  // client.network is keyed by ip:port, and every node publishes several endpoints.
  const network = {
    "1.1.1.1:50211": "0.0.3",
    "1.1.1.2:50211": "0.0.3",
    "2.2.2.1:50211": "0.0.4",
    "2.2.2.2:50211": "0.0.4",
    "3.3.3.1:50211": "0.0.5",
    "3.3.3.2:50211": "0.0.5",
    "4.4.4.1:50211": "0.0.6",
  };
  for (let i = 0; i < 500; i += 1) {
    const picks = pickNodeAccountIds({ network }).map(String);
    assert.equal(picks.length, 3);
    assert.equal(new Set(picks).size, 3, `duplicate node in ${picks}`);
  }
  assert.deepEqual(pickNodeAccountIds({ network: {} }), []);
  assert.deepEqual(pickNodeAccountIds({}), []);
});

test("settledAmount reads the credit to the payee, across every successful row", () => {
  const tx = {
    success: true,
    tokenTransfers: [
      { token_id: "0.0.429274", account: "0.0.1111", amount: -10000 },
      { token_id: "0.0.429274", account: "0.0.2222", amount: 10000 },
    ],
    transfers: [],
  };
  assert.equal(settledAmount(tx, { asset: "0.0.429274", from: "0.0.1111", to: "0.0.2222" }), 10000n);
  assert.equal(settledAmount(tx, { asset: "0.0.429274", from: "0.0.1111", to: "0.0.9999" }), 0n);
  assert.equal(settledAmount({ ...tx, success: false }, { asset: "0.0.429274", to: "0.0.2222" }), 0n);
  // A debit that does not match the credit is not a payment we can vouch for.
  const skewed = {
    success: true,
    tokenTransfers: [
      { token_id: "0.0.429274", account: "0.0.1111", amount: -5000 },
      { token_id: "0.0.429274", account: "0.0.2222", amount: 10000 },
    ],
  };
  assert.equal(settledAmount(skewed, { asset: "0.0.429274", from: "0.0.1111", to: "0.0.2222" }), 0n);
});

test("an HBAR settlement is read from the plain transfer list", () => {
  const tx = { success: true, transfers: [{ account: "0.0.2222", amount: 500 }], tokenTransfers: [] };
  assert.equal(settledAmount(tx, { asset: "0.0.0", from: "0.0.1111", to: "0.0.2222" }), 500n);
});
