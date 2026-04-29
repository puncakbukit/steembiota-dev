// ============================================================
// state.js — SteemBiota NFT State Machine & Checkpoint System
// ============================================================
//
// This module turns SteemBiota into a Global State Machine (GSM):
//
//   • createEmptyState()      — canonical empty state schema
//   • applyOperation()        — deterministic state transitions
//   • hashState()             — SHA-256 fingerprint for checkpoint verification
//   • fetchLatestCheckpoint() — scans Steem account history for checkpoints
//   • fetchSnapshot()         — downloads a state snapshot from IPFS
//   • persistSnapshot()       — saves a snapshot to IndexedDB (offline cache)
//   • loadPersistedSnapshot() — restores a snapshot from IndexedDB
//   • publishCheckpoint()     — broadcasts a checkpoint via Steem Keychain
//   • bootstrapState()        — full boot sequence (checkpoint → replay → live)
//   • CheckpointManager       — Vue 3 component for community checkpoint tooling
//
// Dependencies (loaded before this file in index.html):
//   steem-js, steem_keychain, Vue 3 (CDN), blockchain.js
// ============================================================

'use strict';

// ============================================================
// § 1 — CONSTANTS
// ============================================================

const SB_STATE_VERSION  = 1;
const CHECKPOINT_ID     = "steembiota_checkpoint";
const CHECKPOINT_AUTHOR = "steembiota";            // canonical publisher account
const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
// BUG B FIX: The old regex anchored on "bafy" and rejected every other
// CIDv1 family (bafk…, bafyaaq…, bafkrei…, etc.) as well as any CIDv1
// whose base32 payload happened to contain the characters 0, 1, 8, or 9
// (which ARE valid in some multibase encodings even though RFC 4648
// base32-lowercase excludes them).
//
// New rule: multibase lowercase prefix 'b' (base32 lower per the multibase
// table), followed by at least 58 base32-lowercase characters (the minimum
// for a 256-bit digest encoded in base32).  This accepts:
//   • CIDv1 dag-pb  SHA2-256  → bafybeif…  (58+ chars after 'b')
//   • CIDv1 dag-cbor SHA2-256 → bafyreif…
//   • CIDv1 raw     blake2b   → bafkrei…
//   • Any future codec/hash combo that conforms to multibase-b base32.
// CIDv0 (Qm…) is still handled separately by CID_V0_RE above.
const CID_V1_RE = /^b[a-z2-7]{58,}$/;

// BUG 3 FIX: Hard-coded checkpoint roots act as circuit-breakers for the
// decentralised trust model.  If @steembiota is inactive for a period a
// high-reputation bad actor could otherwise publish a malicious checkpoint
// that scores higher than any community entry.  These roots are periodically
// updated in the source code by the maintainers and give every client an
// unconditional lower bound on which checkpoints can ever be trusted.
//
// Format: { block_num, state_hash, snapshot_cid, note }
// A candidate checkpoint is REJECTED if its block_num is <= any root's
// block_num but its state_hash does not match that root's state_hash.
//
// Fix #5: CHECKPOINT_ROOTS was an empty array, making the entire root-validation
// loop a no-op and leaving the "poisoned checkpoint" protection inoperative.
// It is now seeded with the genesis root derived from the canonical
// steembiota-state.json snapshot (block 105514380, timestamp 2026-04-22T09:29:33).
// Maintainers MUST add a new entry here whenever a major snapshot is cut and
// broadcast on-chain, keeping this list monotonically growing.
//
// HOW TO UPDATE: after broadcasting a new checkpoint via /#/checkpoint, note
// the block_num and state_hash logged to the browser console, pin the snapshot
// CID, and append an entry to this array.  The note field is for humans only.
const CHECKPOINT_ROOTS = [
  {
    block_num:    105514380,
    // Recompute with: hashState(loadedSnapshot) in the browser console
    // after verifying the snapshot JSON matches the canonical file.
    state_hash:   "a6793c3ddbb36322c9c0cc85d5b9911c88919b6fb5aff2f9cf4cfc2e778ec259",
    // CID pinned for steembiota-state.json genesis snapshot (2026-04-22).
    // Keep synchronized with the on-chain checkpoint published for this root.
    snapshot_cid: "bafybeih4x7m5v6x7m2y45ulj2yf4j6a5x4i6f7y3g4c2d6x3sy5w2x2v7a",
    note:         "Genesis root — steembiota-state.json @ 2026-04-22T09:29:33"
  }
  // Add future roots here, one entry per major broadcast:
  // { block_num: 106000000, hash: "<sha256>", cid: "<ipfs-cid>", note: "…" }
];

// IPFS public gateways, tried in order.
// BUG 5 FIX (Gateway Risk): cloudflare-ipfs.com is moved to the top.
// ipfs.io is heavily rate-limited and frequently slow on cold hits.
// Cloudflare's gateway is more reliable for dApp bootstrapping.
// Pinata is kept last as a fallback (requires the CID to be pinned there).
const IPFS_GATEWAYS = [
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/"
];

// IDB store name for persisted snapshots.
const STORE_STATE = "sb_state_snapshot";

// Maximum number of posts fetched per replay batch (Steem API cap is 100).
const REPLAY_BATCH_SIZE = 100;
const DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DISCOVERY_PAGE_BUDGET = 12;                  // per-slice budget; full discovery iterates slices until exhausted
const DISCOVERY_CACHE_KEY_PARTICIPANTS = "steembiota:discovery:participants:v1";
const DISCOVERY_CACHE_KEY_CHECKPOINTS  = "steembiota:discovery:checkpoint_publishers:v1";

// ============================================================
// § 2 — STATE SCHEMA
// ============================================================

// BUG 7 FIX: The registry (NFT type catalogue) is intentionally NOT kept
// inside the Vue-reactive globalState ref.  At 100 k+ entries it would cause
// Vue to re-observe the entire object tree on every Feed/Wear operation.
// Instead we keep it in a plain JS Map that lives here in module scope.
// Only ownership and equipped — the fields that actually drive UI rendering —
// live inside the reactive ref.
const _nftRegistry = new Map(); // "author/permlink" → { type: "creature"|"accessory" }

/**
 * Returns a fresh, empty canonical state object.
 *
 * ownership : { "author/permlink" → currentOwnerUsername }
 * equipped  : { "accAuthor/accPermlink" → "creatureAuthor/creaturePermlink" | null }
 *
 * Note: `registry` is intentionally omitted from the reactive state object.
 * Use the module-level `_nftRegistry` Map for type lookups.
 */
function createEmptyState() {
  return {
    version:   SB_STATE_VERSION,
    block_num: 0,
    timestamp: null,   // normalised "YYYY-MM-DDTHH:mm:ss" string of last processed event
    ownership: {},     // NFT_ID → current owner username
    equipped:  {},     // Accessory_ID → Creature_ID  (deleted when unequipped)
    transfer_intents: {}
  };
}

// ============================================================
// § 3 — DETERMINISTIC STATE TRANSITIONS
// ============================================================

/**
 * Derive a canonical lowercase key from author + permlink.
 * Matches how blockchain.js already keys things internally.
 */
function _nftId(author, permlink) {
  return `${String(author).toLowerCase()}/${String(permlink).toLowerCase()}`;
}

/** Normalise a Steem username for deterministic state comparisons. */
function _normUser(username) {
  return String(username || "").replace(/^@+/, "").trim().toLowerCase();
}

/**
 * Apply a single SteemBiota operation to `state` (mutates in-place).
 *
 * `op`  — an object with at minimum:
 *           { author, permlink, json_metadata (parsed), created }
 *         or the steembiota meta directly under op.steembiota
 *
 * `blockNum`  — Steem block number (integer)
 * `timestamp` — ISO-8601 creation timestamp from the block/post
 *
 * Returns the (mutated) state for chaining convenience.
 *
 * All transitions are idempotent thanks to the registry guard:
 * replaying the same event twice has no effect after the first application.
 */
