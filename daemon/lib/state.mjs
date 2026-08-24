import fsSync from "node:fs";
import crypto from "node:crypto";
import {
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_ALLOW_HOSTS,
  DEFAULT_DAILY_MICRO,
  DEFAULT_PER_REQUEST_MICRO,
  DEFAULT_PORT,
  KEY_MODE,
  KEY_PATH,
  LEDGER_LIMIT,
  MERCHANT_KEY_PATH,
  STATE_DIR,
  STATE_PATH,
  TOKEN_PATH,
} from "./paths.mjs";
import { TESTNET, resolveNetwork } from "./networks.mjs";
import {
  MAX_SECRET_BYTES,
  ensureOwnedDir,
  readVerified,
  writeVerifiedAtomic,
} from "./safeio.mjs";

export const STATE_SCHEMA = 2;
export const STATE_MODE = 0o600;

// Fields from the pre-USDC build. They are HBAR tinybar amounts and rendering them as
// USDC is off by eight orders of magnitude, so they are deleted rather than carried.
const LEGACY_STATE_FIELDS = [
  "balanceTinybars",
  "spentTodayTinybars",
  "dailyCapTinybars",
  "perRequestTinybars",
  "amountTinybars",
];
const LEGACY_LEDGER_FIELDS = ["amountTinybars"];

export const DEFAULT_CONFIG = {
  network: TESTNET.id,
  accountId: "",
  evmAddress: "",
  merchantAccountId: "",
  merchantEvmAddress: "",
  facilitator: TESTNET.facilitator,
  feePayer: TESTNET.feePayer,
  facilitatorApiKey: "",
  port: DEFAULT_PORT,
  tcp: false,
  asset: TESTNET.usdc,
  hashscan: TESTNET.hashscan,
  caps: {
    dailyMicro: DEFAULT_DAILY_MICRO,
    perRequestMicro: DEFAULT_PER_REQUEST_MICRO,
  },
  maxFloatMicro: TESTNET.defaultMaxFloatUsdcMicro,
  allowHosts: [...DEFAULT_ALLOW_HOSTS],
  paused: false,
};

export function emptyState() {
  return {
    schema: STATE_SCHEMA,
    updatedAt: new Date().toISOString(),
    paused: false,
    configured: false,
    accountId: "",
    evmAddress: "",
    merchantAccountId: "",
    merchantEvmAddress: "",
    balanceMicro: "0",
    balanceAt: "",
    hbarTinybars: "0",
    hollow: null,
    spentTodayMicro: "0",
    spentTodayDate: todayStamp(),
    dailyCapMicro: DEFAULT_DAILY_MICRO,
    perRequestMicro: DEFAULT_PER_REQUEST_MICRO,
    associated: false,
    allowHosts: [...DEFAULT_ALLOW_HOSTS],
    hashscan: TESTNET.hashscan,
    facilitator: TESTNET.facilitator,
    feePayer: "",
    feePayerAt: "",
    facilitatorError: "",
    seenPayees: [],
    lastError: "",
    ledger: [],
  };
}

// Local date on purpose: the panel says "today", and the user's today is the one on their
// wall clock, not UTC. Ledger timestamps stay ISO/UTC.
export function todayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Both directories hold things that are nobody else's business: the key and the API key in
// one, the ledger, the log and the installed runtime in the other. Owner-only, and re-checked
// on the descriptor every time rather than assumed from a mkdir that no-ops when it exists.
export async function ensureDirs() {
  await ensureOwnedDir(CONFIG_DIR);
  await ensureOwnedDir(STATE_DIR);
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readVerified(file));
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await writeVerifiedAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function configuredNetworkId(stored = {}) {
  return process.env.CHIP402_NETWORK || stored.network || TESTNET.id;
}

