import { BALANCE_MAX_AGE_MS, DEFAULT_ALLOW_HOSTS } from "./paths.mjs";
import { TESTNET, isSpendAsset, resolveNetwork } from "./networks.mjs";
import { todayStamp } from "./state.mjs";

// v2 reserves extra.paymentFlow. `upfront` and `escrow` settle before the resource runs,
// so paying one means paying first and finding out later. The spec says a client MUST NOT
// construct a payment for a flow it does not recognize and SHOULD skip such entries.
export const AUTHORIZATION_FLOW = "authorization";
export const KNOWN_PAYMENT_FLOWS = new Set([AUTHORIZATION_FLOW]);
// Same rule for how the asset moves. The x402 protocol reserves the key name but defines no
// global vocabulary — values are mechanism-defined — and the Hedera `exact` binding defines
// none at all, its only `extra` key being feePayer. So on hedera:* the sole conformant state
// is the field being absent, and any value present is by definition one we do not recognize.
export const KNOWN_ASSET_TRANSFER_METHODS = new Set();

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function parseHost(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return "";
  }
}

export function parseTarget(urlString) {
  try {
    const url = new URL(urlString);
    return {
      host: url.hostname.toLowerCase(),
      port: url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""),
      explicitPort: url.port || "",
      protocol: url.protocol,
      secure: url.protocol === "https:",
    };
  } catch {
    return null;
  }
}

export function isLoopbackHost(host) {
  const value = String(host || "").toLowerCase();
  return LOOPBACK_HOSTS.has(value) || value.endsWith(".localhost");
}

// Entries are `host` or `host:port`. A bare host matches any port; a host:port entry
// matches only that port. Scheme prefixes are accepted and stripped so `chip402 allow
// https://api.example.com` does the obvious thing.
export function normalizeAllowEntry(entry) {
  let value = String(entry || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "*") return { wildcard: true, host: "*", port: "" };
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");
  const bracket = /^(\[[0-9a-f:]+\])(?::(\d+))?$/.exec(value);
  if (bracket) return { wildcard: false, host: bracket[1], port: bracket[2] || "" };
  const parts = value.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { wildcard: false, host: parts[0], port: parts[1] };
  }
  return { wildcard: false, host: value, port: "" };
}

export function hostMatchesEntry(target, entry) {
  if (!entry || !target) return false;
  const host = target.host === "[::1]" ? "::1" : target.host;
  const entryHost = entry.host === "[::1]" ? "::1" : entry.host;
  if (entryHost !== host) return false;
  if (!entry.port) return true;
  return entry.port === target.port;
}

export function checkHost({ url, allowHosts, profile = TESTNET }) {
  const target = parseTarget(url);
  if (!target || !target.host) return deny("host_denied", "Could not parse a host from the URL");
  const list = Array.isArray(allowHosts) && allowHosts.length ? allowHosts : DEFAULT_ALLOW_HOSTS;
  const entries = list.map(normalizeAllowEntry).filter(Boolean);
  const loopback = isLoopbackHost(target.host);

  // Cleartext to a remote host puts the signed transfer on the wire in the open, and a
  // hostname-only allowlist entry would otherwise permit it.
  if (!loopback && !target.secure) {
    return deny("insecure_host", `Refusing cleartext ${target.protocol}// to ${target.host} — https is required`);
  }
  const wildcard = entries.find((entry) => entry.wildcard);
  if (wildcard) {
    if (profile.allowWildcardHosts !== true) {
      return deny(
        "host_denied",
        `Wildcard allowlist entry "*" is not honoured on ${profile.id} — allow specific hosts`,
      );
    }
    return { ok: true, host: target.host, port: target.port };
  }
  if (!entries.some((entry) => hostMatchesEntry(target, entry))) {
    return deny("host_denied", `Host not on the allowlist: ${target.host}${target.explicitPort ? `:${target.explicitPort}` : ""}`);
  }
  return { ok: true, host: target.host, port: target.port };
}

