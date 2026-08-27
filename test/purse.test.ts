// What the purse keeps, and — more to the point — what it does not. The interesting assertions
// in this file are negative ones: there is no spending in purse.json, there is no way to write
// any, and the labels that do survive cannot reach a number.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Purse, snapshot } from "../src/purse.ts";
import { dayEnd } from "../src/policy.ts";
import { INDEXING_MARGIN_MS, VALID_DURATION_MS } from "../src/chain.ts";

// How long a lock may last: the chain's own validity window plus the margin the mirror node is
// allowed to be behind it. Taken from the constants rather than written out, so the two cannot
// drift apart the way a hand-copied 120_000 would.
const LOCK_DURATION = VALID_DURATION_MS + INDEXING_MARGIN_MS;
import { NOW, OUR_EVM_ADDRESS, OUR_PUBLIC_KEY, OUR_ACCOUNT, fakeMirror, labelStore, ledger, scratch, sleep, testnet } from "./support.ts";
import { refresh } from "../src/wallet.ts";
import { dayStart } from "../src/policy.ts";

function open(dir: string): Purse {
  return Purse.open(join(dir, "purse.json"));
}

const identity = { accountId: "0.0.10193689", accountWithChecksum: "0.0.10193689-wkdxo", evmAddress: null, verified: null };
const labels = labelStore();

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

test("purse.json holds policy and nothing else at all", () => {
  // The whole rewrite, as a shape assertion. A number here that says what was spent is a second
  // copy of something the chain already knows, and a second copy is a second answer. Host names
  // are gone too — not because they are a copy of anything, but because a file that must refuse
  // to start when it cannot be read may not also hold something that grows. See labels.test.ts.
  const dir = scratch();
  const purse = open(dir);
  purse.setPaused(false);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.setLimit("usdc", "maxPayment", 250_000n);

  const written = JSON.parse(readFileSync(join(dir, "purse.json"), "utf8")) as Record<string, any>;
  assert.deepEqual(Object.keys(written).sort(), ["hbar", "paused", "usdc"]);
  assert.deepEqual(Object.keys(written["usdc"]).sort(), ["allowance", "maxPayment"]);
  assert.doesNotMatch(JSON.stringify(written), /spent|receipt|balel|balance|resetsAt|settl|label|host/i);
  // Four numbers, a flag, and room to spare inside what the daemon will agree to read.
  assert.ok(readFileSync(join(dir, "purse.json"), "utf8").length < 400);
});

test("there is no local spending state anywhere in src/", () => {
  // The grep the plan is written around, as a test. `spentToday` was the counter; `annotate` and
  // `confirm` were the machinery for arguing with it. If any of them comes back, so does the
  // drift. The word `receipts` is deliberately not banned — purse.ts reads that field exactly
  // once, to lift host labels out of a file written by the previous build, and the shape test
  // above is what proves it is never written back.
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));
  for (const name of files) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /spentToday|\bannotate\b|\bconfirm\(/, `${name} keeps a spending ledger`);
  }
  // And in the purse itself, no number moves at all: every field it holds is assigned outright
  // by root over the admin socket, or read whole from the chain.
  const purse = readFileSync(new URL("../src/purse.ts", import.meta.url), "utf8");
  assert.doesNotMatch(purse, /[+\-]=/, "the purse does arithmetic on something it keeps");
  // Exactly one read of the legacy shape, and it is the label migration.
  assert.equal((purse.match(/"receipts"/g) ?? []).length, 1, "purse.ts touches the old receipts list more than once");
});

