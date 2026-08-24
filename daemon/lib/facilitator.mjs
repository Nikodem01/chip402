import { FACILITATOR_TTL_MS } from "./paths.mjs";
import { MAX_RESPONSE_BYTES, cancelBody, readCappedJson, requestSignal } from "./http.mjs";

// The trust anchor for a payment is the account that co-signs and submits it. Pinning that
// account in source means a facilitator key rotation either breaks every payment or, worse,
// is silently accepted from a stale constant. Discover it from /supported instead, and
// treat a failed discovery as a reason to stop paying rather than a reason to guess.

export class FacilitatorError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    if (status) this.status = status;
  }
}

export function supportedUrl(facilitator) {
  return `${String(facilitator || "").replace(/\/+$/, "")}/supported`;
}

export function selectKind(supported, networkId) {
  const kinds = Array.isArray(supported?.kinds) ? supported.kinds : [];
  return (
    kinds.find(
      (kind) =>
        kind &&
        Number(kind.x402Version) === 2 &&
        kind.scheme === "exact" &&
        kind.network === networkId,
    ) || null
  );
}

export function feePayerFrom(kind) {
  const value = kind?.extra?.feePayer;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function fetchSupported({
  facilitator,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const url = supportedUrl(facilitator);
  if (!facilitator) {
    throw new FacilitatorError("facilitator_unconfigured", "No facilitator configured for this network");
  }
  const headers = { accept: "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: requestSignal(timeoutMs) });
  } catch (err) {
    throw new FacilitatorError("facilitator_unreachable", `Facilitator /supported unreachable: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    await cancelBody(res);
    throw new FacilitatorError(
      "facilitator_unauthorized",
      `Facilitator rejected the API key (${res.status}) — set facilitatorApiKey`,
      res.status,
    );
  }
  if (res.status === 429) {
    await cancelBody(res);
    throw new FacilitatorError(
      "facilitator_rate_limited",
      "Facilitator rate limit hit on /supported — this is not a declined payment",
      429,
    );
  }
  if (!res.ok) {
    await cancelBody(res);
    throw new FacilitatorError("facilitator_unreachable", `Facilitator /supported ${res.status}`, res.status);
  }
  try {
    return await readCappedJson(res, { maxBytes });
  } catch (err) {
    if (err.code === "response_too_large") {
      throw new FacilitatorError(
        "facilitator_unreachable",
        `Facilitator /supported exceeded ${maxBytes} bytes`,
      );
    }
    throw new FacilitatorError("facilitator_unreachable", `Facilitator /supported is not JSON: ${err.message}`);
  }
}

export function createDiscovery({
  ttlMs = FACILITATOR_TTL_MS,
  now = () => Date.now(),
  fetchImpl = fetch,
} = {}) {
  const cache = new Map();

  function key(facilitator, network) {
    return `${facilitator}|${network}`;
  }

  async function discover({ facilitator, network, apiKey = "", force = false }) {
    const id = key(facilitator, network);
    const hit = cache.get(id);
    if (!force && hit && now() - hit.at < ttlMs) return hit;

    const supported = await fetchSupported({ facilitator, apiKey, fetchImpl });
    const kind = selectKind(supported, network);
    if (!kind) {
      cache.delete(id);
      throw new FacilitatorError(
        "facilitator_network_unsupported",
        `Facilitator no longer advertises x402 v2 exact on ${network}`,
      );
    }
    const feePayer = feePayerFrom(kind);
    if (!feePayer) {
      cache.delete(id);
      throw new FacilitatorError(
        "facilitator_no_fee_payer",
        `Facilitator advertises ${network} without extra.feePayer`,
      );
    }
    const entry = {
      facilitator,
      network,
      feePayer,
      kind,
      // Held in a long-lived cache, so the list a facilitator advertises gets a count.
      extensions: (Array.isArray(supported.extensions) ? supported.extensions : []).slice(0, 64),
      at: now(),
    };
    cache.set(id, entry);
    return entry;
  }

  // Never serves a stale fee payer: an expired entry is reported as absent so the caller
  // pauses instead of signing against a value the facilitator may have rotated away from.
  function peek({ facilitator, network }) {
    const hit = cache.get(key(facilitator, network));
    if (!hit) return null;
    if (now() - hit.at >= ttlMs) return null;
    return hit;
  }

  function invalidate({ facilitator, network } = {}) {
    if (!facilitator) return cache.clear();
    return cache.delete(key(facilitator, network));
  }

  return { discover, peek, invalidate };
}

export const discovery = createDiscovery();
