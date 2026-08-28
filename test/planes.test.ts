// The authority proof. Two real listeners on temp paths — no install, no key, no network — and
// every way an agent might try to talk itself onto the control plane. If this file passes, the
// sentence "authority is which socket accepted the connection" is true rather than intended.

import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_VERBS, RUNTIME_DIR, SPEND_VERBS, verbsFor } from "../src/protocol.ts";
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

test("the runtime directory is 0750 whatever the umask says", async (t) => {
  // The unit sets UMask=0077, and `mkdirSync(…, { mode })` is subject to it — so the mkdir alone
  // produces 0700 and the group cannot reach spend.sock at all. In production the directory is
  // already there, created by `RuntimeDirectory=chip402` at 0750 before node starts, so nothing
  // ever showed; off that path the comment was simply wrong. Run under the unit's own umask so
  // this is the daemon's doing and not the test runner's.
  const umask = process.umask(0o077);
  try {
    const test402 = await startTestDaemon(ready);
    t.after(() => test402.close());
    const dir = dirname(test402.daemon.spendPath);
    assert.equal(statSync(dir).mode & 0o777, 0o750, "the group cannot walk in to reach the sockets");
    // And the group still cannot create or unlink anything in it, which is what stops the socket
    // from being deleted to force a fallback path.
    assert.equal(statSync(dir).mode & 0o020, 0, "the group can write in the runtime directory");
  } finally {
    process.umask(umask);
  }
});

test("the panel and the daemon agree where the sockets are", () => {
  // `/run/chip402` was written out five times. Four of them are one constant now; the fifth is in
  // QML, which cannot import it, so it is checked here rather than kept in step by hand.
  const qml = readFileSync(new URL("../ui/Purse.qml", import.meta.url), "utf8");
  const declared = /property string spendSocket: "([^"]+)"/.exec(qml)?.[1];
  assert.equal(declared, `${RUNTIME_DIR}/spend.sock`, "the panel looks for the socket somewhere else");
  // And nothing else in src/ or bin/ spells the directory out any more.
  for (const name of ["../src/daemon.ts", "../bin/mcp.ts", "../bin/chip402.ts", "../bin/chip402ctl.ts"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /"\/run\/chip402/, `${name} carries its own copy of the runtime directory`);
  }
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

// --- the privileged surface the panel can reach -----------------------------------------------

// Everything the panel can hand to pkexec, read out of the QML rather than listed by hand — a
// list written by hand is a list that goes stale the moment somebody adds a button.
function panelVerbs(): { verbs: string[]; rawPkexec: string[] } {
  const source = readFileSync(new URL("../ui/Purse.qml", import.meta.url), "utf8");
  // `authorise([...])` is the one sanctioned route: pkexec chip402ctl <verb> ...
  const verbs = [...source.matchAll(/authorise\(\s*\[\s*"([a-z]+)"/g)].map((m) => m[1]!);
  // And any other pkexec command assembled anywhere in the file.
  const rawPkexec = [...source.matchAll(/\[\s*"pkexec"\s*,([^\]]*)\]/g)].map((m) => m[1]!.trim());
  return { verbs, rawPkexec };
}

function policyActions(): Map<string, { path: string; argv1: string; message: string; defaults: string[] }> {
  const xml = readFileSync(new URL("../ui/chip402.policy", import.meta.url), "utf8");
  const actions = new Map<string, { path: string; argv1: string; message: string; defaults: string[] }>();
  for (const block of xml.split("<action ").slice(1)) {
    const id = /id="([^"]+)"/.exec(block)?.[1] ?? "";
    actions.set(id, {
      path: /exec\.path">([^<]+)</.exec(block)?.[1] ?? "",
      argv1: /exec\.argv1">([^<]+)</.exec(block)?.[1] ?? "",
      message: /<message>([^<]*)<\/message>/.exec(block)?.[1] ?? "",
      defaults: [...block.matchAll(/<allow_\w+>([^<]+)<\/allow_\w+>/g)].map((m) => m[1]!),
    });
  }
  return actions;
}

test("every privileged thing the panel can ask for has a polkit action that says what it is", () => {
  // SECURITY: this is the test that would have caught a real one. The START button ran
  // `pkexec systemctl start chip402`, which matches none of our actions — so polkit fell back to
  // org.freedesktop.policykit.exec and asked "Authentication is required to run a program as
  // another user". That caption says nothing about chip402 and reads identically to `pkexec` of
  // anything at all, which is exactly the cover a malicious prompt wants. The defence of a
  // human-judgment boundary is that an unexpected dialog is recognisable; a dialog that explains
  // nothing is not.
  const { verbs, rawPkexec } = panelVerbs();
  const actions = policyActions();
  assert.ok(verbs.length > 0, "no privileged verbs found in the panel at all");

  for (const verb of verbs) {
    const action = actions.get(`dev.chip402.${verb}`);
    assert.ok(action, `the panel can ask for "${verb}" and no polkit action declares it`);
    assert.equal(action.path, "/usr/local/bin/chip402ctl", `${verb} is not bound to the root-owned binary`);
    assert.equal(action.argv1, verb);
    // A caption a human can act on, naming chip402 rather than "a program".
    assert.match(action.message, /chip402/, `the dialog for "${verb}" does not name chip402`);
    assert.ok(action.message.length > 40, `the dialog for "${verb}" explains nothing`);
  }

  // And only that one route exists: no pkexec anywhere in the panel that runs something else.
  for (const command of rawPkexec) {
    assert.match(command, /chip402ctl/, `the panel hands pkexec something that is not chip402ctl: ${command}`);
  }
});

