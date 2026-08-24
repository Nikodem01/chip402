import { HBAR, TESTNET, resolveNetwork } from "./networks.mjs";
import { loadSdk } from "./sdk.mjs";
import { log } from "./log.mjs";
import { FETCH_TIMEOUT_MS, cancelBody, readCappedJson, requestSignal } from "./http.mjs";

// The mirror node is not hostile, but it is not this process either: a paginated answer that
// comes back longer than asked for is truncated rather than walked to the end.
const MAX_MIRROR_ROWS = 200;

// docs.hedera.com/native/transactions/modify-fields: max network valid duration 180s, SDK
// default 120s, minimum 15s. The protobuf response-code page still says 120 is the maximum;
// it is stale — 180s transactions reach consensus on mainnet today. Do not "fix" this down.
export const MAX_VALID_DURATION_SECONDS = 180;
export const MIN_VALID_DURATION_SECONDS = 15;
export const DEFAULT_VALID_DURATION_SECONDS = 120;
export const NODE_FANOUT = 3;

export function clientFor(networkId = TESTNET.id) {
  const profile = resolveNetwork(networkId);
  const { Client } = sdkNow();
  return profile.id === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
}

function profileOf(networkOrProfile) {
  if (networkOrProfile && typeof networkOrProfile === "object" && networkOrProfile.id) {
    return resolveNetwork(networkOrProfile.id);
  }
  return resolveNetwork(networkOrProfile || TESTNET.id);
}

let sdk;

function sdkNow() {
  if (!sdk) sdk = loadSdk();
  return sdk;
}

export function parsePrivateKey(raw) {
  const { PrivateKey } = sdkNow();
  const value = String(raw || "").trim();
  const attempts = [
    () => PrivateKey.fromString(value),
    () => PrivateKey.fromStringDer(value),
    () => PrivateKey.fromStringECDSA(value),
    () => PrivateKey.fromStringED25519(value),
  ];
  let last;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("Could not parse Hedera private key");
}

export function generateOperator() {
  const { PrivateKey } = sdkNow();
  const key = PrivateKey.generateECDSA();
  return {
    key,
    der: key.toStringDer(),
    evmAddress: evmAddressFor(key),
  };
}

export function evmAddressFor(key) {
  const hex = key.publicKey.toEvmAddress();
  const body = String(hex || "").replace(/^0x/i, "").toLowerCase();
  return `0x${body}`;
}

// A hollow account has an id and an alias but no key on record, so the facilitator's key
// lookup (the reference implementation reads the mirror node's `key` field; the spec says
// AccountInfoQuery) finds nothing to check the payment signature against, and every payment
// from it is rejected with invalid_exact_hedera_payload_signature_invalid.
// Verified live: a hollow account renders as `"key": null` while `alias`, `evm_address` and
// `max_automatic_token_associations: -1` are identical in both states and prove nothing.
export function isHollowKey(key) {
  if (key == null) return true;
  if (typeof key === "string") return isZeroKeyMaterial(key);
  if (typeof key !== "object") return true;
  const material = key.key ?? key._key ?? "";
  if (!material) return true;
  return isZeroKeyMaterial(String(material));
}

function isZeroKeyMaterial(value) {
  const body = String(value || "").replace(/^0x/i, "").trim();
  if (!body) return true;
  return /^0+$/.test(body);
}

async function mirrorGet(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: requestSignal(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) {
    await cancelBody(res);
    return { status: 404, json: null };
  }
  const json = await readCappedJson(res);
  return { status: res.status, json };
}

