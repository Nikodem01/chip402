#!/usr/bin/env node
import http from "node:http";
import { DEFAULT_PORT } from "./lib/paths.mjs";
import { log } from "./lib/log.mjs";
import {
  loadConfig,
  loadState,
  readKeyFile,
  saveConfig,
  saveState,
  todayStamp,
} from "./lib/state.mjs";
import { evaluateSpend, parseHost } from "./lib/policy.mjs";
import { accountBalance, hashscanAccount, hashscanTransaction, lookupAccount } from "./lib/hedera.mjs";
import { payAndFetch } from "./lib/x402.mjs";

const MAX_BODY = 1_000_000;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function isLoopback(addr) {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === ":ffff:127.0.0.1" ||
    addr === "localhost"
  );
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error("request too large");
      error.code = "too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function publicState(config, state) {
  return {
    ok: true,
    name: "chip402",
    paused: config.paused === true,
    configured: Boolean(config.accountId),
    network: config.network,
    accountId: config.accountId || "",
    evmAddress: config.evmAddress || "",
    merchantAccountId: config.merchantAccountId || "",
    merchantEvmAddress: config.merchantEvmAddress || "",
    accountUrl: hashscanAccount(config.accountId),
    balanceTinybars: state.balanceTinybars || "0",
    spentTodayTinybars: state.spentTodayDate === todayStamp() ? state.spentTodayTinybars : "0",
    spentTodayDate: todayStamp(),
    dailyCapTinybars: config.caps.dailyTinybars,
    perRequestTinybars: config.caps.perRequestTinybars,
    allowHosts: config.allowHosts,
    facilitator: config.facilitator,
    feePayer: config.feePayer,
    lastError: state.lastError || "",
    updatedAt: state.updatedAt,
    ledger: state.ledger || [],
  };
}

async function snapshot(extra = {}) {
  const config = await loadConfig();
  let state = await loadState();
  state = {
    ...state,
    paused: config.paused,
    configured: Boolean(config.accountId),
    accountId: config.accountId,
    evmAddress: config.evmAddress,
    merchantAccountId: config.merchantAccountId,
    merchantEvmAddress: config.merchantEvmAddress,
    dailyCapTinybars: config.caps.dailyTinybars,
    perRequestTinybars: config.caps.perRequestTinybars,
    allowHosts: config.allowHosts,
    ...extra,
  };
  if (state.spentTodayDate !== todayStamp()) {
    state.spentTodayTinybars = "0";
    state.spentTodayDate = todayStamp();
  }
  state = await saveState(state);
  return { config, state, view: publicState(config, state) };
}

async function refreshBalances() {
  const config = await loadConfig();
  const extra = {};
  if (config.accountId) {
    try {
      extra.balanceTinybars = await accountBalance(config.accountId);
      extra.lastError = "";
    } catch (err) {
      extra.lastError = err.message;
    }
  }
  if (config.evmAddress && !config.accountId) {
    try {
      const found = await lookupAccount(config.evmAddress);
      if (found?.accountId) {
        config.accountId = found.accountId;
        extra.accountId = found.accountId;
        extra.balanceTinybars = found.balanceTinybars;
        extra.configured = true;
        await saveConfig(config);
      }
    } catch (err) {
      extra.lastError = err.message;
    }
  }
  if (config.merchantEvmAddress && !config.merchantAccountId) {
    try {
      const merchant = await lookupAccount(config.merchantEvmAddress);
      if (merchant?.accountId) {
        config.merchantAccountId = merchant.accountId;
        extra.merchantAccountId = merchant.accountId;
        await saveConfig(config);
      }
    } catch (err) {
      extra.lastError = extra.lastError || err.message;
    }
  }
  return snapshot(extra);
}

function pushLedger(state, entry) {
  const row = {
    id: entry.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...entry,
  };
  if (row.txId) row.hashscan = hashscanTransaction(row.txId);
  state.ledger = [row, ...(state.ledger || [])];
  return row;
}

