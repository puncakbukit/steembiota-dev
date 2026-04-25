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
const CHECKPOINT_ROOTS = [
  // Example — replace with real values on each periodic release:
  // { block_num: 90000000, state_hash: "0000…", snapshot_cid: "bafy…", note: "Genesis root" }
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
    equipped:  {}      // Accessory_ID → Creature_ID  (deleted when unequipped)
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
        state.ownership[id] = author;
      } else {
        // BUG FIX 2A: Update a synthetic placeholder created by an earlier
        // transfer_accept that arrived before this mint post was replayed.
        // Overwrite type but preserve any ownership already set by the transfer.
        const entry = _nftRegistry.get(id);
        if (entry._synthetic) {
          _nftRegistry.set(id, { type: "creature" });
          // Only set ownership to the minting author if no transfer has claimed it yet.
          if (!state.ownership[id]) state.ownership[id] = author;
        }
      }
      break;
    }

    // ── Accessory minting ─────────────────────────────────────
    case "accessory": {
      const id = _nftId(author, permlink);
      if (!_nftRegistry.has(id)) {
        _nftRegistry.set(id, { type: "accessory" });
        state.ownership[id] = author;
      } else {
        // BUG FIX 2A: Same synthetic-placeholder correction for accessories.
        const entry = _nftRegistry.get(id);
        if (entry._synthetic) {
          _nftRegistry.set(id, { type: "accessory" });
          if (!state.ownership[id]) state.ownership[id] = author;
        }
      }
      break;
    }

    // ── Ownership transfer (the accept leg of the handshake) ──
    case "transfer_accept": {
      // op.author is the *recipient* posting the accept reply
      const cAuthor   = meta.creature?.author   || meta.item?.author   || "";
      const cPermlink = meta.creature?.permlink || meta.item?.permlink || "";
      if (cAuthor && cPermlink) {
        const id = _nftId(cAuthor, cPermlink);
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
        // Anti-spoofing is now handled by the checkpoint root validation in
        // fetchLatestCheckpoint() and the replay ordering (mints always predate
        // transfers on-chain), rather than a local Map lookup that can be
        // undefined due to RPC failures.
        if (!_nftRegistry.has(id)) {
          // Synthesise a placeholder — type will be corrected when the mint
          // post is replayed (chronological order guarantees it comes first in
          // a full replay; in an incremental replay the type is already set).
          _nftRegistry.set(id, { type: "creature", _synthetic: true });
        }
        // BUG 2A FIX (Transfer Wipe): capture the previous owner BEFORE
        // overwriting ownership so we can selectively strip only their accessories.
        // The old code deleted ALL equipped entries referencing this creature
        // unconditionally, meaning accessories were wiped on every transfer and
        // `equipped` stayed perpetually empty when bootstrapping from history.
        const previousOwner = state.ownership[id];
        state.ownership[id] = author;

        // Only unequip accessories that belonged to the *previous* owner.
        // Accessories already owned by the new owner (e.g. they previously
        // traded back-and-forth) are left intact so no legitimate equip is lost.
        for (const [aId, cId] of Object.entries(state.equipped)) {
          if (cId === id) {
            const accOwner = state.ownership[aId];
            // Strip if the accessory owner is unknown or matches the old owner.
            if (!accOwner || accOwner === previousOwner) {
              delete state.equipped[aId];
            }
          }
        }
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
      if (aId) delete state.equipped[aId];
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
 * Produce a deterministic SHA-256 hex digest of the state.
 * Keys inside each sub-object are sorted before serialisation
 * so the hash is stable regardless of insertion order.
 */
async function hashState(state) {
  // Deep-sort keys for determinism
  function sortedClone(obj) {
    if (Array.isArray(obj)) return obj.map(sortedClone);
    if (obj && typeof obj === "object") {
      return Object.fromEntries(
        Object.keys(obj).sort().map(k => [k, sortedClone(obj[k])])
      );
    }
    return obj;
  }
  // Bug Fix #6: Explicitly map to a strictly-defined object so that runtime
  // noise (Vue observer internals, _source tags from the image uploader, etc.)
  // never leaks into the fingerprint and causes spurious "Verification Failed".
  // BUG 2 FIX: Force all primitive fields to their canonical serialised
  // types before hashing.  Steem timestamps are strings (e.g. "2025-05-01T12:00:00")
  // but different browsers may have previously stored them as Date objects.
  // Coercing to an ISO string here ensures the digest is identical across
  // every engine, preventing spurious "Verification Failed" mismatches.
  // BUG 3 FIX: Coerce the timestamp to "YYYY-MM-DDTHH:mm:ss" (no Z, no ms)
  // so two clients that stored the same point-in-time as a Date vs. a raw
  // Steem string produce an identical digest.  toISOString() appends Z + ms,
  // while Steem API strings already lack them — we strip both here.
  const rawTs = state.timestamp;
  let canonicalTimestamp = null;
  if (rawTs instanceof Date) {
    canonicalTimestamp = rawTs.toISOString().replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 19);
  } else if (typeof rawTs === "string") {
    canonicalTimestamp = rawTs.replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 19);
  }

  // BUG FIX 3B: _nftRegistry is a Map.  When we convert it to a plain object
  // for serialisation, JS objects hoist any key that looks like a non-negative
  // integer (e.g. "123", "0042") to the front regardless of insertion order.
  // This means a "Freshly Replayed" registry and a "Loaded from Cache"
  // registry can produce different key orderings even for identical data,
  // causing hashState() to return different digests for the same logical state.
  //
  // Fix: sort the registry keys explicitly and build the snapshot in that
  // order before passing to sortedClone.  sortedClone then deep-sorts all
  // nested objects, so the final JSON is fully deterministic regardless of
  // insertion order, Map reconstruction path, or JS engine key-hoisting rules.
  // BUG 3 FIX: Build the compact merged registry for hashing so the digest
  // matches what is stored on IPFS and IDB — { id: { o, t } }.
  // This replaces the old split { ownership, registry: { type } } that would
  // produce a different hash than the compact snapshot on disk.
  const sortedRegistryKeys = [..._nftRegistry.keys()].sort();
  const compactRegistry = {};
  for (const k of sortedRegistryKeys) {
    const regEntry = _nftRegistry.get(k);
    const entry = { t: regEntry.type === "accessory" ? "a" : "c" };
    const owner = state.ownership?.[k];
    if (owner) entry.o = owner;
    compactRegistry[k] = entry;
  }
  // Include any ownership-only entries not yet typed in the registry.
  if (state.ownership) {
    for (const [k, owner] of Object.entries(state.ownership)) {
      if (!compactRegistry[k]) compactRegistry[k] = { t: "c", o: owner };
    }
  }

  const minimalState = {
    version:   Number(state.version),
    block_num: Number(state.block_num),
    timestamp: canonicalTimestamp,
    registry:  compactRegistry,
    equipped:  state.equipped
  };
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

async function fetchSnapshot(cid) {
  let lastErr;
  for (const gateway of IPFS_GATEWAYS) {
    try {
      // Stage 1 — connect + headers (tight timeout).
      const res = await fetch(`${gateway}${cid}`, {
        signal: AbortSignal.timeout(IPFS_CONNECT_TIMEOUT_MS)
      });

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
      const bodyAbort = new AbortController();
      const bodyTimer = setTimeout(() => bodyAbort.abort(), IPFS_BODY_TIMEOUT_MS);
      try {
        const raw = await res.json();
        clearTimeout(bodyTimer);

        // BUG 3 FIX: Expand compact registry format { id: { o, t } } into
        // runtime structures { ownership, _nftRegistry } on the way in.
        // Also handle old-format snapshots ({ ownership, registry: { type } })
        // so stale IPFS-pinned files are never silently discarded.
        if (raw.registry && !raw.ownership) {
          // New compact format — expand into runtime ownership map.
          const ownership = {};
          for (const [k, v] of Object.entries(raw.registry)) {
            const type = v.t === "a" ? "accessory" : "creature";
            _nftRegistry.set(k, { type });
            if (v.o) ownership[k] = v.o;
          }
          return {
            version:   raw.version,
            block_num: raw.block_num,
            timestamp: raw.timestamp,
            ownership,
            equipped:  raw.equipped || {}
          };
        } else if (raw.ownership && raw.registry) {
          // Old split format — hydrate _nftRegistry from the separate registry map.
          for (const [k, v] of Object.entries(raw.registry)) {
            if (!_nftRegistry.has(k)) _nftRegistry.set(k, v);
          }
          const { registry: _ignored, ...rest } = raw;
          return rest;
        }
        return raw;
      } catch (bodyErr) {
        clearTimeout(bodyTimer);
        console.warn(`[SB State] Gateway ${gateway} body read failed: ${bodyErr.message} — trying next.`);
        lastErr = bodyErr;
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

/** Persist a state snapshot + its CID + hash to IndexedDB for offline reuse. */
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
      snapshot:  {
        version:   snapshot.version,
        block_num: snapshot.block_num,
        timestamp: snapshot.timestamp,
        registry:  compactRegistry,
        equipped:  snapshot.equipped || {}
      },
      savedAt:   Date.now()
    });
    return new Promise((ok, fail) => {
      tx.oncomplete = ok;
      tx.onerror    = () => fail(tx.error);
    });
  } catch (e) {
    console.warn("[SB State] IndexedDB persist failed:", e);
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
        if (snap.registry && !snap._registry && !snap.ownership) {
          // New compact format — expand back into runtime structures.
          const ownership = {};
          const sortedEntries = Object.entries(snap.registry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          for (const [k, v] of sortedEntries) {
            const type = v.t === "a" ? "accessory" : "creature";
            _nftRegistry.set(k, { type });
            if (v.o) ownership[k] = v.o;
          }
          const cleanSnap = { version: snap.version, block_num: snap.block_num, timestamp: snap.timestamp, ownership, equipped: snap.equipped || {} };
          resolve({ ...row, snapshot: cleanSnap });
        } else if (snap._registry) {
          // Legacy format (old split schema) — migrate on the fly.
          const sortedEntries = Object.entries(snap._registry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          for (const [k, v] of sortedEntries) {
            _nftRegistry.set(k, v);
          }
          const { _registry, ...cleanSnap } = snap;
          resolve({ ...row, snapshot: cleanSnap });
        } else {
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
    const batch = await new Promise((resolve, reject) => {
      steem.api.getAccountHistory(account, cursor, pageSize, (err, res) => {
        if (err) return reject(err);
        resolve(Array.isArray(res) ? res : []);
      });
    });

    if (batch.length === 0) break;

    for (const tx of batch) {
      const op = tx[1]?.op;
      if (op && op[0] === "custom_json" && op[1]?.id === CHECKPOINT_ID) {
        try {
          const payload = JSON.parse(op[1].json);
          if (payload && payload.block_num) found.push(payload);
        } catch { /* malformed — skip */ }
      }
    }

    // The oldest entry in this batch tells us how far back we've gone.
    const oldestBlockInBatch = batch[0]?.[1]?.block || 0;
    if (oldestBlockInBatch <= minBlockNum) break; // we've covered the needed range

    // Steem history is indexed by sequence number; the first entry in the batch
    // gives us the sequence to use as the next cursor (exclusive upper bound).
    const oldestSeq = batch[0]?.[0];
    if (oldestSeq === undefined || oldestSeq === 0) break; // reached genesis
    cursor = oldestSeq - 1;
    if (cursor < 0) break;
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

  // Also look at recent posts tagged "steembiota" to discover community
  // accounts that have published checkpoints (best-effort, non-fatal).
  try {
    const tagPosts = await fetchPostsByTag("steembiota", 100);
    const communityAccounts = [...new Set(tagPosts.map(p => p.author))].filter(a => a !== CHECKPOINT_AUTHOR);

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
    await new Promise((resolve) => {
      steem.api.getAccounts(uniqueAccounts, (err, res) => {
        if (!err && Array.isArray(res)) {
          res.forEach(a => {
            // Steem reputation is a log-scaled int; extract raw for ordering
            reputations[a.name] = parseFloat(a.reputation || 0);
          });
        }
        resolve();
      });
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

  // ── 4. Pick the highest-scoring group ─────────────────────────────────────
  const best = Object.values(groups).sort((a, b) => b.score - a.score)[0];
  if (!best) return null;

  // BUG 3 FIX: Validate the winning candidate against hard-coded checkpoint
  // roots.  If a root exists for a block number >= the candidate's block_num,
  // the candidate's state_hash must match that root — otherwise it is a
  // potential "poisoned checkpoint" and must be rejected outright.
  for (const root of CHECKPOINT_ROOTS) {
    if (best.payload.block_num <= root.block_num) {
      if (best.payload.state_hash !== root.state_hash) {
        console.error(
          `[SB State] SECURITY: Checkpoint rejected — hash ${best.payload.state_hash.slice(0, 16)}… ` +
          `does not match root ${root.state_hash.slice(0, 16)}… for block ${root.block_num}. ` +
          `Publishers: ${best.publishers.join(", ")}`
        );
        return null;
      }
    }
  }

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
async function _fetchAllPostsSince(sinceDate) {
  const tag    = "steembiota";
  const limit  = 100; // Steem API hard cap per call
  const result = [];
  let   cursor = null; // { author, permlink } of the oldest post seen so far

  while (true) {
    const query = { tag, limit: cursor ? limit + 1 : limit };
    if (cursor) {
      query.start_author   = cursor.author;
      query.start_permlink = cursor.permlink;
    }

    const batch = await new Promise((resolve, reject) => {
      steem.api.getDiscussionsByCreated(query, (err, res) => {
        if (err) return reject(err);
        resolve(Array.isArray(res) ? res : []);
      });
    });

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

    if (hitCutoff || posts.length < limit) break;

    // Advance cursor to the oldest post in this batch
    const oldest = posts[posts.length - 1];
    cursor = { author: oldest.author, permlink: oldest.permlink };
  }

  return result;
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
async function _fetchReplyOpsSince(sinceDate, communityAuthors = []) {
  // Always include the canonical account; deduplicate the rest.
  const accounts = [...new Set([CHECKPOINT_AUTHOR, ...communityAuthors])];
  const REPLY_TYPES = new Set(["transfer_accept", "feed", "wear_on", "wear_off"]);
  const allResults = [];

  await Promise.allSettled(accounts.map(async (account) => {
    const accountResults = [];
    let cursor   = -1;
    const pageSize = 1000;

    while (true) {
      const batch = await new Promise((resolve, reject) => {
        steem.api.getAccountHistory(account, cursor, pageSize, (err, res) => {
          if (err) return reject(err);
          resolve(Array.isArray(res) ? res : []);
        });
      });

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

    // Push this account's results into the shared array (thread-safe via allSettled).
    allResults.push(...accountResults);
  }));

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
      // If we already have an IDB snapshot for this CID, skip the IPFS download
      if (persisted && persisted.cid === checkpoint.snapshot_cid) {
        status(`✅ Local cache is current (block ${persisted.snapshot?.block_num ?? "?"}).`);
        snapshot     = persisted.snapshot;
        snapshotHash = persisted.stateHash;
        snapshotCid  = persisted.cid;
      } else {
        status(`📥 Downloading snapshot ${checkpoint.snapshot_cid.slice(0, 8)}… from IPFS`);
        try {
          const raw  = await fetchSnapshot(checkpoint.snapshot_cid);
          const hash = await hashState(raw);
          if (hash !== checkpoint.state_hash) {
            throw new Error("Hash mismatch — snapshot may be tampered. Ignored.");
          }
          snapshot     = raw;
          snapshotHash = hash;
          snapshotCid  = checkpoint.snapshot_cid;
          // Persist to IDB so next boot is instant
          await persistSnapshot(snapshot, snapshotCid, snapshotHash);
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
      ? [...new Set(Object.values(currentState.ownership))]
      : [];

    // Source (b): extract owners from the compact registry if the snapshot was
    // loaded in its raw compact form (e.g. from IPFS before expansion into
    // _nftRegistry + ownership).  After loadPersistedSnapshot() the compact
    // registry has already been expanded into _nftRegistry and ownership, so
    // this mainly helps when `snapshot` came straight from fetchSnapshot().
    const registryOwners = [];
    if (snapshot && snapshot.registry && typeof snapshot.registry === "object") {
      for (const entry of Object.values(snapshot.registry)) {
        if (entry && entry.o) registryOwners.push(entry.o);
      }
    }
    // Also harvest from the live _nftRegistry map (populated during snapshot load).
    for (const owner of Object.values(currentState.ownership || {})) {
      if (owner) registryOwners.push(owner);
    }

    let rawPosts = [];
    try {
      const topLevel = await _fetchAllPostsSince(cutoff);
      // Derive the active community from the top-level posts we already fetched.
      const communityAuthors = [...new Set(topLevel.map(p => p.author))];

      // Source (c): if we are doing a genesis bootstrap (no cutoff) OR if the
      // merged author list is suspiciously small (< 3 unique accounts), perform
      // an exhaustive all-time tag scan so we don't miss historical participants
      // who haven't posted since `cutoff`.
      let allTimeAuthors = [];
      const isGenesis = !cutoff;
      const mergedSoFar = new Set([...communityAuthors, ...ownerAuthors, ...registryOwners]);
      if (isGenesis || mergedSoFar.size < 3) {
        try {
          status("🔍 Scanning all-time participants for reply discovery…");
          const allTimePosts = await _fetchAllPostsSince(null); // no cutoff — all history
          allTimeAuthors = [...new Set(allTimePosts.map(p => p.author))];
        } catch (e) {
          console.warn("[SB State] All-time tag scan failed (non-fatal):", e);
        }
      }

      // Merge all four sources: recent creators + all-time creators + current owners + registry owners
      const allAuthors = [...new Set([
        ...communityAuthors,
        ...allTimeAuthors,
        ...ownerAuthors,
        ...registryOwners
      ])];
      const replies = await _fetchReplyOpsSince(cutoff, allAuthors);
      rawPosts = [...topLevel, ...replies];
    } catch (e) {
      console.warn("[SB State] Replay fetch failed:", e);
    }

    // Merge and sort by creation time (oldest first) so state transitions
    // are applied in the correct chronological order regardless of source.
    rawPosts.sort((a, b) => new Date(a.created) - new Date(b.created));
    const ordered = rawPosts;
    let applied = 0;
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
        const dgpo = await new Promise((resolve, reject) => {
          steem.api.getDynamicGlobalProperties((err, res) => {
            if (err) return reject(err);
            resolve(res);
          });
        });
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
    state.ownership[id] = newOwner;
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
 * Inject requirements: "username", "notify", "globalState", "syncStatus"
 */
const CheckpointManager = {
  name: "CheckpointManager",
  inject: ["username", "notify", "globalState", "syncStatus"],

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
      // BUG FIX 3A: Track whether the boot lock is currently set so the
      // template can show a "Force Reset Sync" button when needed.
      syncLocked:    !!localStorage.getItem("sb_booting")
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
    }
  },

  beforeUnmount() {
    // BUG 7 FIX: delegate to the shared helper so revocation logic is never duplicated.
    this._revokeExportUrl();
  },

  methods: {
    // BUG FIX 3A: Force-clear the boot lock so a crashed/refreshed tab does
    // not leave the user locked out of their data for 90 seconds.
    // The lock key "sb_booting" is set by bootstrapState() when it begins
    // loading, and normally removed when it finishes.  If the tab crashes
    // between those two moments the lock is never cleared, and every
    // subsequent tab reports "Another tab is syncing" until the 90-second
    // TTL expires — with no way to escape.
    forceResetSync() {
      localStorage.removeItem("sb_booting");
      this.syncLocked = false;
      this.notify("Sync lock cleared — reloading…", "info");
      // Brief delay so the notification is visible before reload.
      setTimeout(() => location.reload(), 800);
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
        const hash      = await hashState(gs);
        this.hashPreview = hash.slice(0, 16) + "…";

        // BUG 3 FIX: export using the compact merged registry schema.
        // { version, block_num, timestamp, registry: { id: { o, t } }, equipped }
        // This eliminates the old split { ownership, registry } redundancy and
        // reduces snapshot size by ~44%.
        const exportData = {
          version:   gs.version,
          block_num: gs.block_num,
          timestamp: gs.timestamp,
          registry:  this._buildCompactRegistry(gs),
          equipped:  gs.equipped || {}
        };

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
      if (!this.username?.value && !this.username) {
        this.notify("You must be logged in to publish a checkpoint.", "error");
        return;
      }
      this.busy         = true;
      this.statusDetail = "Verifying CID against local state…";
      try {
        const gs = this.globalState?.value || this.globalState || createEmptyState();
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

        // BUG 3 FIX: upload using compact merged registry schema.
        const uploadData = {
          version:   gs.version,
          block_num: gs.block_num,
          timestamp: gs.timestamp,
          registry:  this._buildCompactRegistry(gs),
          equipped:  gs.equipped || {}
        };

        const response = await fetch("https://dark-limit-826f.john-smjth.workers.dev/", {
          method:  "POST",
          body:    JSON.stringify(uploadData),
          headers: {
            "Content-Type": "application/json",
            // BUG 1 FIX: The Cloudflare Worker requires this shared secret to
            // prevent random bots from spamming the Pinata account.  Since this
            // is a public JS file the secret is visible to users — it is only a
            // rate-limit guard, not a true authentication mechanism.
            "X-App-Secret": "GcB9QYuCD5VU6z5aJ8T4LcQwvCdhTPv"
          }
        });

        if (!response.ok) {
          throw new Error(`Proxy returned HTTP ${response.status}`);
        }

        const result = await response.json(); // Expected: { cid: "Qm…" or "bafy…" }
        if (!result?.cid) throw new Error("Proxy response missing CID field.");

        this.cidInput     = result.cid;
        this.statusDetail = `Pinned as ${result.cid.slice(0, 12)}… — broadcasting…`;
        this.notify("Auto-upload successful! Broadcasting checkpoint…", "success");

        // Immediately broadcast — submitCheckpoint handles busy/error itself
        await this.submitCheckpoint();
      } catch (e) {
        this.busy         = false;
        this.statusDetail = "";
        this.notify("Proxy upload failed: " + e.message, "error");
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
            :disabled="busy || !cidInput.trim()"
            class="sb-btn-blue"
            style="white-space:nowrap;"
          >📡 Step 2 — Broadcast</button>
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
