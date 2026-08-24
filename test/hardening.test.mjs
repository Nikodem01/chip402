// The defects a marketplace security review blocks on are the ones nobody notices while the
// happy path keeps working. These are the invariants that keep them from coming back.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readVerified, writeVerifiedAtomic, ensureOwnedDir } from "../daemon/lib/safeio.mjs";
import { forwardableHeaders } from "../daemon/lib/policy.mjs";
import Model from "../Model.js";

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "chip402-hardening-"));
}

test("a symlink standing where a state file should be is refused, not followed", async () => {
  const dir = await tmpdir();
  const secret = path.join(dir, "elsewhere");
  await fs.writeFile(secret, "not yours", { mode: 0o600 });
  const link = path.join(dir, "state.json");
  await fs.symlink(secret, link);
  await assert.rejects(() => readVerified(link), (err) => err.code === "ELOOP" || err.code === "unsafe_file");
});

test("a file larger than the ceiling is refused before it is read", async () => {
  const dir = await tmpdir();
  const file = path.join(dir, "state.json");
  await fs.writeFile(file, "x".repeat(5_000), { mode: 0o600 });
  await assert.rejects(() => readVerified(file, { maxBytes: 1_000 }), (err) => err.code === "unsafe_file");
});

test("a secret whose mode has drifted looser than 600 is refused", async () => {
  const dir = await tmpdir();
  const file = path.join(dir, "key");
  await fs.writeFile(file, "secret\n", { mode: 0o644 });
  await assert.rejects(
    () => readVerified(file, { exactMode: 0o600 }),
    (err) => err.code === "unsafe_file" && /need 600/.test(err.message),
  );
});

test("a write lands at its mode, atomically, leaving no temporary file behind", async () => {
  const dir = await tmpdir();
  const file = path.join(dir, "key");
  await writeVerifiedAtomic(file, "material\n", 0o600);
  const st = await fs.stat(file);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(await readVerified(file, { exactMode: 0o600 }), "material\n");
  assert.deepEqual((await fs.readdir(dir)).sort(), ["key"]);
});

test("a state directory is owner-only even when it already existed wide open", async () => {
  const dir = await tmpdir();
  const state = path.join(dir, "state");
  await fs.mkdir(state, { mode: 0o755 });
  await fs.chmod(state, 0o755);
  await ensureOwnedDir(state);
  assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
});

test("headers that carry an identity are never forwarded to a seller", () => {
  const out = forwardableHeaders({
    Authorization: "Bearer sk-live-secret",
    Cookie: "session=abc",
    "Proxy-Authorization": "Basic xyz",
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  assert.deepEqual(out, { "content-type": "application/json", accept: "application/json" });
});

test("a header value carrying a newline is dropped rather than split into two headers", () => {
  assert.deepEqual(forwardableHeaders({ accept: "application/json\r\nX-Injected: 1" }), {});
});

test("the panel caps how many ledger rows it will render", () => {
  const rows = Array.from({ length: 500 }, () => ({ status: "settled", host: "seller.example" }));
  assert.equal(Model.parseState(JSON.stringify({ ledger: rows })).ledger.length, 50);
});

test("markup-shaped text from a seller cannot reach a Text item as markup", () => {
  const state = Model.parseState(JSON.stringify({ lastError: '<img src="https://tracker.example/x">' }));
  assert.equal(state.lastError.indexOf("<"), -1);
  assert.equal(state.lastError.indexOf(">"), -1);
});

test("an explorer base that is not https produces no link at all", () => {
  assert.equal(Model.hashscanTx("0.0.1@1.2", "javascript:alert(1)"), "");
  assert.equal(Model.hashscanTx("0.0.1@1.2", "file:///etc"), "");
  assert.equal(
    Model.hashscanTx("0.0.1@1.2", "https://hashscan.io/testnet"),
    "https://hashscan.io/testnet/transaction/0.0.1%401.2",
  );
});

test("pending money is added as integers, so a large invoice does not round", () => {
  const rows = [
    { status: "pending", amountMicro: "9007199254740993" },
    { status: "pending", amountMicro: "9007199254740993" },
  ];
  assert.equal(Model.parseState(JSON.stringify({ ledger: rows })).pendingMicro, "18014398509481986");
});

test("the daemon's own pending total is preferred over re-adding it in the panel", () => {
  const state = Model.parseState(
    JSON.stringify({ pendingMicro: "4242", ledger: [{ status: "pending", amountMicro: "99" }] }),
  );
  assert.equal(state.pendingMicro, "4242");
});
