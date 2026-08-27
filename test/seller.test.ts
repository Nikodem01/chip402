// The hostile-seller table. The agent picks the URL, so a seller that is out to get us is the
// normal case rather than the exotic one. Each row is a real HTTP server on loopback answering
// the real `wrapFetchWithPayment` through the real `fetch.ts` and the real guard — only the key
// is a stub, so a signature that should never exist is countable.
//
// Since the chain is the ledger, each row also runs against a mirror node on loopback, and the
// stub signer tells that mirror what it signed. So "the allowance was not touched" is asserted
// the way it is enforced: by asking the chain.

import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { Limits } from "../src/fetch.ts";
import { LIMITS } from "../src/fetch.ts";
import { Purse } from "../src/purse.ts";
import { denialReason, payer, refresh } from "../src/wallet.ts";
import type { Mirror } from "./support.ts";
import {
  FACILITATOR,
  OUR_ACCOUNT,
  OUR_EVM_ADDRESS,
  OUR_PUBLIC_KEY,
  SELLER,
  fakeMirror,
  labelStore,
  scratch,
  testSigner,
  testnet,
} from "./support.ts";
import { Labels } from "../src/labels.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function seller(handler: Handler): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

function offer(over: Record<string, unknown> = {}, count = 1): string {
  const one = {
    scheme: "exact",
    network: testnet.caip2,
    asset: testnet.assets.usdc.id,
    amount: "10000",
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { feePayer: FACILITATOR },
    ...over,
  };
  return b64({
    x402Version: 2,
    resource: { url: "http://127.0.0.1/secret" },
    accepts: Array.from({ length: count }, () => one),
  });
}

// The limits are policy and are set here. What is held and what has gone out today are the
// chain's, and arrive from the mirror node this pipeline is pointed at.
function readyPurse(): Purse {
  const purse = Purse.open(join(scratch(), "purse.json"));
  purse.setPaused(false);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.setLimit("usdc", "maxPayment", 250_000n);
  purse.setLimit("hbar", "allowance", 10_000_000_000n);
  purse.setLimit("hbar", "maxPayment", 1_000_000_000n);
  return purse;
}

// The real payment path with a stub where the key is: the real hardened fetch, the real guard,
// the real policy, the real chain read and the real settlement wait.
function pipeline(purse: Purse, mirror: Mirror, limits: Partial<Limits> = {}) {
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const labels = labelStore();
  const inner = testSigner(mirror);
  const refreshChain = async (): Promise<void> => {
    purse.observe(await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS), false);
  };
  // Patience of zero: this mirror indexes instantly, so a payment that will be seen is seen on
  // the first check, and one that will not needs no waiting for.
  const pay = payer(inner, walletConfig, purse, labels, refreshChain, { ...LIMITS, ...limits }, 0);
  return {
    pay,
    labels,
    signatures: inner.calls,
    // What the chain says we have spent today, which is the only number that bounds anything.
    spent: async () => (await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS)).spent,
  };
}

// Every test wants the same three things torn down, so they are set up together.
async function bench(t: { after: (fn: () => unknown) => void }, limits: Partial<Limits> = {}) {
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const purse = readyPurse();
  return { purse, mirror, ...pipeline(purse, mirror, limits) };
}

test("a 302 to another origin is refused, and nothing is signed", async (t) => {
  // SECURITY: the SDK follows redirects by default and then policies against `response.url`.
  // Without `redirect: "manual"` the harmless name we approved is not the host that got paid.
  const evil = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end("pay me");
  });
  t.after(() => evil.close());
  const bait = await seller((_req, res) => {
    res.writeHead(302, { location: `${evil.base}/secret` }).end();
  });
  t.after(() => bait.close());

  const { pay, signatures, spent } = await bench(t);
  await assert.rejects(() => pay(`${bait.base}/harmless`), /redirected off-origin/);
  assert.equal(signatures(), 0);
  assert.equal((await spent()).usdc, 0n);
});

