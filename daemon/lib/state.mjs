import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_ALLOW_HOSTS,
  DEFAULT_DAILY_TINYBARS,
  DEFAULT_PER_REQUEST_TINYBARS,
  DEFAULT_PORT,
  FACILITATOR,
  FEE_PAYER,
  KEY_MODE,
  KEY_PATH,
  LEDGER_LIMIT,
  MERCHANT_KEY_PATH,
  NETWORK,
  STATE_DIR,
  STATE_PATH,
} from "./paths.mjs";

export const DEFAULT_CONFIG = {
  network: NETWORK,
  accountId: "",
  evmAddress: "",
  merchantAccountId: "",
  merchantEvmAddress: "",
  facilitator: FACILITATOR,
  feePayer: FEE_PAYER,
  port: DEFAULT_PORT,
  caps: {
    dailyTinybars: DEFAULT_DAILY_TINYBARS,
    perRequestTinybars: DEFAULT_PER_REQUEST_TINYBARS,
  },
  allowHosts: [...DEFAULT_ALLOW_HOSTS],
  paused: false,
};

export function emptyState() {
  return {
    updatedAt: new Date().toISOString(),
    paused: false,
    configured: false,
    accountId: "",
    evmAddress: "",
    merchantAccountId: "",
    merchantEvmAddress: "",
    balanceTinybars: "0",
    spentTodayTinybars: "0",
    spentTodayDate: todayStamp(),
    dailyCapTinybars: DEFAULT_DAILY_TINYBARS,
    perRequestTinybars: DEFAULT_PER_REQUEST_TINYBARS,
    allowHosts: [...DEFAULT_ALLOW_HOSTS],
    lastError: "",
    ledger: [],
  };
}

export function todayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function ensureDirs() {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o755 });
}

export async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJsonAtomic(file, value, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, body, { mode });
  await fs.rename(tmp, file);
}

export async function loadConfig() {
  await ensureDirs();
  const stored = await readJson(CONFIG_PATH, {});
  const caps = stored.caps && typeof stored.caps === "object" ? stored.caps : {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    caps: {
      dailyTinybars: String(caps.dailyTinybars ?? DEFAULT_CONFIG.caps.dailyTinybars),
      perRequestTinybars: String(
        caps.perRequestTinybars ?? DEFAULT_CONFIG.caps.perRequestTinybars,
      ),
    },
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

export async function loadState() {
  await ensureDirs();
  const stored = await readJson(STATE_PATH, emptyState());
  const state = { ...emptyState(), ...stored };
  if (state.spentTodayDate !== todayStamp()) {
    state.spentTodayTinybars = "0";
    state.spentTodayDate = todayStamp();
  }
  if (!Array.isArray(state.ledger)) state.ledger = [];
  return state;
}

export async function saveState(state) {
  await ensureDirs();
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    ledger: Array.isArray(state.ledger) ? state.ledger.slice(0, LEDGER_LIMIT) : [],
  };
  await writeJsonAtomic(STATE_PATH, next, 0o644);
  return next;
}

export function assertKeyPermissions(file = KEY_PATH) {
  if (!fsSync.existsSync(file)) {
    throw new Error(`Missing key file: ${file}`);
  }
  const mode = fsSync.statSync(file).mode & 0o777;
  if (mode !== KEY_MODE) {
    throw new Error(
      `Refusing to load ${file}: mode is ${mode.toString(8).padStart(3, "0")}, need 600`,
    );
  }
}

export async function readKeyFile(file = KEY_PATH) {
  assertKeyPermissions(file);
  const raw = (await fs.readFile(file, "utf8")).trim();
  if (!raw) throw new Error(`Key file is empty: ${file}`);
  return raw;
}

export async function writeKeyFile(file, contents) {
  await ensureDirs();
  await fs.writeFile(file, `${contents.trim()}\n`, { mode: KEY_MODE });
  await fs.chmod(file, KEY_MODE);
}

export function keyExists(file = KEY_PATH) {
  return fsSync.existsSync(file);
}

export { KEY_PATH, MERCHANT_KEY_PATH, STATE_PATH, CONFIG_PATH };
