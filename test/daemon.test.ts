// What the daemon adds on top of the guard: one payment at a time, a socket that is never a
// port, and a status frame that arrives without being asked for.
//
// The allowance is no longer enforced by a number the daemon keeps, so the tests that used to
// assert against a counter now assert against a mirror node — a real one, on loopback, that
// answers with the real row shapes. Everything below goes through the shipping chain read.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Purse } from "../src/purse.ts";
import { connect, scratch, sleep, startTestDaemon } from "./support.ts";

const ready = (allowance: bigint) => (purse: Purse) => {
  purse.setPaused(false);
  purse.setLimit("usdc", "allowance", allowance);
  purse.setLimit("usdc", "maxPayment", 250_000n);
};

test("two payments racing an allowance that covers one: exactly one pays", async (t) => {
  // SECURITY: the daemon serializes payments through a single promise chain, and the chain read
  // that bounds the second one happens inside that lane. Without the serialization both calls
  // read the ledger before either signs, and the daily cap is worth nothing under load — which
  // is precisely when it matters.
  const test402 = await startTestDaemon(ready(10_000n), 10_000n, 25);
  t.after(() => test402.close());
  const spend = await connect(test402.daemon.spendPath);
  const [first, second] = await Promise.all([
    spend.send({ cmd: "pay", url: "https://a.example/x" }),
    spend.send({ cmd: "pay", url: "https://a.example/y" }),
  ]);
  const paid = [first, second].filter((reply) => reply!["ok"] === true);
  const denied = [first, second].filter((reply) => reply!["ok"] === false);
  assert.equal(paid.length, 1);
  assert.equal(denied.length, 1);
  assert.match(String(denied[0]!["reason"]), /daily allowance/);
  assert.equal(test402.signatures(), 1);
  // And what stopped the second one is on the chain, not in a file.
  assert.equal(test402.mirror.rows.length, 1);
  spend.close();
});

test("three hundred payments stop at the allowance and never past it", async (t) => {
  const test402 = await startTestDaemon(ready(100_000n), 10_000n);
  t.after(() => test402.close());
  const spend = await connect(test402.daemon.spendPath);
  const replies = await Promise.all(
    Array.from({ length: 300 }, (_, i) => spend.send({ cmd: "pay", url: `https://a.example/${i}` })),
  );
  assert.equal(replies.filter((reply) => reply["ok"] === true).length, 10);
  assert.equal(test402.signatures(), 10, "a signature was produced for a denied payment");
  // Ten transactions on the chain, summing to exactly the allowance and not a unit more.
  assert.equal(test402.mirror.rows.length, 10);
  const spent = test402.mirror.rows.reduce(
    (total, row) => total + BigInt(-(row.token_transfers.find((t) => t.amount < 0)?.amount ?? 0)),
    0n,
  );
  assert.equal(spent, 100_000n);
  spend.close();
});

test("a payment the chain has not shown yet stops the next one, and the panel says so", async (t) => {
  // The indexing gap, closed by waiting rather than by counting. The mirror node holds the
  // transaction back; the lane stays shut; the second payment is refused with a reason a human
  // can act on rather than a wrong number.
  const test402 = await startTestDaemon(ready(2_000_000n), 10_000n);
  t.after(() => test402.close());
  test402.mirror.indexing = true;
  const spend = await connect(test402.daemon.spendPath);

  const first = await spend.send({ cmd: "pay", url: "https://a.example/x" });
  assert.equal(first["ok"], true);
  assert.equal((first["receipt"] as Record<string, unknown>)["onChain"], false, "the chain showed a held transaction");

  const second = await spend.send({ cmd: "pay", url: "https://a.example/y" });
  assert.equal(second["ok"], false);
  assert.match(String(second["reason"]), /still settling/);
  assert.equal(test402.signatures(), 1);

  const status = await spend.send({ cmd: "purse" });
  assert.equal(status["settling"], true);

  // The mirror node catches up, and the same call now goes through — with both payments
  // counted, because they are on the chain and the chain is the ledger.
  test402.mirror.indexing = false;
  test402.mirror.catchUp();
  const third = await spend.send({ cmd: "pay", url: "https://a.example/z" });
  assert.equal(third["ok"], true, String(third["reason"]));
  const settled = (await spend.send({ cmd: "purse" })) as Record<string, any>;
  assert.equal(settled["assets"].usdc.spent, "20000");

  spend.close();
});

