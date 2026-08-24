#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import {
  BALANCE_MAX_AGE_MS,
  DEFAULT_PORT,
  SOCKET_MODE,
  SOCKET_PATH,
  TOKEN_PATH,
} from "./lib/paths.mjs";
import { log } from "./lib/log.mjs";
import {
  KEY_PATH,
  MERCHANT_KEY_PATH,
  keyExists,
  ledgerId,
  loadConfig,
  loadState,
  readKeyFile,
  readTokenFile,
  saveConfig,
  saveState,
  todayStamp,
} from "./lib/state.mjs";
import {
  checkHost,
  evaluateSpend,
  floatWarning,
  isFirstSight,
  forwardableHeaders,
  parseHost,
  payeeKey,
  profileFor,
  safeBigInt,
} from "./lib/policy.mjs";
import {
  accountBalance,
  associateToken,
  completeAccount,
  hashscanAccount,
  hashscanTransaction,
  lookupAccount,
  lookupTransaction,
  settledAmount,
  tokenBalance,
} from "./lib/hedera.mjs";
import { discovery } from "./lib/facilitator.mjs";
import { payAndFetch } from "./lib/x402.mjs";

// Everything this daemon creates holds payment state; none of it is anyone else's business.
process.umask(0o077);

const MAX_BODY = 1_000_000;
const RECONCILE_GRACE_MS = 30_000;
const REFRESH_INTERVAL_MS = 30_000;
const TCP_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function isLoopback(addr) {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr === "localhost"
  );
}

// One in-process lock over the whole check-reserve-sign-settle path. Two parallel /fetch
// calls used to read the same spentTodayMicro, both pass the cap check, and both spend.
let chain = Promise.resolve();
export function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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

// -1 is unlimited and is the default for auto-created and completed-hollow accounts; any
// positive number is a spare slot. Either way the sender's fee covers the association.
export function canAutoAssociate(maxAutoAssociations) {
  const n = Number(maxAutoAssociations);
  return n === -1 || n > 0;
}

function pendingMicro(state) {
  return (state.ledger || [])
    .filter((row) => row && row.status === "pending")
    .reduce((total, row) => total + (safeBigInt(row.amountMicro) ?? 0n), 0n)
    .toString();
}

function publicState(config, state) {
  const discovered = discovery.peek({ facilitator: config.facilitator, network: config.network });
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
    accountUrl: hashscanAccount(config.accountId, config.network),
    asset: config.asset,
    hashscan: config.hashscan,
    associated: state.associated === true,
    hollow: state.hollow === true,
    balanceMicro: state.balanceMicro || "0",
    balanceAt: state.balanceAt || "",
    balanceFresh: Date.now() - Date.parse(state.balanceAt || "") <= BALANCE_MAX_AGE_MS,
    hbarTinybars: state.hbarTinybars || "0",
    spentTodayMicro: state.spentTodayDate === todayStamp() ? state.spentTodayMicro : "0",
    spentTodayDate: todayStamp(),
    pendingMicro: pendingMicro(state),
    dailyCapMicro: config.caps.dailyMicro,
    perRequestMicro: config.caps.perRequestMicro,
    maxFloatMicro: config.maxFloatMicro,
    floatWarning: floatWarning(config, state),
    allowHosts: config.allowHosts,
    facilitator: config.facilitator,
    // The pinned value is a hint for the panel; feePayer is what /supported advertised.
    feePayerPinned: config.feePayer || "",
    feePayer: discovered?.feePayer || "",
    feePayerAt: discovered ? new Date(discovered.at).toISOString() : "",
    facilitatorError: state.facilitatorError || "",
    mainnetShipped: false,
    lastError: state.lastError || "",
    updatedAt: state.updatedAt,
    ledger: state.ledger || [],
  };
}

