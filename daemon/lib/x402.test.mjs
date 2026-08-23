import test from "node:test";
import assert from "node:assert/strict";
import { b64json, parseB64json, paymentRequiredBody, buildPaymentPayload } from "./x402.mjs";

test("PAYMENT-REQUIRED roundtrips", () => {
  const required = paymentRequiredBody({
    url: "http://127.0.0.1:4403/secret",
    payTo: "0.0.1234",
    amount: "1000",
    feePayer: "0.0.9185802",
  });
  const decoded = parseB64json(b64json(required));
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepts[0].network, "hedera:testnet");
  assert.equal(decoded.accepts[0].extra.feePayer, "0.0.9185802");
});

test("PaymentPayload carries the signed transaction", () => {
  const payload = buildPaymentPayload({
    requirement: { scheme: "exact", network: "hedera:testnet", amount: "1000" },
    resource: { url: "http://127.0.0.1:4403/secret", description: "secret", mimeType: "application/json" },
    transaction: "YWJj",
  });
  assert.equal(payload.payload.transaction, "YWJj");
  assert.equal(payload.x402Version, 2);
});
