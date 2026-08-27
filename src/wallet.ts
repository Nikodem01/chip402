// The only thing in the process that touches the key, and the door the check is bolted to.
// `createClientHederaSigner` appears exactly once in the whole of src/ — right here, wrapped —
// and the signer it returns never leaves this closure. So there is no way to produce a
// signature without policy.decide having said yes first.

import { AccountId, PrivateKey, createClientHederaSigner, createHederaClient, ExactHederaScheme, inspectHederaTransaction } from "@x402/hedera";
import type { ClientHederaSigner } from "@x402/hedera";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { Network, PaymentRequirements } from "@x402/fetch";
import type { AssetKey } from "./networks.ts";
import { assetFor } from "./networks.ts";
import type { Ledger } from "./chain.ts";
import { readLedger, transactionSeen, validStartOf } from "./chain.ts";
import { digits, parseUnits } from "./money.ts";
import { dayStart, decide } from "./policy.ts";
import type { PolicyConfig } from "./policy.ts";
import type { Purse } from "./purse.ts";
import type { Labels } from "./labels.ts";
import type { Limits, Sighting } from "./fetch.ts";
import { LIMITS, hardenedFetch } from "./fetch.ts";
import { credentialPath, readSecret } from "./safe.ts";

// The denial has to survive a trip through the SDK, which catches our throw and re-throws it as
// "Failed to create payment payload: …". A prefix we can find again is cheaper than a custom
// error class the SDK would discard.
const DENIED = "chip402-denied: ";

export function denialReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const at = message.indexOf(DENIED);
  return at === -1 ? null : message.slice(at + DENIED.length).split("\n")[0] ?? null;
}

// The SDK's spendControls and scheme registry are the independent second opinion, and they run
// *before* our guard — spend controls filter the offers during selection, and a v1 body has no
// registered client at all. When one of them fires first the agent would otherwise get a
// paragraph about SDK configuration, so their three refusals are translated into the same
// vocabulary policy.ts uses. The check happened twice; only the wording is ours.
const SECOND_OPINION: [RegExp, string][] = [
  [/rejected by spendControls/, "over the per-payment cap"],
  [/No client registered for x402 version/, "unsupported x402 version"],
  [/filtered out by policies|No network\/scheme registered/, "seller takes nothing we can pay"],
];

function translate(error: unknown): unknown {
  if (denialReason(error) !== null) return error;
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, reason] of SECOND_OPINION) {
    if (pattern.test(message)) return new Error(DENIED + reason);
  }
  return error;
}

// What one payment did, as this process knows it. The transaction id is **ours** — read out of
// the bytes we signed, not out of the PAYMENT-RESPONSE header the seller writes — so it is a
// fact about what we authorised rather than a claim about what somebody else then did with it.
// `onChain` says whether the mirror node had it by the time we stopped waiting.
export type Receipt = {
  readonly txId: string | null;
  readonly at: number;
  readonly asset: AssetKey;
  readonly amount: string;
  readonly host: string;
  readonly url: string;
  onChain: boolean;
};

export type PaidResult = {
  status: number;
  contentType: string | null;
  body: string;
  paid: boolean;
  receipt: Receipt | null;
};

