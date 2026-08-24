import test from "node:test";
import assert from "node:assert/strict";
import { FacilitatorError, createDiscovery, feePayerFrom, fetchSupported, selectKind, supportedUrl } from "./facilitator.mjs";

const TESTNET_SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:84532" },
    { x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.9185802" } },
    { x402Version: 1, scheme: "exact", network: "base-sepolia" },
  ],
  extensions: ["builder-code"],
  signers: { "hedera:*": ["0.0.9185802"] },
};

// Real Response objects, because the daemon only ever reads a body by streaming it — a mock
// that answers json() would not exercise the path production takes.
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function respond(status, body) {
  return async () => jsonResponse(status, body);
}

test("the kind is matched on version, scheme and network together", () => {
  assert.equal(selectKind(TESTNET_SUPPORTED, "hedera:testnet").extra.feePayer, "0.0.9185802");
  assert.equal(selectKind(TESTNET_SUPPORTED, "hedera:mainnet"), null);
  assert.equal(selectKind({ kinds: [{ x402Version: 1, scheme: "exact", network: "hedera:testnet" }] }, "hedera:testnet"), null);
  assert.equal(selectKind({ kinds: [{ x402Version: 2, scheme: "upto", network: "hedera:testnet" }] }, "hedera:testnet"), null);
  assert.equal(feePayerFrom({ extra: { feePayer: "  " } }), "");
});

test("supportedUrl does not double the slash", () => {
  assert.equal(supportedUrl("https://x402.org/facilitator/"), "https://x402.org/facilitator/supported");
  assert.equal(supportedUrl("https://api.blocky402.com"), "https://api.blocky402.com/supported");
});

test("a discovered fee payer is cached until the TTL expires, then re-fetched", async () => {
  let calls = 0;
  let clock = 0;
  const discovery = createDiscovery({
    ttlMs: 1000,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, TESTNET_SUPPORTED);
    },
  });
  const args = { facilitator: "https://f", network: "hedera:testnet" };
  assert.equal((await discovery.discover(args)).feePayer, "0.0.9185802");
  await discovery.discover(args);
  assert.equal(calls, 1, "the second call should be served from cache");
  clock = 2000;
  assert.equal(discovery.peek(args), null, "an expired entry must not be readable");
  await discovery.discover(args);
  assert.equal(calls, 2);
});

test("a facilitator that stops advertising our network drops the cached fee payer", async () => {
  let body = TESTNET_SUPPORTED;
  const discovery = createDiscovery({ fetchImpl: async () => jsonResponse(200, body) });
  const args = { facilitator: "https://f", network: "hedera:testnet" };
  await discovery.discover(args);
  body = { kinds: [], extensions: [], signers: {} };
  await assert.rejects(() => discovery.discover({ ...args, force: true }), (err) => {
    assert.equal(err.code, "facilitator_network_unsupported");
    return true;
  });
  assert.equal(discovery.peek(args), null, "never keep a stale fee payer after discovery fails");
});

test("a network advertised without a fee payer is a failure, not an empty default", async () => {
  const discovery = createDiscovery({
    fetchImpl: respond(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet" }] }),
  });
  await assert.rejects(
    () => discovery.discover({ facilitator: "https://f", network: "hedera:testnet" }),
    (err) => err.code === "facilitator_no_fee_payer",
  );
});

test("a rate limit and a rejected key are told apart from a declined payment", async () => {
  for (const [status, code] of [[401, "facilitator_unauthorized"], [403, "facilitator_unauthorized"], [429, "facilitator_rate_limited"], [503, "facilitator_unreachable"]]) {
    const discovery = createDiscovery({ fetchImpl: respond(status, {}) });
    await assert.rejects(
      () => discovery.discover({ facilitator: "https://f", network: "hedera:testnet" }),
      (err) => {
        assert.ok(err instanceof FacilitatorError);
        assert.equal(err.code, code, `status ${status}`);
        return true;
      },
    );
  }
});

test("the API key is sent as X-Api-Key when one is configured", async () => {
  let seen = null;
  const discovery = createDiscovery({
    fetchImpl: async (url, init) => {
      seen = init.headers;
      return jsonResponse(200, TESTNET_SUPPORTED);
    },
  });
  await discovery.discover({ facilitator: "https://f", network: "hedera:testnet", apiKey: "b402_test" });
  assert.equal(seen["X-Api-Key"], "b402_test");
});

test("a /supported body over the byte cap is refused before it is parsed", async () => {
  await assert.rejects(
    () =>
      fetchSupported({
        facilitator: "https://f",
        fetchImpl: async () => new Response("x".repeat(500), { status: 200 }),
        maxBytes: 64,
      }),
    (err) => {
      assert.ok(err instanceof FacilitatorError);
      assert.equal(err.code, "facilitator_unreachable");
      assert.match(err.message, /exceeded 64 bytes/);
      return true;
    },
  );
});

test("an unreachable facilitator is a failure, never a silent fallback", async () => {
  const discovery = createDiscovery({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => discovery.discover({ facilitator: "https://f", network: "hedera:testnet" }),
    (err) => err.code === "facilitator_unreachable",
  );
});
