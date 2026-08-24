// Outbound HTTP from a long-lived payment daemon cannot take a seller, facilitator, or
// mirror node at its word about how large a body is. Stream it, stop at a hard cap, and
// bound the whole round-trip with a deadline before anything is parsed.

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_RESOURCE_BYTES = 8_000_000;

export class ResponseLimitError extends Error {
  constructor(maxBytes) {
    super(`response exceeded ${maxBytes} bytes`);
    this.code = "response_too_large";
    this.maxBytes = maxBytes;
  }
}

export function isAbortError(err) {
  if (!err) return false;
  return err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ABORT_ERR";
}

export function requestSignal(timeoutMs = FETCH_TIMEOUT_MS, extra) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!extra) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, extra]);
  return timeout;
}

export async function cancelBody(res) {
  try {
    if (res?.body && typeof res.body.cancel === "function") await res.body.cancel();
  } catch {
    // Best effort: we already have the status/headers we needed.
  }
}

// Streaming is the only way a body is read here. res.text() and res.json() would have to
// materialize the whole body before any limit could look at it, which is a check after the
// fact and no ceiling at all — so there is no fallback to them, not even for a response that
// merely looks small. A body that cannot be streamed is refused.
export async function readCapped(res, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!res) return "";
  if (res.body === null || res.body === undefined) return "";
  if (typeof res.body.getReader !== "function") {
    const error = new Error("response body is not streamable; refusing to read it unbounded");
    error.code = "unstreamable_body";
    throw error;
  }
  return readStream(res.body, maxBytes);
}

export async function readCappedJson(res, opts = {}) {
  const text = await readCapped(res, opts);
  if (!String(text).trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const error = new Error(`response is not JSON: ${err.message}`);
    error.code = "not_json";
    throw error;
  }
}

async function readStream(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const n = value?.byteLength ?? value?.length ?? 0;
      size += n;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already over the cap; dropping the rest of the body is the point.
        }
        throw new ResponseLimitError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released it.
    }
  }
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString(
    "utf8",
  );
}

export async function fetchCapped(
  url,
  init = {},
  { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, fetchImpl = fetch, read = true } = {},
) {
  const signal = requestSignal(timeoutMs, init.signal);
  const res = await fetchImpl(url, { ...init, signal });
  if (!read) return { res, text: "" };
  const text = await readCapped(res, { maxBytes });
  return { res, text };
}