export function hostAllowed(host, allowHosts, profile = TESTNET) {
  const url = isLoopbackHost(host) ? `http://${host}` : `https://${host}`;
  return checkHost({ url, allowHosts, profile }).ok === true;
}

export function toBigInt(value, label = "amount") {
  try {
    const raw = String(value ?? "0").trim();
    if (!/^\d+$/.test(raw)) throw new Error("not an integer");
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function safeBigInt(value) {
  try {
    return toBigInt(value);
  } catch {
    return null;
  }
}

export function profileFor(config) {
  return resolveNetwork(config?.network || TESTNET.id);
}

export function paymentFlowOf(item) {
  const flow = item?.extra?.paymentFlow;
  return typeof flow === "string" && flow.trim() ? flow.trim() : AUTHORIZATION_FLOW;
}

export function flowRecognized(item) {
  return KNOWN_PAYMENT_FLOWS.has(paymentFlowOf(item));
}

export function transferMethodRecognized(item) {
  const method = item?.extra?.assetTransferMethod;
  if (method == null || method === "") return true;
  return KNOWN_ASSET_TRANSFER_METHODS.has(String(method));
}

export function pickHederaRequirement(paymentRequired, profile = TESTNET) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  const exact = accepts.filter(
    (item) =>
      item &&
      item.scheme === "exact" &&
      item.network === profile.id &&
      isSpendAsset(item.asset, profile) &&
      flowRecognized(item) &&
      transferMethodRecognized(item),
  );
  return exact.find((item) => String(item.asset) === profile.usdc) || exact[0] || null;
}

// Why a 402 had nothing we could pay — so the ledger can say "escrow flow" instead of the
// blank "no option advertised" that an unrecognized flow used to produce.
export function describeSkipped(paymentRequired, profile = TESTNET) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  const hedera = accepts.filter((item) => item && item.network === profile.id);
  const flows = [...new Set(hedera.filter((item) => !flowRecognized(item)).map(paymentFlowOf))];
  const methods = [
    ...new Set(
      hedera
        .filter((item) => !transferMethodRecognized(item))
        .map((item) => String(item.extra.assetTransferMethod)),
    ),
  ];
  const parts = [];
  if (flows.length) parts.push(`unrecognized paymentFlow: ${flows.join(", ")}`);
  if (methods.length) parts.push(`unrecognized assetTransferMethod: ${methods.join(", ")}`);
  return parts.join("; ");
}

export function balanceIsFresh(state, now = Date.now(), maxAgeMs = BALANCE_MAX_AGE_MS) {
  const at = Date.parse(state?.balanceAt || "");
  if (!Number.isFinite(at)) return false;
  return now - at <= maxAgeMs;
}