test("nothing restored from disk carries a fact about the chain", () => {
  const dir = scratch();
  const purse = open(dir);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.observe(ledger({ spent: { usdc: 999_000n, hbar: 0n } }), true);
  purse.beginSettling("0.0.9185802@1800000000.0", Date.now());

  const reloaded = open(dir);
  assert.equal(reloaded.state.usdc.allowance, 2_000_000n, "the limit is policy and survives");
  assert.equal(reloaded.state.ledger, null, "a restarted daemon must ask the chain again");
  assert.equal(reloaded.state.mismatch, false);

  // The lock does survive — that is B12 — and it is the one exception, so it is worth saying
  // exactly what it is allowed to carry. A transaction id and a deadline: what we authorised and
  // when it stops being able to happen. Not what it moved, not whether it did, not a balance and
  // not a running total. Every number the chain owns is still asked for again.
  const settling = reloaded.state.settling as Record<string, unknown> | null;
  assert.notEqual(settling, null, "a restart handed back the allowance");

  // Read off the *file*, not off `state.settling`. That distinction is the whole assertion:
  // `readLock` builds a fresh `{ txId, deadline }` whatever it finds, so checking the object's key
  // set proves only that readLock is readLock. Adding a `units` field to what `beginSettling`
  // writes left the entire suite green — an amount reaching disk and surviving a restart, with the
  // one test that exists to forbid it passing. The word list below is a second net, not the net.
  const onDisk = readFileSync(join(dir, "settling.json"), "utf8");
  const written = JSON.parse(onDisk) as Record<string, unknown>;
  assert.deepEqual(Object.keys(written).sort(), ["deadline", "txId"], "the lock file grew a field");
  assert.equal(typeof written["txId"], "string");
  assert.equal(typeof written["deadline"], "number");
  assert.doesNotMatch(onDisk, /amount|spent|balance|usdc|hbar|paid|settled/i, "the lock is a ledger");
  assert.ok(onDisk.length < 120, "the lock is bigger than a lock needs to be");
});

test("SECURITY: a reading that was overtaken cannot displace the one that overtook it", async (t) => {
  // The invariant the settling lock protects, reached from the other side — after the lock has
  // legitimately opened. `refresh` has three callers and nothing orders them: the chain-poll loop,
  // which is deliberately outside the payment lane, and both ends of a payment. So the last to
  // *complete* used to win rather than the last to start, and a read issued before a payment
  // settled could displace one issued after it — arriving with a timestamp seconds old and a
  // `spent` that predates the payment. Every check in `decide` passes on that, and the day's
  // allowance is charged once for two payments.
  //
  // Both halves are needed and both are exercised here: `Ledger.at` is stamped when the requests go
  // out rather than when they land, and `observe` refuses a reading older than the one it holds.
  const mirror = await fakeMirror();
  t.after(() => mirror.close());
  const walletConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const purse = open(scratch());

  // One reading issued now, with the balances leg held back so it cannot land for a while.
  mirror.accountsDelayMs = 500;
  const overtaken = refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  await sleep(80);

  // A payment settles, and a second reading is issued and served while the first is still in the
  // air. This is the one that tells the truth.
  mirror.accountsDelayMs = 0;
  mirror.record("0.0.9185802@1800000042.0", "usdc", 10_000n, dayStart(Date.now()) + 1_000);
  const current = await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS);
  assert.equal(current.spent.usdc, 10_000n, "the fixture did not produce a reading that saw the payment");
  assert.equal(purse.observe(current, false), true);

  // And now the first one lands, later, knowing less.
  const stale = await overtaken;
  assert.equal(stale.spent.usdc, 0n, "the fixture did not produce an overtaken reading");
  assert.ok(stale.at < current.at, "`at` is stamped on arrival, so a slow read looks fresher than it is");
  assert.equal(purse.observe(stale, false), false, "a reading issued earlier displaced a newer one");
  assert.equal(purse.state.ledger?.spent.usdc, 10_000n, "the purse forgot a payment that had settled");
});

test("the lock the restart honours is the lock, and nothing longer", () => {
  // The restored deadline is the one thing a corrupt file could use to wedge the purse for ever,
  // so it is clamped rather than trusted: a genuine deadline is `validStart + 120s` and validStart
  // is always in the past by the time it is written, so anything past `now + 120s` is damage.
  const dir = scratch();
  const lock = join(dir, "settling.json");
  const far = Date.now() + 400 * 24 * 3600 * 1000;
  writeFileSync(lock, JSON.stringify({ txId: "0.0.9185802@1800000000.0", deadline: far }));
  const held = open(dir).state.settling!;
  assert.ok(held.deadline <= Date.now() + LOCK_DURATION, "a garbled deadline wedged the purse");
  assert.ok(held.deadline > Date.now());

  // And a deadline that has already passed is not a lock at all: the transaction can no longer
  // reach consensus, which is the same exit the running daemon takes on the clock.
  writeFileSync(lock, JSON.stringify({ txId: "0.0.9185802@1800000000.0", deadline: Date.now() - 1 }));
  assert.equal(open(dir).state.settling, null, "an expired lock outlived the transaction it named");
});

