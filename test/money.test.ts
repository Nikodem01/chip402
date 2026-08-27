// Money is the vocabulary everything else is written in, so it gets tested first and hardest.
// The interesting cases are all refusals: a float, a negative, a decimal place the asset does
// not have, and a number too big to ever settle.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UNITS, digits, format, parse, parseUnits } from "../src/money.ts";
import { ASSET_KEYS, NETWORKS } from "../src/networks.ts";

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

// --- the same rule, in the other language -------------------------------------------------------

test("the panel formats money exactly as money.ts does", () => {
  // `digits()`/`format()` here and `money()` in ui/Purse.qml implement one trimming rule twice,
  // because QML cannot import TypeScript. The duplication is unavoidable; the drift is not. The
  // QML function is ordinary ECMAScript, so it is lifted out of the shipping file and run against
  // the shipping formatter over the values where the two could plausibly disagree.
  const qml = readFileSync(new URL("../ui/Purse.qml", import.meta.url), "utf8");
  const source = /\n  function money\(units, asset\) \{\n([\s\S]*?)\n  \}\n/.exec(qml);
  assert.ok(source, "ui/Purse.qml no longer has a money() to compare against");
  // eslint-disable-next-line no-new-func -- the point of this test is to run the panel's own code
  const panelMoney = new Function("units", "asset", source[1]!) as (units: unknown, asset: unknown) => string;

  // The asset as it crosses the socket: the panel is handed the decimals and the symbol and never
  // hardcodes either, so this is the same object `snapshot` sends.
  const wire = (asset: (typeof testnet.assets)["usdc"]) => ({
    decimals: asset.decimals,
    minDisplayDecimals: asset.minDisplayDecimals,
    prefix: asset.prefix,
  });

  const interesting = [
    0n, 1n, 9n, 10n, 99n, 100n, 999n, 1_000n, 9_999n, 10_000n, 100_000n,
    350_000n, 1_000_000n, 1_600_000n, 2_000_000n, 12_500_000n, 17_150_000n,
    99_999_999n, 100_000_000n, 2_500_000_000n, 51_347_384n, 999_999_999_999n,
  ];
  for (const key of ASSET_KEYS) {
    const asset = testnet.assets[key];
    for (const units of interesting) {
      assert.equal(
        panelMoney(units.toString(), wire(asset)),
        format(units, asset),
        `${key} disagrees at ${units} base units`,
      );
    }
    // And the two shapes the socket can legitimately hand the panel where there is no number yet.
    assert.equal(panelMoney(undefined, wire(asset)), format(0n, asset));
    assert.equal(panelMoney(null, wire(asset)), format(0n, asset));
  }
  // The four the review checked by hand, spelled out so a reader can see they are the ones meant.
  assert.equal(format(0n, testnet.assets.usdc), "$0.00");
  assert.equal(format(350_000n, testnet.assets.usdc), "$0.35");
  assert.equal(format(0n, testnet.assets.hbar), "ℏ0");
  assert.equal(format(1_250_000_000n, testnet.assets.hbar), "ℏ12.5");
});