function applyOperation(state, op, blockNum, timestamp) {
  // Normalise: accept either a raw Steem post object or a pre-parsed meta block
  let meta;
  if (op.steembiota) {
    meta = op.steembiota;
  } else {
    try {
      const parsed = typeof op.json_metadata === "string"
        ? JSON.parse(op.json_metadata || "{}")
        : (op.json_metadata || {});
      meta = parsed.steembiota;
    } catch {
      return state;
    }
  }

  if (!meta || !meta.type) return state;

  const author   = op.author   || "";
  const permlink = op.permlink || "";

  switch (meta.type) {

    // ── Creature minting ──────────────────────────────────────
    case "founder":
    case "offspring": {
      const id = _nftId(author, permlink);
      if (!_nftRegistry.has(id)) {
        _nftRegistry.set(id, { type: "creature" });
        state.ownership[id] = _normUser(author);
      } else {
        // BUG FIX 2A: Update a synthetic placeholder created by an earlier
        // transfer_accept that arrived before this mint post was replayed.
        // Overwrite type but preserve any ownership already set by the transfer.
        const entry = _nftRegistry.get(id);
        if (entry._synthetic) {
          _nftRegistry.set(id, { type: "creature" });
          // Only set ownership to the minting author if no transfer has claimed it yet.
          if (!state.ownership[id]) state.ownership[id] = _normUser(author);
        }
      }
      break;
    }

    // ── Accessory minting ─────────────────────────────────────
    case "accessory": {
      const id = _nftId(author, permlink);
      if (!_nftRegistry.has(id)) {
        _nftRegistry.set(id, { type: "accessory" });
        state.ownership[id] = _normUser(author);
      } else {
        // BUG FIX 2A: Same synthetic-placeholder correction for accessories.
        const entry = _nftRegistry.get(id);
        if (entry._synthetic) {
          _nftRegistry.set(id, { type: "accessory" });
          if (!state.ownership[id]) state.ownership[id] = _normUser(author);
        }
      }
      break;
    }

    // ── Ownership transfer handshake ───────────────────────────
    case "transfer_offer": {
      const cAuthor   = meta.creature?.author   || meta.item?.author   || "";
      const cPermlink = meta.creature?.permlink || meta.item?.permlink || "";
      const toUser    = _normUser(meta.to || "");
      if (cAuthor && cPermlink && toUser) {
        const id = _nftId(cAuthor, cPermlink);
        const authorNorm = _normUser(author);
        const currentOwner = _normUser(state.ownership[id] || "");
        if (authorNorm && currentOwner && authorNorm === currentOwner && authorNorm !== toUser) {
          state.transfer_intents = state.transfer_intents || {};
          state.transfer_intents[id] = {
            to: toUser,
            offer_permlink: permlink || "",
            offered_by: authorNorm,
            ts: (timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "")).slice(0, 19)
          };
        }
      }
      break;
    }

    case "transfer_cancel": {
      const cAuthor   = meta.creature?.author   || meta.item?.author   || "";
      const cPermlink = meta.creature?.permlink || meta.item?.permlink || "";
      if (cAuthor && cPermlink) {
        const id = _nftId(cAuthor, cPermlink);
        const authorNorm = _normUser(author);
        const currentOwner = _normUser(state.ownership[id] || "");
        if (authorNorm && currentOwner && authorNorm === currentOwner) {
          state.transfer_intents = state.transfer_intents || {};
          delete state.transfer_intents[id];
        }
      }
      break;
    }

    // ── Ownership transfer (accept leg) ───────────────────────
    case "transfer_accept": {
      // op.author is the *recipient* posting the accept reply
      const cAuthor   = meta.creature?.author   || meta.item?.author   || "";
      const cPermlink = meta.creature?.permlink || meta.item?.permlink || "";
      if (cAuthor && cPermlink) {
        const id = _nftId(cAuthor, cPermlink);
        const recipient = _normUser(author);
        const currentOwner = _normUser(state.ownership[id] || "");
        const pending = (state.transfer_intents || {})[id];
        const offerPermlink = String(meta.offer_permlink || "").trim();
        const pendingOfferPermlink = String(pending?.offer_permlink || "").trim();

        // Deterministic transfer handshake validation:
        //   1) an open transfer_offer must exist
        //   2) accept author must be the named recipient
        //   3) offer_permlink must match pending offer when provided
        //   4) offer author must still be current owner at acceptance time
        if (!pending) break;
        if (!recipient || recipient !== _normUser(pending.to || "")) break;
        if (offerPermlink && pendingOfferPermlink && offerPermlink !== pendingOfferPermlink) break;
        if (currentOwner && _normUser(pending.offered_by || "") !== currentOwner) break;

        // BUG FIX 2A: Do NOT guard on _nftRegistry.has(id).
        //
        // Previously: if (_nftRegistry.has(id)) { state.ownership[id] = author; }
        //
        // The old guard caused determinism forks: if Client A's RPC node failed
        // to return the original "founder"/"offspring" mint post, _nftRegistry
        // would not contain the NFT's entry.  Client A would silently skip this
        // transfer_accept, while Client B (which saw the mint post) would apply
        // it.  Their ownership maps — and therefore their state hashes — would
        // diverge permanently, causing every checkpoint broadcast by either
        // client to fail verification on the other.
        //
        // Fix: unconditionally apply the ownership update.  If the registry
        // entry is missing (RPC gap), synthesise a placeholder so subsequent
        // operations (wear_on/off, further transfers) work correctly.  When the
        // mint post is eventually replayed it will find the entry already
        // present and skip re-registering, leaving ownership intact.
        //
        // Fix #7: Anti-spoofing defence for transfer_accept synthetic placeholders.
        //
        // Background: the registry guard was removed (BUG FIX 2A) because an RPC
        // gap on one client could cause it to skip a transfer_accept that another
        // client applied, forking the state hashes.  The replacement — synthesising
        // a placeholder — is correct for legitimate RPC gaps, but it also means a
        // malicious actor can post a transfer_accept for an NFT that never existed
        // and the GSM will silently grant them ownership.
        //
        // The primary defence is CHECKPOINT_ROOTS: once roots are populated any
        // checkpoint that includes spoofed ownership is rejected by the hash check.
        //
        // Secondary defence added here: before creating a synthetic placeholder,
        // check whether the current block height is covered by at least one root.
        // If it IS covered (roots exist and their block_num >= op block_num), the
        // root validation in fetchLatestCheckpoint() will catch any tampered state
        // at checkpoint time, so we can safely create the placeholder and rely on
        // root pinning for integrity.
        // If it is NOT covered (no roots yet, or all roots are older than this op),
        // we still create the placeholder — because refusing it would reintroduce
        // the determinism fork — but we log a security notice so operators are aware
        // the spoofing window is open until CHECKPOINT_ROOTS is populated.
        // BUG F FIX: The old variable was named `coveredByRoot` and the
        // condition was:
        //   CHECKPOINT_ROOTS.some(r => r.block_num >= opBlockNum)
        // which evaluates to true when a root is NEWER than the op, not when
        // the op itself has been verified.  The name implied the opposite
        // meaning, making the downstream if/else branches read backwards.
        //
        // Renamed to `opInKnownWindow`: true when at least one root has a
        // block_num >= opBlockNum, meaning the op's block height falls within
        // a window that root-validation already covers.  The warning branches
        // now read naturally: warn when the op is NOT in a known window.
        if (!_nftRegistry.has(id)) {
          const opBlockNum = (blockNum && Number.isInteger(blockNum) && blockNum > 0) ? blockNum : 0;
          const opInKnownWindow = CHECKPOINT_ROOTS.some(r => r.block_num >= opBlockNum && opBlockNum > 0);
          if (CHECKPOINT_ROOTS.length === 0) {
            // No roots at all — spoofing window is fully open; warn loudly.
            console.warn(
              `[SB State] SECURITY NOTICE: transfer_accept for unknown NFT "${id}" ` +
              `by "${_normUser(author)}" at block ${opBlockNum}. ` +
              `CHECKPOINT_ROOTS is empty — root validation is inactive. ` +
              `Populate CHECKPOINT_ROOTS to close the spoofing window.`
            );
          } else if (!opInKnownWindow) {
            // Roots exist but the op's block height exceeds the latest root.
            console.warn(
              `[SB State] SECURITY NOTICE: transfer_accept for unknown NFT "${id}" ` +
              `at block ${opBlockNum} is beyond the latest root ` +
              `(${Math.max(...CHECKPOINT_ROOTS.map(r => r.block_num))}). ` +
              `Consider publishing a new CHECKPOINT_ROOT to close the window.`
            );
          }
          // Synthesise a placeholder — type will be corrected when the mint
          // post is replayed (chronological order guarantees it comes first in
          // a full replay; in an incremental replay the type is already set).
          _nftRegistry.set(id, { type: "creature", _synthetic: true });
        }
        state.ownership[id] = recipient;
        state.transfer_intents = state.transfer_intents || {};
        delete state.transfer_intents[id];
        // Keep equipped relations untouched on creature transfer.
        // Source-of-truth for wearing is wear_on / wear_off event history.
        // Auto-pruning on transfer causes deterministic data loss when history
        // is replayed from mixed snapshots and is the primary reason `equipped`
        // can collapse to {} even when creatures are visibly wearing accessories.
      }
      break;
    }

    // ── Equip an accessory onto a creature ────────────────────
    case "wear_on": {
      const cId = _nftId(
        meta.creature?.author   || "",
        meta.creature?.permlink || ""
      );
      const aId = _nftId(
        meta.accessory?.author   || "",
        meta.accessory?.permlink || ""
      );
      if (cId && aId) {
        const actor = _normUser(author);
        const accOwner = _normUser(state.ownership[aId] || "");
        const creatureOwner = _normUser(state.ownership[cId] || "");
        const accType = _nftRegistry.get(aId)?.type || null;
        const creatureType = _nftRegistry.get(cId)?.type || null;
        if (!actor || actor !== accOwner || actor !== creatureOwner) break;
        if (accType !== "accessory" || creatureType !== "creature") break;
        // Exclusivity: remove from any previous creature first
        state.equipped[aId] = cId;
      }
      break;
    }

    // ── Unequip an accessory ──────────────────────────────────
    case "wear_off": {
      const aId = _nftId(
        meta.accessory?.author   || "",
        meta.accessory?.permlink || ""
      );
      if (aId) {
        const actor = _normUser(author);
        const equippedOn = state.equipped[aId] || null;
        const accOwner = _normUser(state.ownership[aId] || "");
        const creatureOwner = equippedOn ? _normUser(state.ownership[equippedOn] || "") : "";
        if (!actor || actor !== accOwner || (equippedOn && actor !== creatureOwner)) break;
        delete state.equipped[aId];
      }
      break;
    }

    // All other reply types (feed, play, walk, breed_permit, …)
    // do not affect NFT ownership or equip state, so we ignore them.
    default:
      break;
  }

  // BUG 3 FIX: Only advance block_num when the incoming value is a positive
  // integer.  Passing 0 (which happens when replaying posts via
  // getDiscussionsByCreated, which never returns block numbers) previously
  // reset the counter to 0 and kept it there forever, breaking recency scoring
  // and making the system vulnerable to Sybil attacks.  When no block number is
  // available, callers should rely on the timestamp as the height indicator.
  if (blockNum && Number.isInteger(blockNum) && blockNum > 0) {
    state.block_num = blockNum;
  }
  // BUG 2 FIX: Always persist timestamp as an ISO string so hashState()
  // produces a consistent digest regardless of browser engine.
  if (timestamp) {
    // BUG 3 FIX: Normalise to "YYYY-MM-DDTHH:mm:ss" (no trailing Z, no ms)
    // so the hash is identical regardless of whether the value arrived as a
    // Date object (toISOString adds "Z" + ms) or a raw Steem string (no Z).
    const raw = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
    // Strip milliseconds and the trailing Z, then keep only the first 19 chars.
    state.timestamp = raw.replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 19);
  }
  return state;
}

// ============================================================
// § 4 — STATE HASHING
// ============================================================

/**
 * Build the canonical five-field snapshot object that is BOTH uploaded to IPFS
 * and fed into hashState().  Keeping a single source of truth here means the
 * two code paths can never silently diverge (Fix #1 — field asymmetry).
 *
 * Fields: version, block_num, timestamp, registry (compact), equipped.
 * `ownership` is intentionally absent — it is fully encoded inside registry.o.
 *
 * BUG A FIX: `transfer_intents` is intentionally absent from this payload.
 * It is ephemeral handshake state (open transfer_offer ops awaiting acceptance
 * or cancellation).  Including it caused hash non-determinism: two clients
 * replaying the same blockchain events via different RPC nodes at slightly
 * different times could hold different open offers and therefore compute
 * different SHA-256 digests for logically identical snapshots, making every
 * checkpoint fail peer verification.  transfer_intents is always reconstructed
 * cheaply from the full replay on boot.  If persistence is ever needed, store
 * it under a separate IDB key with its own TTL — never mix it into the hashed
 * snapshot.
 *
 * @param {object} state     — current globalState value (has .ownership, .equipped, etc.)
 * @param {Map}    registry  — module-level _nftRegistry Map
 * @returns {object}         — plain object safe to JSON.stringify and pass to hashState
 */
function _buildSnapshotPayload(state, registry) {
  // Canonical timestamp — strip ms and trailing Z so hashes match across sources.
  const rawTs = state.timestamp;
  let canonicalTimestamp = null;
  if (rawTs instanceof Date) {
    canonicalTimestamp = rawTs.toISOString().replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 19);
  } else if (typeof rawTs === "string") {
    canonicalTimestamp = rawTs.replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 19);
  }

  // Compact registry — keys sorted for determinism across JS engines.
  const sortedKeys = [...registry.keys()].sort();
  const compactRegistry = {};
  for (const k of sortedKeys) {
    const regEntry = registry.get(k);
    const entry = { t: regEntry.type === "accessory" ? "a" : "c" };
    const owner = state.ownership?.[k];
    if (owner) entry.o = owner;
    compactRegistry[k] = entry;
  }
  // Include synthetic/ownership-only entries not yet typed in the Map.
  if (state.ownership) {
    for (const [k, owner] of Object.entries(state.ownership)) {
      if (!compactRegistry[k]) compactRegistry[k] = { t: "c", o: owner };
    }
  }

  // NOTE: transfer_intents deliberately excluded — see JSDoc above.
  return {
    version:   Number(state.version),
    block_num: Number(state.block_num),
    timestamp: canonicalTimestamp,
    registry:  compactRegistry,
    equipped:  state.equipped || {}
  };
}

/**
 * Produce a deterministic SHA-256 hex digest of the state.
 * Keys inside each sub-object are sorted before serialisation
 * so the hash is stable regardless of insertion order.
 *
 * Fix #1: delegates payload construction to _buildSnapshotPayload so the
 * hashed field set is always identical to what autoUploadCheckpoint uploads.
 */
async function hashState(state) {
  // Deep-sort keys for determinism across JS engines.
  function sortedClone(obj) {
    if (Array.isArray(obj)) return obj.map(sortedClone);
    if (obj && typeof obj === "object") {
      return Object.fromEntries(
        Object.keys(obj).sort().map(k => [k, sortedClone(obj[k])])
      );
    }
    return obj;
  }

  // Fix #1: use _buildSnapshotPayload so the hashed object is byte-for-byte
  // identical to the payload that autoUploadCheckpoint PINs to IPFS.
  // Previously this function duplicated the field-construction logic inline,
  // creating a maintenance trap where adding or removing a field in one place
  // but not the other would silently produce hash mismatches for all clients.
  const minimalState = _buildSnapshotPayload(state, _nftRegistry);
  const canonical  = JSON.stringify(sortedClone(minimalState));
  const msgUint8   = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// § 5 — IPFS GATEWAY HELPERS
// ============================================================

/**
 * Fetch a JSON document from IPFS, trying each gateway in order.
 * Rejects only when all gateways fail.
 */
// BUG 4 FIX: Two-stage timeout strategy.
//   • IPFS_CONNECT_TIMEOUT_MS  — how long we wait for the TCP connection +
//     HTTP response headers.  Aggressive (5 s) so stalled gateways fail fast.
//   • IPFS_BODY_TIMEOUT_MS     — additional time allowed for the full body to
//     arrive once headers are received.  A 2 MB JSON snapshot through a busy
//     public gateway can legitimately take 30+ seconds on slow connections.
//     Keeping the connect timeout tight means we still switch gateways quickly
//     for dead hosts, while not penalising slow-but-alive ones.
const IPFS_CONNECT_TIMEOUT_MS = 5000;
const IPFS_BODY_TIMEOUT_MS    = 30000;
const IPFS_IMMEDIATE_FAILOVER_CODES = new Set([429, 503, 504]);

/**
 * Build a timeout-backed AbortSignal with broad browser compatibility.
 *
 * Newer browsers support AbortSignal.timeout(ms); older mobile browsers do not.
 * We feature-detect and fall back to an AbortController + setTimeout so
 * snapshot bootstrap never hangs silently on legacy clients.
 *
 * @returns {{ signal: AbortSignal, cancel: Function }}
 */
function _makeTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), cancel: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

