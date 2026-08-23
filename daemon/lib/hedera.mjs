import { FEE_PAYER, HASHSCAN, HBAR_ASSET, MIRROR, NETWORK } from "./paths.mjs";
import { loadSdk } from "./sdk.mjs";
import { log } from "./log.mjs";

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

export async function lookupAccount(evmOrId) {
  const id = String(evmOrId || "").trim();
  if (!id) return null;
  const url = `${MIRROR}/api/v1/accounts/${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Mirror node ${res.status} for ${id}`);
  }
  const body = await res.json();
  return {
    accountId: String(body.account || body.account_id || ""),
    evmAddress: body.evm_address ? `0x${String(body.evm_address).replace(/^0x/i, "")}` : "",
    balanceTinybars: String(body.balance?.balance ?? "0"),
  };
}

export async function accountBalance(accountId) {
  const found = await lookupAccount(accountId);
  return found ? found.balanceTinybars : "0";
}

export function hashscanTransaction(txId) {
  const id = String(txId || "");
  if (!id) return "";
  return `${HASHSCAN}/transaction/${encodeURIComponent(id)}`;
}

export function hashscanAccount(accountId) {
  const id = String(accountId || "");
  if (!id) return "";
  return `${HASHSCAN}/account/${encodeURIComponent(id)}`;
}

export async function signExactTransfer({
  payerAccountId,
  privateKeyRaw,
  payTo,
  amountTinybars,
  feePayer = FEE_PAYER,
  asset = HBAR_ASSET,
  network = NETWORK,
}) {
  const { AccountId, Client, Hbar, TokenId, TransactionId, TransferTransaction } = sdkNow();
  const payer = AccountId.fromString(payerAccountId);
  const destination = AccountId.fromString(payTo);
  const sponsor = AccountId.fromString(feePayer);
  const amount = BigInt(String(amountTinybars));
  if (amount <= 0n) throw new Error("amount must be greater than zero");
  const key = typeof privateKeyRaw === "string" ? parsePrivateKey(privateKeyRaw) : privateKeyRaw;

  function buildTransfer() {
    const tx = new TransferTransaction().setTransactionId(TransactionId.generate(sponsor));
    if (asset === HBAR_ASSET) {
      tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
      tx.addHbarTransfer(destination, Hbar.fromTinybars(amount.toString()));
    } else {
      const tokenId = TokenId.fromString(asset);
      tx.addTokenTransfer(tokenId, payer, -amount);
      tx.addTokenTransfer(tokenId, destination, amount);
    }
    return tx;
  }

  const client = network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
  try {
    const tx = buildTransfer();
    tx.freezeWith(client);
    const signed = await tx.sign(key);
    return {
      transaction: Buffer.from(signed.toBytes()).toString("base64"),
      transactionId: signed.transactionId.toString(),
    };
  } catch (err) {
    await log("freezeWith failed, falling back to node 0.0.3", err);
    const tx = buildTransfer();
    tx.setNodeAccountIds([AccountId.fromString("0.0.3")]);
    tx.freeze();
    const signed = await tx.sign(key);
    return {
      transaction: Buffer.from(signed.toBytes()).toString("base64"),
      transactionId: signed.transactionId.toString(),
    };
  } finally {
    client.close();
  }
}