test("a same-origin redirect is followed, and the URL that answered is the one policy sees", async (t) => {
  const shop = await seller((req, res) => {
    if (req.url === "/old") {
      res.writeHead(302, { location: "/secret" }).end();
      return;
    }
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end("pay me");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("the goods");
  });
  t.after(() => shop.close());

  const { pay, signatures, labels } = await bench(t);
  const result = await pay(`${shop.base}/old`);
  assert.equal(result.body, "the goods");
  assert.equal(signatures(), 1);
  assert.match(String(result.receipt?.url), /\/secret$/);
  // The label follows the URL that answered too, so the row a human reads names the right host.
  assert.equal(labels.hostFor(String(result.receipt?.txId)), new URL(`${shop.base}/secret`).host);
});

test("an unbounded 402 body is cut off before it can be parsed", async (t) => {
  // The wrapper does `await response.text()` on the 402 with no cap, before any policy runs.
  const flood = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer() });
    res.end("x".repeat(64 * 1024));
  });
  t.after(() => flood.close());
  const { pay, signatures } = await bench(t, { maxBodyBytes: 1024 });
  await assert.rejects(() => pay(`${flood.base}/secret`), /exceeded 1024 bytes/);
  assert.equal(signatures(), 0);
});

test("a body that never ends hits the deadline instead of holding the lane forever", async (t) => {
  const hang = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer() });
    res.write("x");
    // and never res.end()
  });
  t.after(() => hang.close());
  const { pay, signatures } = await bench(t, { timeoutMs: 300 });
  await assert.rejects(() => pay(`${hang.base}/secret`));
  assert.equal(signatures(), 0);
});

test("a menu of fifty ways to pay is refused before the selector walks it", async (t) => {
  // Fifty rather than ten thousand for a mundane reason worth knowing: a header carrying ten
  // thousand offers is about a megabyte, and every HTTP stack in the path rejects it long
  // before we see it. The cap here is for the sizes that do fit.
  const menu = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer({}, 50) }).end();
  });
  t.after(() => menu.close());
  const { pay, signatures } = await bench(t);
  await assert.rejects(() => pay(`${menu.base}/secret`), /payment options; the cap is 8/);
  assert.equal(signatures(), 0);
});

test("a v1 downgrade is refused", async (t) => {
  // No PAYMENT-REQUIRED header at all, which is when the SDK falls back to reading a v1 body.
  const old = await seller((_req, res) => {
    res
      .writeHead(402, { "content-type": "application/json" })
      .end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "hedera-testnet", maxAmountRequired: "10000" }] }));
  });
  t.after(() => old.close());
  const { pay, signatures, spent } = await bench(t);
  await assert.rejects(() => pay(`${old.base}/secret`));
  assert.equal(signatures(), 0);
  assert.equal((await spent()).usdc, 0n);
});

test("naming our own account as fee payer is refused", async (t) => {
  // Real money twice over: the fee payer is the transaction id's payer, so this would spend the
  // purse's HBAR on gas for a transaction the seller composed — and it would also hide the
  // payment from the chain read, which uses that same field to tell a purchase from something
  // the owner did.
  const greedy = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer({ extra: { feePayer: OUR_ACCOUNT } }) }).end();
  });
  t.after(() => greedy.close());
  const { pay, signatures } = await bench(t);
  await assert.rejects(
    () => pay(`${greedy.base}/secret`),
    (error: unknown) => {
      assert.match(String(denialReason(error)), /named us as fee payer/);
      return true;
    },
  );
  assert.equal(signatures(), 0);
});

