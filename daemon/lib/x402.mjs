import { FACILITATOR } from "./paths.mjs";
import { TESTNET, resolveNetwork } from "./networks.mjs";
import { pickHederaRequirement } from "./policy.mjs";
import { signExactTransfer } from "./hedera.mjs";
import { log } from "./log.mjs";
import {
  FETCH_TIMEOUT_MS,
  MAX_RESOURCE_BYTES,
  MAX_RESPONSE_BYTES,
  cancelBody,
  isAbortError,
  readCapped,
  requestSignal,
} from "./http.mjs";

// A seller chooses how many headers to send and how long each one is. They travel back to
// whoever called /fetch, so the count and the sizes are bounded here.
const MAX_RESPONSE_HEADERS = 32;
const MAX_HEADER_CHARS = 1_024;

function boundedHeaders(headers) {
  const out = {};
  let n = 0;
  for (const [name, value] of headers.entries()) {
    if (n >= MAX_RESPONSE_HEADERS) break;
    const text = String(value ?? "");
    out[String(name).toLowerCase()] = text.length > MAX_HEADER_CHARS ? `${text.slice(0, MAX_HEADER_CHARS)}…` : text;
    n += 1;
  }
  return out;
}

const PAYMENT_REQUIRED = "payment-required";
const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
const PAYMENT_RESPONSE = "payment-response";
const MAX_REDIRECTS = 5;

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

// Servers advertise extensions in PaymentRequired and clients echo them in PaymentPayload;
// the client must include at least the info it received. Dropping the field is a spec
// violation and loses whatever the server needed echoed back.
export function buildPaymentPayload({ requirement, resource, transaction, extensions }) {
  const payload = {
    x402Version: 2,
    resource: resource || { url: "", description: "chip402 payment", mimeType: "application/json" },
    accepted: requirement,
    payload: { transaction },
  };
  // "The client must include at least the info received; it may append additional info but
  // cannot delete or overwrite existing info." Copied verbatim, whatever shape it arrived in.
  if (extensions && typeof extensions === "object") payload.extensions = extensions;
  return payload;
}

export class FacilitatorCallError extends Error {
  constructor(code, message, status, body) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export async function facilitatorCall(
  facilitator,
  path,
  body,
  {
    apiKey = "",
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
  } = {},
) {
  const base = String(facilitator || FACILITATOR).replace(/\/$/, "");
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal(timeoutMs),
    });
  } catch (err) {
    throw new FacilitatorCallError(
      "facilitator_unreachable",
      `Facilitator ${path} unreachable: ${err.message}`,
    );
  }
  let text;
  try {
    text = await readCapped(res, { maxBytes });
  } catch (err) {
    throw new FacilitatorCallError(
      err.code === "response_too_large" ? "response_too_large" : "facilitator_error",
      `Facilitator ${path}: ${err.message}`,
    );
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const reason = json?.invalidReason || json?.errorReason || json?.error || text.slice(0, 240);
    // A rate limit or a rejected key is an infrastructure answer, not a declined payment,
    // and must not be recorded as one.
    const code =
      res.status === 401 || res.status === 403
        ? "facilitator_unauthorized"
        : res.status === 429
          ? "facilitator_rate_limited"
          : "facilitator_error";
    throw new FacilitatorCallError(code, `Facilitator ${path} ${res.status}: ${reason}`, res.status, json);
  }
  return json;
}

// The wire code says which rule was broken; the message says which account or amount broke
// it. Only reporting the code throws away every diagnostic the facilitator produced.
export function facilitatorReason(code, message, fallback) {
  return [code, message].filter(Boolean).join(": ") || fallback;
}

export async function verifyAndSettle({ facilitator, paymentPayload, paymentRequirements, apiKey = "" }) {
  const payload = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };
  const verify = await facilitatorCall(facilitator, "/verify", payload, { apiKey });
  if (verify && verify.isValid === false) {
    const error = new Error(facilitatorReason(verify.invalidReason, verify.invalidMessage, "facilitator rejected payment"));
    error.code = verify.invalidReason || "verify_failed";
    error.body = verify;
    throw error;
  }
  const settle = await facilitatorCall(facilitator, "/settle", payload, { apiKey });
  if (settle && settle.success === false) {
    const error = new Error(facilitatorReason(settle.errorReason, settle.errorMessage, "settlement failed"));
    error.code = settle.errorReason || "settle_failed";
    error.body = settle;
    throw error;
  }
  return { verify, settle };
}

