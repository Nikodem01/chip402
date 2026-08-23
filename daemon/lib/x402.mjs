import { FACILITATOR, FEE_PAYER, HBAR_ASSET, NETWORK } from "./paths.mjs";
import { pickHederaRequirement } from "./policy.mjs";
import { signExactTransfer } from "./hedera.mjs";
import { log } from "./log.mjs";

const PAYMENT_REQUIRED = "payment-required";
const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
const PAYMENT_RESPONSE = "payment-response";

export function b64json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function parseB64json(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toUpperCase()) || headers.get(name.toLowerCase()) || "";
  }
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(val) ? val[0] : val;
  }
  return "";
}

export function decodePaymentRequired(response, bodyText) {
  const fromHeader = parseB64json(header(response.headers, PAYMENT_REQUIRED));
  if (fromHeader && fromHeader.accepts) return fromHeader;
  if (fromHeader && fromHeader.x402Version) return fromHeader;
  try {
    const json = JSON.parse(bodyText || "{}");
    if (json && (json.accepts || json.x402Version === 2)) return json;
    if (json && Array.isArray(json.accepts)) return json;
  } catch {
    // v1 bodies sometimes wrap accepts; ignore parse failures.
  }
  return fromHeader;
}

export function buildPaymentPayload({ requirement, resource, transaction }) {
  return {
    x402Version: 2,
    resource: resource || { url: "", description: "Allowance payment", mimeType: "application/json" },
    accepted: requirement,
    payload: { transaction },
  };
}

export async function facilitatorCall(facilitator, path, body) {
  const base = String(facilitator || FACILITATOR).replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const reason = json?.invalidReason || json?.errorReason || json?.error || text.slice(0, 240);
    const error = new Error(`Facilitator ${path} ${res.status}: ${reason}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

export async function verifyAndSettle({ facilitator, paymentPayload, paymentRequirements }) {
  const payload = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };
  const verify = await facilitatorCall(facilitator, "/verify", payload);
  if (verify && verify.isValid === false) {
    const error = new Error(verify.invalidReason || "facilitator rejected payment");
    error.body = verify;
    throw error;
  }
  const settle = await facilitatorCall(facilitator, "/settle", payload);
  if (settle && settle.success === false) {
    const error = new Error(settle.errorReason || "settlement failed");
    error.body = settle;
    throw error;
  }
  return { verify, settle };
}

async function readBody(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

export async function payAndFetch({
  url,
  method = "GET",
  headers = {},
  body,
  accountId,
  privateKeyRaw,
  facilitator = FACILITATOR,
  feePayer = FEE_PAYER,
  decide,
}) {
  const requestHeaders = { ...headers };
  const init = {
    method,
    headers: requestHeaders,
    redirect: "follow",
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;

  const first = await fetch(url, init);
  if (first.status !== 402) {
    const payload = await readBody(first);
    return {
      paid: false,
      status: first.status,
      headers: Object.fromEntries(first.headers.entries()),
      ...payload,
    };
  }

  const firstBody = await readBody(first);
  const paymentRequired = decodePaymentRequired(first, firstBody.text);
  if (!paymentRequired) {
    throw new Error("402 response had no PAYMENT-REQUIRED payload");
  }
  const requirement = pickHederaRequirement(paymentRequired);
  const decision = decide
    ? decide({ url, paymentRequired, requirement })
    : { ok: true };
  if (!decision.ok) {
    const error = new Error(decision.reason || "policy denied");
    error.code = decision.code || "denied";
    error.policy = decision;
    throw error;
  }
  if (!requirement) {
    throw new Error("No hedera:testnet exact HBAR option advertised");
  }

  const chosen = {
    ...requirement,
    extra: {
      ...(requirement.extra || {}),
      feePayer: requirement.extra?.feePayer || feePayer,
    },
  };
  const signed = await signExactTransfer({
    payerAccountId: accountId,
    privateKeyRaw,
    payTo: chosen.payTo,
    amountTinybars: chosen.amount,
    feePayer: chosen.extra.feePayer,
    asset: chosen.asset || HBAR_ASSET,
    network: chosen.network || NETWORK,
  });
  await log("signed x402 transfer", {
    url,
    amount: chosen.amount,
    payTo: chosen.payTo,
    txId: signed.transactionId,
    bytes: signed.transaction.length,
  });

  const resource = paymentRequired.resource || {
    url,
    description: "Allowance payment",
    mimeType: "application/json",
  };
  const paymentPayload = buildPaymentPayload({
    requirement: chosen,
    resource,
    transaction: signed.transaction,
  });

  const retryHeaders = {
    ...requestHeaders,
    [PAYMENT_SIGNATURE]: b64json(paymentPayload),
  };
  const retryInit = { ...init, headers: retryHeaders };
  const second = await fetch(url, retryInit);
  const secondBody = await readBody(second);
  const settlement = parseB64json(header(second.headers, PAYMENT_RESPONSE));

  return {
    paid: true,
    status: second.status,
    headers: Object.fromEntries(second.headers.entries()),
    paymentRequired,
    requirement: chosen,
    paymentPayload,
    signed,
    settlement,
    ...secondBody,
  };
}

export function paymentRequiredBody({ url, payTo, amount, feePayer, description, mimeType }) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url,
      description: description || "Paid resource",
      mimeType: mimeType || "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: String(amount),
        asset: HBAR_ASSET,
        payTo,
        maxTimeoutSeconds: 180,
        extra: { feePayer: feePayer || FEE_PAYER },
      },
    ],
  };
}
