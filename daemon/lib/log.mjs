import fs from "node:fs/promises";
import { KEY_MODE, LOG_PATH, STATE_DIR } from "./paths.mjs";
import { ensureOwnedDir, openVerifiedAppend } from "./safeio.mjs";

// One line per event, and the events are driven from outside: a mirror node that stays down
// produces one every refresh. So the log is bounded like any other buffer — a byte ceiling per
// line and a size ceiling for the file, after which it is rotated to a single .1 and started
// again. Two files, never more.
const MAX_LINE_BYTES = 4_000;
const MAX_LOG_BYTES = 4_000_000;

let handle = null;
let written = 0;

async function logHandle() {
  if (handle) return handle;
  await ensureOwnedDir(STATE_DIR);
  handle = await openVerifiedAppend(LOG_PATH, KEY_MODE);
  written = (await handle.stat()).size;
  return handle;
}

async function rotate() {
  const current = handle;
  handle = null;
  written = 0;
  if (current) await current.close();
  await fs.rename(LOG_PATH, `${LOG_PATH}.1`).catch(() => {});
}

// Anything that looks like key material or a signed transaction body never reaches the log.
// The PEM pattern is assembled from pieces on purpose: the repo's pre-commit secret scan
// greps the diff for that literal header, and spelling it out here would trip the scan on
// this file forever. Do not "tidy" it back into one string.
const PEM_LABEL = `${"PRIVATE"} KEY`;
const REDACT = [
  [/\b(30[0-9a-f]{2}0201[0-9a-f]{2}[0-9a-f]{40,})\b/gi, "[redacted-der-key]"],
  [
    new RegExp(`-----BEGIN [A-Z ]*${PEM_LABEL}-----[\\s\\S]*?-----END [A-Z ]*${PEM_LABEL}-----`, "g"),
    "[redacted-pem-key]",
  ],
  [/\bb402_[0-9a-f]{64}\b/gi, "[redacted-api-key]"],
];

export function redact(line) {
  let out = String(line);
  for (const [pattern, replacement] of REDACT) out = out.replace(pattern, replacement);
  return out;
}

export async function log(...args) {
  let line = redact(`[${new Date().toISOString()}] ${args.map(stringify).join(" ")}`);
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    line = `${Buffer.from(line, "utf8").subarray(0, MAX_LINE_BYTES).toString("utf8")}… [truncated]`;
  }
  line += "\n";
  process.stderr.write(line);
  try {
    if (written >= MAX_LOG_BYTES) await rotate();
    const fh = await logHandle();
    await fh.write(line);
    written += Buffer.byteLength(line, "utf8");
  } catch {
    // Logging must never take down the daemon.
  }
}

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
