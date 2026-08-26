// Everything chip402 knows about the outside world: two networks, and the two assets we can pay
// in on each. This is the mainnet switch — change `network` in /etc/chip402/config.json and the
// row below is what the rest of the daemon reads. There is no `if (mainnet)` anywhere else.

// A key we use internally, so nothing in the code has to say "0.0.429274" to mean "the dollars".
export type AssetKey = "usdc" | "hbar";

export type Asset = {
  readonly key: AssetKey;
  // What the seller writes in `accepts[].asset`. "0.0.0" is x402's spelling of native HBAR.
  readonly id: string;
  // On-chain decimals. USDC declares 6, HBAR 8 — that difference is why money.ts takes a
  // decimals argument instead of assuming one.
  readonly decimals: number;
  readonly symbol: string;
  // What goes in front of the number when a human reads it: "$0.35", "ℏ12.5".
  readonly prefix: string;
  // Fewest decimals to show, so USDC always looks like money and HBAR never looks like a bank
  // statement. Trailing zeros past this are trimmed.
  readonly minDisplayDecimals: number;
  // The panel's preset chips, as decimal strings in the asset's own unit. They live here rather
  // than in the QML so the two currencies can have different ladders and there is one place to
  // tune them. The first allowance preset is "0", which is how an asset is switched off.
  readonly allowancePresets: readonly string[];
  readonly maxPresets: readonly string[];
};

export type NetworkRow = {
  readonly caip2: string;
  readonly label: string;
  // Read-only, and the only host the daemon talks to that is not the seller. Balances come from
  // here; the daemon never opens a connection to a consensus node.
  readonly mirror: string;
  // The explorer for this network, as a base. A payment row appends `transaction/<id>`; the
  // top-up panel appends `account/<id>`, which is how the address it shows can be checked
  // against a source that is not us.
  readonly hashscan: string;
  // Loud in the panel when real money is at stake.
  readonly live: boolean;
  readonly assets: { readonly [K in AssetKey]: Asset };
};

// Ladders, written once because both networks use the same ones — the token ids differ, the
// pocket-money tiers do not.
const USDC_ALLOWANCE = ["0", "1.00", "2.00", "5.00", "10.00"] as const;
const USDC_MAX = ["0.05", "0.25", "1.00", "5.00"] as const;
const HBAR_ALLOWANCE = ["0", "25", "100", "250", "500"] as const;
const HBAR_MAX = ["1", "10", "25", "50"] as const;

// HBAR is the same asset on both networks: native, id "0.0.0", 8 decimals, no association step.
const hbar = (): Asset => ({
  key: "hbar",
  id: "0.0.0",
  decimals: 8,
  symbol: "HBAR",
  prefix: "ℏ",
  minDisplayDecimals: 0,
  allowancePresets: HBAR_ALLOWANCE,
  maxPresets: HBAR_MAX,
});

const usdc = (id: string): Asset => ({
  key: "usdc",
  id,
  decimals: 6,
  symbol: "USDC",
  prefix: "$",
  minDisplayDecimals: 2,
  allowancePresets: USDC_ALLOWANCE,
  maxPresets: USDC_MAX,
});

// The two rows. Token ids and mirror hosts are the SDK's own constants, checked against
// @x402/hedera's src/constants.ts at the pinned version.
export const NETWORKS: Readonly<Record<string, NetworkRow>> = Object.freeze({
  "hedera:testnet": Object.freeze({
    caip2: "hedera:testnet",
    label: "testnet",
    mirror: "https://testnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/testnet/",
    live: false,
    assets: Object.freeze({ usdc: Object.freeze(usdc("0.0.429274")), hbar: Object.freeze(hbar()) }),
  }),
  "hedera:mainnet": Object.freeze({
    caip2: "hedera:mainnet",
    label: "MAINNET",
    mirror: "https://mainnet-public.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/mainnet/",
    live: true,
    assets: Object.freeze({ usdc: Object.freeze(usdc("0.0.456858")), hbar: Object.freeze(hbar()) }),
  }),
});

export const ASSET_KEYS: readonly AssetKey[] = Object.freeze(["usdc", "hbar"]);

// Fail closed: an unknown network name is not a default, it is a refusal to start.
export function networkFor(caip2: string): NetworkRow | undefined {
  return Object.hasOwn(NETWORKS, caip2) ? NETWORKS[caip2] : undefined;
}

// Resolve what the seller asked to be paid in. Anything not in this network's row is refused,
// never converted — a look-alike token id simply does not resolve.
export function assetFor(network: NetworkRow, assetId: string): Asset | undefined {
  for (const key of ASSET_KEYS) {
    const asset = network.assets[key];
    if (asset.id === assetId) return asset;
  }
  return undefined;
}
