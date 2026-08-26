// Money, as integers. Every amount in chip402 is a bigint count of the asset's smallest unit —
// micro-USDC or tinybars — because 0.1 + 0.2 is 0.30000000000000004 in a float and a purse
// cannot absorb that. Nothing in this file converts between two assets, which is the reason
// chip402 needs no price feed anywhere.

import type { Asset } from "./networks.ts";

// Hedera transfer amounts are signed 64-bit on the wire, so anything past this could never
// settle. Refusing it here means an absurd invoice is a parse error, not a policy near-miss.
export const MAX_UNITS = (1n << 63n) - 1n;

// Digits, optionally a single dot, and nothing else. This is what rejects "1e3", "-1", "0x10",
// " 2.00 ", "Infinity" and "NaN" in one line — a hostile seller does not get to pick the
// spelling of a number we are about to sign for.
const DECIMAL = /^\d+(?:\.\d+)?$/;

// "2.00" at 6 decimals is 2_000_000n; "10.5" at 8 is 1_050_000_000n. More decimals than the
// asset declares is a refusal rather than a rounding, because rounding money silently is how
// you end up paying a cent you never agreed to.
export function parse(text: string, decimals: number): bigint {
  if (typeof text !== "string" || !DECIMAL.test(text)) {
    throw new Error(`not a decimal amount: ${JSON.stringify(text)}`);
  }
  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${text} has more than ${decimals} decimal places`);
  }
  const units = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (units > MAX_UNITS) throw new Error(`${text} is larger than this ledger can hold`);
  return units;
}

// The other direction, for anything that arrives as an already-atomic string: `amount` in a
// seller's payment requirements, and our own state file. Same bounds, no decimal point allowed.
export function parseUnits(text: string): bigint {
  if (typeof text !== "string" || !/^\d+$/.test(text)) {
    throw new Error(`not an integer amount: ${JSON.stringify(text)}`);
  }
  const units = BigInt(text);
  if (units > MAX_UNITS) throw new Error(`${text} is larger than this ledger can hold`);
  return units;
}

// The number a human reads, without the symbol: 2_000_000n at 6 decimals is "2.00". Trailing
// zeros are trimmed down to the asset's floor so USDC always looks like money and HBAR does not
// print eight decimals nobody asked for.
export function digits(units: bigint, asset: Asset): string {
  if (units < 0n) throw new Error("amounts are never negative");
  const scale = 10n ** BigInt(asset.decimals);
  const whole = (units / scale).toString();
  let fraction = (units % scale).toString().padStart(asset.decimals, "0");
  while (fraction.length > asset.minDisplayDecimals && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

// The same number with its currency on the front, which is what the panel and the CLI print.
export function format(units: bigint, asset: Asset): string {
  return asset.prefix + digits(units, asset);
}
