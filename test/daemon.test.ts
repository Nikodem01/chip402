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

test("the indexing gap is closed by counting, not by waiting — and stops nothing else", async (t) => {
  // This used to be a refusal. The mirror node held the transaction back, so what had been spent was
  // not yet knowable, so every other payment was denied for as long as two minutes. The purse now
  // counts what it authorised the moment it authorises it, so payments carry on at the seller's
  // pace and the day already includes the ones in the air.
  //
  // The allowance covers five. Five go out with the chain showing none of them, the sixth is
  // refused by the allowance rather than by anything waiting, and the panel's figure is the same
  // one the decision used.
  const test402 = await startTestDaemon(ready(50_000n), 10_000n);
  t.after(() => test402.close());
  test402.mirror.indexing = true;
  const spend = await connect(test402.daemon.spendPath);

  for (let i = 0; i < 5; i++) {
    const reply = await spend.send({ cmd: "pay", url: `https://a.example/${i}` });
    assert.equal(reply["ok"], true, String(reply["reason"]));
    assert.equal((reply["receipt"] as Record<string, unknown>)["onChain"], false, "the chain showed a held transaction");
  }
  assert.equal(test402.signatures(), 5);

  const held = (await spend.send({ cmd: "purse" })) as Record<string, any>;
  assert.equal(held["assets"].usdc.spent, "50000", "the panel showed a day the chain had not caught up to");
  assert.equal(held["inFlight"], 5);

  const sixth = await spend.send({ cmd: "pay", url: "https://a.example/5" });
  assert.equal(sixth["ok"], false);
  assert.match(String(sixth["reason"]), /daily allowance/, "a payment past the allowance was not refused by the allowance");
  assert.equal(test402.signatures(), 5, "the key was reached past the allowance");

  // The mirror node catches up. The figure does not move — it was already right — and the payments
  // stop being in the air, which is the only thing that changes.
  test402.mirror.indexing = false;
  test402.mirror.catchUp();
  await spend.send({ cmd: "pay", url: "https://a.example/6" }).catch(() => undefined);
  const settled = (await spend.send({ cmd: "purse" })) as Record<string, any>;
  assert.equal(settled["assets"].usdc.spent, "50000", "the chain catching up moved a figure that was already right");
  assert.equal(test402.mirror.rows.length, 5);

  spend.close();
});

test("payments run alongside one another rather than one at a time", async (t) => {
  // The claim the lane cost and this design gets back. Twenty payments are fired at once, each with
  // a 402 round trip standing in front of it, and they overlap — a lane would make the whole thing
  // take twenty round trips end to end. The allowance covers all twenty, so what is being measured
  // is the wall clock and not a limit.
  const roundTrip = 40;
  const test402 = await startTestDaemon(ready(1_000_000n), 10_000n, roundTrip);
  t.after(() => test402.close());
  const spend = await connect(test402.daemon.spendPath);

  const began = Date.now();
  const replies = await Promise.all(
    Array.from({ length: 20 }, (_, i) => spend.send({ cmd: "pay", url: `https://a.example/${i}` })),
  );
  const took = Date.now() - began;

  assert.equal(replies.filter((reply) => reply["ok"] === true).length, 20, replies.map((r) => r["reason"]).join(", "));
  assert.equal(test402.signatures(), 20);
  assert.ok(took < 20 * roundTrip, `twenty payments took ${took}ms, which is one at a time`);
  spend.close();
});