// How long a payment waits at its tail for the mirror node to catch up. Indexing lag is a
// couple of seconds, and the facilitator has already waited for a consensus receipt before the
// seller could answer 200 — so this is patience for the ordinary case, not a timeout for the
// hostile one. Giving up here does not release anything: the lane stays closed until the chain
// answers or until the transaction can no longer reach it.
const SETTLE_WAIT_MS = 20_000;
const SETTLE_POLL_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// SECURITY: the guard. `inner` is the real signer and is never handed out; every caller in the
// process reaches the key through this object or not at all. Deliberately not the SDK's
// onBeforePaymentCreation hook — a hook is a convention that a direct call to the scheme walks
// straight past, and the check has to be on the same side of the door as the key.
//
// One of these is built per payment and thrown away after, which is what makes `signed` below a
// per-payment fact rather than a global one.
export function guard(
  inner: ClientHederaSigner,
  purse: Purse,
  config: PolicyConfig,
  seen: Sighting,
  onCharge: (receipt: Receipt) => void,
): ClientHederaSigner {
  let signed = false;
  return {
    accountId: inner.accountId,
    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
      // SECURITY: one signature per pay(), stated rather than inherited. The README used to
      // argue this was safe because we register no onPaymentResponse hook and because the
      // sighting resets on the 200 — both true, both incidental, and both an SDK release away
      // from not being true. A signed `exact` transfer is a bearer instrument; two of them is
      // twice the money.
      if (signed) throw new Error(DENIED + "a second signature was asked for in one payment");

      const now = Date.now();
      let amount: bigint;
      try {
        amount = parseUnits(requirements.amount);
      } catch {
        throw new Error(DENIED + "unparseable amount");
      }
      const decision = decide(
        {
          // The URL and version come from what actually answered, recorded by our own fetch —
          // not from anything the SDK re-derived after following a redirect.
          finalUrl: seen.finalUrl,
          x402Version: seen.x402Version,
          network: requirements.network,
          assetId: requirements.asset,
          amount,
          payTo: requirements.payTo,
          feePayer: requirements.extra?.["feePayer"],
        },
        purse.state,
        config,
        now,
      );
      if (!decision.ok) throw new Error(DENIED + decision.reason);

      // SECURITY: the lane closes on the way to the key, not on the way back — and it is written
      // to disk here, before anything is signed. Both halves matter and they are the same fix.
      //
      // Durable, because the daemon that has to honour this lock may not be this one. `settling`
      // used to live only in memory, so a restart between the signature and the mirror node
      // catching up came back with the lane open and authorised a second payment against a ledger
      // that did not yet contain the first — demonstrated end to end, and reachable by anyone who
      // could `systemctl restart chip402` inside the indexing window, or by `Restart=on-failure`
      // after a crash.
      //
      // Before, because a write that cannot be made has to be a refusal rather than a surprise.
      // Taken here it is a denial with nothing signed; taken after the signature it would be a
      // payment that has already been authorised failing on a file operation, which is the exact
      // shape of bug the label store was rewritten to make impossible. The id is not known yet, so
      // this first lock carries none — `now` is a deliberate over-estimate of the deadline, since
      // the SDK generates validStart three to eight seconds in the *past*, and the refinement
      // below replaces it with the truth.
      try {
        purse.beginSettling(null, now);
      } catch {
        throw new Error(DENIED + "the settling lock could not be written");
      }

      // Set before the key is reached, not after. Whatever the signer then does — returns,
      // throws, hangs — this payment has had its one signature.
      signed = true;
      let payload: string;
      try {
        payload = await inner.createPartiallySignedTransferTransaction(requirements);
      } catch (error) {
        // The signer builds and signs locally and returns the bytes; there is no network in it.
        // A throw therefore means no payload was produced, so nothing can have left this process
        // — the caller submits what it is handed, and it was handed an exception. Releasing the
        // lane here is what keeps a signer that refuses a malformed request from costing two
        // minutes of denial per attempt. Anything that could return bytes *and* throw would have
        // to release them itself, and there is no such path.
        purse.finishSettling();
        throw error;
      }

      // The transaction id out of the bytes we just signed. It is in the signed body, so the
      // facilitator cannot change it and the seller never gets a say in what it is. This is the
      // id every later question is asked about: did it settle, what did it move, where does the
      // HashScan link go.
      let txId: string | null = null;
      try {
        txId = inspectHederaTransaction(payload).transactionId ?? null;
      } catch {
        // Bytes we cannot read back are bytes we cannot ask the chain about. The lane is already
        // shut — with no id, only the clock can reopen it, which is the fail-closed reading of
        // "we do not know what we just signed".
      }
      const validStart = txId === null ? null : validStartOf(txId);
      try {
        // Name it, so the chain can end the wait rather than only the clock. This second write
        // moves the deadline to the one measured from `validStart`, which is *earlier* than
        // the one above, so a failure here leaves a lock that is honoured for a few seconds longer
        // than it needed to be — a denial, never an extra payment, which is why this one is
        // allowed to fail and the first one is not.
        purse.beginSettling(txId, validStart ?? now);
      } catch {
        // Deliberately nothing. See above.
      }

      // The host is recorded by the caller, not here — see payer(). The guard is about the key
      // and the decision; a display label is neither, and does not belong on the same side of
      // this door.
      const host = new URL(seen.finalUrl).host;
      onCharge({ txId, at: now, asset: decision.asset.key, amount: amount.toString(), host, url: seen.finalUrl, onChain: false });
      return payload;
    },
  };
}

