// What the purse keeps, and — more to the point — what it does not. The interesting assertions
// in this file are negative ones: there is no spending in purse.json, there is no way to write
// any, and the labels that do survive cannot reach a number.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Purse, snapshot } from "../src/purse.ts";
import { dayEnd } from "../src/policy.ts";
import { NOW, ledger, scratch, testnet } from "./support.ts";

function open(dir: string): Purse {
  return Purse.open(join(dir, "purse.json"));
}

const identity = { accountId: "0.0.10193689", accountWithChecksum: "0.0.10193689-wkdxo", evmAddress: null, verified: null };

test("a machine with no purse.json starts paused and cannot spend a cent", () => {
  const purse = open(scratch());
  assert.equal(purse.state.paused, true);
  assert.equal(purse.state.usdc.allowance, 0n);
  assert.equal(purse.state.hbar.allowance, 0n);
  assert.equal(purse.state.usdc.maxPayment, 0n);
});

test("an unparseable purse.json is a refusal to start, not a default", () => {
  const dir = scratch();
  writeFileSync(join(dir, "purse.json"), "{ this is not json");
  assert.throws(() => open(dir));
});

test("a purse.json with a hand-edited limit that is not an integer is refused", () => {
  const dir = scratch();
  writeFileSync(join(dir, "purse.json"), JSON.stringify({ paused: false, usdc: { allowance: "2.00" } }));
  assert.throws(() => open(dir), /not an integer amount/);
});

test("purse.json holds policy and labels, and nothing that bounds spending", () => {
  // The whole rewrite, as a shape assertion. A number here that says what was spent is a second
  // copy of something the chain already knows, and a second copy is a second answer.
  const dir = scratch();
  const purse = open(dir);
  purse.setPaused(false);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.setLimit("usdc", "maxPayment", 250_000n);
  purse.label("0.0.9185802@1.0", "a.example");

  const written = JSON.parse(readFileSync(join(dir, "purse.json"), "utf8")) as Record<string, any>;
  assert.deepEqual(Object.keys(written).sort(), ["hbar", "labels", "paused", "usdc"]);
  assert.deepEqual(Object.keys(written["usdc"]).sort(), ["allowance", "maxPayment"]);
  assert.deepEqual(written["labels"], [{ txId: "0.0.9185802@1.0", host: "a.example" }]);
  assert.doesNotMatch(JSON.stringify(written), /spent|receipt|balance|resetsAt|settl/i);
});

test("there is no local spending state anywhere in src/", () => {
  // The grep the plan is written around, as a test. `spentToday` was the counter and `receipts`
  // was the list; `annotate` and `confirm` were the machinery for arguing with them. If any of
  // them comes back, so does the drift.
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));
  for (const name of files) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /spentToday|\breceipts\b|\bannotate\b/, `${name} keeps a spending ledger`);
  }
  // And in the purse itself, no number moves at all: every field it holds is assigned outright
  // by root over the admin socket, or read whole from the chain.
  const purse = readFileSync(new URL("../src/purse.ts", import.meta.url), "utf8");
  assert.doesNotMatch(purse, /[+\-]=/, "the purse does arithmetic on something it keeps");
});

test("nothing restored from disk carries a fact about the chain", () => {
  const dir = scratch();
  const purse = open(dir);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.observe(ledger({ spent: { usdc: 999_000n, hbar: 0n } }), true);
  purse.beginSettling("0.0.9185802@1.0", Date.now());

  const reloaded = open(dir);
  assert.equal(reloaded.state.usdc.allowance, 2_000_000n, "the limit is policy and survives");
  assert.equal(reloaded.state.ledger, null, "a restarted daemon must ask the chain again");
  assert.equal(reloaded.state.mismatch, false);
  assert.equal(reloaded.state.settling, null);
});

test("a label is decoration: it names a host and reaches nothing", () => {
  const purse = open(scratch());
  purse.label("0.0.9185802@1.0", "a.example");
  purse.label("0.0.9185802@2.0", "b.example");
  assert.equal(purse.hostFor("0.0.9185802@1.0"), "a.example");
  assert.equal(purse.hostFor("0.0.9185802@9.9"), null, "an unlabelled payment is not an error");
  // Re-labelling the same id replaces rather than accumulates.
  purse.label("0.0.9185802@1.0", "c.example");
  assert.equal(purse.labels.length, 2);
  assert.equal(purse.hostFor("0.0.9185802@1.0"), "c.example");
});

test("labels are bounded, so a busy day cannot grow the file without limit", () => {
  const purse = open(scratch());
  for (let i = 0; i < 250; i++) purse.label(`0.0.9185802@${i}.0`, `host${i}.example`);
  assert.equal(purse.labels.length, 100);
  assert.equal(purse.hostFor("0.0.9185802@249.0"), "host249.example");
  assert.equal(purse.hostFor("0.0.9185802@1.0"), null, "the oldest labels are dropped");
});

