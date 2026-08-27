// A real payment, on hedera:testnet, against a seller we did not write the payment code for —
// and checked against the mirror node directly rather than against anything the daemon told us.
// It needs an installed, running, funded daemon, so it is off unless CHIP402_LIVE=1 and excluded
// from the default run.
//
//   CHIP402_LIVE=1 node --test test/live.test.ts        # pays in HBAR, to 0.0.5005
//   CHIP402_LIVE=1 CHIP402_SELLER_ACCOUNT=0.0.x CHIP402_SELLER_ASSET=usdc node --test test/live.test.ts
//
// The seller it starts picks its own facilitator — see demo/seller.ts, and CHIP402_FACILITATOR to
// point it somewhere else.

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

  // A seller paying itself proves nothing, so this points at an account that is not ours. Anything
  // works; the point is that chip402 has never seen it before.
  //
  // HBAR by default, and that is not laziness: a token transfer to an account that is not
  // associated with the token fails at consensus with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT, and
  // `0.0.5005` has no auto-association slots — so the USDC form of this test could never pass
  // against the default counterparty, whatever chip402 did. Every account can receive HBAR. Set
  // CHIP402_SELLER_ASSET=usdc with a CHIP402_SELLER_ACCOUNT that can hold it to run the other one.
  const payTo = process.env["CHIP402_SELLER_ACCOUNT"] ?? "0.0.5005";
  const asset: AssetKey = process.env["CHIP402_SELLER_ASSET"] === "usdc" ? "usdc" : "hbar";
  const other: AssetKey = asset === "usdc" ? "hbar" : "usdc";
  await assertCanReceive(config.network, payTo, asset);
  const seller = spawn(
    "node",
    ["demo/seller.ts", "--pay-to", payTo, "--port", String(SELLER_PORT), "--asset", asset],
    { stdio: "inherit" },
  );
  t.after(() => seller.kill());
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const session = await open(`${RUNTIME}/spend.sock`);
  t.after(() => session.close());

  const before = (await session.ask({ cmd: "purse" })) as Record<string, any>;
  const spentBefore = BigInt(before["assets"][asset].spent);

  // One tool call, one URL the agent has never seen, no allowlist and no prompt.
  const reply = (await session.ask({ cmd: "pay", url: `http://127.0.0.1:${SELLER_PORT}/secret` })) as Record<string, any>;
  assert.equal(reply["ok"], true, String(reply["reason"]));
  assert.equal(reply["paid"], true);

  // SECURITY: the transaction id is ours, out of the bytes the daemon signed — not the seller's
  // claim. `onChain` is the mirror node having confirmed it before we stopped waiting.
  const receipt = reply["receipt"] as Record<string, any>;
  assert.match(String(receipt["txId"]), /^\d+\.\d+\.\d+@\d+\.\d+$/);

  // Two very different things can go wrong from here, and a live test that cannot tell them apart
  // is worse than none: chip402 could be wrong, or the facilitator — a third party the seller
  // chooses, and the only thing in the flow that submits anything to Hedera — could simply not
  // have settled. The chain is what separates them. Past `validStart + TransactionValidDuration`
  // the transaction can never reach consensus, so an id still absent then was never submitted.
  if (receipt["onChain"] !== true) {
    const stillAbsent = async (): Promise<boolean> => {
      const url = `${config.network.mirror}/api/v1/transactions/${toMirrorId(String(receipt["txId"]))}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      return response.status === 404;
    };
    // The lane is shut for the same window, so this wait is not idle time added to the test.
    await new Promise((resolve) => setTimeout(resolve, 125_000));
    assert.ok(await stillAbsent(), "the mirror node showed it late — chip402 stopped waiting too early");

    // Then everything chip402 owes us on that path, asserted rather than waved past. This is the
    // "seller takes a signature and never settles" row of the README's table, live.
    const unpaid = (await session.ask({ cmd: "purse" })) as Record<string, any>;
    assert.equal(BigInt(unpaid["assets"].usdc.spent), spentBefore, "a payment that never settled was counted");
    assert.equal(unpaid["inFlight"], 0, "a transaction that can never arrive was still counted");
    assert.equal(receipt["onChain"], false, "the receipt claimed a settlement the chain never had");
    assert.fail(
      `the facilitator did not settle ${receipt["txId"]} — it is absent from the mirror node past its ` +
        `validity window, so nothing was submitted. chip402 behaved correctly on that path (nothing ` +
        `counted, lane reopened, receipt honest), and everything above this line passed. Check the ` +
        `facilitator the seller chose before reading this as a defect here: ` +
        `${config.network.mirror}/api/v1/transactions/${toMirrorId(String(receipt["txId"]))}`,
    );
  }
  assert.match(String(reply["body"]), /cheese/);

  const after = (await session.ask({ cmd: "purse" })) as Record<string, any>;
  const spentAfter = BigInt(after["assets"][asset].spent);
  // The figure moved by exactly the invoice, and by nothing else — the other asset did not move.
  assert.equal(spentAfter - spentBefore, BigInt(receipt["amount"]));
  assert.equal(BigInt(after["assets"][other].spent), BigInt(before["assets"][other].spent));

  // The row the panel shows is a row the chain returned, and it names our transaction.
  const row = (after["assets"][asset].payments as Record<string, any>[]).find((p) => p["txId"] === receipt["txId"]);
  assert.ok(row, "the payment is not in the list the panel is drawn from");
  assert.equal(BigInt(row["amount"]), BigInt(receipt["amount"]));
  assert.equal(row["payTo"], payTo);

  // THE POINT OF THIS TEST: ask the mirror node ourselves and compare, for both assets. If the
  // daemon were still keeping its own ledger, this is the assertion that would catch it drifting.
  const direct = await mirrorSpend(config.network.mirror, accountId, config.network, dayStart(Date.now()));
  assert.equal(direct[asset], spentAfter, `the panel and the chain disagree about ${asset}`);
  assert.equal(direct[other], BigInt(after["assets"][other].spent), `the panel and the chain disagree about ${other}`);

  // And the transfer really moved our money to the seller, in the token we agreed on.
  const url = `${config.network.mirror}/api/v1/transactions/${toMirrorId(String(receipt["txId"]))}`;
  const settled = ((await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()) as {
    transactions?: Record<string, any>[];
  }).transactions?.find((tx) => tx["result"] === "SUCCESS");
  assert.ok(settled, "the mirror node has no successful transaction with that id");
  const transfers = (settled[asset === "usdc" ? "token_transfers" : "transfers"] ?? []) as {
    account: string;
    amount: number;
    token_id?: string;
  }[];
  const paid = transfers.find((entry) => entry.account === payTo && entry.amount > 0);
  assert.ok(paid, "no positive transfer to the seller");
  assert.equal(String(paid.amount), String(receipt["amount"]));
  if (asset === "usdc") assert.equal(paid.token_id, config.network.assets.usdc.id);
});

// A token transfer to an account that cannot hold the token fails at consensus, and it fails as a
// *transaction* — so chip402 does exactly the right thing with it (rule one of the filter drops a
// non-SUCCESS row, and the allowance is untouched) and the test learns nothing. Said here, before a
// payment is made, rather than discovered afterwards in a receipt that says the money never moved.
async function assertCanReceive(
  network: Parameters<typeof paymentsIn>[1],
  payTo: string,
  asset: AssetKey,
): Promise<void> {
  if (asset === "hbar") return;
  const response = await fetch(`${network.mirror}/api/v1/accounts/${payTo}`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `mirror node said ${response.status} about ${payTo}`);
  const account = (await response.json()) as {
    max_automatic_token_associations?: number;
    balance?: { tokens?: { token_id?: string }[] };
  };
  const associated = (account.balance?.tokens ?? []).some((row) => row.token_id === network.assets.usdc.id);
  const slots = account.max_automatic_token_associations ?? 0;
  assert.ok(
    associated || slots === -1 || slots > 0,
    `${payTo} cannot receive ${network.assets.usdc.id}: no association and no free auto-association slot. ` +
      `The transfer would fail at consensus with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT, which costs the ` +
      `allowance nothing and proves nothing. Point CHIP402_SELLER_ACCOUNT at an account that can hold ` +
      `the token, or leave CHIP402_SELLER_ASSET unset to pay in HBAR.`,
  );
}

// --- the mirror node's own filter, against the real thing ---------------------------------------

async function rowsFrom(url: string): Promise<Record<string, any>[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `mirror node said ${response.status} for ${url}`);
  return ((await response.json()) as { transactions?: Record<string, any>[] }).transactions ?? [];
}

test("type=debit keeps every payment of ours and drops money arriving", { skip: !LIVE }, async () => {
  // `readTransactions` falls back to `&type=debit` when the wide walk overflows, and the whole
  // safety of that rests on a property of somebody else's server: that the mirror node's debit
  // filter reads the *token* transfer list too. Every x402 payment this account makes is a token
  // debit with no HBAR entry for us at all — the facilitator pays the fee — so a filter that only
  // looked at HBAR would hide all of them and the purse would under-count what it had spent.
  //
  // Measured here rather than assumed, against the public mirror node, over a window wide enough
  // to contain real history. `src/chain.ts` cites this test by name.
  const config = loadConfig(process.env["CHIP402_CONFIG"] ?? "/etc/chip402/config.json");
  assert.ok(config.accountId, "run `sudo chip402ctl setup` first");
  const accountId = config.accountId;
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const query = `account.id=${accountId}&timestamp=gte:${(since / 1000).toFixed(9)}&order=desc&limit=100`;
  const base = `${config.network.mirror}/api/v1/transactions?`;

  const wide = await rowsFrom(`${base}${query}`);
  const narrow = await rowsFrom(`${base}${query}&type=debit`);
  assert.ok(wide.length > 0, "no history in the window, so this proves nothing");

  // Narrower is only worth anything if it drops something, and only safe if it drops nothing of
  // ours. Both halves, on the same rows.
  const ids = (rows: Record<string, any>[]) => new Set(rows.map((row) => String(row["transaction_id"])));
  const kept = ids(narrow);
  const dropped = [...wide].filter((row) => !kept.has(String(row["transaction_id"])));
  for (const row of dropped) {
    const mine = [...(row["transfers"] ?? []), ...(row["token_transfers"] ?? [])].filter(
      (entry: Record<string, any>) => entry["account"] === accountId,
    );
    assert.ok(
      mine.length > 0 && mine.every((entry: Record<string, any>) => Number(entry["amount"]) >= 0),
      `type=debit dropped a row where we were debited: ${row["transaction_id"]}`,
    );
  }

  // And, said the way chain.ts relies on it: the payment set is identical through both queries.
  const through = (rows: Record<string, any>[]) =>
    paymentsIn(rows as never[], config.network, accountId, since)
      .map((payment) => `${payment.txId}/${payment.asset}/${payment.amount}`)
      .sort();
  assert.deepEqual(through(narrow), through(wide), "the narrow query lost a payment of ours");

  // A token-only debit is the case that matters, so fail loudly if the window happened not to
  // contain one rather than passing on a window that could not have shown the difference.
  const tokenOnly = paymentsIn(wide as never[], config.network, accountId, since).filter(
    (payment) => payment.asset === "usdc",
  );
  assert.ok(tokenOnly.length > 0, "no token payment in the window, so the interesting case is untested");
});