export function evaluateSpend({
  config,
  state,
  url,
  requirement,
  paymentRequired,
  feePayer,
  now = Date.now(),
}) {
  const profile = profileFor(config);
  if (config.paused === true || state.paused === true) {
    return deny("paused", "chip402 is paused");
  }
  if (!config.accountId) {
    return deny("unconfigured", "No Hedera account yet — fund the operator key first");
  }
  if (state.hollow === true) {
    return deny(
      "hollow_account",
      "Operator account has no key on record yet — chip402 is completing it before it can pay",
    );
  }
  const hostCheck = checkHost({ url, allowHosts: config.allowHosts, profile });
  if (!hostCheck.ok) return hostCheck;
  if (!requirement) {
    const why = describeSkipped(paymentRequired, profile);
    return deny("unsupported", why || `No ${profile.id} USDC exact option in the 402`);
  }
  if (!flowRecognized(requirement)) {
    return deny("unsupported", `Unrecognized paymentFlow: ${paymentFlowOf(requirement)}`);
  }
  if (!transferMethodRecognized(requirement)) {
    return deny("unsupported", `Unrecognized assetTransferMethod: ${requirement.extra.assetTransferMethod}`);
  }
  if (requirement.scheme !== "exact") {
    return deny("unsupported", `Unsupported scheme: ${requirement.scheme}`);
  }
  if (requirement.network !== profile.id) {
    return deny("unsupported", `Unsupported network: ${requirement.network}`);
  }
  if (String(requirement.asset) !== profile.usdc) {
    return deny("unsupported", `Only USDC (${profile.usdc}) is enabled; got ${requirement.asset}`);
  }
  const extra = requirement.extra && typeof requirement.extra === "object" ? requirement.extra : {};
  if (typeof extra.feePayer !== "string" || !extra.feePayer) {
    return deny("invalid_requirement", "Payment requirements are missing extra.feePayer");
  }
  // Discovered from the facilitator's /supported, never a constant. No discovered value
  // means discovery failed or expired, and that pauses spending rather than falling back.
  if (!feePayer) {
    return deny(
      "fee_payer_unknown",
      "Facilitator fee payer is not known right now — /supported discovery has not succeeded",
    );
  }
  if (extra.feePayer !== feePayer) {
    return deny(
      "fee_payer_mismatch",
      `Invoice feePayer ${extra.feePayer} does not match the ${feePayer} advertised by ${config.facilitator}/supported`,
    );
  }
  const payTo = String(requirement.payTo || "");
  if (!/^\d+\.\d+\.\d+$/.test(payTo)) {
    return deny("invalid_requirement", `payTo is not a Hedera account id: ${payTo || "(none)"}`);
  }
  if (payTo === config.accountId) {
    return deny("invalid_requirement", "Invoice pays the operator account itself");
  }
  const amount = safeBigInt(requirement.amount);
  if (amount === null) return deny("invalid_requirement", `Invalid invoice amount: ${requirement.amount}`);
  if (amount === 0n) {
    return deny("invalid_requirement", "Invoice amount is zero");
  }
  const perRequest = toBigInt(config.caps.perRequestMicro, "per-request cap");
  if (amount > perRequest) {
    return deny("per_request_cap", `Invoice ${amount} exceeds per-request cap ${perRequest}`);
  }
  const spentDate = state.spentTodayDate === todayStamp() ? state.spentTodayMicro : "0";
  const spent = toBigInt(spentDate, "spent today");
  const daily = toBigInt(config.caps.dailyMicro, "daily cap");
  if (spent + amount > daily) {
    return deny("daily_cap", `This payment would exceed today's cap (${spent} + ${amount} > ${daily})`);
  }
  // balanceMicro is "0" both for an empty account and for a mirror-node read that failed,
  // so the guard is only meaningful next to a timestamp saying when the read succeeded.
  if (!balanceIsFresh(state, now)) {
    return deny(
      "stale_balance",
      "Operator balance could not be read recently enough to be trusted — refusing to spend",
    );
  }
  const balance = safeBigInt(state.balanceMicro);
  if (balance === null) return deny("stale_balance", "Operator balance is unreadable — refusing to spend");
  if (amount > balance) {
    return deny("insufficient_funds", `Operator holds ${balance} micro-USDC, invoice is ${amount}`);
  }
  return { ok: true, amount, host: hostCheck.host, feePayer: extra.feePayer, payTo };
}

// The whole premise is that real money lives in HashPack and only pocket money lives here.
export function floatWarning(config, state) {
  const balance = safeBigInt(state?.balanceMicro);
  const max = safeBigInt(config?.maxFloatMicro);
  if (balance === null || max === null || max === 0n) return "";
  if (balance <= max) return "";
  return `Operator holds more than the ${max} micro-USDC float — move the excess back to HashPack`;
}

export function payeeKey(host, payTo) {
  return `${String(host || "").toLowerCase()}|${String(payTo || "")}`;
}

export function isFirstSight(state, host, payTo) {
  const seen = Array.isArray(state?.seenPayees) ? state.seenPayees : [];
  return !seen.includes(payeeKey(host, payTo));
}

function deny(code, reason) {
  return { ok: false, code, reason };
}
