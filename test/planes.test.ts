// The authority proof. Two real listeners on temp paths — no install, no key, no network — and
// every way an agent might try to talk itself onto the control plane. If this file passes, the
// sentence "authority is which socket accepted the connection" is true rather than intended.

import { statSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_VERBS, SPEND_VERBS, verbsFor } from "../src/protocol.ts";
import type { Purse } from "../src/purse.ts";
import { connect, startTestDaemon } from "./support.ts";

const ready = (purse: Purse) => {
  purse.setPaused(false);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.setLimit("usdc", "maxPayment", 250_000n);
};

test("the two verb sets are disjoint, and pause is the only kill switch on the cheap side", () => {
  const overlap = SPEND_VERBS.filter((verb) => (ADMIN_VERBS as readonly string[]).includes(verb));
  assert.deepEqual(overlap, []);
  assert.ok(SPEND_VERBS.includes("pause"), "anyone must be able to stop the line");
  assert.ok(!(SPEND_VERBS as readonly string[]).includes("resume"), "only a password restarts it");
  assert.deepEqual(verbsFor("spend"), SPEND_VERBS);
  assert.deepEqual(verbsFor("admin"), ADMIN_VERBS);
});

test("every admin verb is an unknown verb on the spend socket", async (t) => {
  const test402 = await startTestDaemon(ready);
  t.after(() => test402.close());
  const { daemon } = test402;
  const spend = await connect(daemon.spendPath);
  for (const verb of ADMIN_VERBS) {
    const reply = await spend.send({ cmd: verb, asset: "usdc", amount: "1000.00" });
    assert.equal(reply["ok"], false, verb);
    assert.match(String(reply["reason"]), new RegExp(`unknown verb ${verb}`));
  }
  spend.close();
});

test("naming your own plane in the message changes nothing", async (t) => {
  // SECURITY: this is the exact frame an agent would send if the plane were a field. It is not
  // ignored-but-parsed — on the spend socket "resume" is simply not a verb that exists.
  const test402 = await startTestDaemon((purse) => {
    ready(purse);
    purse.setPaused(true);
  });
  t.after(() => test402.close());
  const { daemon, reload } = test402;
  const spend = await connect(daemon.spendPath);
  const reply = await spend.send({ cmd: "resume", plane: "admin" });
  assert.equal(reply["ok"], false);
  assert.match(String(reply["reason"]), /unknown verb resume/);
  assert.equal(reload().state.paused, true);
  spend.close();
});

test("no spend verb can move a limit or clear the pause", async (t) => {
  const test402 = await startTestDaemon((purse) => {
    ready(purse);
    purse.setPaused(true);
  });
  t.after(() => test402.close());
  const { daemon, reload } = test402;
  const spend = await connect(daemon.spendPath);
  for (const verb of SPEND_VERBS) {
    await spend.send({ cmd: verb, url: "https://api.example.com/x", asset: "usdc", amount: "1000.00", allowance: "1000.00", paused: false });
  }
  const after = reload().state;
  assert.equal(after.paused, true, "a spend verb un-paused the purse");
  assert.equal(after.usdc.allowance, 2_000_000n, "a spend verb moved the allowance");
  assert.equal(after.usdc.maxPayment, 250_000n, "a spend verb moved the per-payment cap");
  spend.close();
});

test("pause works from the spend socket, and only the admin socket brings it back", async (t) => {
  const test402 = await startTestDaemon(ready);
  t.after(() => test402.close());
  const { daemon, reload } = test402;
  const spend = await connect(daemon.spendPath);
  const admin = await connect(daemon.adminPath);

  assert.equal((await spend.send({ cmd: "pause" }))["ok"], true);
  assert.equal(reload().state.paused, true);
  assert.equal((await spend.send({ cmd: "resume" }))["ok"], false);
  assert.equal(reload().state.paused, true);
  assert.equal((await admin.send({ cmd: "resume" }))["ok"], true);
  assert.equal(reload().state.paused, false);

  spend.close();
  admin.close();
});

test("the admin socket re-tiers limits per asset, in that asset's own units", async (t) => {
  const test402 = await startTestDaemon(ready);
  t.after(() => test402.close());
  const { daemon, reload } = test402;
  const admin = await connect(daemon.adminPath);
  assert.equal((await admin.send({ cmd: "allowance", asset: "usdc", amount: "5.00" }))["ok"], true);
  assert.equal((await admin.send({ cmd: "max", asset: "hbar", amount: "10" }))["ok"], true);
  const after = reload().state;
  assert.equal(after.usdc.allowance, 5_000_000n);
  assert.equal(after.hbar.maxPayment, 1_000_000_000n);

  // A dollar value where an atomic count belongs, or a currency that does not exist, is a
  // refusal — the admin plane is privileged, not trusting.
  assert.equal((await admin.send({ cmd: "allowance", asset: "eth", amount: "1" }))["ok"], false);
  assert.equal((await admin.send({ cmd: "allowance", asset: "usdc", amount: "1e6" }))["ok"], false);
  admin.close();
});

test("a limit is any amount the asset can express, not just the panel's ladder", async (t) => {
  // The presets are a convenience, never a ceiling — the panel has a free-text field beside them
  // and it sends the same verb. What bounds the number is the asset's own precision.
  const test402 = await startTestDaemon(ready);
  t.after(() => test402.close());
  const { daemon, reload } = test402;
  const admin = await connect(daemon.adminPath);

  for (const [asset, amount, units] of [
    ["usdc", "3.37", 3_370_000n],
    ["usdc", "0.000001", 1n],
    ["usdc", "1234.56", 1_234_560_000n],
    ["hbar", "12.5", 1_250_000_000n],
    ["hbar", "0.00000001", 1n],
  ] as const) {
    assert.equal((await admin.send({ cmd: "allowance", asset, amount }))["ok"], true, amount);
    assert.equal(reload().state[asset].allowance, units, amount);
  }

  // And the things that are not amounts stay refused, whichever box they came from.
  for (const amount of ["1.2345678", "1e6", "-5", "", " 1.00", "$1.00", "one", "0x10", "Infinity"]) {
    assert.equal((await admin.send({ cmd: "allowance", asset: "usdc", amount }))["ok"], false, amount);
  }
  // The last good value stands; a refusal never half-applies.
  assert.equal(reload().state.usdc.allowance, 1_234_560_000n);

  admin.close();
});

test("the socket modes are what the plane split rests on", async (t) => {
  const test402 = await startTestDaemon(ready);
  t.after(() => test402.close());
  const { daemon } = test402;
  // 0660: anything in group chip402 may spend. 0600: uid 1000 cannot even open the admin socket.
  assert.equal(statSync(daemon.spendPath).mode & 0o777, 0o660);
  assert.equal(statSync(daemon.adminPath).mode & 0o777, 0o600);
});

test("garbage on either socket is answered, not crashed on", async (t) => {
  const test402 = await startTestDaemon(ready);
  t.after(() => test402.close());
  const { daemon } = test402;
  const spend = await connect(daemon.spendPath);
  const reply = await spend.send({ cmd: "nonsense" });
  assert.equal(reply["ok"], false);
  // Still alive afterwards.
  assert.equal((await spend.send({ cmd: "purse" }))["type"], "status");
  spend.close();
});