function decorate(config, state, extra = {}) {
  const next = {
    ...state,
    paused: config.paused,
    configured: Boolean(config.accountId),
    accountId: config.accountId,
    evmAddress: config.evmAddress,
    merchantAccountId: config.merchantAccountId,
    merchantEvmAddress: config.merchantEvmAddress,
    dailyCapMicro: config.caps.dailyMicro,
    perRequestMicro: config.caps.perRequestMicro,
    associated: state.associated === true,
    allowHosts: config.allowHosts,
    hashscan: config.hashscan,
    facilitator: config.facilitator,
    maxFloatMicro: config.maxFloatMicro,
    ...extra,
  };
  // The panel reads state.json directly through a FileView, so anything it needs to show has
  // to live there and not only in the /status view.
  next.floatWarning = floatWarning(config, next);
  if (next.spentTodayDate !== todayStamp()) {
    next.spentTodayMicro = "0";
    next.spentTodayDate = todayStamp();
  }
  return next;
}

// Read-only. /status used to write state on every call, which is how a concurrent payment's
// update got clobbered by a stale snapshot.
async function snapshot(extra = {}) {
  const config = await loadConfig();
  const state = decorate(config, await loadState(), extra);
  return { config, state, view: publicState(config, state) };
}

async function persist(config, state, extra = {}) {
  const next = await saveState(decorate(config, state, extra));
  return { config, state: next, view: publicState(config, next) };
}

async function discoverFeePayer(config) {
  try {
    const entry = await discovery.discover({
      facilitator: config.facilitator,
      network: config.network,
      apiKey: config.facilitatorApiKey,
    });
    return { feePayer: entry.feePayer, error: "" };
  } catch (err) {
    await log("facilitator discovery failed", err);
    return { feePayer: "", error: err.message || "facilitator discovery failed" };
  }
}

// A ledger row is written from seller, facilitator and caller strings, kept for 50 rows, and
// read back by the panel. Each field gets a ceiling here, at the one place rows are made,
// rather than at the dozen places that supply them.
const MAX_ROW_FIELD_CHARS = 240;

function clampField(value) {
  const text = String(value ?? "");
  return text.length > MAX_ROW_FIELD_CHARS ? `${text.slice(0, MAX_ROW_FIELD_CHARS)}…` : text;
}

function pushLedger(state, entry) {
  const row = {
    id: entry.id || ledgerId(),
    ts: new Date().toISOString(),
    kind: entry.kind || "payment",
    ...entry,
  };
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string") row[key] = clampField(value);
  }
  if (row.txId) row.hashscan = hashscanTransaction(row.txId, entry.network);
  state.ledger = [row, ...(state.ledger || [])];
  return row;
}

// Raising a cap is the most privileged act in the system. It leaves a row next to the
// payments it enabled.
async function audit(config, state, action, detail) {
  pushLedger(state, {
    kind: "audit",
    action,
    detail,
    network: config.network,
    status: "audit",
    amountMicro: "0",
    host: "",
    url: "",
    payTo: "",
    txId: "",
    reason: detail,
  });
}

function releaseReservation(state, row) {
  if (row.spentDate === state.spentTodayDate) {
    const spent = safeBigInt(state.spentTodayMicro) ?? 0n;
    const amount = safeBigInt(row.amountMicro) ?? 0n;
    state.spentTodayMicro = (spent > amount ? spent - amount : 0n).toString();
  }
  row.status = "denied";
  row.reason = row.reason || "Reservation released — the network never settled this payment";
  row.releasedAt = new Date().toISOString();
}

function promoteReservation(state, row, onChainMicro) {
  const reserved = safeBigInt(row.amountMicro) ?? 0n;
  if (onChainMicro != null && onChainMicro !== reserved && row.spentDate === state.spentTodayDate) {
    const spent = safeBigInt(state.spentTodayMicro) ?? 0n;
    const corrected = spent - reserved + onChainMicro;
    state.spentTodayMicro = (corrected > 0n ? corrected : 0n).toString();
  }
  row.status = "settled";
  row.settledAt = new Date().toISOString();
  if (onChainMicro != null) row.onChainMicro = onChainMicro.toString();
  markSeen(state, row);
}

