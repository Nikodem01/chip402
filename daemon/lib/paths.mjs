import os from "node:os";
import path from "node:path";
import { HBAR, TESTNET } from "./networks.mjs";

export const HOME = os.homedir();
// Overridable so a test run, or a second profile, never touches the live config and state.
export const CONFIG_DIR = process.env.CHIP402_CONFIG_DIR || path.join(HOME, ".config", "chip402");
export const STATE_DIR = process.env.CHIP402_STATE_DIR || path.join(HOME, ".local", "state", "chip402");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const KEY_PATH = path.join(CONFIG_DIR, "key");
export const MERCHANT_KEY_PATH = path.join(CONFIG_DIR, "merchant-key");
export const TOKEN_PATH = path.join(CONFIG_DIR, "token");
export const STATE_PATH = path.join(STATE_DIR, "state.json");
export const RUNTIME_DIR = path.join(STATE_DIR, "runtime");
export const LOG_PATH = path.join(STATE_DIR, "chip402d.log");

// The daemon listens on a unix socket by default. Filesystem permissions are the
// authorization boundary, and a browser cannot reach a unix socket, so DNS rebinding
// against the daemon stops being possible.
// $XDG_RUNTIME_DIR is already 0700 and on tmpfs, so it is a second permission boundary the
// socket's own mode does not have to carry alone, and a crash-left socket never survives a
// reboot. The fallback gets its own 0700 subdirectory rather than sitting in the 0755
// state directory.
export const RUNTIME_BASE =
  process.env.XDG_RUNTIME_DIR && path.isAbsolute(process.env.XDG_RUNTIME_DIR)
    ? process.env.XDG_RUNTIME_DIR
    : path.join(STATE_DIR, "run");
export const SOCKET_PATH = process.env.CHIP402_SOCKET || path.join(RUNTIME_BASE, "chip402.sock");
// Linux caps sun_path at 108 bytes including the terminator.
if (Buffer.byteLength(SOCKET_PATH) > 100) {
  throw new Error(`Socket path is too long for a unix socket (${SOCKET_PATH.length} bytes): ${SOCKET_PATH}`);
}

export const DEFAULT_PORT = 4402;
export const DEFAULT_SELLER_PORT = 4403;
export const FACILITATOR = TESTNET.facilitator;
export const FEE_PAYER = TESTNET.feePayer;
export const NETWORK = TESTNET.id;
export const MIRROR = TESTNET.mirror;
export const HASHSCAN = TESTNET.hashscan;
export const HBAR_ASSET = HBAR;
export const USDC_ASSET = TESTNET.usdc;
export const USDC_DECIMALS = 6;
export const USDC_MICRO = 1_000_000n;
export const DEFAULT_DAILY_MICRO = TESTNET.defaultDailyMicro;
export const DEFAULT_PER_REQUEST_MICRO = TESTNET.defaultPerRequestMicro;
export const DEMO_PRICE_MICRO = "10000"; // 0.01 USDC
export const LEDGER_LIMIT = 50;
export const KEY_MODE = 0o600;
export const SOCKET_MODE = 0o600;
export const DEFAULT_ALLOW_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
// A balance read older than this is not evidence of anything. Unknown is never unlimited.
export const BALANCE_MAX_AGE_MS = 120_000;
// Discovered fee payer cache. Short enough that a facilitator key rotation is noticed.
export const FACILITATOR_TTL_MS = 300_000;
