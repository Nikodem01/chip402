// Authorization is the transport, not a header check. These tests pin both halves: the unix
// socket's permissions, and the checks that make the opt-in TCP fallback survive a browser.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-cfg-"));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chip402-state-"));
process.env.CHIP402_CONFIG_DIR = CONFIG_DIR;
process.env.CHIP402_STATE_DIR = STATE_DIR;
process.env.CHIP402_NO_MAIN = "1";

const { authorize, isLoopback } = await import("../daemon/chip402d.mjs");
const { DEFAULT_PORT } = await import("../daemon/lib/paths.mjs");
const { daemonTarget, daemonUp } = await import("../daemon/lib/client.mjs");

// A daemon of its own, on its own socket, port and directories, so these assertions describe
// this build rather than whatever else the machine happens to be running.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOCKET = path.join(STATE_DIR, "t.sock");
const PORT = 4499;
let child;

before(async () => {
  child = spawn(process.execPath, [path.join(root, "daemon", "chip402d.mjs")], {
    cwd: root,
    env: { ...process.env, CHIP402_NO_MAIN: "0", CHIP402_SOCKET: SOCKET, CHIP402_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  const target = daemonTarget({ socketPath: SOCKET });
  for (let i = 0; i < 60 && !(await daemonUp(target)); i += 1) {
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(() => child?.kill("SIGTERM"));

const TOKEN = "a".repeat(64);
const req = (headers = {}, remoteAddress) => ({ headers, socket: { remoteAddress } });

test("the IPv4-mapped loopback address is recognised", () => {
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("10.0.0.4"), false);
});

test("over the unix socket no token is needed — the filesystem already decided", () => {
  const decision = authorize(req({ host: "chip402.local" }), { tcp: false, token: "", port: DEFAULT_PORT });
  assert.equal(decision.ok, true);
});

test("anything a browser sends is refused on both transports", () => {
  for (const tcp of [false, true]) {
    assert.equal(
      authorize(req({ origin: "http://evil.example" }, "127.0.0.1"), { tcp, token: TOKEN, port: DEFAULT_PORT }).ok,
      false,
      "an Origin header must be refused",
    );
    assert.equal(
      authorize(req({ "sec-fetch-site": "cross-site" }, "127.0.0.1"), { tcp, token: TOKEN, port: DEFAULT_PORT }).ok,
      false,
      "a Sec-Fetch-* header must be refused",
    );
  }
});

test("TCP needs a bearer token, and a wrong one is not enough", () => {
  const base = { tcp: true, token: TOKEN, port: DEFAULT_PORT };
  const host = `127.0.0.1:${DEFAULT_PORT}`;
  assert.equal(authorize(req({ host }, "127.0.0.1"), base).ok, false, "no token");
  assert.equal(
    authorize(req({ host, authorization: `Bearer ${"b".repeat(64)}` }, "127.0.0.1"), base).ok,
    false,
    "wrong token",
  );
  assert.equal(
    authorize(req({ host, authorization: `Bearer ${TOKEN}` }, "127.0.0.1"), base).ok,
    true,
    "correct token",
  );
});

test("TCP validates the Host header, which is what closes DNS rebinding", () => {
  const base = { tcp: true, token: TOKEN, port: DEFAULT_PORT };
  const auth = `Bearer ${TOKEN}`;
  assert.equal(authorize(req({ host: `attacker.example:${DEFAULT_PORT}`, authorization: auth }, "127.0.0.1"), base).ok, false);
  assert.equal(authorize(req({ host: `127.0.0.1:9999`, authorization: auth }, "127.0.0.1"), base).ok, false);
  assert.equal(authorize(req({ authorization: auth }, "127.0.0.1"), base).ok, false, "no Host at all");
  assert.equal(authorize(req({ host: `localhost:${DEFAULT_PORT}`, authorization: auth }, "127.0.0.1"), base).ok, true);
});

test("TCP still refuses a non-loopback peer", () => {
  const decision = authorize(
    req({ host: `127.0.0.1:${DEFAULT_PORT}`, authorization: `Bearer ${TOKEN}` }, "192.168.1.9"),
    { tcp: true, token: TOKEN, port: DEFAULT_PORT },
  );
  assert.equal(decision.ok, false);
});

test("the daemon answers on its unix socket", async () => {
  const status = await daemonUp(daemonTarget({ socketPath: SOCKET }));
  assert.equal(status, true, "the daemon did not come up on its socket");
});

test("TCP is opt-in: the daemon binds no port even though it was given one", async () => {
  const reachable = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: PORT }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1500).unref();
  });
  assert.equal(reachable, false, `the daemon opened 127.0.0.1:${PORT} without being asked to`);
});

test("the socket is mode 0600 and owned by this user", () => {
  const info = fs.lstatSync(SOCKET);
  assert.equal(info.isSocket(), true);
  assert.equal(info.mode & 0o777, 0o600, "another local user could otherwise connect and spend");
  assert.equal(info.uid, process.getuid());
});

test("a second daemon on the same socket stands down instead of fighting over state.json", async () => {
  const second = spawn(process.execPath, [path.join(root, "daemon", "chip402d.mjs")], {
    cwd: root,
    env: { ...process.env, CHIP402_NO_MAIN: "0", CHIP402_SOCKET: SOCKET, CHIP402_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  second.stdout.resume();
  second.stderr.resume();
  const code = await new Promise((resolve) => second.once("exit", resolve));
  assert.equal(code, 0, "the second daemon should exit cleanly, not take the socket");
  assert.equal(await daemonUp(daemonTarget({ socketPath: SOCKET })), true, "the first daemon must still be serving");
});
