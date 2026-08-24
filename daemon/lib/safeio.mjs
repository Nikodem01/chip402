// Every file this plugin touches sits on a predictable path that another process running as
// the same user can reach. Checking a pathname and then opening that pathname is two
// different lookups: the thing that was checked and the thing that was opened need not be
// the same object. So each helper here opens once with O_NOFOLLOW and makes every decision —
// regular file, owner, mode, size — against fstat on that descriptor.
//
// Node exposes no openat/renameat, so a rename cannot literally be directory-relative. The
// closest the runtime allows is what these helpers do: verify the parent directory on its own
// descriptor and hold it owner-only 0700, refuse any symlinked leaf, and give temporary files
// unpredictable names. Said plainly rather than papered over.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIR_MODE, KEY_MODE } from "./paths.mjs";

const C = fsSync.constants;
const O_NOFOLLOW = C.O_NOFOLLOW ?? 0;
const O_DIRECTORY = C.O_DIRECTORY ?? 0;

export const MAX_JSON_BYTES = 1_000_000;
export const MAX_SECRET_BYTES = 4_096;

export class VerifyError extends Error {
  constructor(file, why) {
    super(`Refusing ${file}: ${why}`);
    this.code = "unsafe_file";
  }
}

function assertOwned(file, st) {
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new VerifyError(file, `owned by uid ${st.uid}, not this user`);
  }
}

// Creates the directory owner-only and hands back a descriptor that has been checked to be a
// directory this user owns. The caller closes it. mkdir's mode applies only on creation, so
// an already-existing directory is re-tightened through the descriptor rather than trusted.
export async function openVerifiedDir(dir, mode = DIR_MODE) {
  await fs.mkdir(dir, { recursive: true, mode });
  const handle = await fs.open(dir, C.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isDirectory()) throw new VerifyError(dir, "not a directory");
    assertOwned(dir, st);
    if ((st.mode & 0o777) !== mode) await handle.chmod(mode);
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

export async function ensureOwnedDir(dir, mode = DIR_MODE) {
  const handle = await openVerifiedDir(dir, mode);
  await handle.close();
}

// One open, then every check on that descriptor. `exactMode` is for secrets, where a file
// that has drifted looser than 600 is refused rather than quietly read.
export async function readVerified(file, { maxBytes = MAX_JSON_BYTES, exactMode } = {}) {
  const handle = await fs.open(file, C.O_RDONLY | O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new VerifyError(file, "not a regular file");
    assertOwned(file, st);
    if (exactMode !== undefined && (st.mode & 0o777) !== exactMode) {
      throw new VerifyError(
        file,
        `mode is ${(st.mode & 0o777).toString(8).padStart(3, "0")}, need ${exactMode.toString(8)}`,
      );
    }
    if (st.size > maxBytes) throw new VerifyError(file, `${st.size} bytes exceeds the ${maxBytes} byte ceiling`);
    const buf = Buffer.alloc(Number(st.size));
    if (buf.length > 0) await handle.read(buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

// Permissions are set at open and pinned on the handle before a byte is written, never
// chmod'd afterwards on a pathname. The temporary name is random so nothing can be waiting
// at it, and it lands in the same verified directory as the target.
export async function writeVerifiedAtomic(file, body, mode = KEY_MODE) {
  const dir = path.dirname(file);
  await ensureOwnedDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (err) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  await fs.rename(tmp, file);
}

// Append targets are opened once and written through the descriptor for the life of the
// process, so a symlink swapped in later cannot redirect anything.
export async function openVerifiedAppend(file, mode = KEY_MODE) {
  const handle = await fs.open(file, C.O_WRONLY | C.O_CREAT | C.O_APPEND | O_NOFOLLOW, mode);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new VerifyError(file, "not a regular file");
    assertOwned(file, st);
    if ((st.mode & 0o777) !== mode) await handle.chmod(mode);
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}
