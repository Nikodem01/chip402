// What the purse keeps, and — more to the point — what it does not. The interesting assertions
// in this file are negative ones: there is no spending in purse.json, there is no way to write
// any, and the labels that do survive cannot reach a number.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AUTHORIZATION_MS, Purse, snapshot } from "../src/purse.ts";
import { dayEnd } from "../src/policy.ts";
import { INDEXING_MARGIN_MS, VALID_DURATION_MS } from "../src/chain.ts";
import { NOW, OUR_EVM_ADDRESS, OUR_PUBLIC_KEY, OUR_ACCOUNT, config, fakeMirror, invoice, labelStore, ledger, scratch, sleep, testnet } from "./support.ts";
import { refresh } from "../src/wallet.ts";
import { dayStart, decide } from "../src/policy.ts";

function open(dir: string): Purse {
  return Purse.open(join(dir, "purse.json"), OUR_ACCOUNT);
}

const INFLIGHT = "inflight.json";

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
    assert.doesNotMatch(source, /spentToday|\bannotate\b/, `${name} keeps a spending ledger`);
  }
  // The day's figure is written down, deliberately — but only ever to the in-flight file, beside
  // the entries it is the other half of, and never to purse.json, which is policy. `persist` writes
  // purse.json and `#write` writes the other; those two are the only writers in the file, and what
  // each of them writes is checked field by field below.
  const purse = readFileSync(new URL("../src/purse.ts", import.meta.url), "utf8");
  assert.equal((purse.match(/writeAtomic\(/g) ?? []).length, 2, "purse.ts grew a third thing it writes");
  // Exactly one read of the legacy shape, and it is the label migration.
  assert.equal((purse.match(/"receipts"/g) ?? []).length, 1, "purse.ts touches the old receipts list more than once");
});

test("what a restart restores is the day's figure and what is still in the air, and nothing else", () => {
  const dir = scratch();
  const purse = open(dir);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.observe(ledger({ spent: { usdc: 999_000n, hbar: 0n } }, Date.now()), true);
  const entry = purse.authorize("usdc", 10_000n, Date.now());
  purse.identify(entry, "0.0.9185802@1800000000.0", Date.now());

  const reloaded = open(dir);
  assert.equal(reloaded.state.usdc.allowance, 2_000_000n, "the limit is policy and survives");
  assert.equal(reloaded.state.mismatch, false);

  // The balance is the half of a decision that can only come from the chain, so it is the half a
  // restart still has to go and ask for. `policy.decide` refuses to pay without one, which is what
  // keeps this file from becoming a substitute for the ledger rather than a record corrected by it.
  assert.equal(reloaded.state.ledger, null, "a restarted daemon must ask the chain for the balance again");

  // And the figure is the half a restart may remember. Remembering it is what took the boot walk off
  // the critical path: it comes back tagged with the account and the local day, and `policy.decide`
  // checks both again before it will spend against it.
  assert.equal(reloaded.state.spent?.totals.usdc, 999_000n, "a restart handed the day's spending back");
  assert.equal(reloaded.state.spent?.accountId, OUR_ACCOUNT);
  assert.equal(reloaded.state.spent?.dayStart, dayStart(Date.now()));

  // What was in the air stays in the air, carrying what we authorised, in which asset, its id, and
  // the instant it stops being able to happen — and nothing that outlives its own deadline.
  assert.equal(reloaded.state.inFlight.length, 1, "a restart handed back the allowance");
  assert.equal(reloaded.state.inFlight[0]!.amount, 10_000n);

  // Read off the *file*, not off the object. That distinction is the whole assertion: the readers
  // build fresh values whatever they find, so checking the object's keys proves only that the
  // readers are the readers. A field added to what `#write` writes would otherwise reach disk and
  // survive a restart with the one test that exists to bound it passing.
  const written = JSON.parse(readFileSync(join(dir, INFLIGHT), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(written).sort(), ["accountId", "entries", "spent"], "the in-flight file grew a field");
  assert.deepEqual(Object.keys(written["spent"] as object).sort(), ["dayStart", "totals"], "the figure grew a field");
  const rows = written["entries"] as Record<string, unknown>[];
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["amount", "asset", "deadline", "txId"], "an entry grew a field");
  // The negative half, and it is the one that matters now that a figure is allowed on disk: nothing
  // the chain is the only source of may be written down. Not a balance, not a counterparty, not the
  // key check. Those are re-read on every start, never remembered.
  assert.doesNotMatch(readFileSync(join(dir, INFLIGHT), "utf8"), /balance|payTo|verified|mismatch/);
});

