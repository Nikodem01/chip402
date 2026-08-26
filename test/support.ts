// Small builders so each test can say only what it is actually about. Everything here is a
// permissive baseline: a purse that would pay, and an invoice that would be paid. A test then
// breaks exactly one thing and asserts the reason.
//
// The one thing that is not small is `fakeMirror`. Since the chain is the ledger, almost nothing
// in this project can be tested against a stubbed number any more — the numbers come off the
// mirror node. So the tests run a real mirror node on loopback, speaking the real endpoints with
// the real row shapes, and the code under test cannot tell it apart from the public one.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountId, Hbar, TransactionId, TransferTransaction, createHederaClient, inspectHederaTransaction } from "@x402/hedera";
import type { ClientHederaSigner } from "@x402/hedera";
import type { PaymentRequirements } from "@x402/fetch";
import type { Ledger } from "../src/chain.ts";
import { NETWORKS } from "../src/networks.ts";
import type { AssetKey, NetworkRow } from "../src/networks.ts";
import type { Invoice, PolicyConfig } from "../src/policy.ts";
import { dayStart } from "../src/policy.ts";
import type { PurseState } from "../src/purse.ts";
import { Purse } from "../src/purse.ts";
import { Labels } from "../src/labels.ts";

export const testnet = NETWORKS["hedera:testnet"]!;
export const OUR_ACCOUNT = "0.0.10193689";
export const FACILITATOR = "0.0.9185802";
export const SELLER = "0.0.5005";

// The real public half of this machine's testnet key, and the EVM address derived from it. Both
// are public and both are already in the repo; they are here so `verified` can be tested against
// the shapes the mirror node actually returns rather than against invented ones.
export const OUR_PUBLIC_KEY = "02bef8508826d133c2f84ef423aaea6f9ae25b523d1f71dda76c10a90b7c9a60e0";
export const OUR_EVM_ADDRESS = "9e79d8eb87eb1290e98ec49a818b3f059d8c3636";

export const config: PolicyConfig = { network: testnet, accountId: OUR_ACCOUNT };

export const NOW = 1_800_000_000_000;

export function ledger(overrides: Partial<Ledger> = {}, now = NOW): Ledger {
  return {
    since: dayStart(now),
    at: now,
    balances: { usdc: 5_000_000n, hbar: 50_000_000_000n },
    spent: { usdc: 0n, hbar: 0n },
    payments: [],
    verified: true,
    ...overrides,
  };
}

export function purseState(overrides: Partial<PurseState> = {}): PurseState {
  return {
    paused: false,
    usdc: { allowance: 2_000_000n, maxPayment: 250_000n },
    hbar: { allowance: 10_000_000_000n, maxPayment: 1_000_000_000n },
    ledger: ledger(),
    mismatch: false,
    settling: null,
    ...overrides,
  };
}

export function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    finalUrl: "https://api.example.com/secret",
    x402Version: 2,
    network: testnet.caip2,
    assetId: testnet.assets.usdc.id,
    amount: 10_000n,
    payTo: SELLER,
    feePayer: FACILITATOR,
    ...overrides,
  };
}

export function scratch(): string {
  return mkdtempSync(join(tmpdir(), "chip402-test-"));
}