test("a paused purse denies the next payment, and the panel can pause it itself", async (t) => {
  const test402 = await startTestDaemon(ready(2_000_000n));
  t.after(() => test402.close());
  const spend = await connect(test402.daemon.spendPath);
  assert.equal((await spend.send({ cmd: "pay", url: "https://a.example/x" }))["ok"], true);
  await spend.send({ cmd: "pause" });
  const denied = await spend.send({ cmd: "pay", url: "https://a.example/y" });
  assert.equal(denied["ok"], false);
  assert.equal(denied["reason"], "paused");
  spend.close();
});

test("status arrives on connect and again on every change, unasked", async (t) => {
  const test402 = await startTestDaemon(ready(2_000_000n));
  t.after(() => test402.close());
  const panel = await connect(test402.daemon.spendPath);
  await sleep(20);
  // One frame the instant the socket opens, before anybody asks — that is what makes the panel's
  // first paint real rather than empty. A second may follow immediately behind it, because the
  // daemon reads the chain at start-up and every reading is pushed too.
  assert.ok(panel.pushes.length >= 1, "the first paint should be real, not empty");
  assert.equal(panel.pushes[0]!["type"], "status");
  assert.ok((panel.pushes[0] as Record<string, any>)["assets"].usdc, "the first frame carried no purse");
  const before = panel.pushes.length;

  const spend = await connect(test402.daemon.spendPath);
  await spend.send({ cmd: "pay", url: "https://a.example/x" });
  await sleep(20);
  assert.ok(panel.pushes.length > before, "the panel was not told about a payment it did not make");
  const latest = panel.pushes.at(-1) as Record<string, any>;
  assert.equal(latest["assets"].usdc.spent, "10000");
  // The row is the chain's, and it carries the label the daemon wrote after signing.
  assert.equal(latest["assets"].usdc.payments[0].host, "a.example");
  assert.match(String(latest["assets"].usdc.payments[0].txId), /^\d+\.\d+\.\d+@\d+\.\d+$/);

  spend.close();
  panel.close();
});

test("no verb on either plane returns anything key-shaped", async (t) => {
  const test402 = await startTestDaemon(ready(2_000_000n));
  t.after(() => test402.close());
  const spend = await connect(test402.daemon.spendPath);
  const admin = await connect(test402.daemon.adminPath);
  const replies = [
    await spend.send({ cmd: "purse" }),
    await spend.send({ cmd: "pay", url: "https://a.example/x" }),
    await spend.send({ cmd: "pause" }),
    await admin.send({ cmd: "resume" }),
    await admin.send({ cmd: "allowance", asset: "usdc", amount: "1.00" }),
    await admin.send({ cmd: "max", asset: "usdc", amount: "0.25" }),
  ];
  const text = JSON.stringify(replies);
  assert.doesNotMatch(text, /privateKey|302e0201|CREDENTIALS_DIRECTORY/i);
  assert.doesNotMatch(text, /[0-9a-f]{60,}/i, "something key-shaped came back off a socket");
  spend.close();
  admin.close();
});

test("the daemon binds no TCP port, ever", () => {
  // A port would replace file permission bits — the entire authorization scheme — with a token
  // system there is something to get wrong in.
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.listen\(\s*\d|createServer\(\).listen\(\d|host:|port:/);
  assert.match(source, /server\.listen\(path/);
});

test("an unknown network in config.json is a refusal to start", async () => {
  const { loadConfig } = await import("../src/daemon.ts");
  const dir = scratch();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ network: "hedera:previewnet" }));
  assert.throws(() => loadConfig(join(dir, "config.json")), /unknown network/);
});

test("an accountId that is not an account id is a refusal to start", async () => {
  // It is interpolated into a mirror-node URL path. /etc/chip402/config.json is root-owned, but
  // "root wrote it" is not the same claim as "it is an account id", and a path segment is the
  // wrong place to find that out.
  const { loadConfig } = await import("../src/daemon.ts");
  const dir = scratch();
  for (const bad of ["../../etc/passwd", "0.0.1/../..", "", "0.0", "0.0.1?x=1", "nonsense"]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ network: "hedera:testnet", accountId: bad }));
    assert.throws(() => loadConfig(join(dir, "config.json")), /not a Hedera account id/, bad);
  }
  // And the ordinary case still starts.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ network: "hedera:testnet", accountId: "0.0.10193689" }));
  assert.equal(loadConfig(join(dir, "config.json")).accountId, "0.0.10193689");
});