function markSeen(state, row) {
  if (!row.host || !row.payTo) return;
  const key = payeeKey(row.host, row.payTo);
  const seen = Array.isArray(state.seenPayees) ? state.seenPayees : [];
  if (!seen.includes(key)) {
    row.firstSight = true;
    state.seenPayees = [key, ...seen].slice(0, 200);
  }
}

// The only safe way to release a reservation is for the network to say nothing settled and
// for the signed transaction to have expired, because until it expires the seller can still
// submit it.
export async function reconcilePending(
  config,
  state,
  row,
  { now = Date.now(), lookup = lookupTransaction } = {},
) {
  if (!row.txId) {
    releaseReservation(state, row);
    row.reason = "Never submitted — released before signing completed";
    return "released";
  }
  let tx;
  try {
    tx = await lookup(row.txId, config.network);
  } catch (err) {
    // A mirror node we cannot reach is not evidence that nothing settled.
    await log("reconcile lookup failed", err);
    return "unknown";
  }
  if (tx && tx.success) {
    const moved = settledAmount(tx, {
      asset: config.asset,
      from: config.accountId,
      to: row.payTo,
    });
    promoteReservation(state, row, moved > 0n ? moved : null);
    return "settled";
  }
  if (tx && !tx.success) {
    releaseReservation(state, row);
    row.reason = `Transaction reached consensus and failed: ${tx.result}`;
    return "released";
  }
  const expiresAt = Date.parse(row.expiresAt || "");
  if (Number.isFinite(expiresAt) && now < expiresAt + RECONCILE_GRACE_MS) return "pending";
  releaseReservation(state, row);
  row.reason = "Signed transaction expired without reaching consensus";
  return "released";
}

export async function reconcileAll(config, state, opts = {}) {
  const pending = (state.ledger || []).filter((row) => row && row.status === "pending");
  const outcomes = [];
  for (const row of pending) {
    outcomes.push({ id: row.id, outcome: await reconcilePending(config, state, row, opts) });
  }
  return outcomes;
}