export async function lookupAccount(evmOrId, networkOrProfile = TESTNET) {
  const id = String(evmOrId || "").trim();
  if (!id) return null;
  const profile = profileOf(networkOrProfile);
  const url = `${profile.mirror}/api/v1/accounts/${encodeURIComponent(id)}?limit=1`;
  const res = await mirrorGet(url);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Mirror node ${res.status} for ${id}`);
  }
  const body = res.json || {};
  return {
    accountId: String(body.account || body.account_id || ""),
    evmAddress: body.evm_address ? `0x${String(body.evm_address).replace(/^0x/i, "")}` : "",
    hbarTinybars: String(body.balance?.balance ?? "0"),
    keyType: body.key?._type ? String(body.key._type) : "",
    hollow: isHollowKey(body.key),
    maxAutoAssociations: Number(body.max_automatic_token_associations ?? 0),
    deleted: body.deleted === true,
  };
}

export async function tokenBalance(accountId, tokenId, networkOrProfile = TESTNET) {
  const id = String(accountId || "").trim();
  const profile = profileOf(networkOrProfile);
  const asset = tokenId || profile.usdc;
  if (!id) return { balance: "0", associated: false };
  const url = `${profile.mirror}/api/v1/accounts/${encodeURIComponent(id)}/tokens?limit=100`;
  const res = await mirrorGet(url);
  if (res.status === 404) return { balance: "0", associated: false };
  if (res.status < 200 || res.status >= 300) throw new Error(`Mirror node ${res.status} for tokens of ${id}`);
  const body = res.json || {};
  const tokens = (Array.isArray(body.tokens) ? body.tokens : []).slice(0, MAX_MIRROR_ROWS);
  const hit = tokens.find((row) => String(row.token_id) === String(asset));
  if (!hit) return { balance: "0", associated: false };
  return { balance: String(hit.balance ?? "0"), associated: true };
}

export async function usdcBalance(accountId, networkOrProfile = TESTNET) {
  const found = await tokenBalance(accountId, undefined, networkOrProfile);
  return found.balance;
}

export async function hbarBalance(accountId, networkOrProfile = TESTNET) {
  const found = await lookupAccount(accountId, networkOrProfile);
  return found?.hbarTinybars || "0";
}

export async function accountBalance(accountId, networkOrProfile = TESTNET) {
  return usdcBalance(accountId, networkOrProfile);
}

// The SDK prints `0.0.5@1700000000.000000000`; the mirror node REST API wants
// `0.0.5-1700000000-000000000`. Reconciliation depends on getting this exactly right.
export function mirrorTxId(txId) {
  const raw = String(txId || "").trim().replace(/\?scheduled$/, "").replace(/\/\d+$/, "");
  if (!raw) return "";
  if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(raw)) return raw;
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(raw);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// Independent confirmation that money moved. Returns null when the network has never seen
// the transaction, which is the only safe signal that a reservation can be released.
export async function lookupTransaction(txId, networkOrProfile = TESTNET) {
  const id = mirrorTxId(txId);
  // An unparseable id must never be mistaken for "the network has never seen this", because
  // that is the signal that releases a reservation.
  if (!id) {
    const error = new Error(`Unparseable transaction id: ${txId}`);
    error.code = "bad_transaction_id";
    throw error;
  }
  const profile = profileOf(networkOrProfile);
  const url = `${profile.mirror}/api/v1/transactions/${encodeURIComponent(id)}`;
  const res = await mirrorGet(url);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new Error(`Mirror node ${res.status} for transaction ${id}`);
  const body = res.json || {};
  const rows = (Array.isArray(body.transactions) ? body.transactions : []).slice(0, MAX_MIRROR_ROWS);
  if (rows.length === 0) return null;
  const ok = rows.filter((entry) => String(entry.result || "") === "SUCCESS");
  // The parent is the row the caller asked about; children carry nonce > 0 and scheduled
  // children carry scheduled: true, and both are timestamped before it.
  const parent =
    rows.find((entry) => Number(entry.nonce || 0) === 0 && entry.scheduled !== true) || rows[0];
  return {
    transactionId: String(parent.transaction_id || id),
    result: String(parent.result || ""),
    success: ok.length > 0,
    consensusTimestamp: String(parent.consensus_timestamp || ""),
    tokenTransfers: ok
      .flatMap((entry) => (Array.isArray(entry.token_transfers) ? entry.token_transfers : []))
      .slice(0, MAX_MIRROR_ROWS),
    transfers: ok
      .flatMap((entry) => (Array.isArray(entry.transfers) ? entry.transfers : []))
      .slice(0, MAX_MIRROR_ROWS),
    name: String(parent.name || ""),
    rows: rows.length,
  };
}

// How much of `asset` the transaction actually moved from `from` to `to`, as a positive
// micro-amount. Used by the e2e to check the ledger against the chain, not the seller.
export function settledAmount(tx, { asset, from, to }) {
  if (!tx || !tx.success) return 0n;
  if (String(asset) === HBAR) {
    const credit = (tx.transfers || []).find((row) => String(row.account) === String(to));
    return credit ? BigInt(String(credit.amount || "0")) : 0n;
  }
  const credit = (tx.tokenTransfers || []).find(
    (row) => String(row.token_id) === String(asset) && String(row.account) === String(to),
  );
  const debit = (tx.tokenTransfers || []).find(
    (row) =>
      String(row.token_id) === String(asset) &&
      String(row.account) === String(from) &&
      BigInt(String(row.amount || "0")) < 0n,
  );
  if (!credit) return 0n;
  const moved = BigInt(String(credit.amount || "0"));
  if (from && debit && -BigInt(String(debit.amount || "0")) !== moved) return 0n;
  return moved;
}

export async function associateToken({
  accountId,
  privateKeyRaw,
  tokenId,
  network = TESTNET.id,
}) {
  const profile = profileOf(network);
  const { AccountId, TokenAssociateTransaction, TokenId } = sdkNow();
  const key = typeof privateKeyRaw === "string" ? parsePrivateKey(privateKeyRaw) : privateKeyRaw;
  const account = AccountId.fromString(accountId);
  const client = clientFor(profile.id);
  client.setOperator(account, key);
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(account)
      .setTokenIds([TokenId.fromString(tokenId || profile.usdc)])
      .freezeWith(client)
      .sign(key);
    const submit = await tx.execute(client);
    const receipt = await submit.getReceipt(client);
    return { status: String(receipt.status), transactionId: submit.transactionId.toString() };
  } catch (err) {
    const message = String(err.message || err);
    if (/TOKEN_ALREADY_ASSOCIATED/i.test(message)) return { status: "ALREADY_ASSOCIATED" };
    throw err;
  } finally {
    client.close();
  }
}

// Completing a hollow account only needs one transaction that the account itself pays for
// and signs — the network then writes the ECDSA key from the alias onto the account.
// A fee-only CryptoTransfer (no transfers at all) is the cheapest vehicle at ~127k tinybar;
// measured against 179 real testnet completions, AccountUpdate costs ~2.6x and
// TokenAssociate ~495x, and TokenAssociate charges full price even when it comes back
// TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT. Unlike the token association this used to rely on by
// accident, none of it depends on the payment being HTS-denominated.
export async function completeAccount({ accountId, privateKeyRaw, network = TESTNET.id }) {
  const profile = profileOf(network);
  const { AccountId, AccountUpdateTransaction, TransferTransaction } = sdkNow();
  const key = typeof privateKeyRaw === "string" ? parsePrivateKey(privateKeyRaw) : privateKeyRaw;
  const account = AccountId.fromString(accountId);
  const client = clientFor(profile.id);
  client.setOperator(account, key);

  async function submit(tx) {
    const signed = await tx.freezeWith(client).sign(key);
    const sent = await signed.execute(client);
    const receipt = await sent.getReceipt(client);
    return { status: String(receipt.status), transactionId: sent.transactionId.toString() };
  }

  try {
    try {
      return { vehicle: "transfer", ...(await submit(new TransferTransaction())) };
    } catch (err) {
      await log("fee-only transfer did not complete the account, trying AccountUpdate", err);
      return {
        vehicle: "account-update",
        ...(await submit(new AccountUpdateTransaction().setAccountId(account))),
      };
    }
  } finally {
    client.close();
  }
}

// Sending HBAR to an EVM alias auto-creates the account behind it. Used to stand up the
// demo merchant from the operator's own testnet balance so the demo is self-contained; the
// created account is hollow (no key on record) but a payee never signs, and auto-created
// accounts get unlimited automatic token associations so it can receive USDC immediately.
export async function fundEvmAlias({
  fromAccountId,
  privateKeyRaw,
  evmAddress,
  tinybars,
  network = TESTNET.id,
}) {
  const profile = profileOf(network);
  const { AccountId, Hbar, TransferTransaction } = sdkNow();
  const key = typeof privateKeyRaw === "string" ? parsePrivateKey(privateKeyRaw) : privateKeyRaw;
  const from = AccountId.fromString(fromAccountId);
  const to = AccountId.fromEvmAddress(0, 0, String(evmAddress).replace(/^0x/i, ""));
  const units = BigInt(String(tinybars));
  if (units <= 0n) throw new Error("tinybars must be greater than zero");
  const client = clientFor(profile.id);
  client.setOperator(from, key);
  try {
    const tx = await new TransferTransaction()
      .addHbarTransfer(from, Hbar.fromTinybars((-units).toString()))
      .addHbarTransfer(to, Hbar.fromTinybars(units.toString()))
      .setMaxTransactionFee(new Hbar(2))
      .freezeWith(client)
      .sign(key);
    const sent = await tx.execute(client);
    const receipt = await sent.getReceipt(client);
    return { status: String(receipt.status), transactionId: sent.transactionId.toString() };
  } finally {
    client.close();
  }
}

export function hashscanTransaction(txId, networkOrProfile = TESTNET) {
  const id = String(txId || "");
  if (!id) return "";
  const profile = profileOf(networkOrProfile);
  return `${profile.hashscan}/transaction/${encodeURIComponent(id)}`;
}

export function hashscanAccount(accountId, networkOrProfile = TESTNET) {
  const id = String(accountId || "");
  if (!id) return "";
  const profile = profileOf(networkOrProfile);
  return `${profile.hashscan}/account/${encodeURIComponent(id)}`;
}

export function validDurationFor(maxTimeoutSeconds) {
  const raw = Number(maxTimeoutSeconds);
  // A silent seller gets the SDK default, not the network edge.
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_VALID_DURATION_SECONDS;
  const rounded = Math.floor(raw);
  if (rounded > MAX_VALID_DURATION_SECONDS) return MAX_VALID_DURATION_SECONDS;
  if (rounded < MIN_VALID_DURATION_SECONDS) return MIN_VALID_DURATION_SECONDS;
  return rounded;
}

// Pin the transaction to a random subset of the client's address book rather than to one
// node: a single pinned node that is down or throttled fails the whole payment.
// client.network is keyed by "ip:port" and every consensus node publishes several endpoints
// (14 entries for 7 distinct node ids on testnet, 69 for 32 on mainnet), so the list has to
// be deduplicated by account id or the fanout silently collapses onto one node.
export function pickNodeAccountIds(client, count = NODE_FANOUT, pick = Math.random) {
  const network = client?.network;
  if (!network) return [];
  const values = typeof network.values === "function" ? [...network.values()] : Object.values(network);
  const seen = new Set();
  const nodes = values.filter((value) => {
    if (!value) return false;
    const id = String(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (nodes.length === 0) return [];
  const pool = [...nodes];
  const chosen = [];
  const want = Math.min(count, pool.length);
  while (chosen.length < want) {
    const index = Math.floor(pick() * pool.length) % pool.length;
    chosen.push(pool.splice(index, 1)[0]);
  }
  return chosen;
}

export async function signExactTransfer({
  payerAccountId,
  privateKeyRaw,
  payTo,
  amount,
  feePayer,
  asset,
  network = TESTNET.id,
  maxTimeoutSeconds,
}) {
  const profile = profileOf(network);
  const { AccountId, Hbar, TokenId, TransactionId, TransferTransaction } = sdkNow();
  const payer = AccountId.fromString(payerAccountId);
  const destination = AccountId.fromString(payTo);
  const sponsor = AccountId.fromString(feePayer || profile.feePayer);
  const spendAsset = asset || profile.usdc;
  const units = BigInt(String(amount));
  if (units <= 0n) throw new Error("amount must be greater than zero");
  const key = typeof privateKeyRaw === "string" ? parsePrivateKey(privateKeyRaw) : privateKeyRaw;
  const validSeconds = validDurationFor(maxTimeoutSeconds);

  const client = clientFor(profile.id);
  try {
    const tx = new TransferTransaction()
      .setTransactionId(TransactionId.generate(sponsor))
      .setTransactionValidDuration(validSeconds);
    if (spendAsset === HBAR) {
      tx.addHbarTransfer(payer, Hbar.fromTinybars((-units).toString()));
      tx.addHbarTransfer(destination, Hbar.fromTinybars(units.toString()));
    } else {
      const tokenId = TokenId.fromString(spendAsset);
      tx.addTokenTransfer(tokenId, payer, -units);
      tx.addTokenTransfer(tokenId, destination, units);
    }
    const nodes = pickNodeAccountIds(client);
    if (nodes.length > 0) tx.setNodeAccountIds(nodes);
    tx.freezeWith(client);
    const signed = await tx.sign(key);
    return {
      transaction: Buffer.from(signed.toBytes()).toString("base64"),
      transactionId: signed.transactionId.toString(),
      nodeAccountIds: nodes.map((node) => node.toString()),
      validDurationSeconds: validSeconds,
    };
  } catch (err) {
    // No single-node fallback: a transaction pinned to one node that is down simply fails,
    // and silently signing a different transaction than the caller asked for is worse than
    // surfacing the error.
    await log("signExactTransfer failed", err);
    throw err;
  } finally {
    client.close();
  }
}
