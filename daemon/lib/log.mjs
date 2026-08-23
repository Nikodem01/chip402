import fs from "node:fs/promises";
import { LOG_PATH, STATE_DIR } from "./paths.mjs";

await fs.mkdir(STATE_DIR, { recursive: true });

export async function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(stringify).join(" ")}\n`;
  process.stderr.write(line);
  try {
    await fs.appendFile(LOG_PATH, line);
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
