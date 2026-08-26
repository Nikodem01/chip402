// Two file operations that have to be paranoid: reading the key, and writing the purse. Both
// are short, because the paranoia is in the flags rather than in the logic.

import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// A Hedera private key is well under this. The cap is here so that pointing this function at a
// large file is a refusal rather than a memory spike.
const MAX_SECRET_BYTES = 4096;

// systemd decrypts the TPM2-sealed credential into this directory — a read-only tmpfs,
// dr-x------, owned by the service user. Plaintext never touches disk, and the path is not
// configurable: there is no setting an attacker could point at a key they supplied.
export function credentialPath(name: string): string {
  const dir = process.env["CREDENTIALS_DIRECTORY"];
  if (!dir) {
    throw new Error("no CREDENTIALS_DIRECTORY — chip402 must be started by systemd with LoadCredentialEncrypted");
  }
  return join(dir, name);
}

// SECURITY: O_NOFOLLOW, then fstat on the descriptor we actually opened. Checking the path with
// stat and then opening it is a race that a symlink wins; checking the open descriptor is not.
export function readSecret(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    // SECURITY: world-readable is the thing that must never be true. The group bit deliberately
    // is not checked, because systemd lays a credential out as 0440 root:root plus an ACL
    // granting the service user read — and an ACL shows up in the group class of the mode, so a
    // `mode & 0o077` test reads that as "readable by others" and refuses to start. The real
    // boundary is the directory systemd decrypts into: 0550 root:root on a tmpfs, with the same
    // ACL. Nothing outside this uid can reach either.
    if ((info.mode & 0o007) !== 0) throw new Error(`${path} is world-readable`);
    const uid = process.getuid?.() ?? -1;
    if (info.uid !== 0 && info.uid !== uid) throw new Error(`${path} is owned by neither root nor this service`);
    if (info.size > MAX_SECRET_BYTES) throw new Error(`${path} is too large to be a key`);
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    return buffer.toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

// Node's `--permission` disables every fsync entry point outright — `fs.fsyncSync` and
// `writeFileSync(…, { flush: true })` alike — and the daemon runs under it, so this has to work
// without one. What is lost is durability of the last write across a power cut; what is kept is
// atomicity, which comes from rename() and is the property that actually matters here. On ext4
// with the default data=ordered the data write is ordered before the rename commits anyway.
// Only the permission model's refusal is swallowed: a real I/O error still surfaces.
function flush(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw error;
  }
}

// The purse is the record of what has already been spent. A half-written one after a crash would
// either lose spending — free money for the agent — or invent it, so it is never written in
// place: whole file to a temp name, flush, then a rename the kernel performs atomically.
export function writeAtomic(path: string, data: string, mode = 0o600): void {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
  try {
    writeSync(fd, data);
    flush(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  // Flush the directory as well, so the rename itself survives the same crash the flush above
  // was for.
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try {
    flush(dir);
  } finally {
    closeSync(dir);
  }
}

// The purse and the config are a few hundred bytes each. The cap is here for the same reason the
// one on readSecret is: pointing this function at something large should be a refusal rather
// than a memory spike, and the size is taken off the descriptor we already opened rather than
// off a path that could be something else by the time we read it.
const MAX_JSON_BYTES = 256 * 1024;

// Read a small JSON file, or undefined when it is simply not there. Anything else — a parse
// error, a permissions problem, a file too big to be limits — is thrown, because "I could not
// read the limits" must never quietly become "there are no limits".
export function readJson(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > MAX_JSON_BYTES) throw new Error(`${path} is too large to be a chip402 state file`);
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    return JSON.parse(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