export async function loadConfig() {
  await ensureDirs();
  const stored = await readJson(CONFIG_PATH, {});
  const profile = resolveNetwork(configuredNetworkId(stored));
  const caps = stored.caps && typeof stored.caps === "object" ? stored.caps : {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    network: profile.id,
    facilitator: stored.facilitator || profile.facilitator,
    // The pinned fee payer is only ever a hint for the panel. Spend decisions compare the
    // invoice against the value discovered from /supported.
    feePayer: stored.feePayer || profile.feePayer,
    facilitatorApiKey: String(stored.facilitatorApiKey || ""),
    asset: stored.asset || profile.usdc,
    hashscan: profile.hashscan,
    tcp: stored.tcp === true,
    caps: {
      dailyMicro: String(caps.dailyMicro ?? profile.defaultDailyMicro ?? DEFAULT_CONFIG.caps.dailyMicro),
      perRequestMicro: String(
        caps.perRequestMicro ?? profile.defaultPerRequestMicro ?? DEFAULT_CONFIG.caps.perRequestMicro,
      ),
    },
    maxFloatMicro: String(stored.maxFloatMicro ?? profile.defaultMaxFloatUsdcMicro),
    allowHosts: Array.isArray(stored.allowHosts)
      ? stored.allowHosts.map(String)
      : [...DEFAULT_ALLOW_HOSTS],
    paused: stored.paused === true,
  };
}

export async function saveConfig(config) {
  await ensureDirs();
  await writeJsonAtomic(CONFIG_PATH, config, 0o600);
}

export function migrateState(stored = {}) {
  const state = { ...emptyState(), ...stored };
  if (Number(stored.schema || 0) >= STATE_SCHEMA) {
    state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
    return state;
  }
  for (const field of LEGACY_STATE_FIELDS) delete state[field];
  state.ledger = (Array.isArray(state.ledger) ? state.ledger : []).map((row) => {
    const next = { ...row };
    for (const field of LEGACY_LEDGER_FIELDS) delete next[field];
    if (next.amountMicro == null) next.amountMicro = "0";
    if (!next.kind) next.kind = "payment";
    return next;
  });
  state.schema = STATE_SCHEMA;
  return state;
}

export async function loadState() {
  await ensureDirs();
  const stored = await readJson(STATE_PATH, emptyState());
  const state = migrateState(stored);
  if (state.spentTodayDate !== todayStamp()) {
    state.spentTodayMicro = "0";
    state.spentTodayDate = todayStamp();
  }
  if (!Array.isArray(state.ledger)) state.ledger = [];
  if (!Array.isArray(state.seenPayees)) state.seenPayees = [];
  return state;
}

// Truncation must never drop a `pending` row: that row is the only record that money may
// be in flight, and losing it means the crash reconciler cannot find it.
export function trimLedger(ledger, limit = LEDGER_LIMIT) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const pending = rows.filter((row) => row && row.status === "pending");
  const rest = rows.filter((row) => !row || row.status !== "pending");
  const keep = rest.slice(0, Math.max(0, limit - pending.length));
  const kept = new Set([...pending, ...keep]);
  return rows.filter((row) => kept.has(row));
}

export async function saveState(state) {
  await ensureDirs();
  const next = {
    ...state,
    schema: STATE_SCHEMA,
    updatedAt: new Date().toISOString(),
    ledger: trimLedger(state.ledger),
  };
  await writeJsonAtomic(STATE_PATH, next, STATE_MODE);
  return next;
}

export function ledgerId() {
  return crypto.randomUUID();
}

// The mode is asserted on the same descriptor the bytes are read from, so there is no window
// between "this file is 600 and mine" and "these are its contents".
export async function readKeyFile(file = KEY_PATH) {
  const raw = (await readVerified(file, { maxBytes: MAX_SECRET_BYTES, exactMode: KEY_MODE })).trim();
  if (!raw) throw new Error(`Key file is empty: ${file}`);
  return raw;
}

export async function writeKeyFile(file, contents) {
  await ensureDirs();
  await writeVerifiedAtomic(file, `${String(contents).trim()}\n`, KEY_MODE);
}

// Same treatment as the key: the mode is asserted on the descriptor the bytes come from.
export async function readTokenFile(file = TOKEN_PATH) {
  const raw = (await readVerified(file, { maxBytes: MAX_SECRET_BYTES, exactMode: KEY_MODE })).trim();
  if (!raw) throw new Error(`Token file is empty: ${file}`);
  return raw;
}

export function keyExists(file = KEY_PATH) {
  return fsSync.existsSync(file);
}

export { KEY_PATH, MERCHANT_KEY_PATH, STATE_PATH, CONFIG_PATH };
