// End-to-end proof against hedera:testnet. Every stage asserts; nothing here prints and
// hopes. Stage 6 is the one that matters — it confirms the settlement on the mirror node
// rather than trusting the seller's PAYMENT-RESPONSE header.
//
//   node --test test/e2e.mjs
//
// Needs testnet USDC in the operator account. Without it the payment stages skip with an
// explicit message instead of failing, so the suite still proves everything up to the money.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

import { DEMO_PRICE_MICRO, SOCKET_PATH } from "../daemon/lib/paths.mjs";
import { call, daemonTarget, daemonUp } from "../daemon/lib/client.mjs";
import { loadConfig } from "../daemon/lib/state.mjs";
import { lookupAccount, lookupTransaction, settledAmount } from "../daemon/lib/hedera.mjs";
import { createDiscovery } from "../daemon/lib/facilitator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELLER_PORT = Number(process.env.CHIP402_E2E_SELLER_PORT || 4413);
const SELLER_URL = `http://127.0.0.1:${SELLER_PORT}/secret`;
const PRICE = BigInt(DEMO_PRICE_MICRO);

const target = daemonTarget();
const spawned = [];
let config;
let funded = false;
let reused = false;
let baseline;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function start(file, env = {}) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  spawned.push(child);
  return child;
}

async function tcpUp(port, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return true;
    await wait(250);
  }
  return false;
}

before(async () => {
  config = await loadConfig();
  // Reuse a running daemon rather than starting a second one: two daemons would race each
  // other's writes to state.json. Restart chip402d after changing daemon code, or this suite
  // silently tests the old build.
  reused = await daemonUp(target);
  if (!reused) {
    start(path.join(root, "daemon", "chip402d.mjs"));
    for (let i = 0; i < 60 && !(await daemonUp(target)); i += 1) await wait(250);
  }
  assert.ok(await daemonUp(target), `chip402d is not answering on ${SOCKET_PATH}`);
  await call(target, "POST", "/refresh");
  start(path.join(root, "demo", "seller.mjs"), { CHIP402_SELLER_PORT: String(SELLER_PORT) });
  assert.ok(await tcpUp(SELLER_PORT), `demo seller did not start on :${SELLER_PORT}`);
  await call(target, "POST", "/allow-host", { host: "127.0.0.1" });
  baseline = await call(target, "GET", "/status");
  funded = BigInt(baseline.balanceMicro || "0") >= PRICE;
  console.log(
    `# daemon: ${reused ? "reused the one already running" : "started by this suite"} on ${SOCKET_PATH}`,
  );
  console.log(`# operator ${config.accountId} holds ${baseline.balanceMicro} micro-USDC`);
});

after(async () => {
  for (const child of spawned) child.kill("SIGTERM");
});

test("1. the operator account resolves from its EVM alias", async () => {
  const found = await lookupAccount(config.evmAddress, config.network);
  assert.ok(found, `mirror node has no account for ${config.evmAddress}`);
  assert.equal(found.accountId, config.accountId);
  assert.equal(found.deleted, false);
});

test("2. the operator account is not hollow", async () => {
  const found = await lookupAccount(config.accountId, config.network);
  assert.equal(found.hollow, false, "operator has no key on record — every payment would fail verification");
  assert.equal(found.keyType, "ECDSA_SECP256K1");
  const status = await call(target, "GET", "/status");
  assert.equal(status.hollow, false);
});

test("3. the operator can hold USDC", async () => {
  const status = await call(target, "GET", "/status");
  const account = await lookupAccount(config.accountId, config.network);
  assert.ok(
    status.associated === true || account.maxAutoAssociations === -1 || account.maxAutoAssociations > 0,
    "operator can neither hold nor auto-associate USDC",
  );
  assert.equal(status.balanceFresh, true, "balance read is stale — payments would be denied");
});

test("4. the facilitator advertises the configured network and names a fee payer", async () => {
  const entry = await createDiscovery().discover({
    facilitator: config.facilitator,
    network: config.network,
    apiKey: config.facilitatorApiKey,
  });
  assert.equal(entry.kind.x402Version, 2);
  assert.equal(entry.kind.scheme, "exact");
  assert.equal(entry.kind.network, config.network);
  assert.match(entry.feePayer, /^\d+\.\d+\.\d+$/);
  const status = await call(target, "GET", "/status");
  assert.equal(status.feePayer, entry.feePayer, "daemon is not using the discovered fee payer");
});