// Wait for a transaction we signed to show up on the mirror node, and reopen the lane the moment
// it does. Two exits and no third: the chain has it, or the chain can never have it. Giving up
// on patience is not an exit — it leaves the lane closed and lets policy.ts deny until one of
// the two real answers arrives.
//
// The boolean is the receipt's `onChain`, and it is a claim about the chain rather than about who
// asked it. That distinction is load-bearing: `pollChain` runs every 60 s and is *not* serialized
// against a payment in flight — `inLane` wraps `pay`, not the poll — so a refresh landing between
// the signature and this call can clear the lane first. This used to return `false` there and put
// `onChain: false` on a receipt for a payment that had settled a moment earlier. The ledger was
// right either way, but the receipt was not, and a receipt that lies in the pessimistic direction
// is still a receipt that lies. So when the lane is open and this call did not open it, the
// question goes to the mirror node instead of to the lock.
export async function settle(
  config: PolicyConfig,
  purse: Purse,
  txId: string | null,
  patienceMs: number = SETTLE_WAIT_MS,
): Promise<boolean> {
  const giveUpAt = Date.now() + patienceMs;
  for (;;) {
    const settling = purse.state.settling;
    if (settling === null) {
      // Somebody else ended the wait: `refresh()` from the chain-poll loop, or the clock inside
      // it. Ask the chain what actually happened. An id we never read back, or a mirror node that
      // will not answer, is reported as "not seen" — the honest reading of the one thing this
      // field claims.
      if (txId === null) return false;
      return transactionSeen(config.network, txId).catch(() => false);
    }
    const now = Date.now();
    if (now >= settling.deadline) {
      // validStart + TransactionValidDuration has passed, *and* the margin the mirror node is
      // allowed to be behind that. Hedera will not accept the transaction now and the mirror has
      // had long enough to start showing it if it ever will, so it is not "not yet", it is "never".
      // Those are two different instants and the lock waits for the later one — see
      // INDEXING_MARGIN_MS. Nothing is given back because nothing was taken: a payment that never
      // settled simply never appears in the chain's sum.
      purse.finishSettling();
      return false;
    }
    if (txId !== null) {
      try {
        if (await transactionSeen(config.network, txId)) {
          purse.finishSettling();
          return true;
        }
      } catch {
        // An unreachable mirror node is not evidence of anything. Keep the lane closed and try
        // again; the deadline is what ends this loop if it never comes back.
      }
    }
    if (Date.now() >= giveUpAt) return false;
    await sleep(SETTLE_POLL_MS);
  }
}

// Ask the chain everything, in the order that makes the answer usable: resolve anything in
// flight first, so that the ledger we then read either contains it or provably never will.
export async function refresh(
  config: PolicyConfig,
  purse: Purse,
  publicKeyHex: string,
  evmAddress: string | null,
): Promise<Ledger> {
  const settling = purse.state.settling;
  if (settling !== null) {
    if (Date.now() >= settling.deadline) purse.finishSettling();
    else if (settling.txId !== null && (await transactionSeen(config.network, settling.txId).catch(() => false))) {
      purse.finishSettling();
    }
  }
  // Local midnight, and nothing earlier. This used to widen the window to `now - 120 s` whenever
  // something was settling, on the theory that a transaction signed just before midnight has to be
  // looked for in yesterday too — but nothing ever looked. `readLedger` hands its rows to
  // `paymentsIn`, which drops every row before `since`, and the in-flight question is asked by
  // `transactionSeen` above: a direct lookup of one id, which has no window at all. So the reach
  // back fetched rows only to throw them away, and every one of them counted against the page
  // bound that chain.ts's fallback exists to keep us under. A payment signed at 23:59:30 that
  // reaches consensus at 00:00:02 is in today's window on its own merits, because the chain dates
  // it by consensus and not by signature.
  return readLedger(config.network, config.accountId, publicKeyHex, evmAddress, dayStart(Date.now()));
}

