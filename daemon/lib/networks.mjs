// Flipping this to true plus funding an account is the entire mainnet delta. Everything
// below is written to be correct on mainnet already.
export const MAINNET_SHIPPED = false;
export const HBAR = "0.0.0";

export const NETWORKS = {
  "hedera:testnet": {
    id: "hedera:testnet",
    usdc: "0.0.429274",
    usdcDecimals: 6,
    hbarDecimals: 8,
    facilitator: "https://x402.org/facilitator",
    feePayer: "0.0.9185802",
    mirror: "https://testnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/testnet",
    faucetHbar: "https://portal.hedera.com/faucet",
    defaultDailyMicro: "10000000",
    defaultPerRequestMicro: "1000000",
    defaultMaxFloatUsdcMicro: "20000000",
    defaultMaxFloatHbarTinybars: "2000000000",
    hbarDustTinybars: "50000000",
    allowWildcardHosts: true,
  },
  "hedera:mainnet": {
    id: "hedera:mainnet",
    usdc: "0.0.456858",
    usdcDecimals: 6,
    hbarDecimals: 8,
    // Verified live 2026-08-24: /supported advertises x402Version 2, scheme exact,
    // network hedera:mainnet, extra.feePayer 0.0.10571514. The fee payer is discovered at
    // runtime from that endpoint and deliberately not pinned here.
    facilitator: "https://api.blocky402.com",
    feePayer: "",
    mirror: "https://mainnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/mainnet",
    faucetHbar: "",
    defaultDailyMicro: "1000000",
    defaultPerRequestMicro: "100000",
    defaultMaxFloatUsdcMicro: "5000000",
    defaultMaxFloatHbarTinybars: "500000000",
    hbarDustTinybars: "50000000",
    allowWildcardHosts: false,
  },
};

export const TESTNET = NETWORKS["hedera:testnet"];
export const MAINNET = NETWORKS["hedera:mainnet"];

// USDC only. HBAR invoices are denominated in tinybars while every cap in this build is in
// micro-USDC, so admitting an HBAR `accepts[]` entry would compare units that differ by 10^2
// per unit. signExactTransfer still knows how to build an HBAR transfer, but nothing selects
// one until the caps are made asset-denominated.
export function isSpendAsset(asset, profile = TESTNET) {
  return String(asset || "") === profile.usdc;
}

export function isKnownAsset(asset, profile = TESTNET) {
  const value = String(asset || "");
  return value === HBAR || value === profile.usdc;
}

export function requestedNetworkId(raw) {
  const value = String(raw || "").trim();
  if (!value) return TESTNET.id;
  if (value === "testnet" || value === "hedera:testnet") return "hedera:testnet";
  if (value === "mainnet" || value === "hedera:mainnet") return "hedera:mainnet";
  return value;
}

export function mainnetBlockedMessage() {
  return "hedera:mainnet is not enabled in this build (MAINNET_SHIPPED=false). chip402 ships testnet only.";
}

export function resolveNetwork(raw) {
  const id = requestedNetworkId(raw);
  const profile = NETWORKS[id];
  if (!profile) {
    throw new Error(`Unknown network: ${raw || id}`);
  }
  if (profile.id === "hedera:mainnet" && !MAINNET_SHIPPED) {
    const error = new Error(mainnetBlockedMessage());
    error.code = "mainnet_disabled";
    throw error;
  }
  return profile;
}

// Profile lookup that does not enforce the mainnet gate, for code that has to describe a
// network it will never spend on (docs, the panel, the network command).
export function describeNetwork(raw) {
  const id = requestedNetworkId(raw);
  return NETWORKS[id] || null;
}