test("a lock we cannot read is a lock we honour", () => {
  // Fail-closed, and bounded: the file is unreadable, so we do not know whether anything is in
  // flight — and "assume nothing is" is the reading that authorises a second payment. Holding
  // costs at most TransactionValidDuration of denial, after which the clock opens the lane with
  // no file involved at all.
  for (const damage of ["{ not json", '"a string"', "", "[1,2,3]", '{"txId":"0.0.1@1.0"}', '{"deadline":"soon"}']) {
    const dir = scratch();
    writeFileSync(join(dir, "settling.json"), damage);
    const held = open(dir).state.settling;
    assert.notEqual(held, null, `damage was read as "nothing in flight": ${JSON.stringify(damage)}`);
    assert.ok(held!.deadline > Date.now() && held!.deadline <= Date.now() + LOCK_DURATION);
    // With no id, only the clock can end it — there is nothing to ask the chain about.
    assert.equal(held!.txId, null);
  }
});

test("releasing the lock takes the file with it", () => {
  const dir = scratch();
  const purse = open(dir);
  purse.beginSettling("0.0.9185802@1800000000.0", Date.now());
  assert.ok(existsSync(join(dir, "settling.json")));
  purse.finishSettling();
  assert.equal(existsSync(join(dir, "settling.json")), false, "a released lock still shuts the next daemon's lane");
  assert.equal(open(dir).state.settling, null);
});

test("the lock cannot be taken at all if it cannot be written down", () => {
  // A lock only this process remembers is not a lock. `beginSettling` therefore writes first and
  // sets the field second, and it is allowed to throw — wallet.ts takes it before it reaches the
  // key precisely so that this is a refusal to pay rather than a payment that has already been
  // signed failing on a file operation.
  const dir = scratch();
  const purse = open(dir);
  mkdirSync(join(dir, "settling.json.tmp"));      // writeAtomic cannot create its temp file
  assert.throws(() => purse.beginSettling("0.0.9185802@1800000000.0", Date.now()));
  assert.equal(purse.state.settling, null, "the lane closed on a lock that was never written");
});

test("upgrading from the old build keeps the host names and nothing else", () => {
  // A verbatim excerpt of the purse.json this machine was actually running before the rewrite,
  // wrong ℏ0.02 and all. What survives is the two strings a human reads a row by; the counters,
  // the amounts and the seller's settled claim do not, because the chain answers all three.
  const dir = scratch();
  writeFileSync(
    join(dir, "purse.json"),
    JSON.stringify({
      paused: false,
      resetsAt: 1787754600000,
      usdc: {
        allowance: "10000000",
        maxPayment: "5000000",
        spentToday: "1620000",
        receipts: [
          { id: 5, at: 1787718566933, host: "printwright.liftbyai.com", url: "https://printwright.liftbyai.com/api/v1/models/8/download", amount: "1600000", txId: "0.0.7162784@1787718561.825914914", settled: true, fresh: true },
        ],
      },
      hbar: {
        allowance: "2500000000",
        maxPayment: "100000000",
        spentToday: "2000000",
        receipts: [
          { id: 1, at: 1787712048202, host: "127.0.0.1:4403", amount: "1000000", txId: "0.0.9185802@1787712043.742467199", settled: true, fresh: true },
        ],
      },
    }),
  );

  const purse = open(dir);
  const carried = Object.fromEntries(purse.legacyLabels.map((l) => [l.txId, l.host]));
  assert.equal(carried["0.0.7162784@1787718561.825914914"], "printwright.liftbyai.com");
  assert.equal(carried["0.0.9185802@1787712043.742467199"], "127.0.0.1:4403");
  // The limits are policy and come across; the ℏ0.02 that was wrong does not exist to come across.
  assert.equal(purse.state.usdc.allowance, 10_000_000n);
  assert.equal(purse.state.hbar.maxPayment, 100_000_000n);
  assert.equal(purse.state.ledger, null, "a spending figure survived the upgrade");

  // And the first write drops the old shape for good.
  purse.persist();
  const written = JSON.parse(readFileSync(join(dir, "purse.json"), "utf8")) as Record<string, any>;
  assert.deepEqual(Object.keys(written).sort(), ["hbar", "paused", "usdc"]);
  assert.doesNotMatch(JSON.stringify(written), /spentToday|receipts|resetsAt|settled|fresh|label|host/);
  // Nothing to carry a second time: the names are the label store's now.
  assert.equal(open(dir).legacyLabels.length, 0);
});

