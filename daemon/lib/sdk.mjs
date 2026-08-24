import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { REVIEWED_LOCKFILE, RUNTIME_DIR } from "./paths.mjs";

const runtimePackage = path.join(RUNTIME_DIR, "package.json");
const runtimeLockfile = path.join(RUNTIME_DIR, "package-lock.json");

export function runtimeHint() {
  return "chip402 setup";
}

// The SDK is required into the process that signs transfers, so what gets loaded has to be
// the dependency graph a reviewer read: the runtime directory's lockfile must still be byte
// for byte the one committed at this SHA. A tree installed from anything else — a hand-run
// `npm install`, a half-finished upgrade, another checkout — is refused rather than trusted.
export function loadSdk() {
  let reviewed;
  try {
    reviewed = fs.readFileSync(REVIEWED_LOCKFILE, "utf8");
  } catch {
    throw new Error(`Reviewed lockfile is missing at ${REVIEWED_LOCKFILE}; refusing to load the Hedera SDK.`);
  }
  let installed = "";
  try {
    installed = fs.readFileSync(runtimeLockfile, "utf8");
  } catch {
    throw new Error(`Hedera SDK is not installed. Run: ${runtimeHint()}`);
  }
  if (installed !== reviewed) {
    throw new Error(
      `${RUNTIME_DIR} was installed from a different lockfile than this plugin ships. Run: ${runtimeHint()}`,
    );
  }
  if (!fs.existsSync(path.join(RUNTIME_DIR, "node_modules", "@hashgraph", "sdk"))) {
    throw new Error(`Hedera SDK is not installed. Run: ${runtimeHint()}`);
  }
  const require = createRequire(runtimePackage);
  return require("@hashgraph/sdk");
}