test("SECURITY: an in-flight list written for another account is not this purse's to honour", () => {
  // The shape of the previous build's worst bug, refused at the file. It kept a `spent` figure with
  // nothing on it to say whose it was, so `setup --import` walked an older wallet's spending into a
  // fresh account. Here the account is on the file, and a file that names a different one is
  // discarded rather than applied — a figure that cannot be attributed is not a figure.
  const dir = scratch();
  const purse = open(dir);
  purse.authorize("usdc", 10_000n, Date.now());
  assert.equal(Purse.open(join(dir, "purse.json"), "0.0.999999").state.inFlight.length, 0);
  assert.equal(Purse.open(join(dir, "purse.json"), OUR_ACCOUNT).state.inFlight.length, 1);
});

test("what a restart honours is honoured for no longer than it could really have lasted", () => {
  // The restored deadline is the one thing a corrupt file could use to wedge the purse for ever, so
  // it is clamped rather than trusted: a genuine deadline is `validStart + AUTHORIZATION_MS` and
  // validStart is always in the past by the time it is written, so anything beyond `now + that` is
  // damage.
  const dir = scratch();
  const file = join(dir, INFLIGHT);
  const far = Date.now() + 400 * 24 * 3600 * 1000;
  const row = (deadline: number) =>
    JSON.stringify({ accountId: OUR_ACCOUNT, entries: [{ asset: "usdc", amount: "10000", txId: "0.0.9185802@1800000000.0", deadline }] });

  writeFileSync(file, row(far));
  const held = open(dir).state.inFlight[0]!;
  assert.ok(held.deadline <= Date.now() + AUTHORIZATION_MS, "a garbled deadline wedged the purse");
  assert.ok(held.deadline > Date.now());

  // And one that has already passed is not held at all: the transaction can no longer reach
  // consensus, which is the same exit the running daemon takes on the clock.
  writeFileSync(file, row(Date.now() - 1));
  assert.equal(open(dir).state.inFlight.length, 0, "an expired entry outlived the transaction it named");
});

test("a list we cannot read commits everything, for as long as any entry could have lasted", () => {
  // Fail-closed, and bounded. The file is unreadable, so we do not know what is in the air — and
  // "assume nothing is" is the reading that authorises a second payment. Committing the whole
  // allowance costs at most a little over two minutes of denial, after which every entry expires on
  // its own deadline with no file involved at all.
  for (const damage of ["{ not json", '"a string"', "", "[1,2,3]", '{"accountId":"0.0.10193689"}', '{"accountId":"0.0.10193689","entries":[{"asset":"usdc"}]}']) {
    const dir = scratch();
    const purse = open(dir);
    purse.setLimit("usdc", "allowance", 2_000_000n);
    purse.persist();
    writeFileSync(join(dir, INFLIGHT), damage);
    const held = open(dir).state.inFlight;
    assert.ok(held.length > 0, `damage was read as "nothing in flight": ${JSON.stringify(damage)}`);
    const usdc = held.find((entry) => entry.asset === "usdc")!;
    assert.equal(usdc.amount, 2_000_000n, "damage did not commit the whole allowance");
    assert.ok(usdc.deadline > Date.now() && usdc.deadline <= Date.now() + AUTHORIZATION_MS);
    // With no id there is nothing to ask the chain about; only the deadline can end it.
    assert.equal(usdc.txId, null);
  }
});

