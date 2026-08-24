import http from "node:http";
import fs from "node:fs/promises";
import { DEFAULT_PORT, SOCKET_PATH, TOKEN_PATH } from "./paths.mjs";
import { FETCH_TIMEOUT_MS, MAX_RESOURCE_BYTES } from "./http.mjs";

// The daemon speaks HTTP over a unix socket by default. Everything that talks to it goes
// through here so the transport is decided in exactly one place.

export async function readToken() {
  try {
    const raw = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    return raw || "";
  } catch {
    return "";
  }
}

export function daemonTarget({ socketPath = SOCKET_PATH, port = DEFAULT_PORT, tcp = false } = {}) {
  if (tcp) return { tcp: true, host: "127.0.0.1", port: Number(port) };
  return { tcp: false, socketPath };
}

export function request(target, method, pathname, body, { token = "", timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { accept: "application/json" };
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  const options = target.tcp
    ? { host: target.host, port: target.port, method, path: pathname, headers }
    : { socketPath: target.socketPath, method, path: pathname, headers, host: "chip402.local" };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESOURCE_BYTES) {
          req.destroy();
          done(reject, new Error(`daemon response exceeded ${MAX_RESOURCE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
        done(resolve, { status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(reject, new Error(`daemon request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => done(reject, err));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function call(target, method, pathname, body, opts = {}) {
  const res = await request(target, method, pathname, body, opts);
  if (res.status < 200 || res.status >= 300) {
    const json = res.json || {};
    const error = new Error(json.error || json.reason || `${method} ${pathname} ${res.status}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return res.json;
}

export async function daemonUp(target, opts = {}) {
  try {
    const res = await request(target, "GET", "/status", undefined, opts);
    return res.status === 200 && res.json?.name === "chip402";
  } catch {
    return false;
  }
}