test("5. the demo seller answers 402 with a payable invoice", async () => {
  const res = await fetch(SELLER_URL);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.x402Version, 2);
  const offer = body.accepts.find((item) => item.network === config.network && item.scheme === "exact");
  assert.ok(offer, `seller advertises nothing for ${config.network}`);
  assert.equal(offer.amount, DEMO_PRICE_MICRO);
  assert.equal(offer.asset, config.asset);
  assert.match(offer.payTo, /^\d+\.\d+\.\d+$/);
});

test("6. POST /fetch pays the invoice and returns the resource", async (t) => {
  if (!funded) {
    t.skip(`operator holds ${baseline.balanceMicro} micro-USDC — needs ${PRICE} to pay the demo invoice`);
    return;
  }
  const before = await call(target, "GET", "/status");
  const result = await call(target, "POST", "/fetch", { url: SELLER_URL });
  assert.equal(result.paid, true, "chip402 did not pay");
  assert.equal(result.status, 200);
  assert.equal(result.body.secret, "The agent has chips.");
  assert.ok(result.payment?.txId, "no transaction id was recorded");
  t.diagnostic(`transaction ${result.payment.txId}`);
  test.paid = { result, before };
});

test("7. the mirror node independently confirms the settlement", async (t) => {
  if (!test.paid) {
    t.skip("no payment to confirm");
    return;
  }
  const { txId } = test.paid.result.payment;
  let tx = null;
  for (let i = 0; i < 24 && !tx; i += 1) {
    tx = await lookupTransaction(txId, config.network);
    if (!tx) await wait(2500);
  }
  assert.ok(tx, `mirror node never saw ${txId}`);
  assert.equal(tx.success, true, `transaction did not succeed: ${tx.result}`);
  const moved = settledAmount(tx, {
    asset: config.asset,
    from: config.accountId,
    to: test.paid.result.payment.payTo,
  });
  assert.equal(moved, PRICE, "on-chain amount does not match the invoice");
  test.onChain = { tx, moved };
});

test("8. the ledger row matches the on-chain amount", async (t) => {
  if (!test.onChain) {
    t.skip("no confirmed settlement to compare against");
    return;
  }
  const status = await call(target, "GET", "/status");
  const row = status.ledger.find((entry) => entry.id === test.paid.result.payment.id);
  assert.ok(row, "the payment is not in the ledger");
  assert.equal(row.status, "settled");
  assert.equal(BigInt(row.amountMicro), test.onChain.moved);
  assert.equal(row.payTo, test.paid.result.payment.payTo);
  assert.ok(row.hashscan.includes(encodeURIComponent(row.txId)));
});

test("9. spentTodayMicro advanced by exactly the invoice amount", async (t) => {
  if (!test.paid) {
    t.skip("no payment to account for");
    return;
  }
  const status = await call(target, "GET", "/status");
  const before = BigInt(test.paid.before.spentTodayMicro);
  const now = BigInt(status.spentTodayMicro);
  assert.equal(now - before, PRICE, `daily counter moved by ${now - before}, expected ${PRICE}`);
  assert.equal(status.pendingMicro, "0", "a reservation was left dangling");
});

test("10. a payment over the daily cap is denied", async (t) => {
  if (!funded) {
    t.skip("cap enforcement needs a payable invoice");
    return;
  }
  const status = await call(target, "GET", "/status");
  const restore = { dailyMicro: status.dailyCapMicro, perRequestMicro: status.perRequestMicro };
  // Leave less headroom than the invoice costs.
  await call(target, "POST", "/caps", { dailyMicro: String(BigInt(status.spentTodayMicro) + PRICE - 1n) });
  try {
    await call(target, "POST", "/fetch", { url: SELLER_URL });
    assert.fail("the payment over the cap was allowed");
  } catch (err) {
    assert.equal(err.status, 403);
    assert.equal(err.body.code, "daily_cap");
  } finally {
    await call(target, "POST", "/caps", restore);
  }
  const after = await call(target, "GET", "/status");
  assert.equal(after.spentTodayMicro, status.spentTodayMicro, "a denied payment moved the counter");
});

test("11. the cap change left an audit row", async () => {
  const status = await call(target, "GET", "/status");
  const audits = status.ledger.filter((row) => row.kind === "audit");
  assert.ok(audits.length > 0, "raising a cap left no trace in the ledger");
  assert.ok(audits.some((row) => row.action === "caps"), "no audit row for the cap change");
});

test("12. a host that is not on the allowlist is refused", async () => {
  await assert.rejects(
    () => call(target, "POST", "/fetch", { url: "https://not-allowed.example/thing" }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.body.code, "host_denied");
      return true;
    },
  );
});
