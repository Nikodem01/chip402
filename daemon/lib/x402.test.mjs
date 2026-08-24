import test from "node:test";
import assert from "node:assert/strict";
import {
  b64json,
  buildPaymentPayload,
  decodePaymentRequired,
  facilitatorCall,
  facilitatorReason,
  parseB64json,
  paymentRequiredBody,
} from "./x402.mjs";
import { NETWORKS, TESTNET } from "./networks.mjs";

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
  assert.equal(decoded.accepts[0].asset, "0.0.429274");
  // v2 names the field `amount`; `maxAmountRequired` is v1.
  assert.equal(decoded.accepts[0].amount, "1000");
  assert.equal(decoded.accepts[0].maxAmountRequired, undefined);
});

test("the invoice follows the profile, so a mainnet seller cannot advertise testnet USDC", () => {
  const required = paymentRequiredBody({
    url: "https://shop.example/x",
    payTo: "0.0.1234",
    amount: "1000",
    feePayer: "0.0.10571514",
    profile: NETWORKS["hedera:mainnet"],
  });
  assert.equal(required.accepts[0].network, "hedera:mainnet");
  assert.equal(required.accepts[0].asset, "0.0.456858");
  assert.notEqual(required.accepts[0].asset, TESTNET.usdc);
});

test("PaymentPayload carries the signed transaction under the spec's field names", () => {
  const payload = buildPaymentPayload({
    requirement: { scheme: "exact", network: "hedera:testnet", amount: "1000" },
    resource: { url: "http://127.0.0.1:4403/secret", description: "secret", mimeType: "application/json" },
    transaction: "YWJj",
  });
  assert.equal(payload.payload.transaction, "YWJj");
  assert.equal(payload.x402Version, 2);
  assert.equal(payload.accepted.scheme, "exact");
});

test("extensions advertised by the server are echoed back verbatim", () => {
  const extensions = { "builder-code": { info: { code: "abc" }, schema: {} } };
  const payload = buildPaymentPayload({
    requirement: { scheme: "exact" },
    resource: { url: "x" },
    transaction: "YWJj",
    extensions,
  });
  assert.deepEqual(payload.extensions, extensions, "the client must include at least the info received");
});

test("no extensions advertised means no extensions field invented", () => {
  const payload = buildPaymentPayload({ requirement: {}, resource: { url: "x" }, transaction: "YWJj" });
  assert.equal("extensions" in payload, false);
});

test("PAYMENT-REQUIRED is read from the header or the body", () => {
  const body = paymentRequiredBody({ url: "u", payTo: "0.0.1", amount: "1", feePayer: "0.0.2" });
  const headers = new Headers({ "payment-required": b64json(body) });
  assert.equal(decodePaymentRequired({ headers }, "").accepts[0].payTo, "0.0.1");
  assert.equal(decodePaymentRequired({ headers: new Headers() }, JSON.stringify(body)).accepts[0].payTo, "0.0.1");
});

test("facilitatorCall refuses a body over the byte cap", async () => {
  await assert.rejects(
    () =>
      facilitatorCall("https://f", "/verify", {}, {
        maxBytes: 32,
        fetchImpl: async () => new Response("y".repeat(200), { status: 200 }),
      }),
    (err) => err.code === "response_too_large",
  );
});

test("facilitatorCall treats a deadline as unreachable, not as a declined payment", async () => {
  await assert.rejects(
    () =>
      facilitatorCall("https://f", "/settle", {}, {
        timeoutMs: 40,
        fetchImpl: (_url, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "TimeoutError";
              reject(err);
            });
          }),
      }),
    (err) => err.code === "facilitator_unreachable",
  );
});

test("the facilitator's diagnostic message is kept, not just its code", () => {
  assert.equal(
    facilitatorReason("invalid_exact_hedera_payload_signature_invalid", "payer 0.0.5 did not sign", "x"),
    "invalid_exact_hedera_payload_signature_invalid: payer 0.0.5 did not sign",
  );
  assert.equal(facilitatorReason("", "", "settlement failed"), "settlement failed");
});