export type Wallet = {
  readonly accountId: string;
  // SECURITY: derived from the key this wallet holds, never read back from a config file. An
  // address you are told to send money to has to be the address of the key that would spend it,
  // or a top-up is a donation to whoever wrote the config. Null for an ED25519 key, which has no
  // EVM address — such an account is funded by its 0.0.x id instead.
  readonly evmAddress: string | null;
  // The account id with its HIP-15 checksum, e.g. "0.0.10193689-wkdxo". The five letters are
  // derived from the id *and the ledger id*, so they differ per network and any single-character
  // change to the id changes all five. That makes it something a human can actually compare
  // against a second source, which a forty-two character hex address is not.
  readonly accountWithChecksum: string;
  // Three states. Null until the first mirror read, and null again whenever the chain's answer
  // is one we do not claim to understand — see readKeyMatch.
  readonly verified: boolean | null;
  pay(url: string, init?: RequestInit): Promise<PaidResult>;
  refresh(): Promise<void>;
};

// The payment path, with the real signer injected. Everything a hostile seller can reach is on
// this function, which is why the tests drive it directly with a stub in place of the key.
export function payer(
  inner: ClientHederaSigner,
  config: PolicyConfig,
  purse: Purse,
  labels: Labels,
  refreshChain: () => Promise<void>,
  limits: Limits = LIMITS,
  patienceMs: number = SETTLE_WAIT_MS,
): (url: string, init?: RequestInit) => Promise<PaidResult> {
  const network = config.network;

  return async function pay(url: string, init?: RequestInit): Promise<PaidResult> {
    // Nothing in this process knows what has been spent today until the mirror node says so, and
    // an answer policy.ts considers stale is a denial — so every payment starts by asking.
    await refreshChain();

    // Everything below is built per payment and thrown away after, so no state about one
    // seller can leak into the next one.
    const seen: Sighting = { finalUrl: url, x402Version: 0 };
    let charged: Receipt | null = null;
    const signer = guard(inner, purse, config, seen, (receipt) => {
      charged = receipt;
      // One short append, the moment the transaction id and the host are both known. This runs
      // after the signature, so it must not be able to fail a payment that has already been
      // authorised — every write in labels.ts is best-effort for exactly that reason, and the
      // store's whole contract is that losing it costs names and nothing else.
      labels.record(receipt.txId, receipt.host);
    });

    const usdcAsset = network.assets.usdc;
    const hbarAsset = network.assets.hbar;
    const client = x402Client.fromConfig({
      // Registered for v2 only. A v1 offer therefore has no client at all, which is the
      // structural half of refusing a downgrade; policy.ts is the stated half.
      schemes: [{ network: network.caip2 as Network, client: new ExactHederaScheme(signer), x402Version: 2 }],
      // An independent second opinion on the per-payment cap, by a different implementation
      // than policy.ts. USDC is in the SDK's USD-pegged default table so its cap is a dollar
      // string; HBAR is not in that table, so it has to be opted in with an atomic tinybar cap.
      spendControls: {
        maxAmountPerPayment: `$${digits(purse.state.usdc.maxPayment, usdcAsset)}`,
        allowedAssets: [
          {
            network: network.caip2 as Network,
            asset: hbarAsset.id,
            maxAmountPerPayment: purse.state.hbar.maxPayment.toString(),
          },
        ],
      },
      paymentRequirementsSelector: (_version, accepts) => {
        // Pinned to our network row, and USDC wins when a seller offers both — it is the stable
        // one, so a receipt means the same thing tomorrow as it did today.
        const mine = accepts.filter((r) => r.network === network.caip2 && assetFor(network, r.asset) !== undefined);
        const chosen = mine.find((r) => r.asset === usdcAsset.id) ?? mine[0];
        if (!chosen) throw new Error(DENIED + "seller takes nothing we can pay");
        return chosen;
      },
    });

    let response: Response;
    try {
      response = await wrapFetchWithPayment(hardenedFetch(seen, limits), client)(url, init);
    } catch (error) {
      // A signature that went out and then hit a wall still holds the lane: the chain is the
      // only thing that can say whether it settled, and until it does, nothing else may spend.
      throw translate(error);
    }
    const body = await response.text();

    // The seller's PAYMENT-RESPONSE header is not read at all, here or anywhere. It used to
    // supply the transaction id on a receipt; the id in the bytes we signed is the same id and
    // is not the seller's to write, so a whole class of seller-controlled input is simply gone.
    //
    // `onChain` is the mirror node's answer and not this process's memory — see settle().
    if (charged !== null) {
      const receipt = charged as Receipt;
      receipt.onChain = await settle(config, purse, receipt.txId, patienceMs);
      // Once the chain has it, read the chain again — so the panel, the CLI and the next
      // decision all see this payment as a row the mirror node returned rather than as
      // something we remembered doing. It is the last step of the payment and the reason the
      // figures on screen match a direct mirror query a second after one goes out.
      if (receipt.onChain) await refreshChain().catch(() => undefined);
    }

    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
      paid: charged !== null,
      receipt: charged,
    };
  };
}