test("naming us as the recipient is refused", async (t) => {
  // The transfer nets to zero, the content is delivered, and the day's allowance is gone — a
  // free lunch billed to the agent's leash rather than to the seller's pocket.
  const clever = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer({ payTo: OUR_ACCOUNT }) }).end();
  });
  t.after(() => clever.close());
  const { pay, signatures } = await bench(t);
  await assert.rejects(
    () => pay(`${clever.base}/secret`),
    (error: unknown) => {
      assert.match(String(denialReason(error)), /named us as the recipient/);
      return true;
    },
  );
  assert.equal(signatures(), 0);
});

test("a look-alike token is refused, with no allowlist involved", async (t) => {
  const fake = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer({ asset: "0.0.429275" }) }).end();
  });
  t.after(() => fake.close());
  const { pay, signatures } = await bench(t);
  await assert.rejects(() => pay(`${fake.base}/secret`));
  assert.equal(signatures(), 0);
});

test("an absurd price is refused twice over, and never signed", async (t) => {
  // policy.ts says no, and so does the SDK's own spendControls underneath it — two
  // implementations of the same cap, which is the one place the plan allows redundancy.
  const dear = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer({ amount: "999000000" }) }).end();
  });
  t.after(() => dear.close());
  const { pay, signatures, spent } = await bench(t);
  await assert.rejects(() => pay(`${dear.base}/secret`));
  assert.equal(signatures(), 0);
  assert.equal((await spent()).usdc, 0n);
});

test("a seller's settlement claim is not read, so lying in it changes nothing", async (t) => {
  // PAYMENT-RESPONSE used to supply the transaction id on a receipt, which made a seller's word
  // an input. It is not read any more: the id in the bytes we signed is the same id, and it is
  // not the seller's to write. This seller claims failure and names somebody else's transaction;
  // both are simply ignored.
  const liar = await seller((req, res) => {
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end();
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/plain",
        "PAYMENT-RESPONSE": b64({ success: false, errorReason: "transaction_failed", transaction: "0.0.1@1.0", network: testnet.caip2 }),
      })
      .end("the goods");
  });
  t.after(() => liar.close());

  const { pay, signatures, spent, mirror } = await bench(t);
  const result = await pay(`${liar.base}/secret`);
  assert.equal(signatures(), 1);
  assert.equal(result.paid, true);
  // Ours, from the bytes we signed — not the "0.0.1@1.0" the seller offered.
  assert.notEqual(result.receipt?.txId, "0.0.1@1.0");
  assert.equal(result.receipt?.txId, mirror.rows[0]?.transaction_id.replace(/-(\d+)-(\d+)$/, "@$1.$2"));
  // The transfer happened, so it counts — the seller reporting failure moves nothing.
  assert.equal((await spent()).usdc, 10_000n);
});

test("a seller that takes a signature and never settles costs nothing", async (t) => {
  // The finding this plan started from, answered by construction. The seller answers 200 with a
  // settlement that never reaches the chain. Nothing is given back, because nothing was taken:
  // the payment simply never appears in the sum, and the allowance is whole once the lane's
  // deadline passes.
  const thief = await seller((req, res) => {
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("the goods");
  });
  t.after(() => thief.close());

  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  mirror.indexing = true; // whatever is signed never reaches the chain
  const purse = readyPurse();
  const { pay, signatures, spent } = pipeline(purse, mirror);

  const result = await pay(`${thief.base}/secret`);
  assert.equal(signatures(), 1);
  assert.equal(result.receipt?.onChain, false, "the chain showed a transaction that never settled");
  // The lane is still shut, so nothing else may go out until the answer is known.
  assert.notEqual(purse.state.settling, null);
  assert.equal((await spent()).usdc, 0n, "an unsettled payment was counted against the allowance");

  // Wind past validStart + 120s. The lane opens, and the allowance is exactly where it started.
  purse.beginSettling(purse.state.settling!.txId, Date.now() - 121_000);
  await pay(`${thief.base}/secret`).catch(() => undefined);
  assert.equal((await spent()).usdc, 0n);
});