test("an idle daemon asks the mirror node nothing at all", async (t) => {
  // What the reading loop costs when nothing is happening, measured rather than asserted. The old
  // daemon polled every sixty seconds for ever — about 98 MB a day against the public mirror node
  // to sit doing nothing, because each poll was an account read plus a page of the day's rows. The
  // only chain readings now are the ones something caused: one at start-up, one at local midnight,
  // one when a human is looking, and one page behind a payment.
  const test402 = await startTestDaemon(ready(2_000_000n), 10_000n);
  t.after(() => test402.close());

  // The start-up reading: the account, and one walk of the day.
  await sleep(120);
  const afterBoot = test402.mirror.requests.length;
  assert.ok(afterBoot <= 2, `starting up took ${afterBoot} requests`);

  // And then nothing, with nobody connected and nothing being paid.
  await sleep(400);
  assert.equal(test402.mirror.requests.length, afterBoot, "an idle daemon polled the mirror node");
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

test("SECURITY: a restart inside the indexing window does not hand the allowance back", async (t) => {
  // B12, end to end. The reviewed build kept what was in flight in memory only, so this sequence
  // bought a second payment out of an allowance that covers one:
  //
  //   1. pay — signed, and the mirror node has not indexed it yet
  //   2. pay — denied, the allowance is committed
  //   3. restart the daemon
  //   4. pay — PAID, because the new process read a ledger that did not contain (1) and had no
  //      lock to tell it that something was in flight
  //
  // Bound: one extra payment of up to maxPayment, for anyone who can restart the unit — a cached
  // polkit `manage-units` authorization is enough, and `Restart=on-failure` does it unattended.
  // Step 4 must be a denial, and the chain must still show exactly one transaction.
  const test402 = await startTestDaemon(ready(10_000n), 10_000n);
  t.after(() => test402.close());
  test402.mirror.indexing = true;

  const before = await connect(test402.daemon.spendPath);
  assert.equal((await before.send({ cmd: "pay", url: "https://a.example/x" }))["ok"], true);
  const second = await before.send({ cmd: "pay", url: "https://a.example/y" });
  assert.equal(second["ok"], false);
  assert.match(String(second["reason"]), /daily allowance/);
  before.close();

  await test402.restart();

  const after = await connect(test402.daemon.spendPath);
  const third = await after.send({ cmd: "pay", url: "https://a.example/z" });
  assert.equal(third["ok"], false, "a restart inside the indexing window authorised a second payment");
  assert.match(String(third["reason"]), /daily allowance/);
  // The new daemon read the amount off disk and counted it, before the chain could tell it anything.
  const resumed = (await after.send({ cmd: "purse" })) as Record<string, any>;
  assert.equal(resumed["assets"].usdc.spent, "10000");
  // One signature across both daemons, and one transaction in the mirror node's whole world.
  assert.equal(test402.signatures(), 1);
  assert.equal(test402.mirror.rows.length + test402.mirror.held.length, 1);

  // And once the chain shows the payment the figure is the same figure, now with the chain behind
  // it rather than the file — which is what makes the file safe to be as short-lived as it is.
  test402.mirror.indexing = false;
  test402.mirror.catchUp();
  const fourth = await after.send({ cmd: "pay", url: "https://a.example/w" });
  assert.equal(fourth["ok"], false, String(fourth["reason"]));
  assert.match(String(fourth["reason"]), /daily allowance/);
  after.close();
});

test("a restart after the transaction can no longer settle gives the allowance back", async (t) => {
  // The other half of the same fix, and the half it would be easy to break: a payment that never
  // reached consensus must not cost the allowance for ever. The deadline is
  // `validStart + TransactionValidDuration + the indexing margin`, and it is honoured across a
  // restart in both directions — counted while it is in the future, gone the moment it is not, with
  // nothing asked of the mirror node to conclude it.
  const test402 = await startTestDaemon(ready(10_000n), 10_000n);
  t.after(() => test402.close());
  test402.mirror.indexing = true;

  const before = await connect(test402.daemon.spendPath);
  assert.equal((await before.send({ cmd: "pay", url: "https://a.example/x" }))["ok"], true);
  before.close();

  // Wind the entry past its deadline by rewriting the file the way two minutes of waiting would
  // have left it. Nothing else changes: same daemon state, same mirror still holding the row.
  const path = join(test402.stateDir, "inflight.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as { accountId: string; entries: Record<string, unknown>[] };
  writeFileSync(
    path,
    JSON.stringify({ ...file, entries: file.entries.map((entry) => ({ ...entry, deadline: Date.now() - 1 })) }),
  );

  await test402.restart();
  const after = await connect(test402.daemon.spendPath);
  const next = await after.send({ cmd: "pay", url: "https://a.example/y" });
  assert.equal(next["ok"], true, `a payment that can never settle cost the allowance: ${String(next["reason"])}`);
  after.close();
});