// A label store in a temp file. Every test that renders a row or makes a payment needs one, and
// none of them care what is in it, so this keeps the noise out of the tests themselves.
export function labelStore(dir: string = scratch()): Labels {
  return Labels.open(join(dir, "labels.jsonl"));
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- a mirror node on loopback ---------------------------------------------------------------

// One transaction, in the mirror node's own spelling. Amounts are plain numbers because that is
// what the real endpoint returns.
export type MirrorRow = {
  transaction_id: string;
  consensus_timestamp: string;
  result: string;
  name: string;
  transfers: { account: string; amount: number }[];
  token_transfers: { token_id: string; account: string; amount: number }[];
};

export type Mirror = {
  // A network row pointed at this server. Everything else about it is the real testnet row, so
  // the token ids and the asset table under test are the shipping ones.
  network: NetworkRow;
  balances: Record<AssetKey, bigint>;
  // What `/api/v1/accounts/:id` will say about the key. Set to null for an account with no key
  // on record, or to a KeyList shape to test the "cannot tell" path.
  key: { _type?: string; key?: string } | null;
  evmAddress: string | null;
  rows: MirrorRow[];
  // While true, a recorded payment is held back — the indexing gap between a transaction
  // reaching consensus and the mirror node answering for it.
  indexing: boolean;
  held: MirrorRow[];
  // Let everything held through, as the mirror node catching up would.
  catchUp(): void;
  // Record an x402 payment exactly as the chain shows one: SUCCESS, the facilitator as fee
  // payer, and our account down by `amount` in that asset.
  record(txId: string, asset: AssetKey, amount: bigint, at?: number): MirrorRow;
  requests: string[];
  close(): Promise<void>;
};

const mirrorSpelling = (txId: string): string => txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");

function consensusOf(at: number): string {
  const seconds = Math.floor(at / 1000);
  const nanos = String((at % 1000) * 1_000_000).padStart(9, "0");
  return `${seconds}.${nanos}`;
}

function withinRange(row: MirrorRow, query: URLSearchParams): boolean {
  for (const value of query.getAll("timestamp")) {
    const [op, at] = value.split(":");
    const bound = Number(at);
    const stamp = Number(row.consensus_timestamp);
    if (op === "gte" && !(stamp >= bound)) return false;
    if (op === "lt" && !(stamp < bound)) return false;
  }
  return true;
}

export async function fakeMirror(overrides: Partial<Pick<Mirror, "balances" | "key" | "evmAddress">> = {}): Promise<Mirror> {
  const state = {
    balances: overrides.balances ?? { usdc: 5_000_000n, hbar: 50_000_000_000n },
    key: overrides.key === undefined ? { _type: "ECDSA_SECP256K1", key: OUR_PUBLIC_KEY } : overrides.key,
    evmAddress: overrides.evmAddress === undefined ? OUR_EVM_ADDRESS : overrides.evmAddress,
    rows: [] as MirrorRow[],
    held: [] as MirrorRow[],
    indexing: false,
    requests: [] as string[],
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://mirror");
    state.requests.push(url.pathname + url.search);
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (url.pathname.startsWith("/api/v1/accounts/")) {
      send(200, {
        account: OUR_ACCOUNT,
        evm_address: state.evmAddress === null ? null : `0x${state.evmAddress}`,
        key: state.key,
        balance: {
          balance: Number(state.balances.hbar),
          tokens: [{ token_id: testnet.assets.usdc.id, balance: Number(state.balances.usdc) }],
        },
      });
      return;
    }

    const one = /^\/api\/v1\/transactions\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const found = state.rows.filter((row) => row.transaction_id === decodeURIComponent(one[1]!));
      if (found.length === 0) {
        send(404, { _status: { messages: [{ message: "Not found" }] } });
        return;
      }
      send(200, { transactions: found });
      return;
    }

    if (url.pathname === "/api/v1/transactions") {
      const limit = Number(url.searchParams.get("limit") ?? "25");
      const matching = state.rows
        .filter((row) => withinRange(row, url.searchParams))
        .sort((a, b) => Number(b.consensus_timestamp) - Number(a.consensus_timestamp))
        .slice(0, limit);
      send(200, { transactions: matching, links: { next: null } });
      return;
    }

    send(404, {});
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const network: NetworkRow = { ...testnet, mirror: `http://127.0.0.1:${port}` };

  return {
    network,
    get balances() {
      return state.balances;
    },
    set balances(value: Record<AssetKey, bigint>) {
      state.balances = value;
    },
    get key() {
      return state.key;
    },
    set key(value) {
      state.key = value;
    },
    get evmAddress() {
      return state.evmAddress;
    },
    set evmAddress(value) {
      state.evmAddress = value;
    },
    get rows() {
      return state.rows;
    },
    get held() {
      return state.held;
    },
    get indexing() {
      return state.indexing;
    },
    set indexing(value: boolean) {
      state.indexing = value;
    },
    get requests() {
      return state.requests;
    },
    catchUp() {
      state.rows.push(...state.held);
      state.held = [];
    },
    record(txId: string, asset: AssetKey, amount: bigint, at = Date.now()): MirrorRow {
      const native = asset === "hbar";
      const row: MirrorRow = {
        transaction_id: mirrorSpelling(txId),
        consensus_timestamp: consensusOf(at),
        result: "SUCCESS",
        name: "CRYPTOTRANSFER",
        transfers: native
          ? [
              { account: OUR_ACCOUNT, amount: -Number(amount) },
              { account: SELLER, amount: Number(amount) },
            ]
          : [],
        token_transfers: native
          ? []
          : [
              { token_id: testnet.assets.usdc.id, account: OUR_ACCOUNT, amount: -Number(amount) },
              { token_id: testnet.assets.usdc.id, account: SELLER, amount: Number(amount) },
            ],
      };
      // The balance moves with the transfer, because on a real chain it does — a test that let
      // them disagree would be testing a chain that does not exist.
      state.balances = { ...state.balances, [asset]: state.balances[asset] - amount };
      (state.indexing ? state.held : state.rows).push(row);
      return row;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// --- a signer with a stub where the key is, producing transactions that are otherwise real ----

// The bytes have to be a real, readable Hedera transaction: the guard reads its own transaction
// id back out of them, and a placeholder string would exercise the "we cannot tell what we
// signed" path instead of the ordinary one. Nothing here signs — freezing is enough to fix the
// id, which is the only part the guard uses.
export function frozenTransfer(payer = FACILITATOR): string {
  const client = createHederaClient(testnet.caip2);
  try {
    const transaction = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(OUR_ACCOUNT), Hbar.fromTinybars(-1))
      .addHbarTransfer(AccountId.fromString(SELLER), Hbar.fromTinybars(1))
      .setTransactionId(TransactionId.generate(AccountId.fromString(payer)))
      .freezeWith(client);
    return Buffer.from(transaction.toBytes()).toString("base64");
  } finally {
    // Closed every time, because an open client keeps a network-update timer alive and a test
    // run that will not exit is a test run nobody trusts.
    client.close();
  }
}

// A signer that produces real bytes and, when a mirror is given, tells that mirror the payment
// happened — because on the real chain the facilitator submits what we signed and the mirror
// sees it moments later.
export function testSigner(mirror?: Mirror): ClientHederaSigner & { calls: () => number } {
  let calls = 0;
  return {
    accountId: OUR_ACCOUNT,
    calls: () => calls,
    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
      calls++;
      const payload = frozenTransfer();
      if (mirror) {
        const txId = inspectHederaTransaction(payload).transactionId!;
        const asset: AssetKey = requirements.asset === testnet.assets.hbar.id ? "hbar" : "usdc";
        mirror.record(txId, asset, BigInt(requirements.amount));
      }
      return payload;
    },
  };
}

// --- a daemon you can start from the checkout, with no key, no network and no install --------

import { start } from "../src/daemon.ts";
import { open } from "../src/protocol.ts";
import type { Daemon } from "../src/daemon.ts";
import type { PaidResult, Receipt, Wallet } from "../src/wallet.ts";
import { guard, refresh, settle } from "../src/wallet.ts";

// A wallet with a stub in place of the key, but the *real* guard, the real policy, the real
// chain read and the real settlement wait in front of it — so the daemon tests exercise the
// actual enforcement path and not a re-implementation of it. Only the 402 round trip is stood in
// for, by a sleep; test/seller.test.ts drives the wire for real.
export function stubWallet(
  purse: Purse,
  labels: Labels,
  mirror: Mirror,
  price: bigint,
  delayMs = 0,
  asset: AssetKey = "usdc",
): Wallet & { signatures: () => number } {
  const walletConfig: PolicyConfig = { network: mirror.network, accountId: OUR_ACCOUNT };
  const inner = testSigner(mirror);
  const refreshChain = async (): Promise<void> => {
    purse.observe(await refresh(walletConfig, purse, OUR_PUBLIC_KEY, OUR_EVM_ADDRESS), false);
  };
  return {
    accountId: OUR_ACCOUNT,
    evmAddress: OUR_EVM_ADDRESS,
    accountWithChecksum: OUR_ACCOUNT + "-wkdxo",
    verified: true,
    signatures: inner.calls,
    refresh: refreshChain,
    async pay(url: string): Promise<PaidResult> {
      await refreshChain();
      const seen = { finalUrl: url, x402Version: 2 };
      let receipt: Receipt | null = null;
      const signer = guard(inner, purse, walletConfig, seen, (charged) => {
        receipt = charged;
        labels.record(charged.txId, charged.host);
      });
      // Stands in for the 402 round trip: the gap that makes two concurrent payments a race if
      // the daemon does not serialize them.
      await sleep(delayMs);
      await signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: mirror.network.caip2,
        asset: mirror.network.assets[asset].id,
        amount: price.toString(),
        payTo: SELLER,
        maxTimeoutSeconds: 60,
        extra: { feePayer: FACILITATOR },
      } as PaymentRequirements);
      const charged = receipt as Receipt | null;
      if (charged !== null) {
        charged.onChain = await settle(walletConfig, purse, charged.txId, 0);
        if (charged.onChain) await refreshChain();
      }
      return { status: 200, contentType: "text/plain", body: "the secret", paid: charged !== null, receipt: charged };
    },
  };
}