async function refreshBalances() {
  return withLock(async () => {
    const config = await loadConfig();
    const state = await loadState();
    const extra = {};
    const discovered = await discoverFeePayer(config);
    extra.facilitatorError = discovered.error;
    extra.feePayer = discovered.feePayer;
    extra.feePayerAt = discovered.feePayer ? new Date().toISOString() : "";

    if (config.evmAddress && !config.accountId) {
      try {
        const found = await lookupAccount(config.evmAddress, config.network);
        if (found?.accountId) {
          config.accountId = found.accountId;
          extra.accountId = found.accountId;
          extra.configured = true;
          await saveConfig(config);
        }
      } catch (err) {
        extra.lastError = err.message;
      }
    }

    if (config.accountId) {
      try {
        const account = await lookupAccount(config.accountId, config.network);
        extra.hollow = account ? account.hollow : true;
        extra.hbarTinybars = account?.hbarTinybars || "0";
        extra.maxAutoAssociations = account?.maxAutoAssociations ?? 0;
        // A hollow account has no key on record, so the facilitator's signature check has
        // nothing to check against and every payment from it is rejected. One self-paid,
        // self-signed transaction writes the key. This used to happen by accident as a side
        // effect of token association, which never runs for an HBAR-denominated payment.
        if (account?.hollow && keyExists(KEY_PATH)) {
          try {
            const done = await completeAccount({
              accountId: config.accountId,
              privateKeyRaw: await readKeyFile(KEY_PATH),
              network: config.network,
            });
            await log("completed hollow account", { accountId: config.accountId, status: done.status });
            extra.hollow = false;
          } catch (err) {
            extra.lastError = `Could not complete the hollow account (needs a little HBAR): ${err.message}`;
          }
        }
      } catch (err) {
        extra.lastError = err.message;
      }

      try {
        const token = await tokenBalance(config.accountId, undefined, config.network);
        extra.balanceMicro = token.balance;
        extra.balanceAt = new Date().toISOString();
        extra.associated = token.associated;
        extra.lastError = extra.lastError || "";
        if (!token.associated && !canAutoAssociate(extra.maxAutoAssociations)) {
          try {
            await associateToken({
              accountId: config.accountId,
              privateKeyRaw: await readKeyFile(KEY_PATH),
              network: config.network,
            });
            extra.associated = true;
          } catch (assocErr) {
            extra.lastError = `USDC association failed (need a little HBAR for fees): ${assocErr.message}`;
          }
        }
      } catch (err) {
        // Leave balanceAt alone: a failed read must not look like a fresh zero balance.
        extra.lastError = err.message;
      }
    }

    if (config.merchantEvmAddress && !config.merchantAccountId) {
      try {
        const merchant = await lookupAccount(config.merchantEvmAddress, config.network);
        if (merchant?.accountId) {
          config.merchantAccountId = merchant.accountId;
          extra.merchantAccountId = merchant.accountId;
          await saveConfig(config);
        }
      } catch (err) {
        extra.lastError = extra.lastError || err.message;
      }
    }
    if (config.merchantAccountId && keyExists(MERCHANT_KEY_PATH)) {
      try {
        const token = await tokenBalance(config.merchantAccountId, undefined, config.network);
        const merchant = await lookupAccount(config.merchantAccountId, config.network);
        if (!token.associated && !canAutoAssociate(merchant?.maxAutoAssociations)) {
          await associateToken({
            accountId: config.merchantAccountId,
            privateKeyRaw: await readKeyFile(MERCHANT_KEY_PATH),
            network: config.network,
          });
        }
      } catch (err) {
        extra.lastError = extra.lastError || `Merchant USDC association failed: ${err.message}`;
      }
    }

    const merged = decorate(config, state, extra);
    await reconcileAll(config, merged);
    return persist(config, merged);
  });
}