async function handleFetch(body) {
  const url = String(body.url || "").trim();
  if (!url) {
    const error = new Error("url is required");
    error.status = 400;
    throw error;
  }
  const { config, state } = await snapshot();
  let key;
  try {
    key = await readKeyFile();
  } catch (err) {
    const error = new Error(err.message);
    error.status = 409;
    throw error;
  }

  const method = String(body.method || "GET").toUpperCase();
  try {
    const result = await payAndFetch({
      url,
      method,
      headers: body.headers && typeof body.headers === "object" ? body.headers : {},
      body: body.body,
      accountId: config.accountId,
      privateKeyRaw: key,
      facilitator: config.facilitator,
      feePayer: config.feePayer,
      decide: ({ requirement }) =>
        evaluateSpend({ config, state, url, requirement }),
    });

    if (!result.paid) {
      return {
        ok: true,
        paid: false,
        status: result.status,
        body: result.json ?? result.text,
      };
    }

    const amount = String(result.requirement.amount);
    const spentDate = state.spentTodayDate === todayStamp() ? state.spentTodayTinybars : "0";
    state.spentTodayTinybars = String(BigInt(spentDate) + BigInt(amount));
    state.spentTodayDate = todayStamp();
    const txId = result.settlement?.transactionId || result.settlement?.transaction || result.signed.transactionId;
    const row = pushLedger(state, {
      url,
      host: parseHost(url),
      amountTinybars: amount,
      payTo: result.requirement.payTo,
      txId,
      status: result.status >= 200 && result.status < 300 ? "settled" : "paid",
      reason: "",
    });
    state.lastError = "";
    try {
      state.balanceTinybars = await accountBalance(config.accountId);
    } catch {
      // Mirror lag is fine; next refresh will catch up.
    }
    await saveState(state);
    return {
      ok: true,
      paid: true,
      status: result.status,
      body: result.json ?? result.text,
      payment: row,
    };
  } catch (err) {
    const code = err.code || err.policy?.code || "failed";
    const reason = err.message || "payment failed";
    pushLedger(state, {
      url,
      host: parseHost(url),
      amountTinybars: err.policy?.amount ? String(err.policy.amount) : "0",
      payTo: "",
      txId: "",
      status: "denied",
      reason,
      code,
    });
    state.lastError = reason;
    await saveState(state);
    const error = new Error(reason);
    error.status = code === "paused" || code === "host_denied" || code === "daily_cap" || code === "per_request_cap" ? 403 : 502;
    error.payload = { ok: false, code, reason };
    throw error;
  }
}

async function handle(req, res) {
  if (!isLoopback(req.socket.remoteAddress || "")) {
    return json(res, 403, { ok: false, error: "loopback only" });
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /status" || route === "GET /") {
      const { view } = await snapshot();
      return json(res, 200, view);
    }
    if (route === "POST /refresh") {
      const { view } = await refreshBalances();
      return json(res, 200, view);
    }
    if (route === "POST /pause") {
      const body = await readBody(req);
      if (typeof body.paused !== "boolean") {
        return json(res, 400, { ok: false, error: "paused must be a boolean" });
      }
      const config = await loadConfig();
      config.paused = body.paused;
      await saveConfig(config);
      const { view } = await snapshot({ paused: config.paused, lastError: "" });
      return json(res, 200, view);
    }
    if (route === "POST /caps") {
      const body = await readBody(req);
      const config = await loadConfig();
      if (body.dailyTinybars != null) config.caps.dailyTinybars = String(body.dailyTinybars);
      if (body.perRequestTinybars != null) {
        config.caps.perRequestTinybars = String(body.perRequestTinybars);
      }
      await saveConfig(config);
      const { view } = await snapshot();
      return json(res, 200, view);
    }
    if (route === "POST /allow-host") {
      const body = await readBody(req);
      const host = String(body.host || "").trim().toLowerCase();
      if (!host) return json(res, 400, { ok: false, error: "host is required" });
      const config = await loadConfig();
      if (!config.allowHosts.includes(host)) config.allowHosts.push(host);
      await saveConfig(config);
      const { view } = await snapshot();
      return json(res, 200, view);
    }
    if (route === "POST /fetch") {
      const body = await readBody(req);
      const result = await handleFetch(body);
      return json(res, 200, result);
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    await log(route, err);
    const status = err.status || (err.code === "too_large" ? 413 : 500);
    return json(res, status, err.payload || { ok: false, error: err.message });
  }
}

const port = Number(process.env.CHIP402_PORT || DEFAULT_PORT);
const server = http.createServer((req, res) => {
  handle(req, res).catch(async (err) => {
    await log("unhandled", err);
    if (!res.headersSent) json(res, 500, { ok: false, error: "internal error" });
  });
});

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      const body = await res.json();
      if (body?.name === "chip402") {
        await log(`already running on :${port}`);
        process.exit(0);
      }
    } catch {
      // occupied by something else
    }
    await log(`port ${port} is in use`);
    process.exit(1);
  }
  await log(err);
  process.exit(1);
});

server.listen(port, "127.0.0.1", async () => {
  await log(`chip402d listening on 127.0.0.1:${port}`);
  try {
    await refreshBalances();
  } catch (err) {
    await log("startup refresh failed", err);
  }
});

setInterval(() => {
  refreshBalances().catch((err) => log("periodic refresh failed", err));
}, 30_000).unref();
