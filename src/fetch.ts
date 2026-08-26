// The fetch we hand to the x402 SDK. `globalThis.fetch` is never given to it, because the
// wrapper does three things to a seller's response before any policy of ours has run: it
// follows redirects and then reports the *final* URL, it reads the 402 body with no cap and no
// deadline, and it hands the decoded requirements straight on. A hostile seller is the normal
// case here — the agent picks the URL — so all three are closed in this one file.

// The daemon always uses these. They are a parameter only so the hostile-seller tests can run a
// never-ending response against a one-second deadline instead of a fifteen-second one — nothing
// reads them from a config file, so there is no setting an attacker could widen.
export const LIMITS = {
  // One megabyte of paid content is generous for pocket money, and an unbounded read is how a
  // seller crashes the daemon without spending anything.
  maxBodyBytes: 1024 * 1024,
  // Every request gets a deadline. A seller that never finishes a response otherwise holds the
  // single payment lane open forever, which costs the seller nothing.
  timeoutMs: 15_000,
  // Same-origin redirects are ordinary; three is more than any real seller needs.
  maxRedirects: 3,
  // A 402 offering thousands of ways to pay is not a menu, it is a way to make us spend a
  // second on parsing per request.
  maxAccepts: 8,
};

export type Limits = typeof LIMITS;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
// These statuses are defined to have no body, and constructing a Response with one throws.
const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);

// What the seller's 402 actually said, taken off the wire before the SDK touches it: the URL
// that answered — not the URL the agent typed — and the protocol version it declared. The
// wallet creates one of these per payment and reads it inside the guarded signer.
export type Sighting = { finalUrl: string; x402Version: number };

async function readCapped(response: Response, limits: Limits): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // SECURITY: cancel rather than drain. Reading to the end to find out how big it was is the
    // bug, not the measurement.
    if (total > limits.maxBodyBytes) {
      await reader.cancel();
      throw new Error(`seller response exceeded ${limits.maxBodyBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// A 402 carries its terms in the PAYMENT-REQUIRED header, as base64 JSON. We decode it here to
// note two things the SDK would otherwise digest before we see them, and then throw our copy
// away — the SDK decodes it again for real.
function inspectOffer(response: Response, seen: Sighting, limits: Limits): void {
  // Version 0 means "no v2 offer was made". The SDK falls back to a v1 body when this header is
  // missing, and policy.ts refuses anything that is not 2 — so the downgrade dies here by
  // simply never being recorded as a version we accept.
  seen.x402Version = 0;
  if (response.status !== 402) return;
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return;
  let decoded: { x402Version?: unknown; accepts?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    // Unparseable is the SDK's error to report; ours is only what we can read off it.
    return;
  }
  if (typeof decoded?.x402Version === "number") seen.x402Version = decoded.x402Version;
  // SECURITY: counting the offers early means a 10,000-entry accepts[] never reaches the
  // selector, which walks it once per registered scheme.
  if (Array.isArray(decoded?.accepts) && decoded.accepts.length > limits.maxAccepts) {
    throw new Error(`seller offered ${decoded.accepts.length} payment options; the cap is ${limits.maxAccepts}`);
  }
}

export function hardenedFetch(seen: Sighting, limits: Limits = LIMITS): typeof globalThis.fetch {
  return async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init);

    for (let hop = 0; ; hop++) {
      // SECURITY: `redirect: "manual"` is what stops the wrapper from ever seeing a URL we did
      // not approve. Without it, https://harmless.example → 302 → https://evil.example serves
      // the 402 and the check runs against the harmless name.
      const response = await globalThis.fetch(
        new Request(request, { redirect: "manual", signal: AbortSignal.timeout(limits.timeoutMs) }),
      );

      if (REDIRECT_STATUS.has(response.status)) {
        if (hop >= limits.maxRedirects) throw new Error("too many redirects from the seller");
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect with no location");
        const target = new URL(location, request.url);
        // SECURITY: this is the line that makes the redirect check meaningful. Same host, same
        // scheme, same port, or we do not go — a seller cannot hand its 402 to somebody else.
        if (target.origin !== new URL(request.url).origin) {
          throw new Error(`seller redirected off-origin to ${target.origin}`);
        }
        // 307 and 308 promise the method and body survive; the older three do not, and the
        // browser rule is to fall back to GET.
        const keepMethod = response.status === 307 || response.status === 308;
        request = keepMethod
          ? new Request(target, request)
          : new Request(target, { method: "GET", headers: request.headers });
        continue;
      }

      inspectOffer(response, seen, limits);
      const bytes = BODYLESS_STATUS.has(response.status) ? null : await readCapped(response, limits);
      const capped = new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      // A Response's url is read-only and defaults to empty when you build one by hand, and the
      // SDK reads it. Setting it to the URL that answered keeps our record honest.
      Object.defineProperty(capped, "url", { value: request.url });
      seen.finalUrl = request.url;
      return capped;
    }
  };
}