test("every prose that counts the polkit actions counts the ones that are there", () => {
  // install.sh and the README both describe this surface in words, and the description is the
  // only thing a reader has before they open the XML. It said "three" for a while after `start`
  // was added — a small drift, and exactly the kind that makes the rest of the document harder
  // to trust. Counted rather than proof-read, so adding a fifth action fails here.
  const spelled: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const actual = policyActions().size;
  for (const name of ["../install.sh", "../README.md"]) {
    const text = readFileSync(new URL(name, import.meta.url), "utf8");
    const counts = [...text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+) polkit action/gi)];
    assert.ok(counts.length > 0, `${name} never says how many polkit actions there are`);
    for (const [phrase, word] of counts) {
      const claimed = spelled[String(word).toLowerCase()] ?? Number(word);
      assert.equal(claimed, actual, `${name} says "${phrase}" and ui/chip402.policy declares ${actual}`);
    }
  }
});

test("no chip402 action is auth_admin_keep, so none of them can be silently reused", () => {
  // The one thing that must never be reusable is the authority to raise a cap. systemd's own
  // manage-units action is auth_admin_keep, which is why a cached authorization can stop the
  // daemon without a second prompt — fail-closed, and the reason chip402's own verbs do not
  // borrow that setting.
  const actions = policyActions();
  assert.ok(actions.size >= 4);
  for (const [id, action] of actions) {
    assert.equal(action.defaults.length, 3, `${id} does not state all three defaults`);
    for (const value of action.defaults) {
      assert.equal(value, "auth_admin", `${id} allows ${value} — a cap change must prompt every time`);
    }
  }
});

test("a definite key mismatch hides the address the panel would ask you to fund", () => {
  // SECURITY, and a claim the README makes that nothing checked. Money sent to an account this key
  // does not control is money nobody can move, so on a positively-parsed, positively *different*
  // key the top-up block is not shown at all and no QR is rendered. "We could not tell" is `null`
  // and must still show the address — hiding a working purse's top-up over an unrecognised key
  // shape would be the larger failure, and it is the same three-state rule `readKeyMatch` keeps.
  //
  // Asserted against the source rather than against a running panel: `ui/Chip.qml` needs Omarchy's
  // own shell components to load at all, so there is no standalone harness for it the way there is
  // for `ui/Purse.qml`. What that buys is a guard on the binding itself — the check being deleted,
  // or quietly turned into a truthy test that a `null` would also fail, fails here.
  const qml = readFileSync(new URL("../ui/Chip.qml", import.meta.url), "utf8");
  const gates = qml
    .split("\n")
    .filter((line) => line.includes("accountVerified") && !line.trim().startsWith("//"))
    .map((line) => line.trim());
  assert.ok(gates.length >= 2, "the funding block and the QR are not both gated on accountVerified");
  for (const gate of gates) {
    // Either direction is fine — the funding block shows on `!== false`, `makeQr()` bails on
    // `=== false`. What is not fine is a truthy test, which would also hide a purse whose key
    // shape we simply could not read.
    assert.match(gate, /accountVerified\s*(!==|===)\s*false/, `a truthy test would also hide it on null: ${gate}`);
  }
  // And the row that is gated is the one carrying the address and the QR.
  const funding = qml.slice(qml.indexOf("visible: purse.accountVerified !== false"));
  assert.match(funding.slice(0, 4000), /evmAddress|qrPath|accountWithChecksum/, "the gated block is not the funding block");
});

test("the panel cannot reach an admin verb or spend money without going through pkexec", () => {
  // What the panel may write straight down the socket. This used to pin the list at exactly
  // `pause`, which was the whole set at the time and so could not say which part of it mattered;
  // adding `purse` — a read the daemon already pushes to this panel unasked — failed it for no
  // security reason. So the invariant is stated instead of the inventory:
  //
  //   - never an admin verb. Those cost a polkit password and go out as `pkexec chip402ctl …`,
  //     and the daemon would not accept one on this socket anyway. Belt and braces, on purpose:
  //     the panel asking is meant to be impossible, not merely absent.
  //   - never `pay`. The daemon *would* honour it — the panel holds the spend socket, which is
  //     the point of the spend socket — so this is the only line stopping a status widget from
  //     being able to spend money. It is a guard on us, not on an attacker: anything that can
  //     write to that socket can already pay without editing this file.
  //
  // What is left is the free half of the spend plane: ask what the purse says, and stop it.
  const source = readFileSync(new URL("../ui/Purse.qml", import.meta.url), "utf8");
  const written = [...source.matchAll(/write\(JSON\.stringify\(\{\s*cmd:\s*"([a-z]+)"/g)].map((m) => m[1]!);
  assert.ok(written.length > 0, "the panel no longer writes to the socket at all");
  for (const verb of written) {
    assert.ok(SPEND_VERBS.includes(verb as never), `the panel writes ${verb}, which is not a spend verb`);
    assert.notEqual(verb, "pay", "the panel writes `pay` straight to the socket");
  }
});
