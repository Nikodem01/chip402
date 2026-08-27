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
import type { Authorization } from "./purse.ts";
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

// How long the *caller* waits at the tail of its own payment for the mirror node to catch up, so
// that the receipt it is handed says what the chain says. Indexing lag is a couple of seconds and
// the facilitator has already waited for a consensus receipt before the seller could answer 200, so
// this is patience for the ordinary case rather than a timeout for the hostile one.
//
// It bounds one caller and nothing else. Other payments do not queue behind it — there is no lane
// to hold — and giving up does not abandon the question: `resolve` carries on asking in the
// background until the chain answers or the transaction can no longer reach it.
const SETTLE_WAIT_MS = 20_000;
const SETTLE_POLL_MS = 1_000;

// Unref'd: a background `resolve` still asking about a payment must never be the reason a process
// stays alive. The daemon is held open by its listeners, and nothing else should be held open by a
// question about a transaction that may never have happened.
const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });

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
  onCharge: (receipt: Receipt, entry: Authorization) => void,
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

      // SECURITY: the amount is committed against the day on the way to the key, not on the way
      // back, and it is written to disk here, before anything is signed. Three things ride on that
      // ordering and they are all the same fix.
      //
      // *Before the key*, because `decide` has just read the figure this raises and there is no
      // `await` between the two. Two payments cannot both see the same figure and both pass, so a
      // hundred at once are counted exactly — which is why this daemon needs no lane and no lock,
      // and why concurrency is no longer bought with latency.
      //
      // *Durable*, because the daemon that has to honour this may not be this one. It used to live
      // in memory alone, so a restart between the signature and the mirror node catching up came
      // back knowing nothing and authorised a second payment against a day that did not yet contain
      // the first — demonstrated end to end, and reachable by anyone who could
      // `systemctl restart chip402` inside the indexing window, or by `Restart=on-failure`.
      //
      // *Allowed to throw*, because a write that cannot be made has to be a refusal rather than a
      // surprise. Taken here it is a denial with nothing signed; taken after the signature it would
      // be a payment already authorised failing on a file operation. The id is not known yet, so
      // `now` is a deliberate over-estimate of the deadline — the SDK dates validStart three to
      // eight seconds in the *past* — and the refinement below replaces it with the truth.
      let entry: Authorization;
      try {
        entry = purse.authorize(decision.asset.key, amount, now);
      } catch {
        throw new Error(DENIED + "the payment could not be written down");
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
        // — the caller submits what it is handed, and it was handed an exception. Giving the
        // amount back here is what keeps a signer that refuses a malformed request from holding
        // part of the allowance for two minutes per attempt. Anything that could return bytes
        // *and* throw would have to give it back itself, and there is no such path.
        purse.abandon(entry);
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
        // Bytes we cannot read back are bytes we cannot ask the chain about. The amount is already
        // committed — with no id, only the deadline can end it, which is the fail-closed reading of
        // "we do not know what we just signed".
      }
      const validStart = txId === null ? null : validStartOf(txId);
      purse.identify(entry, txId, validStart ?? now);

      // The host is recorded by the caller, not here — see payer(). The guard is about the key
      // and the decision; a display label is neither, and does not belong on the same side of
      // this door.
      const host = new URL(seen.finalUrl).host;
      onCharge(
        { txId, at: now, asset: decision.asset.key, amount: amount.toString(), host, url: seen.finalUrl, onChain: false },
        entry,
      );
      return payload;
    },
  };
}

// Ask the chain about one payment we authorised, and keep asking until it answers. There are two
// answers and no third: the chain has it, or the chain can never have it. Running out of patience
// is not an answer — it only stops the *caller* waiting, and the asking carries on in the
// background, because an authorisation nobody finished resolving would hold part of the day against
// a payment that may never have happened.
//
// The boolean is the receipt's `onChain`, and it is a claim about the chain rather than about this
// process's memory. Nothing else is waiting on it: payments do not queue behind one another any
// more, so a slow answer here costs one caller a few seconds of latency and costs nobody else
// anything at all.
//
// `reread` is only reached by an authorisation we could never name — bytes we signed and could not
// read back. Its deadline is the only thing that can end it, and letting go on the clock alone
// would forget a payment that did happen, so the day is read once more first and `Purse.observe`
// raises the figure if the chain shows it. Every other entry is answered for by its own id.
export async function resolve(
  config: PolicyConfig,
  purse: Purse,
  entry: Authorization,
  patienceMs: number = SETTLE_WAIT_MS,
  reread?: () => Promise<unknown>,
): Promise<boolean> {
  const giveUpAt = Date.now() + patienceMs;
  for (;;) {
    if (entry.txId !== null) {
      try {
        if (await transactionSeen(config.network, entry.txId)) {
          purse.settled(entry);
          return true;
        }
      } catch {
        // An unreachable mirror node is not evidence of anything. Ask again; the deadline is what
        // ends this loop if it never comes back.
      }
    }
    const now = Date.now();
    if (now >= entry.deadline) {
      // validStart + TransactionValidDuration has passed, *and* the margin the mirror node is
      // allowed to be behind it — see INDEXING_MARGIN_MS. Hedera will not accept the transaction
      // now and the mirror has had long enough to start showing it if it ever will, so this is not
      // "not yet", it is "never". Nothing is given back because nothing was taken.
      if (entry.txId === null && reread !== undefined) await reread().catch(() => undefined);
      purse.abandon(entry);
      return false;
    }
    if (now >= giveUpAt) {
      // The caller's patience, not the question's. Hand back what we know and go on asking with the
      // time the entry has left.
      void resolve(config, purse, entry, entry.deadline - now, reread).catch(() => undefined);
      return false;
    }
    await sleep(SETTLE_POLL_MS);
  }
}

