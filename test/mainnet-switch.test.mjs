// "CHIP402_NETWORK=mainnet with MAINNET_SHIPPED=true needs no other code change."
// Proven rather than asserted: copy the tree, flip the one constant, and run a real daemon on
// hedera:mainnet. The copy gets an empty config directory with no key in it, so nothing can be
// signed even in principle, and nothing here calls /fetch.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { daemonTarget, daemonUp, call } from "../daemon/lib/client.mjs";
import { MAINNET_SHIPPED, NETWORKS } from "../daemon/lib/networks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NETWORKS_FILE = "daemon/lib/networks.mjs";
let tree;
let child;
let target;
let status;

before(async () => {
  tree = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-mainnet-"));
  for (const entry of ["daemon", "Model.js", "manifest.json"]) {
    fs.cpSync(path.join(root, entry), path.join(tree, entry), { recursive: true });
  }
  const file = path.join(tree, NETWORKS_FILE);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace("export const MAINNET_SHIPPED = false;", "export const MAINNET_SHIPPED = true;");
  assert.notEqual(after, before, "MAINNET_SHIPPED is not where it is expected to be");
  fs.writeFileSync(file, after);

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-mainnet-cfg-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-mainnet-state-"));
  const socket = path.join(stateDir, "m.sock");
  child = spawn(process.execPath, [path.join(tree, "daemon", "chip402d.mjs")], {
    cwd: tree,
    env: {
      ...process.env,
      CHIP402_NETWORK: "mainnet",
      CHIP402_CONFIG_DIR: configDir,
      CHIP402_STATE_DIR: stateDir,
      CHIP402_SOCKET: socket,
      CHIP402_NO_MAIN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  target = daemonTarget({ socketPath: socket });
  for (let i = 0; i < 80 && !(await daemonUp(target)); i += 1) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(await daemonUp(target), "the mainnet daemon never came up");
  await call(target, "POST", "/refresh");
  status = await call(target, "GET", "/status");
  assert.equal(fs.existsSync(path.join(configDir, "key")), false, "the mainnet copy must have no key");
});

after(() => child?.kill("SIGTERM"));

test("this build still ships testnet-only", () => {
  assert.equal(MAINNET_SHIPPED, false);
  assert.match(fs.readFileSync(path.join(root, NETWORKS_FILE), "utf8"), /MAINNET_SHIPPED = false;/);
});

test("flipping the constant is the whole diff", () => {
  const mine = fs.readFileSync(path.join(root, NETWORKS_FILE), "utf8").split("\n");
  const theirs = fs.readFileSync(path.join(tree, NETWORKS_FILE), "utf8").split("\n");
  const differing = mine.map((line, i) => (line === theirs[i] ? null : i)).filter((i) => i !== null);
  assert.equal(differing.length, 1, `expected one changed line, got ${differing.length}`);
  assert.match(theirs[differing[0]], /MAINNET_SHIPPED = true;/);
});

test("the daemon comes up on hedera:mainnet with the mainnet profile", () => {
  assert.equal(status.network, "hedera:mainnet");
  assert.equal(status.asset, NETWORKS["hedera:mainnet"].usdc);
  assert.equal(status.facilitator, "https://api.blocky402.com");
  assert.equal(status.hashscan, "https://hashscan.io/mainnet");
  assert.equal(status.mainnetShipped, false, "the /status flag reports this build, not the copy");
});

test("mainnet defaults are the tighter ones", () => {
  assert.equal(status.dailyCapMicro, "1000000", "1 USDC");
  assert.equal(status.perRequestMicro, "100000", "0.10 USDC");
  assert.equal(status.maxFloatMicro, "5000000", "5 USDC float");
});

test("the mainnet fee payer is discovered from the live facilitator, not from source", () => {
  assert.equal(status.facilitatorError, "", `discovery failed: ${status.facilitatorError}`);
  assert.equal(status.feePayer, "0.0.10571514");
  assert.equal(status.feePayerPinned, "", "nothing about the fee payer is pinned in the profile");
  assert.equal(NETWORKS["hedera:mainnet"].feePayer, "");
});

test("with no account and no key it can only refuse", async () => {
  assert.equal(status.configured, false);
  assert.equal(status.accountId, "");
  await assert.rejects(
    () => call(target, "POST", "/fetch", { url: "https://api.example/thing" }),
    (err) => {
      assert.equal(err.status, 403, "a mainnet payment must never be attempted from this fixture");
      assert.equal(err.body.code, "host_denied");
      return true;
    },
  );
});
