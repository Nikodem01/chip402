import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_SCHEMA, migrateState, trimLedger, writeJsonAtomic } from "./state.mjs";

test("the tinybar-era fields are deleted, not carried into a USDC ledger", () => {
  const legacy = {
    balanceTinybars: "100",
    spentTodayTinybars: "5",
    dailyCapTinybars: "100000000",
    perRequestTinybars: "10000000",
    ledger: [{ id: "1", amountTinybars: "12345678", status: "settled" }],
  };
  const migrated = migrateState(legacy);
  for (const field of ["balanceTinybars", "spentTodayTinybars", "dailyCapTinybars", "perRequestTinybars"]) {
    assert.equal(field in migrated, false, `${field} survived the migration`);
  }
  assert.equal("amountTinybars" in migrated.ledger[0], false, "an HBAR amount would render as USDC");
  assert.equal(migrated.ledger[0].amountMicro, "0");
  assert.equal(migrated.ledger[0].kind, "payment");
  assert.equal(migrated.schema, STATE_SCHEMA);
});

test("migration is a one-shot: an already-migrated state is left alone", () => {
  const current = { schema: STATE_SCHEMA, ledger: [{ id: "1", amountMicro: "10", kind: "payment" }], balanceMicro: "7" };
  const migrated = migrateState(current);
  assert.equal(migrated.balanceMicro, "7");
  assert.deepEqual(migrated.ledger, current.ledger);
});

test("truncation never drops a pending row — it is the only record of money in flight", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: String(i),
    status: i % 25 === 0 ? "pending" : "settled",
  }));
  const kept = trimLedger(rows, 50);
  assert.equal(kept.length, 50);
  assert.equal(kept.filter((row) => row.status === "pending").length, 4);
  for (const row of rows.filter((r) => r.status === "pending")) {
    assert.ok(kept.includes(row), `pending row ${row.id} was dropped`);
  }
});

test("state is written atomically at the mode it was asked for", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-write-"));
  const file = path.join(dir, "state.json");
  await writeJsonAtomic(file, { a: 1 }, 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await writeJsonAtomic(file, { a: 2 }, 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "a rewrite must not widen the file");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).a, 2);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
    "no temporary file left behind",
  );
});