const MAX_URL_CHARS = 2_048;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
async function handleFetch(body) {
  const url = String(body.url || "").trim();
  if (!url) {
    const error = new Error("url is required");
    error.status = 400;
    throw error;
  }
  if (url.length > MAX_URL_CHARS) {
    const error = new Error(`url exceeds ${MAX_URL_CHARS} characters`);
    error.status = 400;
    throw error;
  }
  const method = String(body.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    const error = new Error(`method must be one of ${[...ALLOWED_METHODS].join(", ")}`);
    error.status = 400;
    throw error;
  }

  return withLock(async () => {
    const config = await loadConfig();
    const state = decorate(config, await loadState());
    const profile = profileFor(config);
    const gate = (target) => checkHost({ url: target, allowHosts: config.allowHosts, profile });

    // Refuse before any packet leaves the machine, and before the key file is even opened.
    const preflight = gate(url);
    if (!preflight.ok) {
      pushLedger(state, {
        url,
        host: parseHost(url),
        amountMicro: "0",
        payTo: "",
        txId: "",
        network: config.network,
        status: "denied",
        reason: preflight.reason,
        code: preflight.code,
      });
      state.lastError = preflight.reason;
      await persist(config, state);
      const error = new Error(preflight.reason);
      error.status = 403;
      error.payload = { ok: false, code: preflight.code, reason: preflight.reason };
      throw error;
    }

    let key;
    try {
      key = await readKeyFile();
    } catch (err) {
      const error = new Error(err.message);
      error.status = 409;
      throw error;
    }

    const discovered = await discoverFeePayer(config);
    state.facilitatorError = discovered.error;
    state.feePayer = discovered.feePayer;

    let reservation = null;
    try {
      const result = await payAndFetch({
        url,
        method,
        headers: forwardableHeaders(body.headers),
        body: body.body,
        accountId: config.accountId,
        privateKeyRaw: key,
        facilitator: config.facilitator,
        feePayer: discovered.feePayer,
        network: config.network,
        checkHost: gate,
        decide: ({ url: resourceUrl, requirement, paymentRequired }) =>
          evaluateSpend({
            config,
            state,
            url: resourceUrl,
            requirement,
            paymentRequired,
            feePayer: discovered.feePayer,
          }),
        // Reserve before the retry goes out: if the retry throws after the facilitator has
        // already settled, the money is gone on-chain and the only record of it is this row.
        onSigned: async ({ signed, requirement, resourceUrl }) => {
          const amount = String(requirement.amount);
          const spent = safeBigInt(state.spentTodayMicro) ?? 0n;
          state.spentTodayMicro = (spent + BigInt(amount)).toString();
          state.spentTodayDate = todayStamp();
          reservation = pushLedger(state, {
            url: resourceUrl,
            host: parseHost(resourceUrl),
            amountMicro: amount,
            payTo: requirement.payTo,
            txId: signed.transactionId,
            network: config.network,
            status: "pending",
            reason: "",
            spentDate: state.spentTodayDate,
            expiresAt: new Date(
              Date.now() + (signed.validDurationSeconds || 180) * 1000,
            ).toISOString(),
          });
          await persist(config, state);
        },
      });

      if (!result.paid) {
        return {
          ok: true,
          paid: false,
          status: result.status,
          body: result.json ?? result.text,
        };
      }

      const facilitatorFailed = result.settlement?.success === false;
      const pendingSettlement = result.settlement?.errorReason === "settlement_pending";
      const settled = result.status >= 200 && result.status < 300 && !facilitatorFailed;
      // The id this daemon signed is the only one it will reconcile against. Taking the
      // facilitator's echoed value instead would let a seller name a transaction the mirror
      // node has never heard of, and the reservation it belongs to would never settle.
      const txId = result.signed.transactionId;
      if (reservation) {
        reservation.txId = txId;
        reservation.hashscan = hashscanTransaction(txId, config.network);
        if (settled) {
          promoteReservation(state, reservation, null);
        } else {
          // The seller answered but not with the resource, or the facilitator reported a
          // failure. Money may or may not have moved; ask the network rather than the seller,
          // and keep holding the reservation until the signed transaction can no longer be
          // submitted by anyone.
          reservation.reason =
            result.settlement?.errorReason ||
            (pendingSettlement ? "settlement_pending" : `seller answered ${result.status}`);
          await reconcilePending(config, state, reservation);
        }
      }
      state.lastError = "";
      try {
        state.balanceMicro = await accountBalance(config.accountId, config.network);
        state.balanceAt = new Date().toISOString();
      } catch {
        // Mirror lag is fine; balanceAt stays where it was and the next spend re-checks.
      }
      await persist(config, state);
      return {
        ok: true,
        paid: true,
        status: result.status,
        body: result.json ?? result.text,
        payment: reservation,
      };
    } catch (err) {
      const code = err.code || err.policy?.code || "failed";
      const reason = err.message || "payment failed";
      if (reservation) {
        reservation.reason = reason;
        reservation.code = code;
        await reconcilePending(config, state, reservation);
      } else {
        pushLedger(state, {
          url,
          host: parseHost(url),
          amountMicro: err.policy?.amount ? String(err.policy.amount) : "0",
          payTo: "",
          txId: "",
          network: config.network,
          status: "denied",
          reason,
          code,
        });
      }
      state.lastError = reason;
      await persist(config, state);
      const error = new Error(reason);
      error.status =
        code === "paused" ||
        code === "host_denied" ||
        code === "insecure_host" ||
        code === "daily_cap" ||
        code === "per_request_cap" ||
        code === "hollow_account" ||
        code === "stale_balance" ||
        code === "insufficient_funds" ||
        code === "redirect_denied" ||
        code === "fee_payer_unknown" ||
        code === "fee_payer_mismatch"
          ? 403
          : 502;
      error.payload = { ok: false, code, reason, payment: reservation || undefined };
      throw error;
    }
  });
}

