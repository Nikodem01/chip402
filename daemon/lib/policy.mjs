import { DEFAULT_ALLOW_HOSTS, HBAR_ASSET, NETWORK } from "./paths.mjs";
import { todayStamp } from "./state.mjs";

export function parseHost(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return "";
  }
}

export function hostAllowed(host, allowHosts) {
  const list = Array.isArray(allowHosts) ? allowHosts : DEFAULT_ALLOW_HOSTS;
  if (list.includes("*")) return true;
  const value = String(host || "").toLowerCase();
  if (!value) return false;
  return list.some((entry) => String(entry).toLowerCase() === value);
}

export function toBigInt(value, label = "amount") {
  try {
    const n = BigInt(String(value ?? "0"));
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function pickHederaRequirement(paymentRequired) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  return (
    accepts.find(
      (item) =>
        item &&
        item.scheme === "exact" &&
        item.network === NETWORK &&
        String(item.asset || HBAR_ASSET) === HBAR_ASSET,
    ) || null
  );
}

export function evaluateSpend({ config, state, url, requirement }) {
  if (config.paused === true || state.paused === true) {
    return deny("paused", "chip402 is paused");
  }
  if (!config.accountId) {
    return deny("unconfigured", "No Hedera account yet — fund the operator key first");
  }
  const host = parseHost(url);
  if (!hostAllowed(host, config.allowHosts)) {
    return deny("host_denied", `Host not on the allowlist: ${host || "(none)"}`);
  }
  if (!requirement) {
    return deny("unsupported", "No hedera:testnet HBAR exact option in the 402");
  }
  if (requirement.scheme !== "exact") {
    return deny("unsupported", `Unsupported scheme: ${requirement.scheme}`);
  }
  if (requirement.network !== NETWORK) {
    return deny("unsupported", `Unsupported network: ${requirement.network}`);
  }
  if (String(requirement.asset || HBAR_ASSET) !== HBAR_ASSET) {
    return deny("unsupported", `Only HBAR (0.0.0) is enabled; got ${requirement.asset}`);
  }
  const extra = requirement.extra && typeof requirement.extra === "object" ? requirement.extra : {};
  if (typeof extra.feePayer !== "string" || !extra.feePayer) {
    return deny("invalid_requirement", "Payment requirements are missing extra.feePayer");
  }
  const amount = toBigInt(requirement.amount, "invoice amount");
  if (amount === 0n) {
    return deny("invalid_requirement", "Invoice amount is zero");
  }
  const perRequest = toBigInt(config.caps.perRequestTinybars, "per-request cap");
  if (amount > perRequest) {
    return deny("per_request_cap", `Invoice ${amount} tinybars exceeds per-request cap ${perRequest}`);
  }
  const spentDate = state.spentTodayDate === todayStamp() ? state.spentTodayTinybars : "0";
  const spent = toBigInt(spentDate, "spent today");
  const daily = toBigInt(config.caps.dailyTinybars, "daily cap");
  if (spent + amount > daily) {
    return deny("daily_cap", `This payment would exceed today's cap (${spent} + ${amount} > ${daily})`);
  }
  const balance = toBigInt(state.balanceTinybars || "0", "balance");
  if (balance > 0n && amount > balance) {
    return deny("insufficient_funds", "Operator account does not have enough HBAR");
  }
  return { ok: true, amount, host, feePayer: extra.feePayer };
}

function deny(code, reason) {
  return { ok: false, code, reason };
}