test("a seller that claims success it never earned still only gets one signature", async (t) => {
  let requests = 0;
  const boaster = await seller((req, res) => {
    requests++;
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end();
      return;
    }
    res
      .writeHead(200, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0.0.1@1.0", network: testnet.caip2 }) })
      .end("the goods");
  });
  t.after(() => boaster.close());
  const { pay, signatures, spent } = await bench(t);
  await pay(`${boaster.base}/secret`);
  // One 402, one paid request. The SDK's `recovered` path can build a second payload; we
  // register no hook that would ask for it, and the guard would throw if anything did.
  assert.equal(requests, 2);
  assert.equal(signatures(), 1);
  assert.equal((await spent()).usdc, 10_000n);
});

test("a label store that cannot be written costs a name, never the payment", async (t) => {
  // The host name is decoration: `hostFor` is read by the status snapshot and by nothing else, so
  // losing it costs a row that says 0.0.5005 instead of a hostname. It must therefore be
  // impossible for it to cost a payment — and the append happens *after* the signature, so a
  // throw here would fail a payment that had already been authorised, and leave the settling lane
  // shut behind it for the whole validity window.
  const shop = await seller((req, res) => {
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("the goods");
  });
  t.after(() => shop.close());

  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const purse = readyPurse();
  const dir = scratch();
  const path = join(dir, "labels.jsonl");
  mkdirSync(path);                                   // every append against this throws EISDIR
  const labels = Labels.open(path);
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const inner = testSigner(mirror);
  const refreshChain = async (): Promise<void> => {
    purse.observe(await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS), false);
  };
  const pay = payer(inner, walletConfig, purse, labels, refreshChain, LIMITS, 0);

  const result = await pay(`${shop.base}/secret`);
  assert.equal(result.body, "the goods", "a name that could not be written failed the payment");
  assert.equal(result.paid, true);
  assert.equal(labels.hostFor(String(result.receipt?.txId)), new URL(shop.base).host, "the name is still usable in memory");
  // And the lane is not left shut behind a payment that was never delivered.
  assert.equal(purse.state.settling, null);
});

test("a paused purse denies even a perfectly well-behaved seller", async (t) => {
  const shop = await seller((_req, res) => {
    res.writeHead(402, { "PAYMENT-REQUIRED": offer() }).end();
  });
  t.after(() => shop.close());
  const { pay, signatures, purse } = await bench(t);
  purse.setPaused(true);
  await assert.rejects(
    () => pay(`${shop.base}/secret`),
    (error: unknown) => {
      assert.equal(denialReason(error), "paused");
      return true;
    },
  );
  assert.equal(signatures(), 0);
});

test("HBAR is paid when it is all the seller takes, and USDC wins when both are offered", async (t) => {
  const both = await seller((req, res) => {
    const wantsHbar = req.url?.includes("hbar");
    const accepts = wantsHbar
      ? [{ scheme: "exact", network: testnet.caip2, asset: "0.0.0", amount: "100000000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FACILITATOR } }]
      : [
          { scheme: "exact", network: testnet.caip2, asset: "0.0.0", amount: "100000000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FACILITATOR } },
          { scheme: "exact", network: testnet.caip2, asset: testnet.assets.usdc.id, amount: "10000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FACILITATOR } },
        ];
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url: "http://127.0.0.1/x" }, accepts }) }).end();
      return;
    }
    res.writeHead(200).end("the goods");
  });
  t.after(() => both.close());
  const { pay, spent } = await bench(t);

  await pay(`${both.base}/hbar`);
  const afterHbar = await spent();
  assert.equal(afterHbar.hbar, 100_000_000n);
  assert.equal(afterHbar.usdc, 0n, "an HBAR payment showed up in the USDC figure");

  await pay(`${both.base}/either`);
  const afterBoth = await spent();
  assert.equal(afterBoth.usdc, 10_000n, "USDC should win when both are on offer");
  assert.equal(afterBoth.hbar, 100_000_000n, "the HBAR figure moved for a USDC payment");
});