// SECURITY: the anti-brick counter's two numbers. A mismatch has to be read three times, a minute
// apart, before it stops payment — so a mirror node having a bad minute, or an account mid-update,
// costs nothing. Anything we could not parse never gets here at all: readKeyMatch returns null for
// it, and null resets the count exactly like a match does.
//
// The gap is a parameter of `openWallet` for the same reason `patienceMs` is one of `payer`: a test
// that had to wait two real minutes to reach the third reading would not be written. Nothing reads
// it from a config file, so there is no setting an attacker could widen.
const STRIKE_GAP_MS = 60_000;
const STRIKES_TO_DENY = 3;

export function openWallet(
  config: PolicyConfig,
  purse: Purse,
  labels: Labels,
  strikeGapMs: number = STRIKE_GAP_MS,
): Wallet {
  // The key is read once, from the tmpfs systemd decrypted the TPM2-sealed credential into. It
  // lives in this closure and is never stored on the Wallet object, so nothing that holds a
  // wallet holds a key.
  const key = PrivateKey.fromStringDer(readSecret(credentialPath("chip402-key")));
  const inner = createClientHederaSigner(config.accountId, key, { network: config.network.caip2 });

  // Only an ECDSA key has an EVM address. This is the address the panel offers for a top-up, and
  // it is computed here from the key rather than trusted from anywhere.
  let evmAddress: string | null = null;
  try {
    evmAddress = key.publicKey.toEvmAddress();
  } catch {
    evmAddress = null;
  }
  const publicKeyHex = key.publicKey.toStringRaw().toLowerCase();
  let verified: boolean | null = null;

  // Offline: this builds a client only to read its ledger id, and closes it immediately. No
  // consensus node is contacted here or anywhere else in the daemon.
  let accountWithChecksum = config.accountId;
  try {
    const client = createHederaClient(config.network.caip2);
    try {
      accountWithChecksum = AccountId.fromString(config.accountId).toStringWithChecksum(client);
    } finally {
      client.close();
    }
  } catch {
    // An id we cannot checksum is still an id; the panel just shows it bare.
  }

  let strikes = 0;
  let lastStrike = 0;

  const observe = (ledger: Ledger): void => {
    // The counter counts *readings*, so it must not advance on one the purse refuses as overtaken
    // — see Purse.observe. Work out what this reading would do to the count, offer it, and keep the
    // answer only if it was taken; otherwise three "different key" readings could be one reading
    // arriving three times out of order.
    const disagrees = ledger.verified === false;
    const counts = disagrees && (strikes === 0 || ledger.at - lastStrike >= strikeGapMs);
    const nextStrikes = disagrees ? (counts ? strikes + 1 : strikes) : 0;
    if (!purse.observe(ledger, nextStrikes >= STRIKES_TO_DENY)) return;
    verified = ledger.verified;
    strikes = nextStrikes;
    lastStrike = disagrees ? (counts ? ledger.at : lastStrike) : 0;
  };

  const refreshChain = async (): Promise<void> => {
    observe(await refresh(config, purse, publicKeyHex, evmAddress));
  };

  return {
    accountId: config.accountId,
    evmAddress,
    accountWithChecksum,
    get verified() {
      return verified;
    },
    pay: payer(inner, config, purse, labels, refreshChain),
    refresh: refreshChain,
  };
}

export type { AssetKey };
