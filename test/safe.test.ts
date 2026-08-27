// The two contracts in `src/safe.ts`, tested as the opposites they are.
//
// `readSecret` is the strictest function in the project — it is the one that reads the key — and
// until now it was the only one with no test at all. Its two guards are argued for carefully in
// comments and were asserted nowhere: the `O_NOFOLLOW` that makes the check race-free, and the
// `mode & 0o007` that deliberately ignores the group bit because a systemd credential arrives
// `0440` plus an ACL. That second one is easy to "fix" into a `mode & 0o077` that refuses to start
// against a real credential, so it is pinned here in both directions.
//
// `readTail` is the other contract: it has no failure that stops a caller. The path that had never
// been exercised is the interesting one — a file bigger than the cap, read from the end, with the
// first and probably-partial line dropped rather than parsed as half a name.

import { chmodSync, closeSync, mkdirSync, openSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_JSON_BYTES, credentialPath, readJson, readSecret, readTail, removeFile, writeAtomic } from "../src/safe.ts";
import { scratch } from "./support.ts";

// A real DER-encoded ECDSA private key is 96 hex characters behind a short prefix. Nothing here
// is a key — this is the public half of the test account, reused only for its shape.
const KEYISH = "3030020100300706052b8104000a04220420" + "b".repeat(64);

// A fresh name each time, and the mode applied afterwards: `writeFileSync`'s mode option only
// applies when it creates the file, and a 0400 file cannot be written over to set up the next case.
let written = 0;
function secretAt(dir: string, mode: number, body = KEYISH + "\n"): string {
  const path = join(dir, `chip402-key-${written++}`);
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

// --- readSecret: the strict end ----------------------------------------------------------------

test("readSecret reads the key and trims what the file adds", () => {
  const dir = scratch();
  assert.equal(readSecret(secretAt(dir, 0o400, `  ${KEYISH}\n\n`)), KEYISH);
});

test("SECURITY: readSecret does not follow a symlink", () => {
  // The reason the check is on the descriptor and not on the path: stat-then-open is a race a
  // symlink wins, and the thing on the other end of a swapped link is a key an attacker chose.
  // O_NOFOLLOW makes the open itself refuse, so there is no window to win.
  const dir = scratch();
  const real = secretAt(dir, 0o400);
  const link = join(dir, "link-to-key");
  symlinkSync(real, link);
  assert.throws(() => readSecret(link), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ELOOP", `a symlink was followed (${error.code})`);
    return true;
  });
  // And the file it pointed at still reads, so this is the link being refused and not the key.
  assert.equal(readSecret(real), KEYISH);
});

test("SECURITY: readSecret refuses anything that is not a regular file", () => {
  // A directory opens perfectly well for reading on Linux; the fstat is what catches it. Same
  // check that would catch a device node or a socket left where the credential should be.
  const dir = scratch();
  mkdirSync(join(dir, "chip402-key"));
  assert.throws(() => readSecret(join(dir, "chip402-key")), /not a regular file/);
});

test("SECURITY: readSecret refuses a key anything else can read", () => {
  // The bit that must never be set. All three of the world bits are refused, because "world
  // executable" on a key file is not a thing that happens by accident either.
  const dir = scratch();
  for (const mode of [0o404, 0o406, 0o444, 0o604, 0o777, 0o401]) {
    assert.throws(() => readSecret(secretAt(dir, mode)), /world-readable/, `mode ${mode.toString(8)}`);
  }
});

test("SECURITY: readSecret accepts the group bit, because a systemd credential has one", () => {
  // Deliberate, and the thing most likely to be "tidied" into a `mode & 0o077` by someone reading
  // the line above out of context. systemd lays a decrypted credential out as 0440 root:root plus
  // an ACL granting the service user read — and an ACL shows up in the group class of the mode, so
  // a group-bit test reads a perfectly correct credential as world-readable and the daemon refuses
  // to start. The real boundary is the directory it lives in: 0550 on a tmpfs, same ACL, nothing
  // outside this uid can reach either.
  const dir = scratch();
  for (const mode of [0o440, 0o640, 0o460, 0o400, 0o600]) {
    assert.equal(readSecret(secretAt(dir, mode)), KEYISH, `mode ${mode.toString(8)} was refused`);
  }
});