async function readBody(response, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const text = await readCapped(response, { maxBytes });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

async function timedFetch(fetchImpl, url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    return await fetchImpl(url, { ...init, signal: requestSignal(timeoutMs, init.signal) });
  } catch (err) {
    if (isAbortError(err)) {
      const error = new Error(`Timed out fetching ${url}`);
      error.code = "timeout";
      throw error;
    }
    throw err;
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sameOrigin(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && left.host === right.host;
  } catch {
    return false;
  }
}

function redirectDenied(reason) {
  const error = new Error(reason);
  error.code = "redirect_denied";
  return error;
}

// The unpaid probe may be redirected, but every hop is re-checked against the allowlist:
// otherwise a seller redirects to a host that was never allowed and its 402 is the one we
// evaluate.
async function fetchFollowing(url, init, checkHost, fetchImpl = fetch) {
  let current = url;
  const first = checkHost ? checkHost(url) : { ok: true };
  if (!first.ok) {
    const error = new Error(first.reason || `Host not allowed: ${url}`);
    error.code = first.code || "host_denied";
    error.policy = first;
    throw error;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await timedFetch(fetchImpl, current, { ...init, redirect: "manual" });
    if (!isRedirect(res.status)) return { response: res, url: current };
    const location = res.headers.get("location");
    if (!location) return { response: res, url: current };
    await cancelBody(res);
    const next = new URL(location, current).toString();
    const decision = checkHost ? checkHost(next) : { ok: true };
    if (!decision.ok) {
      throw redirectDenied(decision.reason || `Redirect to a host that is not allowed: ${next}`);
    }
    current = next;
  }
  throw redirectDenied(`Too many redirects from ${url}`);
}

export async function payAndFetch({
  url,
  method = "GET",
  headers = {},
  body,
  accountId,
  privateKeyRaw,
  facilitator = FACILITATOR,
  feePayer,
  network = TESTNET.id,
  decide,
  checkHost,
  onSigned,
  fetchImpl = fetch,
}) {
  const requestHeaders = { ...headers };
  const init = {
    method,
    headers: requestHeaders,
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;

  const probe = await fetchFollowing(url, init, checkHost, fetchImpl);
  const first = probe.response;
  const resourceUrl = probe.url;
  if (first.status !== 402) {
    const payload = await readBody(first);
    return {
      paid: false,
      status: first.status,
      url: resourceUrl,
      headers: boundedHeaders(first.headers),
      ...payload,
    };
  }

  const firstBody = await readBody(first);
  const paymentRequired = decodePaymentRequired(first, firstBody.text);
  if (!paymentRequired) {
    throw new Error("402 response had no PAYMENT-REQUIRED payload");
  }
  const profile = resolveNetwork(network);
  if (Number(paymentRequired.x402Version || 0) === 1 || paymentRequired.accepts?.some?.((item) => item?.maxAmountRequired != null)) {
    const error = new Error("Seller speaks x402 v1; chip402 is v2-only");
    error.code = "unsupported_version";
    throw error;
  }
  const requirement = pickHederaRequirement(paymentRequired, profile);
  const decision = decide
    ? await decide({ url: resourceUrl, paymentRequired, requirement })
    : { ok: true };
  if (!decision.ok) {
    const error = new Error(decision.reason || "policy denied");
    error.code = decision.code || "denied";
    error.policy = decision;
    throw error;
  }
  if (!requirement) {
    throw new Error(`No ${profile.id} exact USDC option advertised`);
  }
  if (!feePayer) {
    const error = new Error("No discovered facilitator fee payer — refusing to sign");
    error.code = "fee_payer_unknown";
    throw error;
  }
  // The discovered fee payer is an assertion, never a substitution. Rewriting the invoice's
  // extra.feePayer would make paymentPayload.accepted disagree with the requirements the
  // resource server hands the facilitator, which is a guaranteed
  // accepted_payment_requirements_mismatch rejection instead of a clean skip.
  const advertised = requirement.extra?.feePayer;
  if (advertised !== feePayer) {
    const error = new Error(
      `Invoice feePayer ${advertised || "(none)"} is not the ${feePayer} advertised by ${facilitator}/supported`,
    );
    error.code = "fee_payer_mismatch";
    throw error;
  }
  const chosen = requirement;
  const signed = await signExactTransfer({
    payerAccountId: accountId,
    privateKeyRaw,
    payTo: chosen.payTo,
    amount: chosen.amount,
    feePayer: advertised,
    asset: chosen.asset || profile.usdc,
    network: chosen.network || profile.id,
    maxTimeoutSeconds: chosen.maxTimeoutSeconds,
  });
  // Never log the transaction body: it is a signed, spendable transfer.
  await log("signed x402 transfer", {
    url: resourceUrl,
    amount: chosen.amount,
    payTo: chosen.payTo,
    txId: signed.transactionId,
    bytes: signed.transaction.length,
    nodes: signed.nodeAccountIds,
    validFor: signed.validDurationSeconds,
  });

  // The daemon records the transaction id before the retry goes out, so a crash mid-flight
  // leaves something the reconciler can look up on the mirror node.
  if (onSigned) await onSigned({ signed, requirement: chosen, resourceUrl });

  const resource = paymentRequired.resource || {
    url: resourceUrl,
    description: "chip402 payment",
    mimeType: "application/json",
  };
  const paymentPayload = buildPaymentPayload({
    requirement: chosen,
    resource,
    transaction: signed.transaction,
    extensions: paymentRequired.extensions,
  });

  const signatureHeader = b64json(paymentPayload);
  await log("x402 payment header", {
    txId: signed.transactionId,
    headerBytes: signatureHeader.length,
    nodes: signed.nodeAccountIds.length,
  });
  const retryHeaders = {
    ...requestHeaders,
    [PAYMENT_SIGNATURE]: signatureHeader,
  };
  // The paid retry carries a signed, spendable transfer. It is never followed anywhere the
  // allowlist has not cleared, and never to a different origin than the one the payment was
  // constructed for.
  const second = await timedFetch(fetchImpl, resourceUrl, {
    ...init,
    headers: retryHeaders,
    redirect: "manual",
  });
  if (isRedirect(second.status)) {
    await cancelBody(second);
    const location = second.headers.get("location");
    const next = location ? new URL(location, resourceUrl).toString() : "";
    const allowed = next && checkHost ? checkHost(next) : { ok: false, reason: "no redirect target" };
    const error = redirectDenied(
      !next
        ? "Paid retry was redirected without a target"
        : !allowed.ok
          ? `Paid retry redirected to a host that is not allowed: ${next}`
          : `Paid retry redirected off-origin to ${next} — the payment was constructed for ${resourceUrl}`,
    );
    error.signed = signed;
    error.requirement = chosen;
    throw error;
  }
  const secondBody = await readBody(second, { maxBytes: MAX_RESOURCE_BYTES });
  const settlement = parseB64json(header(second.headers, PAYMENT_RESPONSE));

  return {
    paid: true,
    status: second.status,
    url: resourceUrl,
    headers: Object.fromEntries(second.headers.entries()),
    paymentRequired,
    requirement: chosen,
    paymentPayload,
    signed,
    settlement,
    ...secondBody,
  };
}

export function paymentRequiredBody({
  url,
  payTo,
  amount,
  feePayer,
  description,
  mimeType,
  profile = TESTNET,
  extensions,
  maxTimeoutSeconds = 180,
}) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url,
      description: description || "Paid resource",
      mimeType: mimeType || "application/json",
    },
    ...(extensions && typeof extensions === "object" ? { extensions } : {}),
    accepts: [
      {
        scheme: "exact",
        network: profile.id,
        amount: String(amount),
        asset: profile.usdc,
        payTo,
        maxTimeoutSeconds,
        extra: { feePayer: feePayer || profile.feePayer },
      },
    ],
  };
}

export { sameOrigin };
