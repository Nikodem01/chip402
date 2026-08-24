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
import fs from "node:fs";
import os from "node:os";

import { DEMO_PRICE_MICRO, RUNTIME_DIR, SOCKET_PATH } from "../daemon/lib/paths.mjs";
import { call, daemonTarget, daemonUp } from "../daemon/lib/client.mjs";
import { loadConfig } from "../daemon/lib/state.mjs";
import { lookupAccount, lookupTransaction, settledAmount } from "../daemon/lib/hedera.mjs";
import { createDiscovery } from "../daemon/lib/facilitator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELLER_PORT = Number(process.env.CHIP402_E2E_SELLER_PORT || 4413);
const SELLER_URL = `http://127.0.0.1:${SELLER_PORT}/secret`;
const PRICE = BigInt(DEMO_PRICE_MICRO);

// Its own state directory and socket, sharing the real config directory. The suite signs with
// the real key and spends real testnet USDC, but the ledger, caps and allowlist it churns
// through are throwaway — it must not leave rows in the ledger the panel shows, add hosts to
// the user's allowlist, or leave the daily cap lowered if a run is killed mid-test.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-e2e-"));
const socketPath = path.join(stateDir, "chip402.sock");
// The Hedera SDK install lives under the state directory but is a cache, not state — share
// the real one rather than making every run npm install into a temp directory.
if (fs.existsSync(RUNTIME_DIR)) fs.symlinkSync(RUNTIME_DIR, path.join(stateDir, "runtime"));
const target = daemonTarget({ socketPath });
const spawned = [];
let config;
let funded = false;
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
  // Always started from current source, so the suite can never silently test a stale build
  // the way reusing a long-running daemon could.
  start(path.join(root, "daemon", "chip402d.mjs"), {
    CHIP402_STATE_DIR: stateDir,
    CHIP402_SOCKET: socketPath,
  });
  for (let i = 0; i < 60 && !(await daemonUp(target)); i += 1) await wait(250);
  assert.ok(await daemonUp(target), `chip402d is not answering on ${socketPath}`);
  await call(target, "POST", "/refresh");
  start(path.join(root, "demo", "seller.mjs"), { CHIP402_SELLER_PORT: String(SELLER_PORT) });
  assert.ok(await tcpUp(SELLER_PORT), `demo seller did not start on :${SELLER_PORT}`);
  await call(target, "POST", "/allow-host", { host: "127.0.0.1" });
  baseline = await call(target, "GET", "/status");
  funded = BigInt(baseline.balanceMicro || "0") >= PRICE;
  console.log(`# daemon: started by this suite on ${socketPath}`);
  console.log(`# live state at ${SOCKET_PATH} is untouched; this run writes to ${stateDir}`);
  console.log(`# operator ${config.accountId} holds ${baseline.balanceMicro} micro-USDC`);
});

after(async () => {
  for (const child of spawned) child.kill("SIGTERM");
  fs.rmSync(stateDir, { recursive: true, force: true });
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

// The reconciler is what makes a crash mid-payment safe, so prove it against a real
// settlement rather than only against a stub: seed the on-disk state a crash would leave —
// a pending row holding a reservation for a transaction that did land — and let a daemon
// start on it. A separate state directory and socket keep this away from the live daemon.
test("13. a daemon starting on a crashed state settles the reservation from the chain", async (t) => {
  if (!test.onChain) {
    t.skip("needs a confirmed settlement to reconcile against");
    return;
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-crash-"));
  const socket = path.join(stateDir, "crash.sock");
  const { txId, payTo, amountMicro } = test.paid.result.payment;
  const stamp = new Date();
  const today = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      schema: 2,
      accountId: config.accountId,
      spentTodayMicro: amountMicro,
      spentTodayDate: today,
      seenPayees: [],
      ledger: [
        {
          id: "crashed-row",
          kind: "payment",
          status: "pending",
          amountMicro,
          payTo,
          host: "127.0.0.1",
          txId,
          spentDate: today,
          expiresAt: new Date(Date.now() + 180_000).toISOString(),
        },
      ],
    }),
    { mode: 0o600 },
  );

  const crashed = spawn(process.execPath, [path.join(root, "daemon", "chip402d.mjs")], {
    cwd: root,
    env: { ...process.env, CHIP402_STATE_DIR: stateDir, CHIP402_SOCKET: socket },
    stdio: ["ignore", "pipe", "pipe"],
  });
  crashed.stdout.resume();
  crashed.stderr.resume();
  spawned.push(crashed);
  const crashedTarget = daemonTarget({ socketPath: socket });
  for (let i = 0; i < 80 && !(await daemonUp(crashedTarget)); i += 1) await wait(250);
  assert.ok(await daemonUp(crashedTarget), "the recovering daemon never came up");

  // Startup reconcile is asynchronous — it has a mirror-node round trip to make.
  let status;
  let row;
  for (let i = 0; i < 40; i += 1) {
    status = await call(crashedTarget, "GET", "/status");
    row = status.ledger.find((entry) => entry.id === "crashed-row");
    if (row && row.status !== "pending") break;
    await wait(500);
  }
  assert.ok(row, "the pending row was lost");
  assert.equal(row.status, "settled", "a settled payment must not be released back to the cap");
  assert.equal(row.onChainMicro, amountMicro, "the amount was taken from the chain");
  assert.equal(status.spentTodayMicro, amountMicro, "the daily counter still reflects the spend");
  assert.equal(status.pendingMicro, "0");
  crashed.kill("SIGTERM");
  fs.rmSync(stateDir, { recursive: true, force: true });
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
