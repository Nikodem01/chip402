// The file operations that have to be paranoid, and they come in two kinds. The strict ones —
// `readSecret` for the key, `writeAtomic` and `readJson` for the purse and the in-flight list —
// refuse rather than guess, because "I could not read the limits" must never become "there are no
// limits". The forgiving ones — `appendLine` and `readTail` for the host names, and `removeFile`
// for clearing the last one — have the opposite contract: they degrade and never refuse, because
// what they carry is decoration, or an amount that was about to stop counting anyway. All of them are short,
// because the paranoia is in the flags rather than in the logic.

import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// A Hedera private key is well under this. The cap is here so that pointing this function at a
// large file is a refusal rather than a memory spike.
const MAX_SECRET_BYTES = 4096;

// systemd decrypts the TPM2-sealed credential into this directory. Plaintext never touches disk —
// it is a read-only tmpfs — and the path is not configurable: there is no setting an attacker
// could point at a key they supplied.
//
// Exactly what it looks like, because two comments in this file used to describe it differently
// and only one of them was right. Measured on the running unit:
//
//   $ findmnt -no FSTYPE,OPTIONS /run/credentials/chip402.service
//   tmpfs  ro,nosuid,nodev,noexec,relatime,nosymfollow,size=1024k,mode=700
//   $ getfacl -p /run/credentials/chip402.service
//   # owner: root      user::r-x      user:chip402:r-x
//   # group: root      group::---     mask::r-x      other::---
//
// So: owned by **root**, POSIX bits `dr-x------`, and the service user reaches it through an ACL
// entry rather than through ownership. `ls -ld` renders that as `dr-xr-x---+`, because the group
// field of a file with an ACL shows the mask and not the group bits — which is the whole reason
// the mode check below skips the group bit. uid 1000 cannot open the directory at all.
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
    // is not checked, because systemd lays a credential out root-owned plus an ACL granting the
    // service user read — and an ACL puts its mask in the group class of the mode, so a
    // `mode & 0o077` test reads that as "readable by others" and refuses to start against a
    // perfectly correct credential. The real boundary is the directory systemd decrypts into,
    // described above: a read-only tmpfs, `dr-x------` root-owned with the same kind of ACL, which
    // nothing outside this uid can open. `test/safe.test.ts` pins both directions — a world bit
    // refuses, a group bit does not.
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

// The purse is the record of the limits — what may be spent, not what has been. A half-written
// one after a crash would either lose a limit somebody set or invent one nobody did, and
// purse.ts refuses to start on a file it cannot parse, so a torn write is a machine that will not
// come back up. It is therefore never written in place: whole file to a temp name, flush, then a
// rename the kernel performs atomically.
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

// Take a file away, and never mind if it is not there or will not go. The only caller is the
// in-flight list's last entry going, and the ordering there is deliberate: the entry is already
// gone in memory by the time this runs, so a removal that fails costs the *next* daemon an amount
// committed until its own deadline — a denial for at most two minutes, never a payment. Refusing
// here would turn that into a thrown error on the path that has just finished a payment, which is
// the failure this project spent a whole file avoiding.
export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Deliberately nothing. See above.
  }
}

// The purse and the config are a few hundred bytes each — four numbers, a flag and a network
// name. This cap is three hundred times that, and it is a real guard precisely because nothing
// that grows lives in either file: growing things live in an append-only log with a cap of its
// own, which degrades instead of refusing. The size is taken off the descriptor we already
// opened rather than off a path that could be something else by the time we read it.
export const MAX_JSON_BYTES = 64 * 1024;

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


// --- the append-only side: state that grows, and must never stop the daemon ------------------

// Add one line to a file, creating it if it is not there. O_APPEND means the kernel places the
// write at the end atomically, so there is no read-modify-write and no window in which a crash
// loses what was already there — which is the whole reason growing state does not live in a file
// that gets rewritten whole.
export function appendLine(path: string, line: string, mode = 0o600): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, mode);
  try {
    writeSync(fd, line.endsWith("\n") ? line : line + "\n");
  } finally {
    closeSync(fd);
  }
}

// Read at most the last `maxBytes` of a file, as whole lines. A file bigger than that is not an
// error: it is read from the end and the first, probably-partial line is dropped. Missing file is
// an empty list.
//
// SECURITY-adjacent, and the point of the whole exercise: this function has no failure that stops
// a caller. Everything it holds is decoration — lose all of it and the worst outcome is rows that
// name an account id instead of a hostname — so a truncated, oversized or half-written file must
// cost fewer lines and never a refusal to start. That is exactly the property the limits file
// must NOT have, which is why the two no longer share a file.
export function readTail(path: string, maxBytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return [];
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0) return [];
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // Read from the middle of the file, so the first line is very likely half of one.
    if (length < info.size) lines.shift();
    return lines.filter((line) => line.trim() !== "");
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
