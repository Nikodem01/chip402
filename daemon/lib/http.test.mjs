import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RESPONSE_BYTES,
  ResponseLimitError,
  fetchCapped,
  readCapped,
  readCappedJson,
  requestSignal,
} from "./http.mjs";

function countingStream(totalBytes, chunkSize = 64) {
  const stats = { sent: 0, pulls: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      stats.pulls += 1;
      if (stats.sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - stats.sent);
      controller.enqueue(new Uint8Array(n).fill(65));
      stats.sent += n;
    },
  });
  return { stream, stats };
}

test("readCapped stops a streamed body at the byte cap without draining the rest", async () => {
  const { stream, stats } = countingStream(50_000, 64);
  await assert.rejects(
    () => readCapped({ body: stream }, { maxBytes: 200 }),
    (err) => {
      assert.ok(err instanceof ResponseLimitError);
      assert.equal(err.code, "response_too_large");
      return true;
    },
  );
  assert.ok(stats.sent <= 200 + 64, `kept reading after the cap: sent ${stats.sent}`);
  assert.ok(stats.sent < 50_000, "must not consume the whole body");
});

test("readCapped accepts a body at the limit", async () => {
  const text = "a".repeat(32);
  const res = new Response(text, { status: 200 });
  assert.equal(await readCapped(res, { maxBytes: 32 }), text);
});

test("readCappedJson parses a streamed body", async () => {
  const res = new Response(JSON.stringify({ kinds: [{ network: "hedera:testnet" }] }), { status: 200 });
  const json = await readCappedJson(res);
  assert.equal(json.kinds[0].network, "hedera:testnet");
});

test("readCappedJson refuses a streamed payload over the cap", async () => {
  const res = new Response(JSON.stringify({ pad: "x".repeat(500) }), { status: 200 });
  await assert.rejects(() => readCappedJson(res, { maxBytes: 40 }), (err) => err.code === "response_too_large");
});

// The point of the helper is that no body is ever materialized before a limit sees it, so a
// response that can only be read whole is refused rather than read.
test("readCapped refuses a response whose body cannot be streamed", async () => {
  await assert.rejects(
    () => readCapped({ body: {}, json: async () => ({ ok: true }), text: async () => "ok" }),
    (err) => err.code === "unstreamable_body",
  );
});

test("readCapped treats an absent body as empty", async () => {
  assert.equal(await readCapped({ body: null }), "");
});

test("requestSignal is aborted once the deadline passes", async () => {
  const signal = requestSignal(30);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal.aborted, true);
});

test("fetchCapped passes a timeout signal and refuses a hanging body", async () => {
  await assert.rejects(
    () =>
      fetchCapped(
        "https://example.invalid/supported",
        {},
        {
          timeoutMs: 40,
          fetchImpl: (_url, init) =>
            new Promise((_, reject) => {
              init.signal.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "TimeoutError";
                reject(err);
              });
            }),
        },
      ),
    (err) => err.name === "TimeoutError",
  );
});

test("the JSON cap is well under what a hostile endpoint could stream into memory", () => {
  assert.ok(MAX_RESPONSE_BYTES <= 1_000_000);
});
