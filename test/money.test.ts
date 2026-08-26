// Money is the vocabulary everything else is written in, so it gets tested first and hardest.
// The interesting cases are all refusals: a float, a negative, a decimal place the asset does
// not have, and a number too big to ever settle.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UNITS, digits, format, parse, parseUnits } from "../src/money.ts";
import { NETWORKS } from "../src/networks.ts";

const testnet = NETWORKS["hedera:testnet"]!;
const usdc = testnet.assets.usdc;
const hbar = testnet.assets.hbar;

test("parses each asset in its own base units", () => {
  assert.equal(parse("2.00", 6), 2_000_000n);
  assert.equal(parse("0.25", 6), 250_000n);
  assert.equal(parse("10.5", 8), 1_050_000_000n);
  assert.equal(parse("0", 8), 0n);
  assert.equal(parse("100", 8), 10_000_000_000n);
});

test("refuses anything that is not a plain decimal", () => {
  for (const bad of ["1e3", "-1", "0x10", " 2.00", "2.00 ", "", ".5", "2.", "NaN", "Infinity", "1,000", "2.0.0"]) {
    assert.throws(() => parse(bad, 6), new RegExp("not a decimal amount"), `should refuse ${JSON.stringify(bad)}`);
  }
});

test("refuses more decimal places than the asset declares", () => {
  assert.equal(parse("1.123456", 6), 1_123_456n);
  assert.throws(() => parse("1.1234567", 6), /more than 6 decimal places/);
  assert.equal(parse("1.12345678", 8), 112_345_678n);
  assert.throws(() => parse("1.123456789", 8), /more than 8 decimal places/);
});

test("refuses an amount larger than the ledger can hold", () => {
  assert.equal(parseUnits(MAX_UNITS.toString()), MAX_UNITS);
  assert.throws(() => parseUnits((MAX_UNITS + 1n).toString()), /larger than this ledger/);
  assert.throws(() => parse("99999999999999999999", 8), /larger than this ledger/);
});

test("parseUnits takes integers only, because that is what the wire carries", () => {
  assert.equal(parseUnits("2000000"), 2_000_000n);
  for (const bad of ["2.0", "-5", "", "0x1", "1e6"]) {
    assert.throws(() => parseUnits(bad), /not an integer amount/);
  }
});

test("round-trips in both units", () => {
  for (const text of ["0.00", "0.01", "2.00", "1234.56"]) {
    assert.equal(digits(parse(text, usdc.decimals), usdc), Number(text).toFixed(2));
  }
  assert.equal(digits(parse("10.5", 8), hbar), "10.5");
  assert.equal(digits(parse("100", 8), hbar), "100");
  assert.equal(digits(parse("0", 8), hbar), "0");
});

test("formats with the currency a human recognises", () => {
  assert.equal(format(350_000n, usdc), "$0.35");
  assert.equal(format(0n, usdc), "$0.00");
  assert.equal(format(1_250_000_000n, hbar), "ℏ12.5");
  assert.equal(format(0n, hbar), "ℏ0");
});

test("no exported function in money.ts takes two assets at once", () => {
  // SECURITY-adjacent, and the reason chip402 needs no price feed: if no function can see two
  // assets, no function can convert between them, so a stale or hostile exchange rate has
  // nowhere to enter the deny path.
  const source = readFileSync(new URL("../src/money.ts", import.meta.url), "utf8");
  for (const signature of source.matchAll(/export function \w+\(([^)]*)\)/g)) {
    const assets = (signature[1]?.match(/:\s*Asset\b/g) ?? []).length;
    assert.ok(assets <= 1, `two assets in one signature: ${signature[0]}`);
  }
});
