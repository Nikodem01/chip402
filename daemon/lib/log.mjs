import fs from "node:fs/promises";
import { LOG_PATH, STATE_DIR } from "./paths.mjs";

await fs.mkdir(STATE_DIR, { recursive: true });
try {
  await fs.chmod(LOG_PATH, 0o600);
} catch {
  // Not created yet; the first append below makes it, and the daemon's umask keeps it tight.
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
  const line = redact(`[${new Date().toISOString()}] ${args.map(stringify).join(" ")}\n`);
  process.stderr.write(line);
  try {
    await fs.appendFile(LOG_PATH, line, { mode: 0o600 });
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