test("readSecret refuses a file too large to be a key", () => {
  // Not a security boundary so much as a refusal to turn a wrong path into a memory spike.
  const dir = scratch();
  assert.throws(() => readSecret(secretAt(dir, 0o400, "x".repeat(5000))), /too large to be a key/);
});

test("readSecret refuses a file that is not there at all", () => {
  assert.throws(() => readSecret(join(scratch(), "absent")), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });
});

// The ownership guard — `info.uid !== 0 && info.uid !== uid` — is the one branch this file cannot
// reach: making a file owned by a third uid needs root, and a test suite that needs root is a test
// suite that does not run. What is checked here is that the two ownerships it must accept do work,
// since everything above is written by this uid. Root ownership is exercised by the daemon itself
// on every start, against a credential systemd writes as root — see README, "Key custody".

test("credentialPath refuses to guess where a credential is", () => {
  // There is no default and no setting: if systemd did not hand us a credentials directory then
  // nothing decrypted a key, and inventing a path is how you end up reading a key somebody else
  // supplied.
  const before = process.env["CREDENTIALS_DIRECTORY"];
  try {
    delete process.env["CREDENTIALS_DIRECTORY"];
    assert.throws(() => credentialPath("chip402-key"), /LoadCredentialEncrypted/);
    process.env["CREDENTIALS_DIRECTORY"] = "/run/credentials/chip402.service";
    assert.equal(credentialPath("chip402-key"), "/run/credentials/chip402.service/chip402-key");
  } finally {
    if (before === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
    else process.env["CREDENTIALS_DIRECTORY"] = before;
  }
});

// --- readTail: the forgiving end ----------------------------------------------------------------

const LINE = (i: number): string => `{"txId":"0.0.9185802@${String(i).padStart(9, "0")}.0","host":"h${String(i).padStart(9, "0")}.example"}\n`;

test("readTail reads a big file from the end and drops the half-line it lands in", () => {
  // The path nothing exercised: `length < info.size`, so the read starts in the middle of the file
  // and the first line is very probably half of one. Dropping it is the difference between losing
  // a name and inventing one.
  const dir = scratch();
  const path = join(dir, "labels.jsonl");
  const width = LINE(0).length;
  const count = 400;
  writeFileSync(path, Array.from({ length: count }, (_, i) => LINE(i)).join(""));
  const size = statSync(path).size;
  assert.equal(size, width * count);

  // A cap that deliberately lands in the middle of a line rather than on a boundary.
  const cap = width * 100 + Math.floor(width / 2);
  const lines = readTail(path, cap);
  const ids = lines.map((line) => (JSON.parse(line) as { txId: string }).txId);

  // Nothing partial survived: every line that came back parses, and the newest is the last one.
  assert.equal(ids.at(-1), `0.0.9185802@${String(count - 1).padStart(9, "0")}.0`);
  // The line the read started inside was dropped, and the one after it was not.
  const straddled = count - 101;
  assert.ok(!ids.includes(`0.0.9185802@${String(straddled).padStart(9, "0")}.0`), "a half-line was kept");
  assert.ok(ids.includes(`0.0.9185802@${String(straddled + 1).padStart(9, "0")}.0`), "a whole line was dropped");
  assert.equal(lines.length, 100);
});

test("readTail reads the whole of a file that fits, and keeps the first line", () => {
  const dir = scratch();
  const path = join(dir, "labels.jsonl");
  writeFileSync(path, LINE(1) + LINE(2) + LINE(3));
  assert.equal(readTail(path, 1024).length, 3);
  // Exactly at the boundary is "fits", not "does not".
  assert.equal(readTail(path, statSync(path).size).length, 3);
  // One byte short of it is not, and costs exactly the first line.
  assert.equal(readTail(path, statSync(path).size - 1).length, 2);
});

test("readTail has no failure that reaches a caller", () => {
  const dir = scratch();
  assert.deepEqual(readTail(join(dir, "absent"), 1024), [], "a missing file was not an empty list");
  mkdirSync(join(dir, "a-directory"));
  assert.deepEqual(readTail(join(dir, "a-directory"), 1024), [], "a directory was not an empty list");
  writeFileSync(join(dir, "empty"), "");
  assert.deepEqual(readTail(join(dir, "empty"), 1024), []);
  writeFileSync(join(dir, "no-newline"), '{"txId":"0.0.1@1.0","host":"a.example"}');
  assert.equal(readTail(join(dir, "no-newline"), 1024).length, 1, "a file with no trailing newline lost its line");
});

// --- the rest of the strict end ------------------------------------------------------------------

test("readJson tells a missing file apart from an unreadable one", () => {
  // The distinction the limits rest on: absent is "never configured", and everything else is a
  // refusal to start rather than a default.
  const dir = scratch();
  assert.equal(readJson(join(dir, "absent")), undefined);
  writeFileSync(join(dir, "broken.json"), "{ not json");
  assert.throws(() => readJson(join(dir, "broken.json")));
  mkdirSync(join(dir, "a-directory"));
  assert.throws(() => readJson(join(dir, "a-directory")), /not a regular file/);
  writeFileSync(join(dir, "huge.json"), JSON.stringify({ pad: "x".repeat(MAX_JSON_BYTES) }));
  assert.throws(() => readJson(join(dir, "huge.json")), /too large/);
});

test("writeAtomic leaves the old file behind rather than half of a new one", () => {
  const dir = scratch();
  const path = join(dir, "purse.json");
  writeAtomic(path, '{"paused":true}\n');
  assert.equal(statSync(path).mode & 0o777, 0o600, "state was written readable by somebody else");
  writeAtomic(path, '{"paused":false}\n');
  assert.equal((readJson(path) as Record<string, unknown>)["paused"], false);
  // And it cannot write at all if it cannot create its temp file, which is what makes the rename
  // the only thing that ever changes the real path.
  mkdirSync(path + ".tmp");
  assert.throws(() => writeAtomic(path, '{"paused":true}\n'));
  assert.equal((readJson(path) as Record<string, unknown>)["paused"], false, "a failed write changed the file");
});

test("removeFile never refuses, because the lane it releases reopens on the clock anyway", () => {
  const dir = scratch();
  removeFile(join(dir, "absent"));
  const path = join(dir, "settling.json");
  writeFileSync(path, "{}");
  removeFile(path);
  assert.equal(readJson(path), undefined);
  // A directory in the way is a file that will not go, and it is still not an error here.
  mkdirSync(join(dir, "stuck"));
  writeFileSync(join(dir, "stuck", "child"), "x");
  removeFile(join(dir, "stuck"));
});

// A descriptor left open by a failing readSecret would be a leak in the process that holds the
// key, so the closes are asserted rather than assumed.
test("readSecret closes the descriptor it opened, on every path", () => {
  const dir = scratch();
  const before = openSync(secretAt(dir, 0o400), "r");
  closeSync(before);
  for (let i = 0; i < 200; i++) {
    try {
      readSecret(secretAt(dir, 0o404));
    } catch {
      // The refusal is the point of the loop; the leak would be the cost of it.
    }
  }
  const after = openSync(secretAt(dir, 0o400), "r");
  closeSync(after);
  // File descriptors are handed out lowest-first, so a leak of two hundred shows up here as a
  // number two hundred higher than the one we started with.
  assert.ok(after - before < 50, `readSecret leaked descriptors: ${before} then ${after}`);
});