// Read the chain. Two requests: the account, for the balances and the key check, and one walk of
// the day's outgoing transactions.
//
// This is not on the payment path and that is the point. It runs when the daemon starts, when the
// local day rolls over, and when somebody is actually looking at the panel — not before and after
// every payment, and not on a timer. What a payment needs to know, this process already knows: it
// signed every transaction that could have moved the figure, and only its own key can make the
// balance smaller. The daemon used to ask the mirror node roughly 1,440 times a day to be told
// things it had told the mirror node itself.
//
// `maxPages` is the difference between the two callers. The reading that seeds a day has to reach
// the end of it; the reading that keeps a panel current takes the newest page and stops, because
// its sum may only ever raise the figure and never set it.
export async function refresh(
  config: PolicyConfig,
  purse: Purse,
  publicKeyHex: string,
  evmAddress: string | null,
  maxPages?: number,
): Promise<Ledger> {
  return readLedger(config.network, config.accountId, publicKeyHex, evmAddress, dayStart(Date.now()), maxPages);
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
  // A reading of the chain. With no argument it walks the whole day and is what seeds a new one;
  // with `1` it takes the newest page for the display's sake and may be dropped if the last
  // reading was recent. See `refresh` and the shared reader in `openWallet`.
  refresh(maxPages?: number): Promise<void>;
  // Ask the chain about everything a previous daemon signed and was not around to hear the answer
  // for. Returns as soon as each has been asked once; the asking continues in the background.
  resume(): Promise<void>;
};

// The payment path, with the real signer injected. Everything a hostile seller can reach is on
// this function, which is why the tests drive it directly with a stub in place of the key.
export function payer(
  inner: ClientHederaSigner,
  config: PolicyConfig,
  purse: Purse,
  labels: Labels,
  refreshChain: (maxPages?: number) => Promise<void>,
  limits: Limits = LIMITS,
  patienceMs: number = SETTLE_WAIT_MS,
): (url: string, init?: RequestInit) => Promise<PaidResult> {
  const network = config.network;

  return async function pay(url: string, init?: RequestInit): Promise<PaidResult> {
    // The chain is asked here only when this process does not yet have a day to measure against:
    // the first payment after a start, and the first after local midnight. Every payment in between
    // decides against a figure this process maintains itself, because it signed everything that
    // could have moved it. That is the whole difference between a purse that can serve
    // per-request metering and one that cannot — the mirror node used to be asked twice per
    // payment, and every answer was a page of rows it had already been told about.
    const spent = purse.state.spent;
    if (spent === null || spent.dayStart !== dayStart(Date.now())) await refreshChain();

    // Everything below is built per payment and thrown away after, so no state about one
    // seller can leak into the next one.
    const seen: Sighting = { finalUrl: url, x402Version: 0 };
    let charged: Receipt | null = null;
    let authorized: Authorization | null = null;
    const signer = guard(inner, purse, config, seen, (receipt, entry) => {
      charged = receipt;
      authorized = entry;
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
    if (charged !== null && authorized !== null) {
      const receipt = charged as Receipt;
      receipt.onChain = await resolve(config, purse, authorized as Authorization, patienceMs, () => refreshChain());
      // A single page of the day, so the panel and the CLI show the payment as a row the mirror
      // node returned rather than as something we remembered doing. Not awaited and not needed:
      // the figure the next decision uses was raised the moment the chain confirmed the id, and
      // this only fetches the row behind it. `refreshChain` drops it if the last reading is recent,
      // so a hundred payments a minute do not become a hundred requests.
      if (receipt.onChain) void refreshChain(1).catch(() => undefined);
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

// How stale a reading may be before a request made for the display's sake is worth serving. It
// bounds nothing about spending — the figures a decision uses are this process's own — so it is
// chosen for how fresh a panel should look and for how little a busy purse should cost the public
// mirror node, and for nothing else.
const DISPLAY_GAP_MS = 5_000;

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

  // One reader, not many. Callers that want the chain read while a read is already running share
  // that one rather than starting a second, which is what keeps a burst of payments from becoming a
  // burst of requests. And a single-page reading — the kind a payment's tail and a connecting panel
  // ask for — is dropped outright if the last one was recent, because it is for the display and the
  // display was already right. A full reading is never dropped: it is the one that seeds a day.
  let reading: Promise<void> | null = null;
  let readAt = 0;
  const refreshChain = async (maxPages?: number): Promise<void> => {
    if (maxPages !== undefined && Date.now() - readAt < DISPLAY_GAP_MS) return;
    if (reading !== null) return reading;
    const run = (async (): Promise<void> => {
      try {
        observe(await refresh(config, purse, publicKeyHex, evmAddress, maxPages));
        readAt = Date.now();
      } finally {
        reading = null;
      }
    })();
    reading = run;
    return run;
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
    resume: async (): Promise<void> => {
      const waiting = purse.state.inFlight.map((entry) =>
        resolve(config, purse, entry, 0, () => refreshChain()).catch(() => false),
      );
      await Promise.all(waiting);
    },
  };
}

export type { AssetKey };