test("the lane closes on a signature and only the chain or the clock opens it", () => {
  const purse = open(scratch());
  assert.equal(purse.state.settling, null);
  const validStart = 1_800_000_000_000;
  purse.beginSettling("0.0.9185802@1800000000.0", validStart);
  const settling = purse.state.settling as { txId: string | null; deadline: number } | null;
  assert.equal(settling?.txId, "0.0.9185802@1800000000.0");
  // 120 seconds because that is Hedera's TransactionValidDuration and not a number we chose, plus
  // the indexing margin — the gap between "the chain can no longer accept it" and "the mirror node
  // can no longer start showing it". Releasing at 120 s exactly would open the lane for the second
  // or three a transaction submitted at the very end of its window takes to appear.
  assert.equal(settling?.deadline, validStart + 120_000 + INDEXING_MARGIN_MS);
  assert.ok(INDEXING_MARGIN_MS > 0, "a zero margin is the bug this line exists for");
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
  labels.record("0.0.7162784@1787718561.825914914", "printwright.liftbyai.com");

  const frame = snapshot(purse, labels, testnet, identity, NOW) as Record<string, any>;
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

test("the frame carries a bounded number of rows, and the sum is not one of them", () => {
  // The panel draws six rows and the CLI five, so a busy day must not push hundreds down the
  // socket on every change. What must never be truncated is the figure: it is summed from every
  // row the chain returned, upstream of this cut.
  const purse = open(scratch());
  const many = Array.from({ length: 200 }, (_, i) => ({
    txId: `0.0.9185802@${1_800_000_000 + i}.0`,
    at: NOW - i * 1000,
    asset: "usdc" as const,
    amount: 1_000n,
    payTo: "0.0.5005",
  }));
  purse.observe(ledger({ payments: many, spent: { usdc: 200_000n, hbar: 0n } }), false);

  const frame = snapshot(purse, labels, testnet, identity, NOW) as Record<string, any>;
  assert.equal(frame["assets"].usdc.payments.length, 20, "the frame is unbounded");
  // Newest first, so a cut keeps the rows a human would actually be shown.
  assert.equal(frame["assets"].usdc.payments[0].txId, many[0]!.txId);
  // And the number the limits are measured against is the whole day, not the twenty.
  assert.equal(frame["assets"].usdc.spent, "200000");
});

test("before the chain has answered the snapshot says so rather than showing a zero", () => {
  const purse = open(scratch());
  const frame = snapshot(purse, labels, testnet, identity, NOW) as Record<string, any>;
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

test("the settling lock is taken and released under node --permission too", () => {
  // The same class of bug as the fsync one below, and the reason this is a subprocess rather than
  // a mock: the lock adds a write and an unlink to the payment path, and the daemon runs under a
  // permission model that disables whole syscall families. A lock that could not be written would
  // refuse every payment; a lock that could not be removed would deny for two minutes after each
  // one. Both would only ever show on the installed service.
  const dir = scratch();
  const script = join(dir, "lock.ts");
  const repo = new URL("../", import.meta.url).pathname;
  writeFileSync(
    script,
    `import { Purse } from "${repo}src/purse.ts";\n` +
      `const purse = Purse.open(${JSON.stringify(join(dir, "purse.json"))});\n` +
      `purse.beginSettling("0.0.9185802@1800000000.0", Date.now());\n` +
      `if (Purse.open(${JSON.stringify(join(dir, "purse.json"))}).state.settling === null) throw new Error("the lock was not written");\n` +
      `purse.finishSettling();\n` +
      `if (Purse.open(${JSON.stringify(join(dir, "purse.json"))}).state.settling !== null) throw new Error("the lock was not released");\n`,
  );
  execFileSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${repo}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, script],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  assert.equal(existsSync(join(dir, "settling.json")), false);
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