test("the lock the previous build kept is honoured once and then gone", () => {
  // Upgrading over a daemon that had a payment in the air. The old file carried no amount, so the
  // only safe reading of it is "all of it" — and then it is deleted, because this build never
  // writes one and a file nobody writes is a file nobody should keep reading.
  const dir = scratch();
  const purse = open(dir);
  purse.setLimit("usdc", "allowance", 2_000_000n);
  purse.persist();
  writeFileSync(join(dir, "settling.json"), JSON.stringify({ txId: "0.0.9185802@1800000000.0", deadline: Date.now() + 60_000 }));
  const held = open(dir).state.inFlight;
  assert.equal(held.find((entry) => entry.asset === "usdc")?.amount, 2_000_000n);
  assert.equal(existsSync(join(dir, "settling.json")), false, "the old lock file is still there to be read again");
});

test("answering for a payment moves it out of the list and into the figure, and never leaves it in neither", () => {
  // The two halves of one fact, which is why they share a file and a single write. While the payment
  // is in the air the entry commits the allowance; once the chain has shown it, the figure carries
  // it instead. Persisting those separately would leave an instant where a crash loses it from both
  // — an undercount, and an undercount is how one allowance pays for two payments.
  const dir = scratch();
  const purse = open(dir);
  const entry = purse.authorize("usdc", 10_000n, Date.now());
  assert.ok(existsSync(join(dir, INFLIGHT)));
  assert.equal(purse.state.spent?.totals.usdc, 0n, "the amount entered the figure before the chain answered");

  purse.settled(entry);

  const next = open(dir);
  assert.equal(next.state.inFlight.length, 0, "an answered payment still commits the next daemon's allowance");
  assert.equal(next.state.spent?.totals.usdc, 10_000n, "an answered payment was forgotten by the next daemon");
});