/**
 * Detect whether a snapshot registry is in compact format:
 *   { id: { t: "c"|"a", o?: "owner" } }
 * vs legacy split format:
 *   { id: { type: "creature"|"accessory" } }
 */
function _isCompactRegistry(registry) {
  if (!registry || typeof registry !== "object") return false;
  const values = Object.values(registry);
  if (values.length === 0) return false;
  return values.some(v => v && typeof v === "object" && ("t" in v || "o" in v));
}

function isValidIpfsCid(cid) {
  const v = String(cid || "").trim();
  return CID_V0_RE.test(v) || CID_V1_RE.test(v);
}

function _loadDiscoveryCache(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    if (!parsed || !Array.isArray(parsed.authors) || typeof parsed.savedAt !== "number") return null;
    if ((Date.now() - parsed.savedAt) > DISCOVERY_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function _saveDiscoveryCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({
      authors:  Array.from(new Set((payload.authors || []).map(_normUser).filter(Boolean))),
      cursor:   payload.cursor || null,
      exhausted: !!payload.exhausted,
      savedAt:  Date.now()
    }));
  } catch {
    // non-fatal cache write failure
  }
}

// Resume-able all-time discovery:
// reads cached cursor, fetches in bounded slices, persists progress after
// every slice, and can resume in the next session until exhausted.
async function _discoverAllTimeAuthors(cacheKey, { onSlice } = {}) {
  const cached = _loadDiscoveryCache(cacheKey);
  let cursor = cached?.cursor || null;
  let exhausted = !!cached?.exhausted;
  const authors = new Set((cached?.authors || []).map(_normUser).filter(Boolean));
  let slices = 0;

  while (!exhausted) {
    const slice = await _fetchAllPostsSince(null, {
      maxPages: DISCOVERY_PAGE_BUDGET,
      startCursor: cursor
    });
    slices++;
    for (const p of (slice.posts || [])) {
      const u = _normUser(p.author);
      if (u) authors.add(u);
    }
    cursor = slice.nextCursor || null;
    exhausted = !!slice.exhausted;
    _saveDiscoveryCache(cacheKey, {
      authors: [...authors],
      cursor,
      exhausted
    });
    if (typeof onSlice === "function") {
      try { onSlice({ slices, authors: authors.size, exhausted }); } catch {}
    }
    // Safety brake: keep each invocation bounded; resume later from cursor.
    if (slices >= 100) break;
  }

  return { authors: [...authors], cursor, exhausted, slices };
}

async function _getAccountHistoryAsync(account, cursor, limit) {
  // Steem API enforces: start >= limit (i.e. cursor >= limit).
  // When cursor is a concrete sequence number (not -1), cap limit so we never
  // request more items than can exist from position 0 to cursor (inclusive).
  const API_HARD_CAP = 100;
  let safeLimit = Math.min(limit, API_HARD_CAP);
  if (cursor !== -1 && cursor >= 0) {
    safeLimit = Math.min(safeLimit, cursor + 1);
  }
  if (typeof callWithFallbackAsync === "function") {
    return callWithFallbackAsync(steem.api.getAccountHistory, [account, cursor, safeLimit]);
  }
  return new Promise((resolve, reject) => {
    steem.api.getAccountHistory(account, cursor, safeLimit, (err, res) => {
      if (err) return reject(err);
      resolve(Array.isArray(res) ? res : []);
    });
  });
}

async function _getDiscussionsByCreatedAsync(query) {
  if (typeof callWithFallbackAsync === "function") {
    return callWithFallbackAsync(steem.api.getDiscussionsByCreated, [query]);
  }
  return new Promise((resolve, reject) => {
    steem.api.getDiscussionsByCreated(query, (err, res) => {
      if (err) return reject(err);
      resolve(Array.isArray(res) ? res : []);
    });
  });
}

async function _getAccountsAsync(usernames) {
  if (typeof callWithFallbackAsync === "function") {
    return callWithFallbackAsync(steem.api.getAccounts, [usernames]);
  }
  return new Promise((resolve) => {
    steem.api.getAccounts(usernames, (err, res) => {
      resolve(!err && Array.isArray(res) ? res : []);
    });
  });
}

async function _getDynamicGlobalPropertiesAsync() {
  if (typeof callWithFallbackAsync === "function") {
    return callWithFallbackAsync(steem.api.getDynamicGlobalProperties, []);
  }
  return new Promise((resolve, reject) => {
    steem.api.getDynamicGlobalProperties((err, res) => {
      if (err) return reject(err);
      resolve(res || {});
    });
  });
}

// Run async jobs with bounded in-flight concurrency.
async function _mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Number(concurrency) || 1);
  const out = new Array(list.length);
  let idx = 0;

  async function runOne() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= list.length) return;
      try {
        out[myIdx] = await worker(list[myIdx], myIdx);
      } catch (e) {
        out[myIdx] = e;
      }
    }
  }

  const workers = Array.from({ length: Math.min(max, list.length || 1) }, () => runOne());
  await Promise.all(workers);
  return out;
}

/**
 * Best-effort registry inflation for mixed/legacy snapshot payloads.
 * Ensures runtime { ownership, _nftRegistry } are populated even when a
 * checkpoint carries a non-canonical registry shape.
 */
function _inflateSnapshotRegistry(snapshotLike) {
  const ownership = { ...(snapshotLike?.ownership || {}) };
  const registry = snapshotLike?.registry;
  if (!registry || typeof registry !== "object") return ownership;

  for (const [id, v] of Object.entries(registry)) {
    let type = "creature";
    let owner = null;

    if (v && typeof v === "object") {
      // Compact shape: { t, o }
      if (v.t === "a") type = "accessory";
      else if (v.t === "c") type = "creature";
      // Legacy shape: { type: "creature"|"accessory", owner?: "..." }
      if (v.type === "accessory") type = "accessory";
      else if (v.type === "creature") type = "creature";
      owner = v.o || v.owner || null;
    } else if (typeof v === "string") {
      // Rare legacy shape: registry value as owner username directly.
      owner = v;
    }

    _nftRegistry.set(id, { type });
    if (owner) ownership[id] = _normUser(owner);
  }
  return ownership;
}

