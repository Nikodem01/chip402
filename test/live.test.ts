// A real payment, on hedera:testnet, against a seller we did not write the payment code for —
// and checked against the mirror node directly rather than against anything the daemon told us.
// It needs an installed, running, funded daemon, so it is off unless CHIP402_LIVE=1 and excluded
// from the default run.
//
//   node demo/seller.ts --pay-to <someone else's 0.0.x> &
//   CHIP402_LIVE=1 node --test test/live.test.ts

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { paymentsIn, toMirrorId } from "../src/chain.ts";
import { loadConfig } from "../src/daemon.ts";
import { dayStart } from "../src/policy.ts";
import { open } from "../src/protocol.ts";
import type { AssetKey } from "../src/networks.ts";

const LIVE = process.env["CHIP402_LIVE"] === "1";
const RUNTIME = process.env["CHIP402_RUNTIME_DIR"] ?? "/run/chip402";
const SELLER_PORT = 4403;

// The independent second source. This asks the public mirror node the same question the daemon
// asks it, through the same filter, and nothing else — so if the panel and this disagree, one of
// them is inventing a number.
async function mirrorSpend(
  mirror: string,
  accountId: string,
  network: Parameters<typeof paymentsIn>[1],
  since: number,
): Promise<Record<AssetKey, bigint>> {
  const url = `${mirror}/api/v1/transactions?account.id=${accountId}&timestamp=gte:${(since / 1000).toFixed(9)}&order=desc&limit=100`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `mirror node said ${response.status}`);
  const body = (await response.json()) as { transactions?: unknown[] };
  const total: Record<AssetKey, bigint> = { usdc: 0n, hbar: 0n };
  for (const payment of paymentsIn((body.transactions ?? []) as never[], network, accountId, since)) {
    total[payment.asset] += payment.amount;
  }
  return total;
}

test("a real testnet payment, and the panel agreeing with the chain about it", { skip: !LIVE }, async (t) => {
  const config = loadConfig(process.env["CHIP402_CONFIG"] ?? "/etc/chip402/config.json");
  assert.ok(config.accountId, "run `sudo chip402ctl setup` first");
  const accountId = config.accountId;

  // A seller paying itself proves nothing, so the walkthrough points this at an account that is
  // not ours. Anything works; the point is that chip402 has never seen it before.
  const payTo = process.env["CHIP402_SELLER_ACCOUNT"] ?? "0.0.5005";
  const seller = spawn("node", ["demo/seller.ts", "--pay-to", payTo, "--port", String(SELLER_PORT)], {
    stdio: "inherit",
  });
  t.after(() => seller.kill());
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const session = await open(`${RUNTIME}/spend.sock`);
  t.after(() => session.close());

  const before = (await session.ask({ cmd: "purse" })) as Record<string, any>;
  const spentBefore = BigInt(before["assets"].usdc.spent);

  // One tool call, one URL the agent has never seen, no allowlist and no prompt.
  const reply = (await session.ask({ cmd: "pay", url: `http://127.0.0.1:${SELLER_PORT}/secret` })) as Record<string, any>;
  assert.equal(reply["ok"], true, String(reply["reason"]));
  assert.equal(reply["paid"], true);
  assert.match(String(reply["body"]), /cheese/);

  // SECURITY: the transaction id is ours, out of the bytes the daemon signed — not the seller's
  // claim. `onChain` is the mirror node having confirmed it before we stopped waiting.
  const receipt = reply["receipt"] as Record<string, any>;
  assert.match(String(receipt["txId"]), /^\d+\.\d+\.\d+@\d+\.\d+$/);
  assert.equal(receipt["onChain"], true, "the chain had not shown the payment by the time pay() returned");

  const after = (await session.ask({ cmd: "purse" })) as Record<string, any>;
  const spentAfter = BigInt(after["assets"].usdc.spent);
  // The figure moved by exactly the invoice, and by nothing else.
  assert.equal(spentAfter - spentBefore, BigInt(receipt["amount"]));
  assert.equal(BigInt(after["assets"].hbar.spent), BigInt(before["assets"].hbar.spent));

  // The row the panel shows is a row the chain returned, and it names our transaction.
  const row = (after["assets"].usdc.payments as Record<string, any>[]).find((p) => p["txId"] === receipt["txId"]);
  assert.ok(row, "the payment is not in the list the panel is drawn from");
  assert.equal(BigInt(row["amount"]), BigInt(receipt["amount"]));
  assert.equal(row["payTo"], payTo);

  // THE POINT OF THIS TEST: ask the mirror node ourselves and compare, for both assets. If the
  // daemon were still keeping its own ledger, this is the assertion that would catch it drifting.
  const direct = await mirrorSpend(config.network.mirror, accountId, config.network, dayStart(Date.now()));
  assert.equal(direct.usdc, spentAfter, "the panel and the chain disagree about USDC");
  assert.equal(direct.hbar, BigInt(after["assets"].hbar.spent), "the panel and the chain disagree about HBAR");

  // And the transfer really moved our money to the seller, in the token we agreed on.
  const url = `${config.network.mirror}/api/v1/transactions/${toMirrorId(String(receipt["txId"]))}`;
  const settled = ((await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()) as {
    transactions?: Record<string, any>[];
  }).transactions?.find((tx) => tx["result"] === "SUCCESS");
  assert.ok(settled, "the mirror node has no successful transaction with that id");
  const transfers = (settled["token_transfers"] ?? []) as { account: string; amount: number; token_id: string }[];
  const paid = transfers.find((entry) => entry.account === payTo && entry.amount > 0);
  assert.ok(paid, "no positive transfer to the seller");
  assert.equal(String(paid.amount), String(receipt["amount"]));
  assert.equal(paid.token_id, config.network.assets.usdc.id);
});
