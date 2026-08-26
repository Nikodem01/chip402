// The one thing chip402 knows that the chain cannot: that account 0.0.9584959 was reached at
// printwright.liftbyai.com. A payment row reads as a name instead of a number because of this
// file, and for no other reason.
//
// It lives apart from purse.json deliberately, and the split is the point rather than tidiness.
// Those two files have opposite requirements and used to share one, which is a defect however
// small the file is:
//
//                    | purse.json (policy)          | this (labels)
//   -----------------|------------------------------|---------------------------------
//   size             | ~250 bytes, fixed            | grows with every payment
//   written by       | root, over the admin socket  | the daemon, on every payment
//   if unreadable    | REFUSE TO START — "I do not  | carry on with fewer names. Losing
//                    | know the limits" must never  | all of it costs nothing at all
//                    | become "there are no limits" |
//
// Sharing a file meant sharing a failure mode, and the shared one had to be the strict one: a
// growing pile of decoration could push the file past the size the daemon would agree to read,
// and then the daemon would refuse to *start*, on some later boot, over host names. A display
// nicety must never be able to stop a payment daemon. Apart, each file gets the behaviour it
// actually wants.
//
// Append-only, one JSON object per line. A payment costs one short write at the end of a file
// rather than an atomic rewrite of the limits, and a crash can lose at most the line being
// written — of a value that is decoration.
//
// SECURITY: nothing here can reach a decision. `hostFor` is read by the status snapshot and by
// nothing else; no limit, no sum and no policy path touches it. That is what makes this local
// state legitimate where a local count of the day's spending was not: the chain cannot answer
// this question, so there is no second copy to drift from, and no number depends on the answer.

import { appendLine, readTail, writeAtomic } from "./safe.ts";

export type Label = { readonly txId: string; readonly host: string };

// Two caps, and neither is a cliff. The byte cap bounds what is read at start-up — past it the
// tail is read and the older lines are simply not seen. The entry cap bounds what is held in
// memory and what a compaction keeps. At roughly seventy bytes a line, eight megabytes is about
// a hundred thousand payments: twenty a day for thirteen years. On a disk with gigabytes free
// that is not a number anybody should ever meet, and if they do, they lose the oldest names and
// nothing else.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

// Rewrite the file when it has grown past the point where reading it whole is sensible. Done at
// start-up, never during a payment, and through writeAtomic so a crash mid-compaction leaves the
// previous file rather than half of a new one.
const COMPACT_AT_BYTES = MAX_FILE_BYTES;

function parse(line: string): Label | null {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry?.["txId"] !== "string" || typeof entry["host"] !== "string") return null;
    return { txId: entry["txId"], host: entry["host"] };
  } catch {
    // A line we cannot read is a line we do not have. It is a hostname.
    return null;
  }
}

const encode = (label: Label): string => JSON.stringify({ txId: label.txId, host: label.host });

export class Labels {
  readonly #path: string;
  readonly #byTxId: Map<string, string>;

  constructor(path: string, entries: Label[]) {
    this.#path = path;
    this.#byTxId = new Map(entries.map((entry) => [entry.txId, entry.host]));
  }

  // `seed` is for an upgrade: the build before this one kept host names inside purse.json, first
  // in a `labels` array and before that on each receipt. It is read once, only when this store is
  // empty, and written here — so the names survive and purse.json stops carrying them.
  static open(path: string, seed: () => readonly Label[] = () => []): Labels {
    const lines = readTail(path, MAX_FILE_BYTES);
    let entries: Label[] = [];
    for (const line of lines) {
      const label = parse(line);
      if (label !== null) entries.push(label);
    }
    // Later lines win, and only the newest are kept: appending the same id twice is how a label
    // is corrected, and the file is read forwards.
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);

    const store = new Labels(path, entries);
    if (entries.length === 0) {
      const carried = seed();
      if (carried.length > 0) {
        // One write, not one per label: this happens once, on the first start after an upgrade.
        writeAtomic(path, carried.map(encode).join("\n") + "\n");
        for (const label of carried) store.#byTxId.set(label.txId, label.host);
      }
    } else if (lines.length > entries.length || entries.length >= MAX_ENTRIES) {
      // Unreadable lines, or more entries than we intend to hold. Neither is urgent and neither
      // is an error; tidying at start-up keeps the next read cheap.
      store.compact();
    }
    return store;
  }

  hostFor(txId: string): string | null {
    return this.#byTxId.get(txId) ?? null;
  }

  get size(): number {
    return this.#byTxId.size;
  }

  get all(): readonly Label[] {
    return [...this.#byTxId].map(([txId, host]) => ({ txId, host }));
  }

  // Written after the signature, from the URL that actually answered. One append; no read, no
  // rewrite, and nothing else in the process waits on it.
  record(txId: string | null, host: string): void {
    if (txId === null || host === "") return;
    if (this.#byTxId.get(txId) === host) return;
    this.#byTxId.set(txId, host);
    appendLine(this.#path, encode({ txId, host }));
  }

  compact(): void {
    const kept = this.all.slice(-MAX_ENTRIES);
    writeAtomic(this.#path, kept.length === 0 ? "" : kept.map(encode).join("\n") + "\n");
  }

  // The size at which `open` will rewrite rather than keep reading a longer and longer tail.
  static get compactAtBytes(): number {
    return COMPACT_AT_BYTES;
  }
}
