#!/usr/bin/env node
// The unprivileged CLI. Everything here goes to the spend socket, which is the whole point:
// there is no code path in this file that can raise a limit, so there is nothing worth an agent
// rewriting it for. It runs straight from the checkout — only the daemon gets installed.

import { ASSET_KEYS, networkFor } from "../src/networks.ts";
import type { AssetKey } from "../src/networks.ts";
import { format } from "../src/money.ts";
import { open } from "../src/protocol.ts";

// A daemon that is not running, or a socket this uid cannot reach, is an ordinary answer.
process.on("unhandledRejection", (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const RUNTIME = process.env["CHIP402_RUNTIME_DIR"] ?? "/run/chip402";

type Status = Record<string, any>;

function show(status: Status): void {
  const network = networkFor(String(status["network"]));
  if (!network) throw new Error(`the daemon reports a network I do not know: ${status["network"]}`);
  const paused = status["paused"] === true;
  console.log(`chip402 · ${status["networkLabel"]} · ${status["accountId"] ?? "not set up yet"}${paused ? " · PAUSED" : ""}`);

  // Every number below this line came off the mirror node, so when the mirror node has not
  // answered there is nothing to print. A zero here would be a claim we have not earned — and
  // policy.ts refuses to pay in this state for the same reason.
  if (Number(status["chainAt"]) === 0) {
    console.log("  the chain has not answered yet — nothing can be paid until it does");
    return;
  }
  if (status["keyMismatch"] === true) {
    console.log("  the chain says a different key controls this account; payment is refused.");
    console.log("  re-import it with `sudo chip402ctl setup --import`");
  }
  if (status["settling"] === true) console.log("  a payment is still settling");

  for (const key of ASSET_KEYS as AssetKey[]) {
    const row = status["assets"][key];
    const asset = network.assets[key];
    const off = BigInt(row.allowance) === 0n;
    console.log(
      `  ${asset.symbol.padEnd(5)} ${format(BigInt(row.balance), asset).padStart(10)} in the purse` +
        (off ? "   (off)" : ""),
    );
    if (!off) {
      console.log(
        `        today ${format(BigInt(row.spent), asset)} of ${format(BigInt(row.allowance), asset)}` +
          `, at most ${format(BigInt(row.maxPayment), asset)} per payment`,
      );
    }
  }

  // Not a list we keep — a list the chain has. Every row here is a transaction that provably
  // happened, so every HashScan link below provably resolves.
  const payments = ASSET_KEYS.flatMap((key) =>
    (status["assets"][key].payments as any[]).map((payment) => ({ payment, asset: network.assets[key as AssetKey] })),
  ).sort((a, b) => b.payment.at - a.payment.at);
  for (const { payment, asset } of payments.slice(0, 5)) {
    // The host is our own label for a counterparty the chain knows only as an account id; the
    // id is what HashScan will confirm.
    const who = payment.host ?? payment.payTo;
    console.log(
      `  ${format(BigInt(payment.amount), asset).padStart(10)}  ${who} ${status["hashscan"]}transaction/${payment.txId}`,
    );
  }
}

const [verb, argument] = process.argv.slice(2);
const session = await open(`${RUNTIME}/spend.sock`);

try {
  if (verb === "status" || verb === undefined) {
    show(await session.ask({ cmd: "purse" }));
  } else if (verb === "pause") {
    // No confirmation and no password. Anyone can hit the big red button — that asymmetry is
    // what makes it a real kill switch rather than a setting.
    await session.ask({ cmd: "pause" });
    console.log("paused. only `sudo chip402ctl resume` starts it again.");
  } else if (verb === "pay") {
    if (!argument) throw new Error("usage: chip402 pay <url>");
    const reply = await session.ask({ cmd: "pay", url: argument });
    if (reply["ok"] !== true) {
      console.error(`denied: ${reply["reason"]}`);
      process.exitCode = 1;
    } else {
      process.stdout.write(String(reply["body"]));
      if (reply["paid"] === true) console.error(`\n[paid] ${JSON.stringify(reply["receipt"])}`);
    }
  } else {
    console.error("usage: chip402 [status] | pay <url> | pause");
    process.exitCode = 2;
  }
} finally {
  session.close();
}
