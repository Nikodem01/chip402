// What a Hedera identifier looks like, in one place. Nothing here reaches the network, the clock
// or the disk, so every other file can import it — including policy.ts, which has to stay pure.
//
// It exists because the shape was written out five times: `/^\d+\.\d+\.\d+$/` in policy.ts and
// again in daemon.ts, and three transaction-id literals in chain.ts that each embed the same
// thing. Five spellings of one fact is five places to fix it and four places to forget, and the
// two entity-id copies guarded different doors — a mirror-node URL path segment in one case, a
// seller-supplied `payTo` in the other — so a divergence would not have been obvious from either
// side.

// An account, token or file id: `0.0.1234`. Anchored, digits only, and nothing else looks like
// it. This is the shape a mirror-node URL path segment must have and the shape a seller's
// `payTo`/`feePayer` must have; both are the same question.
export const ENTITY_ID = /^\d+\.\d+\.\d+$/;

export function isEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID.test(value);
}

// The two spellings of a transaction id, both of which begin with the entity id of the account
// that paid for it. The mirror node writes `0.0.9185802-1787717722-334755737`; the SDK, HashScan
// and every id chip402 hands out write `0.0.9185802@1787717722.334755737`. chain.ts converts at
// the two edges — see `toMirrorId` and `fromMirrorId` — rather than carrying both around.
export const MIRROR_TX_ID = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/;
export const SDK_TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;