let bearerToken = "";

function timingSafeEquals(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

// A browser cannot open a unix socket, which is the point of the default transport. When
// TCP is explicitly enabled these are the checks that keep a web page from driving the
// daemon through DNS rebinding.
export function authorize(req, { tcp, token, port }) {
  if (req.headers.origin) {
    return { ok: false, reason: "requests carrying an Origin header are rejected" };
  }
  if (req.headers["sec-fetch-mode"] || req.headers["sec-fetch-site"] || req.headers["sec-fetch-dest"]) {
    return { ok: false, reason: "browser-originated requests are rejected" };
  }
  if (!tcp) return { ok: true };
  if (!isLoopback(req.socket.remoteAddress || "")) {
    return { ok: false, reason: "loopback only" };
  }
  const host = String(req.headers.host || "").toLowerCase();
  const bare = host.replace(/:\d+$/, "");
  if (!TCP_HOSTS.has(bare) || (host.includes(":") && !host.endsWith(`:${port}`))) {
    return { ok: false, reason: `unexpected Host header: ${host || "(none)"}` };
  }
  const auth = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || !timingSafeEquals(match[1].trim(), token)) {
    return { ok: false, reason: "missing or invalid bearer token" };
  }
  return { ok: true };
}

async function handle(req, res, options) {
  const auth = authorize(req, options);
  if (!auth.ok) {
    return json(res, 403, { ok: false, error: auth.reason });
  }
  const url = new URL(req.url, "http://chip402.local");
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
      const view = await withLock(async () => {
        const config = await loadConfig();
        const state = await loadState();
        config.paused = body.paused;
        await saveConfig(config);
        await audit(config, state, body.paused ? "pause" : "resume", body.paused ? "chip402 paused" : "chip402 resumed");
        const persisted = await persist(config, state, { paused: config.paused, lastError: "" });
        return persisted.view;
      });
      return json(res, 200, view);
    }
    if (route === "POST /caps") {
      const body = await readBody(req);
      const view = await withLock(async () => {
        const config = await loadConfig();
        const state = await loadState();
        const changes = [];
        if (body.dailyMicro != null) {
          if (safeBigInt(body.dailyMicro) === null) throw badRequest("dailyMicro must be a non-negative integer");
          changes.push(`daily cap ${config.caps.dailyMicro} to ${String(body.dailyMicro)} micro-USDC`);
          config.caps.dailyMicro = String(body.dailyMicro);
        }
        if (body.perRequestMicro != null) {
          if (safeBigInt(body.perRequestMicro) === null) {
            throw badRequest("perRequestMicro must be a non-negative integer");
          }
          changes.push(`per-request cap ${config.caps.perRequestMicro} to ${String(body.perRequestMicro)} micro-USDC`);
          config.caps.perRequestMicro = String(body.perRequestMicro);
        }
        if (!changes.length) throw badRequest("nothing to change");
        await saveConfig(config);
        await audit(config, state, "caps", changes.join("; "));
        const persisted = await persist(config, state);
        return persisted.view;
      });
      return json(res, 200, view);
    }
    if (route === "POST /allow-host") {
      const body = await readBody(req);
      const host = String(body.host || "").trim().toLowerCase();
      if (!host) return json(res, 400, { ok: false, error: "host is required" });
      const view = await withLock(async () => {
        const config = await loadConfig();
        const state = await loadState();
        if (host === "*" && profileFor(config).allowWildcardHosts !== true) {
          throw badRequest(`Wildcard "*" is not honoured on ${config.network}`);
        }
        if (!config.allowHosts.includes(host)) {
          config.allowHosts.push(host);
          await saveConfig(config);
          await audit(config, state, "allow-host", `allowlisted ${host}`);
        }
        const persisted = await persist(config, state);
        return persisted.view;
      });
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

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function probeSocket(socketPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath });
    const done = (value) => {
      probe.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    timer.unref();
    probe.once("connect", () => {
      clearTimeout(timer);
      done("live");
    });
    probe.once("error", (err) => {
      clearTimeout(timer);
      done(err.code || "error");
    });
  });
}