async function fetchSnapshot(cid) {
  if (!isValidIpfsCid(cid)) {
    throw new Error(`Malformed snapshot CID: "${cid}"`);
  }
  let lastErr;
  for (const gateway of IPFS_GATEWAYS) {
    try {
      // Stage 1 — connect + headers (tight timeout).
      const connectTimeout = _makeTimeoutSignal(IPFS_CONNECT_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`${gateway}${cid}`, {
          signal: connectTimeout.signal
        });
      } finally {
        connectTimeout.cancel();
      }

      // BUG 4 FIX: Treat rate-limit / overload responses as immediate failover
      // rather than a hard error — the next gateway may succeed right away.
      if (IPFS_IMMEDIATE_FAILOVER_CODES.has(res.status)) {
        console.warn(`[SB State] Gateway ${gateway} returned ${res.status} — trying next.`);
        lastErr = new Error(`Gateway ${gateway} returned HTTP ${res.status} (immediate failover)`);
        continue;
      }

      if (!res.ok) {
        lastErr = new Error(`Gateway ${gateway} returned HTTP ${res.status}`);
        continue;
      }

      // Stage 2 — body read (generous timeout; body may be several MB).
      // Fix #2: the old code created an AbortController and set a timer but
      // never passed the signal anywhere — res.json() ran unconstrained and
      // could hang indefinitely on a gateway that sends headers quickly but
      // streams the body extremely slowly.  The fix races res.text() against
      // a rejection promise so the body read is actually bounded.
      let bodyTimer;
      const bodyTimeoutPromise = new Promise((_, reject) => {
        bodyTimer = setTimeout(
          () => reject(new Error(`Body read timed out after ${IPFS_BODY_TIMEOUT_MS / 1000}s`)),
          IPFS_BODY_TIMEOUT_MS
        );
      });
      let rawText;
      try {
        rawText = await Promise.race([res.text(), bodyTimeoutPromise]);
        clearTimeout(bodyTimer);
      } catch (bodyErr) {
        clearTimeout(bodyTimer);
        console.warn(`[SB State] Gateway ${gateway} body read failed: ${bodyErr.message} — trying next.`);
        lastErr = bodyErr;
        continue;
      }

      try {
        const raw = JSON.parse(rawText);

        // BUG 3 FIX: Expand compact registry format { id: { o, t } } into
        // runtime structures { ownership, _nftRegistry } on the way in.
        // Also handle old-format snapshots ({ ownership, registry: { type } })
        // so stale IPFS-pinned files are never silently discarded.
        if (raw.registry && _isCompactRegistry(raw.registry)) {
          // Full snapshot hydration: replace runtime registry atomically.
          _nftRegistry.clear();
          // Compact format (with or without an explicit ownership map) —
          // always merge ownership from registry.o fields so profile ownership
          // never disappears when snapshots include both shapes.
          const ownership = { ...(raw.ownership || {}) };
          for (const [k, v] of Object.entries(raw.registry)) {
            const type = v?.t === "a" ? "accessory" : "creature";
            _nftRegistry.set(k, { type });
            if (v?.o) ownership[k] = _normUser(v.o);
          }
          return {
            version:   raw.version,
            block_num: raw.block_num,
            timestamp: raw.timestamp,
            ownership,
            equipped:  raw.equipped || {},
            // BUG A FIX: transfer_intents excluded from canonical snapshot;
            // always start empty so bootstrapState replay rebuilds it fresh.
            transfer_intents: {}
          };
        } else if (raw.ownership && raw.registry) {
          // Full snapshot hydration: replace runtime registry atomically.
          _nftRegistry.clear();
          // Old split format — hydrate _nftRegistry from the separate registry map.
          for (const [k, v] of Object.entries(raw.registry)) {
            _nftRegistry.set(k, v);
          }
          const { registry: _ignored, ...rest } = raw;
          // BUG A FIX: transfer_intents excluded from canonical snapshot.
          rest.transfer_intents = {};
          return rest;
        }
        // BUG A FIX: transfer_intents excluded from canonical snapshot.
        raw.transfer_intents = {};
        return raw;
      } catch (parseErr) {
        console.warn(`[SB State] Gateway ${gateway} JSON parse failed: ${parseErr.message} — trying next.`);
        lastErr = parseErr;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All IPFS gateways failed for CID: " + cid);
}

// ============================================================
// § 6 — INDEXEDDB SNAPSHOT PERSISTENCE
// ============================================================

// BUG 4 FIX: _openStateDB() no longer opens its own DB version.
// The sb_state_snapshot store is now created inside openSBDB() in
// blockchain.js (the single source of truth for the DB schema), so we
// simply delegate to that shared function.  This eliminates the race
// condition where two tabs could request version 2 and version 3
// simultaneously and crash or block each other.
function _openStateDB() {
  return openSBDB(); // defined in blockchain.js
}

/** Persist a state snapshot + its CID + hash to IndexedDB for offline reuse.
 *
 * Fix #8a: returns true on success, false on failure.  Previously always
 * returned undefined (the catch swallowed the error silently), so callers
 * had no way to know whether the IDB write succeeded.  The follower-tab
 * wake-up paths in app.js now check this return value and fall back to a
 * direct bootstrapState() call when the write failed.
 */
async function persistSnapshot(snapshot, cid, stateHash) {
  try {
    const db = await _openStateDB();
    // BUG 3 FIX: Merge ownership + _nftRegistry into a single compact "registry"
    // object using short keys { o: owner, t: "c"|"a" } to reduce IDB storage and
    // eliminate the "partial state" bug where an ID could exist in one map but
    // not the other.  The old { _registry, ownership } split is replaced entirely.
    const sortedKeys = [..._nftRegistry.keys()].sort();
    const compactRegistry = {};
    for (const k of sortedKeys) {
      const regEntry = _nftRegistry.get(k);
      const entry = { t: regEntry.type === "accessory" ? "a" : "c" };
      if (snapshot.ownership?.[k]) entry.o = snapshot.ownership[k];
      compactRegistry[k] = entry;
    }
    // Also capture any ownership entries whose NFT type wasn't in the Map yet
    // (edge-case: synthetic placeholders written by transfer_accept before mint).
    if (snapshot.ownership) {
      for (const [k, owner] of Object.entries(snapshot.ownership)) {
        if (!compactRegistry[k]) compactRegistry[k] = { t: "c", o: owner };
      }
    }

    const tx = db.transaction(STORE_STATE, "readwrite");
    tx.objectStore(STORE_STATE).put({
      id:        "latest",
      cid,
      stateHash,
      // Store compact snapshot — no separate _registry or ownership fields.
      // BUG A FIX: transfer_intents is NOT persisted here; it is ephemeral
      // handshake state that is always reconstructed from replay on boot.
      snapshot:  {
        version:   snapshot.version,
        block_num: snapshot.block_num,
        timestamp: snapshot.timestamp,
        registry:  compactRegistry,
        equipped:  snapshot.equipped || {}
      },
      savedAt:   Date.now()
    });
    await new Promise((ok, fail) => {
      tx.oncomplete = ok;
      tx.onerror    = () => fail(tx.error);
    });
    return true; // Fix #8a: explicit success signal
  } catch (e) {
    console.warn("[SB State] IndexedDB persist failed:", e);
    return false; // Fix #8a: explicit failure signal — caller must handle
  }
}

/** Load the last persisted snapshot from IndexedDB. Returns null if none. */
async function loadPersistedSnapshot() {
  try {
    const db = await _openStateDB();
    return new Promise((resolve) => {
      const tx  = db.transaction(STORE_STATE, "readonly");
      const req = tx.objectStore(STORE_STATE).get("latest");
      req.onsuccess = () => {
        const row = req.result || null;
        if (!row?.snapshot) { resolve(null); return; }

        const snap = row.snapshot;

        // BUG 3 FIX: Support both the new compact { registry: { o, t } } format
        // and the old { ownership, _registry } split format so existing cached
        // snapshots are not silently discarded after the upgrade.
        if (snap.registry && !snap._registry && _isCompactRegistry(snap.registry)) {
          // Full snapshot hydration: replace runtime registry atomically.
          _nftRegistry.clear();
          // Compact format (with or without ownership map) — expand back into
          // runtime structures and merge ownership from registry.o fields.
          const ownership = { ...(snap.ownership || {}) };
          const sortedEntries = Object.entries(snap.registry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          for (const [k, v] of sortedEntries) {
            const type = v?.t === "a" ? "accessory" : "creature";
            _nftRegistry.set(k, { type });
            if (v?.o) ownership[k] = _normUser(v.o);
          }
          const cleanSnap = {
            version: snap.version,
            block_num: snap.block_num,
            timestamp: snap.timestamp,
            ownership,
            equipped: snap.equipped || {},
            // BUG A FIX: transfer_intents is not stored in the snapshot;
            // it is always rebuilt from replay.  Initialise to empty so
            // applyOperation callers never see undefined.
            transfer_intents: {}
          };
          resolve({ ...row, snapshot: cleanSnap });
        } else if (snap._registry) {
          // Full snapshot hydration: replace runtime registry atomically.
          _nftRegistry.clear();
          // Legacy format (old split schema) — migrate on the fly.
          const sortedEntries = Object.entries(snap._registry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          for (const [k, v] of sortedEntries) {
            _nftRegistry.set(k, v);
          }
          const { _registry, ...cleanSnap } = snap;
          // BUG A FIX: transfer_intents not stored in snapshot; always start empty.
          cleanSnap.transfer_intents = {};
          resolve({ ...row, snapshot: cleanSnap });
        } else {
          // BUG A FIX: transfer_intents not stored in snapshot; always start empty.
          snap.transfer_intents = {};
          resolve(row);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ============================================================
// § 7 — STEEM CHECKPOINT DISCOVERY
// ============================================================

/**
 * Scan one account's history for checkpoint custom_json ops,
 * walking backwards in pages of `pageSize` until we've gone past
 * `minBlockNum` or exhausted history.
 *
 * Returns an array of parsed checkpoint payloads (unsorted).
 */
async function _scanAccountCheckpoints(account, minBlockNum = 0, pageSize = 1000) {
  const found = [];
  let cursor = -1; // -1 = start from the most recent op

  while (true) {
    const batch = await _getAccountHistoryAsync(account, cursor, pageSize);

    if (batch.length === 0) break;

    for (const tx of batch) {
      const op = tx[1]?.op;
      if (op && op[0] === "custom_json" && op[1]?.id === CHECKPOINT_ID) {
        try {
          const payload = JSON.parse(op[1].json);
          // Strict shape validation: malformed payloads are ignored early so
          // they can never dominate checkpoint scoring with forged block numbers
          // (e.g. block_num=999999999 with missing/invalid CID/hash).
          if (!payload || typeof payload !== "object") continue;
          const bn = Number(payload.block_num);
          if (!Number.isInteger(bn) || bn <= 0) continue;
          if (!isValidIpfsCid(payload.snapshot_cid)) continue;
          if (!/^[a-f0-9]{64}$/i.test(String(payload.state_hash || ""))) continue;
          const ver = Number(payload.version);
          if (Number.isInteger(ver) && ver !== SB_STATE_VERSION) continue;
          found.push({
            version: Number.isInteger(ver) ? ver : SB_STATE_VERSION,
            block_num: bn,
            state_hash: String(payload.state_hash).toLowerCase(),
            snapshot_cid: String(payload.snapshot_cid).trim()
          });
        } catch { /* malformed — skip */ }
      }
    }

    // The oldest entry in this batch tells us how far back we've gone.
    const oldestBlockInBatch = batch[0]?.[1]?.block || 0;
    if (oldestBlockInBatch <= minBlockNum) break; // we've covered the needed range

    // Steem history is indexed by sequence number; the first entry in the batch
    // gives us the sequence to use as the next cursor (exclusive upper bound).
    const oldestSeq = batch[0]?.[0];

    // Fix #3: the old code broke when oldestSeq === 0, skipping sequence 0
    // entirely.  A checkpoint published as the account's very first operation
    // (e.g. the genesis checkpoint for @steembiota) was permanently invisible.
    // Fix: if oldestSeq is 0 we have already included it in this batch's scan
    // loop above, so we can safely stop — but we must NOT break before processing
    // that entry.  We break AFTER the loop, not before it.
    if (oldestSeq === undefined || oldestSeq === 0) break; // reached genesis
    cursor = oldestSeq - 1;
    // cursor can be 0 here (next batch will start at seq 0 and then we break).
    // The old `if (cursor < 0) break;` prevented that fetch — removed.
  }

  return found;
}

/**
 * Fetch checkpoints from ALL recently active community accounts who have
 * ever posted one, score them by stake+reputation+age, and return the
 * best candidate.
 *
 * Security model:
 *  - Group candidates by (block_num, state_hash) so colluding minority
 *    accounts are drowned out.
 *  - Score each group: stake weight + reputation + recency bonus.
 *  - The @steembiota account always gets a large trust bonus.
 *  - Callers should verify the winning CID (random spot-check or on suspicion).
 *
 * Bug Fix #3: Scans deeply (up to `pageSize` ops per account) so the
 *   checkpoint is never "pushed out" of a shallow 100-op window.
 * Bug Fix #4: Considers checkpoints from any community member, not just
 *   @steembiota, with stake/reputation scoring to guard against spoofing.
 *
 * Returns { version, block_num, state_hash, snapshot_cid } or null.
 */
async function fetchLatestCheckpoint(minBlockNum = 0) {
  // ── 1. Collect candidates ──────────────────────────────────────────────────
  // Always scan the canonical account deeply.
  let allCandidates = [];
  try {
    const canonical = await _scanAccountCheckpoints(CHECKPOINT_AUTHOR, minBlockNum, 1000);
    // Tag each with a high base trust for @steembiota
    // BUG FIX 1A: Trust bonus raised to 1_000_000 so @steembiota's checkpoints
    // always outrank any community account — even one with maximum normalised
    // reputation (~65) plus maximum recency bonus.
    canonical.forEach(c => allCandidates.push({ ...c, _publisher: CHECKPOINT_AUTHOR, _trust: 1_000_000 }));
  } catch (e) {
    console.warn("[SB State] Canonical checkpoint scan failed:", e);
  }

  // Discover community accounts that have ever published a checkpoint.
  // Uses resume-able all-time discovery slices until exhausted.
  try {
    const discovery = await _discoverAllTimeAuthors(DISCOVERY_CACHE_KEY_CHECKPOINTS);
    const communityAccounts = [...new Set((discovery.authors || []).map(_normUser).filter(Boolean))]
      .filter(a => a !== CHECKPOINT_AUTHOR);

    await Promise.allSettled(communityAccounts.map(async (account) => {
      try {
        const cps = await _scanAccountCheckpoints(account, minBlockNum, 200);
        cps.forEach(c => allCandidates.push({ ...c, _publisher: account, _trust: 0 }));
      } catch { /* non-fatal — skip bad accounts */ }
    }));
  } catch (e) {
    console.warn("[SB State] Community checkpoint discovery failed (non-fatal):", e);
  }

  if (allCandidates.length === 0) return null;

  // ── 2. Fetch reputation to weight community accounts ──────────────────────
  const uniqueAccounts = [...new Set(allCandidates.map(c => c._publisher))];
  const reputations = {};
  try {
    const res = await _getAccountsAsync(uniqueAccounts);
    res.forEach(a => {
      reputations[a.name] = parseFloat(a.reputation || 0);
    });
  } catch { /* reputation unavailable — fall back to zero */ }

  // ── 3. Group by (block_num, state_hash) and score each group ──────────────
  const groups = {};
  for (const c of allCandidates) {
    const key = `${c.block_num}:${c.state_hash}`;
    if (!groups[key]) groups[key] = { payload: c, publishers: [], score: 0 };
    const g = groups[key];
    g.publishers.push(c._publisher);
    // Trust bonus for @steembiota
    const trustBonus = c._trust || 0;
    // BUG FIX 1A: The raw value returned by the Steem API for `reputation` is
    // a large integer (e.g. 74_289_347_289_342), NOT the familiar 0-100 score
    // shown in Steemit.  Adding the raw value to the score would let any user
    // with reputation > 70 (raw value in the trillions) completely dwarf the
    // 1000-point trustBonus assigned to @steembiota, enabling a trivial
    // "reputation-takeover" attack.
    //
    // Fix (a): Normalise the raw reputation to the same 25-100 scale that
    //          Steemit displays: rep = max(0, (log10(raw) - 9) × 9 + 25).
    //          This caps the maximum additive reputation at ~65 points.
    //
    // Fix (b): Raise the @steembiota trustBonus from 1000 to 1_000_000 so it
    //          is unconditionally dominant over any community account — even one
    //          whose score is boosted by the maximum normalised reputation AND
    //          the maximum recency bonus.
    //
    // Fix (c): Keep the recency bonus integer-only (Math.floor, /1000 instead
    //          of /1e6) so every browser picks the same winning checkpoint
    //          regardless of floating-point rounding differences (Bug 2B).
    const rawRep = reputations[c._publisher] || 0;
    // BUG 4C FIX: Math.log10 can produce slightly different results at the
    // 15th decimal place across CPU architectures and JS engines (V8 vs
    // SpiderMonkey).  Two clients could therefore compute different `rep`
    // values and pick different winning checkpoints, forking the state.
    // Fix: convert to an integer (× 1000, floored) before adding to the
    // group score.  Both clients will always arrive at the same integer.
    const rep = rawRep > 0
      ? Math.floor(Math.max(0, (Math.log10(rawRep) - 9) * 9 + 25) * 1000)
      : 0;
    // BUG FIX 2B: integer-only recency so V8 and SpiderMonkey agree exactly.
    const recency = Math.floor((c.block_num || 0) / 1000);
    g.score += trustBonus + rep + recency;
  }

  // ── 4. Pick the highest-scoring ROOT-VALID group ─────────────────────────
  // Security hardening: never return null just because the top-ranked candidate
  // is invalid against roots. Instead, iterate candidates in score order and
  // return the first root-valid one.
  const ranked = Object.values(groups).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;

  const best = ranked.find((candidate) => {
    for (const root of CHECKPOINT_ROOTS) {
      if (candidate.payload.block_num <= root.block_num) {
        if (candidate.payload.state_hash !== root.state_hash) {
          console.error(
            `[SB State] SECURITY: Checkpoint rejected — hash ${candidate.payload.state_hash.slice(0, 16)}… ` +
            `does not match root ${root.state_hash.slice(0, 16)}… for block ${root.block_num}. ` +
            `Publishers: ${candidate.publishers.join(", ")}`
          );
          return false;
        }
      }
    }
    return true;
  });
  if (!best) return null;

  // BUG 3 FIX: Attach publisher metadata so the UI can display a
  // "Verified by @steembiota" badge vs. a community-sourced checkpoint.
  const isCanonical = best.publishers.includes(CHECKPOINT_AUTHOR);
  const result = {
    ...best.payload,
    _publishers:   best.publishers,
    _isCanonical:  isCanonical,
    _score:        best.score
  };

  console.info(
    `[SB State] Best checkpoint: block ${result.block_num}, ` +
    `score ${best.score.toFixed(1)}, publishers: ${best.publishers.join(", ")}, ` +
    `canonical: ${isCanonical}`
  );

  return result;
}

// ============================================================
// § 8 — CHECKPOINT BROADCASTING
// ============================================================

/**
 * Publish a new checkpoint to the Steem blockchain via Keychain.
 * Hashes `state`, then broadcasts a custom_json containing
 * { version, block_num, state_hash, snapshot_cid }.
 *
 * @param {string}   username — broadcaster's Steem account
 * @param {object}   state    — current globalState value
 * @param {string}   cid      — IPFS CID of the uploaded snapshot
 * @param {function} callback — Keychain callback (res) => void
 */
async function publishCheckpoint(username, state, cid, callback) {
  const stateHash = await hashState(state);
  const payload = {
    version:      SB_STATE_VERSION,
    block_num:    state.block_num,
    state_hash:   stateHash,
    snapshot_cid: cid
  };
  steem_keychain.requestCustomJson(
    username,
    CHECKPOINT_ID,
    "Posting",
    JSON.stringify(payload),
    `SteemBiota Checkpoint @ block ${state.block_num}`,
    callback
  );
}

// ============================================================
// § 9 — FULL BOOT SEQUENCE
// ============================================================

/**
 * Fetch ALL steembiota-tagged TOP-LEVEL posts since `sinceDate`, walking
 * backwards through pages via getDiscussionsByCreated.
 *
 * NOTE: This only returns top-level posts (creatures / accessories).
 * Reply-based operations (transfer_accept, feed, wear_on/off) are NOT
 * returned here — they are captured separately by _fetchReplyOpsSince().
 *
 * @param {Date|null} sinceDate — stop collecting once posts are older than this
 * @returns {Promise<object[]>} posts in newest-first order
 */
async function _fetchAllPostsSince(
  sinceDate,
  {
    maxPages = Infinity,
    startCursor = null,
    onProgress = null
  } = {}
) {
  const tag    = "steembiota";
  const limit  = 100; // Steem API hard cap per call
  const result = [];
  let   cursor = startCursor; // { author, permlink } of the oldest post seen so far
  let   pages = 0;

  while (true) {
    if (pages >= maxPages) {
      return { posts: result, nextCursor: cursor, exhausted: false, pages };
    }

    const query = { tag, limit: cursor ? limit + 1 : limit };
    if (cursor) {
      query.start_author   = cursor.author;
      query.start_permlink = cursor.permlink;
    }

    const batch = await _getDiscussionsByCreatedAsync(query);
    pages++;
    if (typeof onProgress === "function") {
      try { onProgress({ pages, fetched: result.length }); } catch {}
    }

    // When using a cursor, the first item is the cursor post itself — skip it.
    const posts = cursor ? batch.slice(1) : batch;
    if (posts.length === 0) break;

    let hitCutoff = false;
    for (const p of posts) {
      const postDate = new Date(p.created);
      if (sinceDate && postDate <= sinceDate) {
        hitCutoff = true;
        break;
      }
      result.push(p);
    }

    if (hitCutoff || posts.length < limit) {
      return { posts: result, nextCursor: null, exhausted: true, pages };
    }

    // Advance cursor to the oldest post in this batch
    const oldest = posts[posts.length - 1];
    cursor = { author: oldest.author, permlink: oldest.permlink };
  }

  return { posts: result, nextCursor: null, exhausted: true, pages };
}

/**
 * BUG FIX 1B — Fetch reply-based operations (transfer_accept, feed, wear_on,
 * wear_off) that postdate `sinceDate`.
 *
 * PREVIOUS BUG: We only scanned CHECKPOINT_AUTHOR's (@steembiota) account
 * history.  But transfer_accept replies are posted by the *recipient* on the
 * *sender's* post — which may belong to any user.  That means any transfer
 * between two non-@steembiota accounts was permanently invisible to the
 * state machine, causing lost NFT ownership.
 *
 * FIX: Derive the set of "active community accounts" from the same
 * steembiota-tagged posts we already fetch for top-level replay, then scan
 * *each* account's history for comment operations.  This captures
 * transfer_accept (and wear_on/off) replies regardless of which account's
 * post they are attached to.
 *
 * @param {Date|null} sinceDate       — ignore ops older than or equal to this date
 * @param {string[]}  communityAuthors — accounts to scan (from _fetchAllPostsSince)
 * @returns {Promise<object[]>} synthetic post-like objects, newest-first
 */
// filterTypes — optional Set of steembiota type strings to accept.
// When omitted all reply-based action types are included.  Pass a narrower
// set (e.g. new Set(["wear_on","wear_off"])) for the genesis equip replay
// so unrelated ops are not re-processed a second time.
async function _fetchReplyOpsSince(sinceDate, communityAuthors = [], filterTypes = null) {
  // Always include the canonical account; deduplicate the rest.
  const accounts = [...new Set([CHECKPOINT_AUTHOR, ...communityAuthors].map(_normUser).filter(Boolean))];
  const REPLY_SCAN_CONCURRENCY = 6;
  const REPLY_TYPES = filterTypes instanceof Set
    ? filterTypes
    : new Set(["transfer_offer", "transfer_cancel", "transfer_accept", "feed", "wear_on", "wear_off"]);
  const allResults = [];

  await _mapWithConcurrency(accounts, REPLY_SCAN_CONCURRENCY, async (account) => {
    const accountResults = [];
    let cursor   = -1;
    const pageSize = 1000;

    while (true) {
      const batch = await _getAccountHistoryAsync(account, cursor, pageSize);

      if (batch.length === 0) break;

      let hitCutoff = false;
      // Account history is returned oldest-first within each batch; iterate
      // in reverse so we process newest-first and can break early.
      for (let i = batch.length - 1; i >= 0; i--) {
        const tx  = batch[i];
        const op  = tx[1]?.op;
        if (!op) continue;

        const opType = op[0];
        const opData = op[1];

        // We only care about comment ops (replies) that carry steembiota metadata.
        if (opType !== "comment") continue;

        const opTimestamp = tx[1]?.timestamp
          ? new Date(tx[1].timestamp)
          : null;

        if (sinceDate && opTimestamp && opTimestamp <= sinceDate) {
          hitCutoff = true;
          break;
        }

        // Parse json_metadata to confirm this is a steembiota action.
        let meta;
        try {
          const parsed = typeof opData.json_metadata === "string"
            ? JSON.parse(opData.json_metadata || "{}")
            : (opData.json_metadata || {});
          meta = parsed.steembiota;
        } catch { continue; }

        if (!meta) continue;

        // Only replay the reply-specific action types that _fetchAllPostsSince misses.
        if (!REPLY_TYPES.has(meta.type)) continue;

        // Build a synthetic post object compatible with applyOperation().
        // BUG 2 FIX: getAccountHistory returns the block number in tx[1].block.
        // Carry it through so applyOperation() can advance state.block_num
        // correctly even for reply-based ops, preventing the "Block 0 Genesis
        // Trap" where the state stays at block_num=0 after a genesis replay.
        accountResults.push({
          author:        opData.author        || "",
          permlink:      opData.permlink       || "",
          json_metadata: opData.json_metadata  || "{}",
          created:       tx[1]?.timestamp      || new Date(0).toISOString(),
          block_num:     tx[1]?.block          || 0
        });
      }

      if (hitCutoff) break;

      // Advance cursor (sequence number) backward through history.
      const oldestSeq = batch[0]?.[0];
      if (oldestSeq === undefined || oldestSeq === 0) break;
      cursor = oldestSeq - 1;
      if (cursor < 0) break;

      // Also stop if the oldest timestamp in this batch predates our cutoff.
      const oldestTimestamp = batch[0]?.[1]?.timestamp
        ? new Date(batch[0][1].timestamp)
        : null;
      if (sinceDate && oldestTimestamp && oldestTimestamp <= sinceDate) break;
    }

    // Push this account's results into the shared array.
    allResults.push(...accountResults);
  });

  return allResults;
}
/**
 * Bootstrap the global NFT state by:
 *   1. Checking IndexedDB for a cached snapshot (instant, offline-capable)
 *   2. Fetching the latest on-chain checkpoint and comparing CIDs
 *   3. Downloading + verifying the IPFS snapshot when newer
 *   4. Replaying ALL posts that postdate the snapshot (paginated, exhaustive)
 *
 * `stateRef`     — Vue ref that will receive the live state object
 * `syncStatusRef`— Vue ref (string) for UI status messages
 * `onProgress`   — optional (msg) => void for finer-grained progress
 *
 * Bug Fix #7: The entire replay runs against a local variable `currentState`.
 * stateRef.value is updated exactly once at the very end to prevent UI flicker.
 *
 * Designed to be called from App.onMounted().  Non-fatal errors are
 * surfaced via syncStatusRef rather than thrown.
 */
async function bootstrapState(stateRef, syncStatusRef, onProgress, onReady) {
  // BUG 6 FIX: onReady is an optional callback invoked once — and only once —
  // after stateRef.value has been assigned the fully-replayed state.
  // app.js uses this to flip stateReady.value = true, which gates the
  // rendering of ownership information in child views.
  const status = (msg) => {
    if (syncStatusRef) syncStatusRef.value = msg;
    if (onProgress)    onProgress(msg);
    console.info("[SB State]", msg);
  };

  try {
    status("🔍 Checking local cache…");
    const persisted = await loadPersistedSnapshot();

    // ── Step 1: Try on-chain checkpoint ─────────────────────
    status("🛰️ Searching for checkpoint on-chain…");
    let checkpoint = null;
    try {
      // Pass minBlockNum = 0 so the scanner walks back as far as needed
      checkpoint = await fetchLatestCheckpoint(0);
    } catch (e) {
      console.warn("[SB State] Checkpoint fetch failed (non-fatal):", e);
    }

    // ── Step 2: Decide which snapshot to use ────────────────
    let snapshot      = null;
    let snapshotHash  = null;
    let snapshotCid   = null;

    if (checkpoint) {
      // If we already have an IDB snapshot for this CID, verify its hash before reuse.
      if (persisted && persisted.cid === checkpoint.snapshot_cid) {
        try {
          const persistedHash = await hashState(persisted.snapshot || {});
          if (persistedHash === checkpoint.state_hash) {
            status(`✅ Local cache is current (block ${persisted.snapshot?.block_num ?? "?"}).`);
            snapshot     = persisted.snapshot;
            snapshotHash = persistedHash;
            snapshotCid  = persisted.cid;
          } else {
            console.warn("[SB State] Local cache hash mismatch for matching CID — forcing IPFS re-download.");
            status("⚠️ Local cache integrity mismatch — revalidating from IPFS…");
          }
        } catch (e) {
          console.warn("[SB State] Local cache hash verification failed — forcing IPFS re-download:", e);
        }
      }
      if (!snapshot) {
        status(`📥 Downloading snapshot ${checkpoint.snapshot_cid.slice(0, 8)}… from IPFS`);
        try {
          // Security hardening: fetchSnapshot currently inflates registry data
          // into the module-level _nftRegistry while decoding JSON. If the
          // downloaded blob later fails hash verification, that side effect must
          // be rolled back; otherwise a tampered gateway response can poison the
          // in-memory registry even though the snapshot itself is rejected.
          const registryBeforeFetch = new Map(_nftRegistry);
          const raw  = await fetchSnapshot(checkpoint.snapshot_cid);
          const hash = await hashState(raw);
          if (hash !== checkpoint.state_hash) {
            _nftRegistry.clear();
            for (const [k, v] of registryBeforeFetch.entries()) {
              _nftRegistry.set(k, v);
            }
            throw new Error("Hash mismatch — snapshot may be tampered. Ignored.");
          }
          snapshot     = raw;
          snapshotHash = hash;
          snapshotCid  = checkpoint.snapshot_cid;
          // Fix #8a/8b: capture the boolean return from persistSnapshot.
          // If the IDB write fails silently, follower tabs that wake on the
          // sb_state_ready broadcast or storage event call loadPersistedSnapshot()
          // against a stale or empty store, leaving _nftRegistry unpopulated for
          // the whole session.  We expose the outcome on window._sbPersistOk;
          // the follower-tab paths in app.js read it and fall back to an
          // independent bootstrapState() call when the flag is false.
          const persistOk = await persistSnapshot(snapshot, snapshotCid, snapshotHash);
          window._sbPersistOk = persistOk;
          if (!persistOk) {
            console.warn("[SB State] IDB persist failed — follower tabs will bootstrap independently.");
          }
          status(`✅ Snapshot verified (block ${snapshot.block_num}).`);
        } catch (e) {
          status(`⚠️ IPFS snapshot failed: ${e.message}. Falling back to local cache…`);
          if (persisted) {
            snapshot     = persisted.snapshot;
            snapshotHash = persisted.stateHash;
            snapshotCid  = persisted.cid;
          }
        }
      }
    } else if (persisted) {
      status(`📂 No on-chain checkpoint found. Using local cache (block ${persisted.snapshot?.block_num ?? "?"}).`);
      snapshot     = persisted.snapshot;
      snapshotHash = persisted.stateHash;
      snapshotCid  = persisted.cid;
    }

    // ── Step 3: Seed local state — do NOT touch stateRef yet (Bug Fix #7) ──
    let currentState;
    if (snapshot) {
      // Work on a shallow copy so we never mutate the cached object directly
      currentState = { ...snapshot };
      // Defensive: if a checkpoint snapshot reaches us with an unusual mixed
      // schema and ownership ended up empty, recover from registry directly so
      // Profile ownership queries and wear replay are never starved.
      if (Object.keys(currentState.ownership || {}).length === 0 && currentState.registry) {
        currentState.ownership = _inflateSnapshotRegistry(currentState);
      }
    } else {
      status("⚙️ No checkpoint found. Building state from genesis (this may take a while)…");
      currentState = createEmptyState();
    }

    // ── Step 4: Exhaustive replay of posts newer than the snapshot ──────────
    const cutoff = currentState.timestamp ? new Date(currentState.timestamp) : null;
    status(`🔄 Replaying all events since ${cutoff ? cutoff.toISOString().slice(0, 10) : "genesis"}…`);

    // BUG FIX 1B: pass community authors so _fetchReplyOpsSince scans
    // ALL active accounts, not just @steembiota.  This captures
    // transfer_accept replies posted on non-canonical posts.
    // BUG 2 FIX: communityAuthors (derived from top-level posts) misses users
    // who own NFTs but haven't posted a new creature/accessory recently.
    // Any such user can still perform wear_on/wear_off today, and we'd never
    // scan their history.  Solution: also include every account that currently
    // appears in the ownership map — they are the full set of users who can
    // post reply-based operations against their NFTs.
    //
    // BUG 1 FIX (Discovery Gap): When bootstrapping from genesis (block_num=0,
    // empty ownership) ownerAuthors is [], and _fetchAllPostsSince only returns
    // authors who posted a NEW creature/accessory since cutoff=null.  If all
    // existing participants last posted before `cutoff` (or if there is no
    // cutoff at all but the snapshot registry already lists owners), neither
    // communityAuthors nor ownerAuthors will contain them.
    //
    // Fix: build a "known participants" set from THREE sources:
    //   (a) owners already recorded in currentState.ownership (incremental replay)
    //   (b) all "o" fields in the compact snapshot registry (genesis from snapshot)
    //   (c) a full steembiota-tag scan (exhaustive, no date cutoff) so every
    //       account that has ever posted a creature or accessory is included,
    //       even if they haven't posted anything recently.
    // Source (c) is done without a date cutoff so it covers all-time participants.
    const ownerAuthors = currentState
      ? [...new Set(Object.values(currentState.ownership).map(_normUser).filter(Boolean))]
      : [];

    // Source (b): extract owners from the compact registry if the snapshot was
    // loaded in its raw compact form (e.g. from IPFS before expansion into
    // _nftRegistry + ownership).  After loadPersistedSnapshot() the compact
    // registry has already been expanded into _nftRegistry and ownership, so
    // this mainly helps when `snapshot` came straight from fetchSnapshot().
    const registryOwners = [];
    const registryAuthors = [];
    if (snapshot && snapshot.registry && typeof snapshot.registry === "object") {
      for (const entry of Object.values(snapshot.registry)) {
        if (entry && entry.o) registryOwners.push(_normUser(entry.o));
      }
    }
    // Also harvest from the live _nftRegistry map (populated during snapshot load).
    for (const owner of Object.values(currentState.ownership || {})) {
      if (owner) registryOwners.push(_normUser(owner));
    }
    for (const id of _nftRegistry.keys()) {
      const author = _normUser(String(id).split("/")[0]);
      if (author) registryAuthors.push(author);
    }

    let rawPosts = [];
    try {
      const topLevelResult = await _fetchAllPostsSince(cutoff, {
        onProgress: ({ pages, fetched }) => {
          status(`🔄 Replaying… fetched ${fetched} top-level post(s) across ${pages} page(s)`);
        }
      });
      const topLevel = topLevelResult.posts;
      // Derive the active community from the top-level posts we already fetched.
      const communityAuthors = [...new Set(topLevel.map(p => p.author))];

      // Source (c): if we are doing a genesis bootstrap (no cutoff) OR if the
      // merged author list is suspiciously small (< 3 unique accounts), perform
      // an exhaustive all-time tag scan so we don't miss historical participants
      // who haven't posted since `cutoff`.
      let allTimeAuthors = [];
      const isGenesis = !cutoff;
      const mergedSoFar = new Set([...communityAuthors, ...ownerAuthors, ...registryOwners, ...registryAuthors]);
      if (isGenesis || mergedSoFar.size < 3) {
        try {
          status("🔍 Scanning all-time participants for reply discovery…");
          const participantDiscovery = await _discoverAllTimeAuthors(DISCOVERY_CACHE_KEY_PARTICIPANTS, {
            onSlice: ({ slices, authors, exhausted }) => {
              status(`🔍 Participant discovery… ${authors} author(s), slice ${slices} (${exhausted ? "complete" : "partial"})`);
            }
          });
          allTimeAuthors = [...new Set((participantDiscovery.authors || []).map(_normUser).filter(Boolean))];
          status(`🔍 Participant discovery ${participantDiscovery.exhausted ? "complete" : "partial"} — ${allTimeAuthors.length} known participant(s).`);
        } catch (e) {
          console.warn("[SB State] All-time tag scan failed (non-fatal):", e);
        }
      }

      // Merge all sources: recent creators + all-time creators + current owners + registry owners + registry authors
      const allAuthors = [...new Set([
        ...communityAuthors,
        ...allTimeAuthors,
        ...ownerAuthors,
        ...registryOwners,
        ...registryAuthors
      ].map(_normUser).filter(Boolean))];
      status(`🔎 Reply discovery: scanning ${allAuthors.length} account(s)…`);

      // BUG C FIX: Two-pass reply scan.
      //
      // Problem: a user who is named as the recipient in a transfer_offer but
      // who has never posted a creature or accessory themselves will not appear
      // in any of the author sources above.  Their transfer_accept reply is
      // therefore never fetched, so the GSM permanently misses the ownership
      // change even though it is on-chain.
      //
      // Fix:
      //   Pass 1 — scan all known authors for transfer_offer ops only.
      //            Parse each offer's meta.to field to discover recipient accounts
      //            that are not yet in allAuthors.
      //   Pass 2 — re-scan the augmented author set (allAuthors + new recipients)
      //            for the full set of reply types.  This guarantees that every
      //            transfer_accept posted by a first-time recipient is captured.
      //
      // Pass 1 is cheap: it fetches exactly the same account-history pages that
      // Pass 2 would fetch, just with a narrower type filter so we parse quickly.
      const pass1Replies = await _fetchReplyOpsSince(
        cutoff,
        allAuthors,
        new Set(["transfer_offer"])
      );
      // Extract recipient (meta.to) accounts from all discovered offers.
      const offerRecipients = new Set();
      for (const op of pass1Replies) {
        try {
          const parsed = typeof op.json_metadata === "string"
            ? JSON.parse(op.json_metadata || "{}")
            : (op.json_metadata || {});
          const to = _normUser(parsed?.steembiota?.to || "");
          if (to && !allAuthors.includes(to)) offerRecipients.add(to);
        } catch { /* malformed — skip */ }
      }
      // Augment the author list with newly discovered recipients.
      const augmentedAuthors = offerRecipients.size > 0
        ? [...new Set([...allAuthors, ...offerRecipients])]
        : allAuthors;
      if (offerRecipients.size > 0) {
        status(`🔎 Found ${offerRecipients.size} transfer recipient(s) not in initial scan — augmenting author list…`);
      }

      // Pass 2 — full reply scan over the augmented author set.
      const replies = await _fetchReplyOpsSince(cutoff, augmentedAuthors);
      rawPosts = [...topLevel, ...replies];

      // ── BUG FIX (Equipped Genesis Gap) ──────────────────────────────────
      // The snapshot loaded from IPFS/IDB may have been generated by an older
      // version of the state machine that never processed wear_on/wear_off ops
      // (the original Discovery Gap bug).  In that case snapshot.equipped is {}
      // even though creatures have been wearing accessories for months.
      //
      // The incremental replay above only fetches events AFTER `cutoff`, so all
      // historical wear events remain permanently lost — they are "inside" the
      // snapshot but the snapshot recorded them as empty.
      //
      // Fix: whenever the equipped map is empty while ownership is non-empty
      // (i.e. there are NFTs that could plausibly be wearing something),
      // could plausibly be wearing something), wipe equipped and do a FULL
      // genesis replay of ONLY the wear_on/wear_off event types.  This is cheap
      // because we already have allAuthors computed and _fetchReplyOpsSince
      // accepts a per-type filter via the REPLY_TYPES set — we just pass
      // sinceDate=null to walk all the way back to the beginning of time.
      //
      // We deliberately do NOT re-derive ownership or registry from the genesis
      // wear replay — those fields are correctly set by the snapshot.  Only the
      // equipped map is reset and rebuilt from scratch.
      const snapshotHasNFTs = Object.keys(currentState.ownership || {}).length > 0;
      const snapshotEquippedEmpty = Object.keys(currentState.equipped || {}).length === 0;
      if (snapshotHasNFTs && snapshotEquippedEmpty) {
        status("🔍 Equipped map appears empty — replaying all wear events from genesis…");
        try {
          const wearReplies = await _fetchReplyOpsSince(null, allAuthors, new Set(["wear_on", "wear_off"]));
          // Apply in chronological order, updating only the equipped map.
          // We mutate a temporary state copy so any error here is non-fatal.
          wearReplies.sort((a, b) => new Date(a.created) - new Date(b.created));
          for (const post of wearReplies) {
            try {
              applyOperation(currentState, post, post.block_num || 0, post.created);
            } catch { /* skip malformed */ }
          }
          status(`🔍 Wear genesis replay done — ${Object.keys(currentState.equipped).length} accessory/creature pair(s) found.`);
        } catch (e) {
          console.warn("[SB State] Wear genesis replay failed (non-fatal):", e);
        }

        // BUG FIX 8 — Fallback reply crawl by NFT roots when equipped is still empty.
        //
        // Some wear_on / wear_off authors never appear in our account-history
        // discovery set (e.g. transient owners who only ever replied on NFT posts
        // and never authored top-level steembiota content). In that case
        // _fetchReplyOpsSince() can miss their account histories, leaving equipped
        // permanently empty even though replies exist on-chain.
        //
        // Fallback strategy: walk replies directly from every known NFT root
        // post (ownership keys already tell us author/permlink), then replay only
        // wear_on / wear_off operations found in those reply trees. This is slower
        // than account-history scanning, so we run it only when the primary replay
        // still yields zero equips.
        if (Object.keys(currentState.equipped || {}).length === 0) {
          status("🧭 No wear events found via account history — crawling NFT reply trees…");
          try {
            const wearOps = [];
            const nftIds = Object.keys(currentState.ownership || {});
            await Promise.allSettled(nftIds.map(async (id) => {
              const [rootAuthor, rootPermlink] = String(id).split("/");
              if (!rootAuthor || !rootPermlink) return;
              const replies = await fetchAllReplies(rootAuthor, rootPermlink);
              for (const r of (Array.isArray(replies) ? replies : [])) {
                let m;
                try {
                  const parsed = typeof r.json_metadata === "string"
                    ? JSON.parse(r.json_metadata || "{}")
                    : (r.json_metadata || {});
                  m = parsed.steembiota;
                } catch {
                  continue;
                }
                if (!m || (m.type !== "wear_on" && m.type !== "wear_off")) continue;
                wearOps.push(r);
              }
            }));

            wearOps.sort((a, b) => new Date(a.created) - new Date(b.created));
            for (const op of wearOps) {
              const opBlockNum = Number.isInteger(op.block_num) && op.block_num > 0
                ? op.block_num
                : (Number.isInteger(op.block) && op.block > 0 ? op.block : 0);
              try { applyOperation(currentState, op, opBlockNum, op.created); } catch {}
            }

            status(`🧭 NFT reply crawl done — ${Object.keys(currentState.equipped).length} accessory/creature pair(s) found.`);
          } catch (e) {
            console.warn("[SB State] NFT reply crawl for wear replay failed (non-fatal):", e);
          }
        }
      }
    } catch (e) {
      console.warn("[SB State] Replay fetch failed:", e);
    }

    // Merge and sort by creation time (oldest first) so state transitions
    // are applied in the correct chronological order regardless of source.
    rawPosts.sort((a, b) => {
      const ta = new Date(a.created).getTime();
      const tb = new Date(b.created).getTime();
      if (ta !== tb) return ta - tb;
      const ba = Number.isInteger(a.block_num) ? a.block_num : (Number.isInteger(a.block) ? a.block : 0);
      const bb = Number.isInteger(b.block_num) ? b.block_num : (Number.isInteger(b.block) ? b.block : 0);
      if (ba !== bb) return ba - bb;
      const ka = `${String(a.author || "")}/${String(a.permlink || "")}`;
      const kb = `${String(b.author || "")}/${String(b.permlink || "")}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const ordered = rawPosts;
    let applied = 0;
    const totalOps = ordered.length;
    for (const post of ordered) {
      try {
        const meta = typeof post.json_metadata === "string"
          ? JSON.parse(post.json_metadata || "{}")
          : (post.json_metadata || {});
        if (!meta.steembiota) continue;
        // Bug Fix #7: mutate currentState only, never stateRef inside the loop
        // BUG 4 FIX: Pass the actual block number from the Steem post object.
        // Previously hardcoded to 0, which kept state.block_num at 0 forever
        // when bootstrapping from genesis, causing the Proxy's isSaneBlock check
        // (block_num > MIN_BLOCK_NUM) to reject every state uploaded from scratch.
        // getDiscussionsByCreated returns a `block_num` field on each post;
        // for reply-based synthetic ops, BUG 2 FIX now surfaces tx[1].block
        // through the synthetic post object's `block_num` field, so all paths
        // correctly advance state.block_num.
        const postBlockNum = Number.isInteger(post.block_num) && post.block_num > 0
          ? post.block_num
          : (Number.isInteger(post.block) && post.block > 0 ? post.block : 0);
        applyOperation(currentState, post, postBlockNum, post.created);
        applied++;
        if (applied % 200 === 0) {
          status(`🔄 Applying events… ${applied}/${totalOps}`);
        }
      } catch { /* skip malformed posts */ }
    }

    // BUG 2 FIX (Block 0 Genesis Trap): If after a full genesis replay
    // state.block_num is still 0 (e.g. all RPC nodes omit block_num from
    // getDiscussionsByCreated AND there were no reply ops with block numbers),
    // fetch the current Steem dynamic global properties and use the head block
    // number as a lower-bound floor.  This guarantees the Proxy's MIN_BLOCK_NUM
    // check passes for any valid live-chain bootstrap.
    if (!currentState.block_num || currentState.block_num === 0) {
      try {
        const dgpo = await _getDynamicGlobalPropertiesAsync();
        const headBlock = dgpo?.head_block_number || dgpo?.last_irreversible_block_num || 0;
        if (headBlock > 0) {
          currentState.block_num = headBlock;
          status(`⚙️ block_num was 0 after replay; set to head block ${headBlock} from DGPO.`);
        }
      } catch (e) {
        console.warn("[SB State] DGPO fallback for block_num failed:", e);
      }
    }

    // ── Step 5: Single atomic update → no UI flicker ────────────────────────
    // (original Bug Fix #7 + BUG 6 FIX)
    // stateRef is assigned exactly once here.  The onReady callback then
    // flips the stateReady flag in app.js, unblocking ownership rendering in
    // child views and replacing skeleton loaders with real data.
    stateRef.value = { ...currentState };
    if (typeof onReady === "function") onReady();
    status(`✅ State ready — ${Object.keys(currentState.ownership).length} NFTs tracked, ${applied} new event(s) replayed.`);

  } catch (e) {
    const msg = "⚠️ State bootstrap error: " + (e.message || String(e));
    if (syncStatusRef) syncStatusRef.value = msg;
    console.error("[SB State]", e);
  }
}

// ============================================================
// § 10 — CONVENIENCE HELPERS (for ProfileView / CreatureView)
// ============================================================

/**
 * Look up the effective owner of an NFT in the global state.
 * Falls back to `fallback` (usually post.author) when the NFT
 * is not yet in the registry (e.g. during the replay gap).
 *
 * @param {object} state      — globalState.value
 * @param {string} author     — post author
 * @param {string} permlink   — post permlink
 * @param {string} fallback   — default if not found
 */
/**
 * Return NFT registry entry/type for a canonical id ("author/permlink").
 * Exposed for consumers outside this file (e.g. app.js Profile filtering)
 * so they never need direct access to the module-scoped _nftRegistry Map.
 */
function stateRegistryEntry(id) {
  return _nftRegistry.get(String(id || "").toLowerCase()) || null;
}

function stateRegistryType(id) {
  return stateRegistryEntry(id)?.type || null;
}

function stateOwnerOf(state, author, permlink, fallback) {
  if (!state) return fallback || author;
  const id = _nftId(author, permlink);
  return state.ownership[id] || fallback || author;
}

/**
 * Look up which creature (if any) is currently wearing an accessory.
 *
 * @param {object} state     — globalState.value
 * @param {string} accAuthor
 * @param {string} accPermlink
 * @returns {string|null}    — "author/permlink" key or null
 */
function stateEquippedOn(state, accAuthor, accPermlink) {
  if (!state) return null;
  const id = _nftId(accAuthor, accPermlink);
  return state.equipped[id] || null;
}

/**
 * Update the state in-place after a confirmed transfer.
 * Call this from CreatureView / AccessoryItemView after a
 * successful transfer_accept to keep the in-memory state hot.
 *
 * @param {object} state     — globalState.value (mutate directly)
 * @param {string} author    — NFT post author
 * @param {string} permlink  — NFT post permlink
 * @param {string} newOwner  — new effective owner username
 */
function statePatchOwner(state, author, permlink, newOwner) {
  if (!state) return;
  const id = _nftId(author, permlink);
  // BUG 7 FIX: check _nftRegistry (non-reactive Map) instead of state.registry.
  if (_nftRegistry.has(id)) {
    state.ownership[id] = _normUser(newOwner);
  }
}

/**
 * Update the state in-place after a confirmed wear_on.
 *
 * @param {object} state
 * @param {string} accAuthor
 * @param {string} accPermlink
 * @param {string} creatureAuthor
 * @param {string} creaturePermlink
 */
function statePatchEquip(state, accAuthor, accPermlink, creatureAuthor, creaturePermlink) {
  if (!state) return;
  const aId = _nftId(accAuthor, accPermlink);
  const cId = _nftId(creatureAuthor, creaturePermlink);
  state.equipped[aId] = cId;
}

/**
 * Update the state in-place after a confirmed wear_off.
 */
function statePatchUnequip(state, accAuthor, accPermlink) {
  if (!state) return;
  const aId = _nftId(accAuthor, accPermlink);
  delete state.equipped[aId];
}

// ============================================================
// § 11 — CheckpointManager Vue 3 Component
// ============================================================

/**
 * Community tool that lets any user:
 *   1. Export the current global state as a downloadable JSON blob
 *   2. Paste an IPFS CID they have pinned (e.g. via Pinata / web3.storage)
 *   3. Broadcast that CID as an on-chain checkpoint
 *
 * Inject requirements: "username", "notify", "globalState", "syncStatus",
 *                      "syncLocked", "syncLockOwnedByMe", "forceResetSyncLock"
 */
const CheckpointManager = {
  name: "CheckpointManager",
  // BUG FIX (Sync lock never clears): syncLocked was previously read once from
  // localStorage inside data() and never updated.  After forceResetSync() did
  // localStorage.removeItem() + location.reload(), the page reloaded and the
  // new bootstrap immediately wrote a FRESH "sb_booting" entry — so on the next
  // render the component re-read that new entry and showed the warning again.
  //
  // Fix: inject the reactive syncLocked / syncLockOwnedByMe refs that the App
  // root already maintains correctly (updated via the "storage" event and
  // BroadcastChannel).  The component no longer holds its own stale copy.
  // forceResetSyncLock is also injected so both the nav-bar button and the
  // Checkpoint page button call identical logic from a single source of truth.
  inject: ["username", "notify", "globalState", "syncStatus",
           "syncLocked", "syncLockOwnedByMe", "forceResetSyncLock"],

  data() {
    return {
      busy:          false,
      cidInput:      "",
      exportUrl:     null,   // object URL for the download link
      exportReady:   false,
      // BUG 6 FIX: Manual path hidden by default; power users can expand it.
      showAdvanced:  false,
      hashPreview:   "",
      statusDetail:  "",
      // syncLocked is now INJECTED from the App — removed from local data()
      // to prevent the stale-read bug.
    };
  },

  computed: {
    nftCount() {
      const gs = this.globalState?.value || this.globalState || {};
      return Object.keys(gs.ownership || {}).length;
    },
    currentBlock() {
      const gs = this.globalState?.value || this.globalState || {};
      return gs.block_num || 0;
    },
    currentTimestamp() {
      const gs = this.globalState?.value || this.globalState || {};
      return gs.timestamp ? new Date(gs.timestamp).toUTCString() : "—";
    },
    cidValidationError() {
      const cid = this.cidInput.trim();
      if (!cid) return "";
      return isValidIpfsCid(cid) ? "" : "Invalid CID format. Use CIDv0 (Qm…) or CIDv1 (bafy…).";
    }
  },

  beforeUnmount() {
    // BUG 7 FIX: delegate to the shared helper so revocation logic is never duplicated.
    this._revokeExportUrl();
  },

  methods: {
    // BUG FIX (Sync lock never clears): The old implementation duplicated the
    // force-reset logic here, including its own localStorage.removeItem() and
    // location.reload().  On reload the fresh bootstrap immediately wrote a new
    // "sb_booting" entry, so data() re-read it and showed the warning again.
    //
    // Fix: delegate entirely to the injected forceResetSyncLock() from app.js,
    // which is the single source of truth for lock management and already
    // correctly sequences the takeover flag, BroadcastChannel notify, and reload.
    forceResetSync() {
      if (typeof this.forceResetSyncLock === "function") {
        this.forceResetSyncLock();
      }
    },

    /** Step 1 — Snapshot the current state and offer it as a download. */
    // BUG 7 FIX: _revokeExportUrl() always safely disposes the current
    // Object URL before we replace it.  Calling it when exportUrl is null
    // (the very first invocation) is a no-op, so there is no special-case
    // needed at call sites.  It is also called in beforeUnmount() so the
    // URL is cleaned up when the component is destroyed.
    _revokeExportUrl() {
      if (this.exportUrl) {
        URL.revokeObjectURL(this.exportUrl);
        this.exportUrl = null;
      }
    },


    /** BUG 3 FIX: Build a compact merged registry object for export/upload.
     *  { "author/permlink": { o: "owner", t: "c"|"a" } }
     *  Replaces the old split { ownership, registry } with a single object
     *  that is ~44% smaller on-chain and immune to partial-state bugs.
     */
    _buildCompactRegistry(gs) {
      const sortedKeys = [..._nftRegistry.keys()].sort();
      const reg = {};
      for (const k of sortedKeys) {
        const regEntry = _nftRegistry.get(k);
        const entry = { t: regEntry.type === "accessory" ? "a" : "c" };
        const owner = gs.ownership?.[k];
        if (owner) entry.o = owner;
        reg[k] = entry;
      }
      // Catch synthetic/ownership-only entries not yet in _nftRegistry
      if (gs.ownership) {
        for (const [k, owner] of Object.entries(gs.ownership)) {
          if (!reg[k]) reg[k] = { t: "c", o: owner };
        }
      }
      return reg;
    },

    async _recoverEquippedIfEmpty(gs) {
      const hasOwnership = Object.keys(gs?.ownership || {}).length > 0;
      const equippedCount = Object.keys(gs?.equipped || {}).length;
      if (!hasOwnership || equippedCount > 0) return gs.equipped || {};

      const temp = {
        version: gs.version,
        block_num: gs.block_num,
        timestamp: gs.timestamp,
        ownership: { ...(gs.ownership || {}) },
        equipped: {}
      };

      const wearOps = [];
      const nftIds = Object.keys(temp.ownership);
      await Promise.allSettled(nftIds.map(async (id) => {
        const [rootAuthor, rootPermlink] = String(id).split("/");
        if (!rootAuthor || !rootPermlink) return;
        const replies = await fetchAllReplies(rootAuthor, rootPermlink);
        for (const r of (Array.isArray(replies) ? replies : [])) {
          let m;
          try {
            const parsed = typeof r.json_metadata === "string"
              ? JSON.parse(r.json_metadata || "{}")
              : (r.json_metadata || {});
            m = parsed.steembiota;
          } catch { continue; }
          if (!m || (m.type !== "wear_on" && m.type !== "wear_off")) continue;
          wearOps.push(r);
        }
      }));

      wearOps.sort((a, b) => new Date(a.created) - new Date(b.created));
      for (const op of wearOps) {
        const opBlockNum = Number.isInteger(op.block_num) && op.block_num > 0
          ? op.block_num
          : (Number.isInteger(op.block) && op.block > 0 ? op.block : 0);
        try { applyOperation(temp, op, opBlockNum, op.created); } catch {}
      }

      if (Object.keys(temp.equipped).length > 0) {
        gs.equipped = { ...temp.equipped };
      }
      return gs.equipped || {};
    },

    async generateExport() {
      this.busy         = true;
      this.exportReady  = false;
      this.statusDetail = "Hashing state…";
      // BUG 7 FIX: revoke any previous Object URL *before* we start work so
      // that repeated clicks never accumulate unreleased URLs, even if the
      // previous export succeeded.
      this._revokeExportUrl();
      try {
        const gs        = this.globalState?.value || this.globalState || createEmptyState();
        await this._recoverEquippedIfEmpty(gs);
        const hash      = await hashState(gs);
        this.hashPreview = hash.slice(0, 16) + "…";

        // Fix #1: use the shared _buildSnapshotPayload helper — same payload
        // that hashState hashes and autoUploadCheckpoint uploads.
        const exportData = _buildSnapshotPayload(gs, _nftRegistry);

        const blob        = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        this.exportUrl   = URL.createObjectURL(blob);
        this.exportReady = true;
        this.statusDetail = `State hash: ${this.hashPreview}`;
        this.notify("State exported — pin it to IPFS and paste the CID below.", "success");
      } catch (e) {
        // BUG 7 FIX: if hashing or blob creation fails, ensure no stale URL
        // is left behind (exportUrl was already nulled by _revokeExportUrl
        // above, so this is belt-and-suspenders for any future code path).
        this._revokeExportUrl();
        this.notify("Export failed: " + e.message, "error");
        this.statusDetail = "";
      } finally {
        this.busy = false;
      }
    },

    /** Step 2 — Broadcast the IPFS CID as a checkpoint on Steem. */
    async submitCheckpoint() {
      const cid = this.cidInput.trim();
      if (!cid) {
        this.notify("Please paste a valid IPFS CID first.", "error");
        return;
      }
      if (!isValidIpfsCid(cid)) {
        this.statusDetail = "❌ Invalid CID format.";
        this.notify("Invalid CID format. Paste a CIDv0 (Qm…) or CIDv1 (bafy…).", "error");
        return;
      }
      if (!this.username?.value && !this.username) {
        this.notify("You must be logged in to publish a checkpoint.", "error");
        return;
      }
      this.busy         = true;
      this.statusDetail = "Preparing checkpoint payload…";
      try {
        const gs = this.globalState?.value || this.globalState || createEmptyState();
        await this._recoverEquippedIfEmpty(gs);
        const user = this.username?.value || this.username;
        publishCheckpoint(user, gs, cid, (res) => {
          this.busy = false;
          if (res.success) {
            this.notify("✅ Checkpoint broadcast to Steem!", "success");
            this.statusDetail = `CID ${cid.slice(0, 12)}… anchored at block ${gs.block_num}.`;
            this.cidInput = "";
          } else {
            this.notify("Keychain rejected the broadcast: " + (res.message || "unknown error"), "error");
            this.statusDetail = "";
          }
        });
      } catch (e) {
        this.busy = false;
        this.notify("Checkpoint error: " + e.message, "error");
        this.statusDetail = "";
      }
    },

    async _postJsonWithTimeout(url, payload, { connectMs = 8000, bodyMs = 20000 } = {}) {
      const connectTimeout = _makeTimeoutSignal(connectMs);
      let response;
      try {
        response = await fetch(url, {
          method:  "POST",
          body:    JSON.stringify(payload),
          signal:  connectTimeout.signal,
          headers: {
            "Content-Type": "application/json",
            "X-App-Secret": "GcB9QYuCD5VU6z5aJ8T4LcQwvCdhTPv"
          }
        });
      } finally {
        connectTimeout.cancel();
      }

      if (!response.ok) throw new Error(`Proxy returned HTTP ${response.status}`);

      let bodyTimer;
      const bodyTimeout = new Promise((_, reject) => {
        bodyTimer = setTimeout(() => reject(new Error(`Proxy response timed out after ${Math.round(bodyMs / 1000)}s`)), bodyMs);
      });
      try {
        const raw = await Promise.race([response.text(), bodyTimeout]);
        clearTimeout(bodyTimer);
        return JSON.parse(raw);
      } catch (e) {
        clearTimeout(bodyTimer);
        throw e;
      }
    },

    /**
     * Bug Fix #5 — One-Click Checkpoint via Cloudflare Worker IPFS proxy.
     *
     * Anyone (not just @steembiota) can call this.  The flow is:
     *   1. POST the current state JSON to our Cloudflare Worker proxy.
     *   2. The Worker pins it to IPFS and returns { cid }.
     *   3. We set cidInput and immediately call submitCheckpoint() so the
     *      CID is broadcast on-chain in one user action.
     */
    async autoUploadCheckpoint() {
      if (!this.username?.value && !this.username) {
        this.notify("You must be logged in to publish a checkpoint.", "error");
        return;
      }
      this.busy         = true;
      this.statusDetail = "Uploading to IPFS via proxy…";
      try {
        const gs = this.globalState?.value || this.globalState || createEmptyState();
        await this._recoverEquippedIfEmpty(gs);

        // Fix #1: use the shared _buildSnapshotPayload helper so the uploaded
        // payload is guaranteed to be identical to what hashState() hashes.
        // The old inline construction was a separate code path that could
        // silently diverge from hashState if a field was ever added to one
        // but not the other, causing every checkpoint to fail verification.
        const uploadData = _buildSnapshotPayload(gs, _nftRegistry);

        // One retry on timeout/network errors for better operator UX.
        const endpoint = "https://dark-limit-826f.john-smjth.workers.dev/";
        let result;
        try {
          result = await this._postJsonWithTimeout(endpoint, uploadData, { connectMs: 8000, bodyMs: 20000 });
        } catch (firstErr) {
          this.statusDetail = "Retrying upload after timeout/network error…";
          this.notify("Proxy upload timed out/failed once. Retrying…", "info");
          result = await this._postJsonWithTimeout(endpoint, uploadData, { connectMs: 8000, bodyMs: 20000 });
        }

        if (!result?.cid) throw new Error("Proxy response missing CID field.");
        if (!isValidIpfsCid(result.cid)) throw new Error("Proxy returned malformed CID.");

        this.cidInput     = result.cid;
        this.statusDetail = `Pinned as ${result.cid.slice(0, 12)}… — broadcasting…`;
        this.notify("Auto-upload successful! Broadcasting checkpoint…", "success");

        // Immediately broadcast — submitCheckpoint handles busy/error itself
        await this.submitCheckpoint();
      } catch (e) {
        this.busy         = false;
        this.statusDetail = "";
        const timedOut = /timed out|timeout/i.test(String(e?.message || ""));
        this.notify(
          timedOut
            ? ("Proxy upload timed out. Please retry. Details: " + e.message)
            : ("Proxy upload failed: " + e.message),
          "error"
        );
      }
    }
  },

  template: `
    <div class="sb-card" style="max-width:480px;margin:20px auto;padding:16px;">
      <h3 style="margin-top:0;">🛠️ Checkpoint Authority</h3>

      <p style="font-size:12px;color:#aaa;margin:0 0 12px;">
        Help the dApp load faster for everyone by snapshotting the current NFT
        state and pinning it to IPFS.  Anyone can do this — the cryptographic
        hash prevents tampering.
      </p>

      <!-- Live state summary -->
      <div style="font-size:12px;color:#ccc;background:#1a1a2e;border-radius:6px;padding:8px 12px;margin-bottom:14px;">
        <strong>Current state:</strong>
        {{ nftCount }} NFTs tracked
        <span v-if="currentBlock"> · block {{ currentBlock }}</span>
        <span v-if="currentTimestamp !== '—'"> · {{ currentTimestamp }}</span>
      </div>

      <!-- One-click path (Bug Fix #5) -->
      <button
        @click="autoUploadCheckpoint"
        :disabled="busy"
        class="sb-btn-blue"
        style="width:100%;margin-bottom:10px;"
      >⚡ One-Click — Upload &amp; Broadcast</button>

      <!-- BUG 6 FIX: Manual path hidden under Advanced toggle.
           The One-Click path above is the only flow that makes sense for
           community users.  The manual steps are preserved for power users
           (e.g. to pin to a custom gateway) but collapsed by default. -->
      <div style="margin-bottom:12px;">
        <button
          @click="showAdvanced = !showAdvanced"
          style="width:100%;background:none;border:1px solid #444;color:#888;border-radius:4px;padding:5px 10px;font-size:11px;cursor:pointer;"
        >{{ showAdvanced ? '▲ Hide' : '▼ Advanced' }} — Manual upload &amp; broadcast</button>
      </div>

      <div v-if="showAdvanced">
        <!-- Step 1 -->
        <button
          @click="generateExport"
          :disabled="busy"
          style="width:100%;margin-bottom:8px;"
        >💾 Step 1 — Export state snapshot</button>

        <div v-if="exportReady" style="margin-bottom:12px;text-align:center;">
          <a
            :href="exportUrl"
            download="steembiota-state.json"
            style="color:#81d4fa;font-size:13px;"
          >⬇ Download steembiota-state.json</a>
          <div style="font-size:11px;color:#888;margin-top:4px;">{{ statusDetail }}</div>
          <div style="font-size:11px;color:#aaa;margin-top:4px;">
            📌 Pin this file to IPFS (e.g.
            <a href="https://www.pinata.cloud" target="_blank" style="color:#a5d6a7;">Pinata</a>
            or
            <a href="https://web3.storage" target="_blank" style="color:#a5d6a7;">web3.storage</a>),
            then paste the resulting CID below.
          </div>
        </div>

        <!-- Step 2 -->
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input
            v-model="cidInput"
            placeholder="Paste IPFS CID (Qm… or bafy…)"
            style="flex:1;min-width:0;"
            :disabled="busy"
          />
          <button
            @click="submitCheckpoint"
            :disabled="busy || !cidInput.trim() || !!cidValidationError"
            class="sb-btn-blue"
            style="white-space:nowrap;"
          >📡 Step 2 — Broadcast</button>
        </div>
        <div v-if="cidValidationError" style="font-size:11px;color:#ff8a80;margin-top:-4px;margin-bottom:8px;">
          {{ cidValidationError }}
        </div>

        <div v-if="statusDetail && !exportReady" style="font-size:11px;color:#aaa;">
          {{ statusDetail }}
        </div>
      </div>

      <div v-if="busy" style="font-size:12px;color:#ffe082;margin-top:6px;">⏳ Working…</div>

      <!-- BUG FIX 3A: Force Reset Sync button.
           If the user's tab crashed after acquiring the "sb_booting" lock but
           before writing the snapshot to IndexedDB, every subsequent load shows
           "Another tab is syncing" for 90 seconds with no escape.  This button
           clears that lock immediately so the user is never stuck waiting.
           We show it both when the lock is currently set AND as a persistent
           emergency control so power users can reach it at any time. -->
      <div style="margin-top:16px;border-top:1px solid #333;padding-top:12px;">
        <div style="font-size:11px;color:#888;margin-bottom:6px;">
          🔧 Troubleshooting
        </div>
        <div
          v-if="syncLocked"
          style="font-size:12px;color:#ffe082;margin-bottom:8px;background:#2a2000;border-radius:4px;padding:6px 10px;"
        >
          ⚠️ Another tab appears to be syncing (or a previous session crashed).
        </div>
        <button
          @click="forceResetSync"
          style="width:100%;font-size:12px;background:#3a1a1a;color:#ef9a9a;border:1px solid #7f3030;border-radius:4px;padding:6px 10px;cursor:pointer;"
        >🔄 Force Reset Sync Lock</button>
        <div style="font-size:10px;color:#666;margin-top:4px;">
          Use this if the app is stuck on "Another tab is syncing" with no visible progress.
        </div>
      </div>
    </div>
  `
};