test("nothing may be authorised that cannot be written down", () => {
  // An authorisation only this process remembers is no authorisation at all: the daemon that has to
  // honour it may be the next one. `authorize` therefore writes first and sets the field second, and
  // it is allowed to throw — wallet.ts calls it before it reaches the key precisely so that this is
  // a refusal to pay rather than a payment already signed failing on a file operation.
  const dir = scratch();
  const purse = open(dir);
  mkdirSync(join(dir, `${INFLIGHT}.tmp`));          // writeAtomic cannot create its temp file
  assert.throws(() => purse.authorize("usdc", 10_000n, Date.now()));
  assert.equal(purse.state.inFlight.length, 0, "an amount was committed that was never written");
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

test("an authorisation is answered for by the chain or by its own deadline, and by nothing else", () => {
  const purse = open(scratch());
  purse.observe(ledger(), false);
  assert.equal(purse.state.inFlight.length, 0);
  const validStart = 1_800_000_000_000;
  const entry = purse.authorize("usdc", 10_000n, validStart);
  purse.identify(entry, "0.0.9185802@1800000000.0", validStart);
  assert.equal(entry.txId, "0.0.9185802@1800000000.0");
  // 120 seconds because that is Hedera's TransactionValidDuration and not a number we chose, plus
  // the indexing margin — the gap between "the chain can no longer accept it" and "the mirror node
  // can no longer start showing it". Letting go at 120 s exactly would forget a transaction
  // submitted at the very end of its window for the second or three it takes to appear.
  assert.equal(entry.deadline, validStart + 120_000 + INDEXING_MARGIN_MS);
  assert.ok(INDEXING_MARGIN_MS > 0, "a zero margin is the bug this line exists for");

  // The chain has it. The amount moves out of the air and into the day, and the total does not
  // move — it was already counted the moment it was authorised.
  purse.settled(entry);
  assert.equal(purse.state.inFlight.length, 0);
  assert.equal(purse.state.spent?.totals.usdc, 10_000n);

  // And the other exit gives nothing back, because nothing was taken.
  const lost = purse.authorize("usdc", 50_000n, validStart);
  purse.abandon(lost);
  assert.equal(purse.state.inFlight.length, 0);
  assert.equal(purse.state.spent?.totals.usdc, 10_000n, "a payment that never happened was counted");
});

test("a payment is counted exactly once, whichever of the chain's two answers lands first", () => {
  // Found by a test that expected ten payments out of an allowance for ten and got nine. There are
  // two ways the chain tells us a payment happened — a reading of the day that contains it, and a
  // direct lookup of its id — and they can arrive in either order. Adding the amount on the second
  // one without checking the first charged the day twice for one payment.
  const txId = "0.0.9185802@1800000000.0";
  const row = { txId, at: NOW, asset: "usdc" as const, amount: 10_000n, payTo: "0.0.5005" };

  // The lookup first, then the reading. The reading contains it, so it may only raise to where the
  // lookup already put it.
  const lookupFirst = open(scratch());
  lookupFirst.observe(ledger(), false);
  const one = lookupFirst.authorize("usdc", 10_000n, Date.now());
  lookupFirst.identify(one, txId, Date.now());
  lookupFirst.settled(one);
  assert.equal(lookupFirst.state.spent?.totals.usdc, 10_000n);
  lookupFirst.observe(ledger({ at: NOW + 1, spent: { usdc: 10_000n, hbar: 0n }, payments: [row] }), false);
  assert.equal(lookupFirst.state.spent?.totals.usdc, 10_000n, "the day was charged twice for one payment");

  // The reading first, then the lookup. The lookup finds it already counted and adds nothing.
  const readingFirst = open(scratch());
  readingFirst.observe(ledger(), false);
  const two = readingFirst.authorize("usdc", 10_000n, Date.now());
  readingFirst.identify(two, txId, Date.now());
  readingFirst.observe(ledger({ at: NOW + 1, spent: { usdc: 10_000n, hbar: 0n }, payments: [row] }), false);
  assert.equal(readingFirst.state.spent?.totals.usdc, 10_000n);
  readingFirst.settled(two);
  assert.equal(readingFirst.state.spent?.totals.usdc, 10_000n, "the day was charged twice for one payment");
});

test("a reading may seed a day or raise it, and may never talk it down", () => {
  // The whole of what a chain reading is allowed to do to the figure. It seeds one for an account
  // and a day it has none for — but only if it read the day to the end, because a partial sum is
  // not a day's spending. After that it may only raise: by then this purse knows about payments the
  // mirror node has not indexed yet, and letting a reading lower the figure is how an allowance
  // gets spent twice.
  const purse = open(scratch());
  purse.observe(ledger({ spent: { usdc: 1_000_000n, hbar: 0n } }), false);
  assert.equal(purse.state.spent?.totals.usdc, 1_000_000n);

  purse.observe(ledger({ at: NOW + 1, spent: { usdc: 500_000n, hbar: 0n } }), false);
  assert.equal(purse.state.spent?.totals.usdc, 1_000_000n, "a later reading talked the day down");

  purse.observe(ledger({ at: NOW + 2, spent: { usdc: 1_400_000n, hbar: 0n } }), false);
  assert.equal(purse.state.spent?.totals.usdc, 1_400_000n, "a later reading could not raise the day");

  // A partial walk may not *replace* a figure. It is not a day's spending, and the reading above
  // names a different day from the one this purse is measuring.
  const fresh = open(scratch());
  assert.equal(fresh.state.spent?.totals.usdc, 0n, "a purse with no file on disk has spent nothing today");
  fresh.observe(ledger({ complete: false, spent: { usdc: 900_000n, hbar: 0n } }), false);
  assert.equal(fresh.state.spent?.dayStart, dayStart(Date.now()), "a partial walk replaced the day being measured");
  assert.equal(fresh.state.spent?.totals.usdc, 0n, "a day was seeded from a walk that never reached its end");

  // And where there is genuinely no figure to raise — a file this purse may not trust, which is the
  // case the boot walk still exists for — a partial walk may not seed one either.
  const dir = scratch();
  open(dir).authorize("usdc", 10_000n, Date.now());
  const foreign = Purse.open(join(dir, "purse.json"), "0.0.999999");
  assert.equal(foreign.state.spent, null, "a figure written for another account was adopted");
  foreign.observe(ledger({ complete: false, spent: { usdc: 900_000n, hbar: 0n } }), false);
  assert.equal(foreign.state.spent, null, "a day was seeded from a walk that never reached its end");
});

test("a restored figure is enough to decide against, without a walk that reached the end of the day", () => {
  // Why the figure is written down at all, as one assertion.
  //
  // Its only source used to be a walk of the whole local day, and that walk had to finish before
  // anything could be paid. So the amount of work standing between a restart and a working purse was
  // set by how busy the agent had been — and the busier it was, the likelier the walk was to be too
  // big to finish. A purse for per-request metering could be stopped by being used for per-request
  // metering.
  //
  // Now the figure comes off disk, the reading supplies the balance, and a reading that stopped
  // short costs nothing but the rows it did not fetch.
  const dir = scratch();
  const first = open(dir);
  first.setPaused(false);
  first.setLimit("usdc", "allowance", 2_000_000n);
  first.setLimit("usdc", "maxPayment", 250_000n);
  first.settled(first.authorize("usdc", 1_000_000n, Date.now()));

  const restarted = open(dir);
  assert.equal(restarted.state.spent?.totals.usdc, 1_000_000n, "the restart forgot what it had spent");
  // The only reading it ever gets is one that never reached the end of the day.
  restarted.observe(ledger({ complete: false, spent: { usdc: 0n, hbar: 0n } }, Date.now()), false);
  assert.equal(restarted.state.spent?.totals.usdc, 1_000_000n, "a partial reading talked the restored figure down");

  const allowed = decide(invoice({ amount: 250_000n }), restarted.state, config, Date.now());
  assert.equal(allowed.ok, true, `a restored purse could not pay: ${allowed.ok ? "" : allowed.reason}`);

  // And it is still the *day's* figure being enforced, not a fresh one: what is left is the
  // allowance less what the previous daemon spent, so the restart bought nothing.
  const overDay = decide(invoice({ amount: 1_100_000n }), restarted.state, config, Date.now());
  assert.equal(overDay.ok, false, "a restart handed back the day's allowance");
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

test("an authorisation is written and cleared under node --permission too", () => {
  // The same class of bug as the fsync one below, and the reason this is a subprocess rather than
  // a mock: committing a payment adds a write and an unlink to the payment path, and the daemon
  // runs under a permission model that disables whole syscall families. A write that could not be
  // made would refuse every payment; an unlink that could not be made would commit part of the
  // allowance for two minutes after each one. Both would only ever show on the installed service.
  const dir = scratch();
  const script = join(dir, "lock.ts");
  const repo = new URL("../", import.meta.url).pathname;
  const path = JSON.stringify(join(dir, "purse.json"));
  const account = JSON.stringify(OUR_ACCOUNT);
  writeFileSync(
    script,
    `import { Purse } from "${repo}src/purse.ts";\n` +
      `const purse = Purse.open(${path}, ${account});\n` +
      `const entry = purse.authorize("usdc", 10000n, Date.now());\n` +
      `purse.identify(entry, "0.0.9185802@1800000000.0", Date.now());\n` +
      `if (Purse.open(${path}, ${account}).state.inFlight.length !== 1) throw new Error("the authorisation was not written");\n` +
      `purse.settled(entry);\n` +
      `if (Purse.open(${path}, ${account}).state.inFlight.length !== 0) throw new Error("the authorisation was not cleared");\n`,
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