test("the lane closes on a signature and only the chain or the clock opens it", () => {
  const purse = open(scratch());
  assert.equal(purse.state.settling, null);
  const validStart = 1_800_000_000_000;
  purse.beginSettling("0.0.9185802@1800000000.0", validStart);
  const settling = purse.state.settling as { txId: string | null; deadline: number } | null;
  assert.equal(settling?.txId, "0.0.9185802@1800000000.0");
  // 120 seconds, because that is Hedera's TransactionValidDuration and not a number we chose.
  assert.equal(settling?.deadline, validStart + 120_000);
  purse.finishSettling();
  assert.equal(purse.state.settling, null);
});

test("the snapshot the panel sees is the chain's answer, with no key material in it", () => {
  const purse = open(scratch());
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.observe(
    ledger({
      balances: { usdc: 4_120_000n, hbar: 1_000_000_000n },
      spent: { usdc: 1_620_000n, hbar: 0n },
      payments: [{ txId: "0.0.7162784@1787718561.825914914", at: NOW, asset: "usdc", amount: 1_600_000n, payTo: "0.0.9584959" }],
    }),
    false,
  );
  purse.label("0.0.7162784@1787718561.825914914", "printwright.liftbyai.com");

  const frame = snapshot(purse, testnet, identity, NOW) as Record<string, any>;
  assert.equal(frame["type"], "status");
  assert.equal(frame["assets"].usdc.balance, "4120000");
  assert.equal(frame["assets"].usdc.spent, "1620000");
  assert.equal(frame["assets"].hbar.spent, "0");
  assert.equal(frame["assets"].usdc.payments.length, 1);
  assert.equal(frame["assets"].usdc.payments[0].host, "printwright.liftbyai.com");
  assert.equal(frame["assets"].usdc.payments[0].payTo, "0.0.9584959");
  assert.equal(frame["assets"].hbar.payments.length, 0, "a USDC payment appeared in the HBAR view");
  assert.equal(frame["resetsAt"], dayEnd(NOW));
  assert.deepEqual(frame["assets"].usdc.allowancePresets, testnet.assets.usdc.allowancePresets);
  // Nothing key-shaped, said precisely rather than by banning the word "key" — the frame has to
  // carry `keyMismatch` so the panel can explain a refusal. A DER private key is 96 hex
  // characters and the longest legitimate string in here is a forty-character EVM address.
  const text = JSON.stringify(frame);
  assert.doesNotMatch(text, /privateKey|302e0201|-----BEGIN/i);
  assert.doesNotMatch(text, /[0-9a-f]{60,}/i, "something key-shaped reached the panel");
});

test("before the chain has answered the snapshot says so rather than showing a zero", () => {
  const purse = open(scratch());
  const frame = snapshot(purse, testnet, identity, NOW) as Record<string, any>;
  assert.equal(frame["chainAt"], 0);
  assert.equal(frame["assets"].usdc.payments.length, 0);
});

test("a truncated temp file never becomes the purse", () => {
  // writeAtomic writes purse.json.tmp and then renames. A crash mid-write leaves the debris, and
  // the real file is whatever it was before — never half of the new one.
  const dir = scratch();
  const purse = open(dir);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  writeFileSync(join(dir, "purse.json.tmp"), '{"paused":false,"usdc":{"allo');
  const reloaded = open(dir);
  assert.equal(reloaded.state.usdc.allowance, 2_000_000n);
});

test("a purse.json too large to be limits is refused rather than read", () => {
  const dir = scratch();
  writeFileSync(join(dir, "purse.json"), JSON.stringify({ paused: true, pad: "x".repeat(300 * 1024) }));
  assert.throws(() => open(dir), /too large/);
});

test("the purse still writes under node --permission, which forbids fsync", () => {
  // A regression guard for a bug that only showed up on the installed service: the daemon runs
  // under `node --permission`, which disables every fsync entry point outright, and the kill
  // switch itself is a purse write — so a throwing fsync meant `pause` failed and the big red
  // button did nothing. Run in a real subprocess under the real flag, because a mock of the
  // permission model would have been written from the same wrong assumption as the bug.
  const dir = scratch();
  const script = join(dir, "write.ts");
  const target = join(dir, "purse.json");
  const repo = new URL("../", import.meta.url).pathname;
  writeFileSync(
    script,
    `import { writeAtomic } from "${repo}src/safe.ts";\nwriteAtomic(${JSON.stringify(target)}, '{"ok":true}\\n');\n`,
  );
  execFileSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${repo}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, script],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
});
