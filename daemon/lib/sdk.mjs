import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "./paths.mjs";

const runtimePackage = path.join(RUNTIME_DIR, "package.json");

export function runtimeHint() {
  return `cd ${RUNTIME_DIR} && npm install @hashgraph/sdk`;
}

export function loadSdk() {
  if (!fs.existsSync(path.join(RUNTIME_DIR, "node_modules", "@hashgraph", "sdk"))) {
    throw new Error(`Hedera SDK is not installed. Run: ${runtimeHint()}`);
  }
  const require = createRequire(runtimePackage);
  return require("@hashgraph/sdk");
}
