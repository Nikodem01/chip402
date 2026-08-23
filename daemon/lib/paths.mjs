import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const CONFIG_DIR = path.join(HOME, ".config", "omarchy-allowance");
export const STATE_DIR = path.join(HOME, ".local", "state", "omarchy-allowance");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const KEY_PATH = path.join(CONFIG_DIR, "key");
export const MERCHANT_KEY_PATH = path.join(CONFIG_DIR, "merchant-key");
export const STATE_PATH = path.join(STATE_DIR, "state.json");
export const RUNTIME_DIR = path.join(STATE_DIR, "runtime");
export const LOG_PATH = path.join(STATE_DIR, "allowanced.log");

export const DEFAULT_PORT = 4402;
export const DEFAULT_SELLER_PORT = 4403;
export const FACILITATOR = "https://x402.org/facilitator";
export const FEE_PAYER = "0.0.9185802";
export const NETWORK = "hedera:testnet";
export const MIRROR = "https://testnet.mirrornode.hedera.com";
export const HASHSCAN = "https://hashscan.io/testnet";
export const HBAR_ASSET = "0.0.0";
export const TINYBARS_PER_HBAR = 100_000_000n;
export const DEFAULT_DAILY_TINYBARS = String(TINYBARS_PER_HBAR); // 1 HBAR
export const DEFAULT_PER_REQUEST_TINYBARS = "10000000"; // 0.1 HBAR
export const DEMO_PRICE_TINYBARS = "1000"; // 0.00001 HBAR
export const LEDGER_LIMIT = 50;
export const KEY_MODE = 0o600;
export const DEFAULT_ALLOW_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