// ECONNREFUSED alone does not prove the socket is stale — a directory answers the same way,
// and a hostile process could point the path at something else entirely. Only unlink a real
// socket that this user owns, and use lstat so a symlink swap cannot redirect the delete.
async function claimSocketPath(socketPath) {
  let info;
  try {
    info = fsSync.lstatSync(socketPath);
  } catch (err) {
    if (err.code === "ENOENT") return "free";
    throw err;
  }
  if (!info.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket — refusing to remove it`);
  }
  if (info.uid !== process.getuid()) {
    throw new Error(`${socketPath} is owned by uid ${info.uid}, not ${process.getuid()}`);
  }
  const state = await probeSocket(socketPath);
  if (state === "live") return "live";
  await fs.rm(socketPath, { force: true });
  return "free";
}

async function main() {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  const tcp = config.tcp === true || process.env.CHIP402_TCP === "1";
  const port = Number(process.env.CHIP402_PORT || config.port || DEFAULT_PORT);
  if (tcp) {
    // The mode is proven on the descriptor the token is read from, before it is a secret in
    // this process, not by a second stat of the same pathname afterwards.
    try {
      bearerToken = await readTokenFile(TOKEN_PATH);
    } catch (err) {
      console.error(
        `TCP transport is enabled but ${TOKEN_PATH} is unusable: ${err.message}. Run: chip402 token`,
      );
      process.exit(1);
    }
  }

  const options = { tcp, token: bearerToken, port };
  const server = http.createServer((req, res) => {
    handle(req, res, options).catch(async (err) => {
      await log("unhandled", err);
      if (!res.headersSent) json(res, 500, { ok: false, error: "internal error" });
    });
  });

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      await log(tcp ? `port ${port} is in use` : `socket ${SOCKET_PATH} is in use`);
      process.exit(1);
    }
    await log(err);
    process.exit(1);
  });

  if (tcp) {
    server.listen(port, "127.0.0.1", () => onListening(`127.0.0.1:${port} (TCP, bearer token required)`));
  } else {
    const dir = path.dirname(SOCKET_PATH);
    fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((await claimSocketPath(SOCKET_PATH)) === "live") {
      await log(`chip402d already running on ${SOCKET_PATH}`);
      process.exit(0);
    }
    // The mode has to come from the umask in force at bind(2); there is no listen() option
    // for it and a chmod afterwards is a tick too late.
    const previousUmask = process.umask(0o777 & ~SOCKET_MODE);
    try {
      server.listen(SOCKET_PATH, () => onListening(`${SOCKET_PATH} (unix socket, mode 0600)`));
    } finally {
      process.umask(previousUmask);
    }
  }

  const cleanup = () => {
    try {
      if (!tcp) fsSync.rmSync(SOCKET_PATH, { force: true });
    } catch {
      // Best effort; a stale socket is detected on next start.
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  async function onListening(where) {
    await log(`chip402d listening on ${where}`);
    // A crash mid-payment leaves pending rows holding a reservation. Settle or release them
    // against the mirror node before accepting new work.
    try {
      await withLock(async () => {
        const cfg = await loadConfig();
        const state = await loadState();
        const outcomes = await reconcileAll(cfg, state);
        if (outcomes.length) await log("startup reconcile", outcomes);
        await persist(cfg, state);
      });
    } catch (err) {
      await log("startup reconcile failed", err);
    }
    try {
      await refreshBalances();
    } catch (err) {
      await log("startup refresh failed", err);
    }
  }

  setInterval(() => {
    refreshBalances().catch((err) => log("periodic refresh failed", err));
  }, REFRESH_INTERVAL_MS).unref();
}

if (process.env.CHIP402_NO_MAIN !== "1") {
  await main();
}