export type TestDaemon = {
  daemon: Daemon;
  mirror: Mirror;
  reload: () => Purse;
  signatures: () => number;
  close: () => Promise<void>;
};

export async function startTestDaemon(
  setup: (purse: Purse) => void,
  price = 10_000n,
  delayMs = 0,
): Promise<TestDaemon> {
  const dir = scratch();
  const mirror = await fakeMirror();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ network: testnet.caip2, accountId: OUR_ACCOUNT }));
  // The limits are written to disk before the daemon starts, the same way a real install does
  // it: the daemon reads purse.json once at start-up and is the only writer afterwards.
  const seed = Purse.open(join(dir, "purse.json"));
  setup(seed);
  seed.persist();

  let signatures = () => 0;
  const daemon = await start({
    configPath: join(dir, "config.json"),
    stateDir: dir,
    runtimeDir: join(dir, "run"),
    makeWallet: (_config, purse, labels) => {
      const wallet = stubWallet(purse, labels, mirror, price, delayMs);
      signatures = wallet.signatures;
      return wallet;
    },
  });
  // Assertions read the file back rather than the daemon's in-memory copy, so what they check is
  // what actually survived to disk.
  return {
    daemon,
    mirror,
    reload: () => Purse.open(join(dir, "purse.json")),
    signatures: () => signatures(),
    close: async () => {
      await daemon.close();
      await mirror.close();
    },
  };
}

export type Conn = {
  send: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>;
  pushes: Record<string, unknown>[];
  close: () => void;
};

// The same client the CLI uses, with the unsolicited frames collected so a test can assert the
// panel would have seen them.
export async function connect(path: string): Promise<Conn> {
  const session = await open(path);
  const pushes: Record<string, unknown>[] = [];
  session.onStatus((frame) => pushes.push(frame));
  return { send: session.ask, pushes, close: session.close };
}
