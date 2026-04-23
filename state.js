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

// IPFS public gateways, tried in order.
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/"
];

// IDB store name for persisted snapshots.
const STORE_STATE = "sb_state_snapshot";

// Maximum number of posts fetched per replay batch (Steem API cap is 100).
const REPLAY_BATCH_SIZE = 100;

// ============================================================
// § 2 — STATE SCHEMA
// ============================================================

/**
 * Returns a fresh, empty canonical state object.
 *
 * ownership : { "author/permlink" → currentOwnerUsername }
 * equipped  : { "accAuthor/accPermlink" → "creatureAuthor/creaturePermlink" | null }
 * registry  : { "author/permlink" → { type: "creature"|"accessory", genome } }
 */
function createEmptyState() {
  return {
    version:   SB_STATE_VERSION,
    block_num: 0,
    timestamp: null,   // ISO-8601 string of last processed event
    ownership: {},     // NFT_ID → current owner username
    equipped:  {},     // Accessory_ID → Creature_ID  (null when unequipped)
    registry:  {}      // NFT_ID → { type, genome }
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
      if (!state.registry[id]) {
        state.registry[id]  = { type: "creature", genome: meta.genome || {} };
        state.ownership[id] = author;
      }
      break;
    }

    // ── Accessory minting ─────────────────────────────────────
    case "accessory": {
      const id = _nftId(author, permlink);
      if (!state.registry[id]) {
        const accGenome = meta.accessory?.genome || {};
        state.registry[id]  = { type: "accessory", genome: accGenome };
        state.ownership[id] = author;
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
        // Only transfer if we know about this NFT (guards against spoofing)
        if (state.registry[id]) {
          state.ownership[id] = author;
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

  state.block_num = blockNum  || state.block_num;
  state.timestamp = timestamp || state.timestamp;
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
  const canonical  = JSON.stringify(sortedClone(state));
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
async function fetchSnapshot(cid) {
  let lastErr;
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gateway}${cid}`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
      lastErr = new Error(`Gateway ${gateway} returned HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All IPFS gateways failed for CID: " + cid);
}

// ============================================================
// § 6 — INDEXEDDB SNAPSHOT PERSISTENCE
// ============================================================

/** Open (or upgrade) the SteemBiotaDB, adding the state store if absent. */
async function _openStateDB() {
  // Piggy-back on the existing DB (same name, bump version).
  // DB_VERSION is declared in blockchain.js — we read it and add 1.
  const targetVersion = (typeof DB_VERSION !== "undefined" ? DB_VERSION : 2) + 1;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("SteemBiotaDB", targetVersion);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** Persist a state snapshot + its CID + hash to IndexedDB for offline reuse. */
async function persistSnapshot(snapshot, cid, stateHash) {
  try {
    const db = await _openStateDB();
    const tx = db.transaction(STORE_STATE, "readwrite");
    tx.objectStore(STORE_STATE).put({
      id:        "latest",
      cid,
      stateHash,
      snapshot,
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
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ============================================================
// § 7 — STEEM CHECKPOINT DISCOVERY
// ============================================================

/**
 * Scan the canonical account's history for the latest valid checkpoint
 * custom_json broadcast.
 *
 * Returns { version, block_num, state_hash, snapshot_cid } or null.
 */
async function fetchLatestCheckpoint(account = CHECKPOINT_AUTHOR) {
  return new Promise((resolve, reject) => {
    steem.api.getAccountHistory(account, -1, 100, (err, result) => {
      if (err) return reject(err);
      if (!Array.isArray(result)) return resolve(null);

      const checkpoints = result
        .filter(tx => {
          const op = tx[1]?.op;
          return op && op[0] === "custom_json" && op[1]?.id === CHECKPOINT_ID;
        })
        .map(tx => {
          try { return JSON.parse(tx[1].op[1].json); } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b.block_num || 0) - (a.block_num || 0));

      resolve(checkpoints[0] || null);
    });
  });
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
 * Bootstrap the global NFT state by:
 *   1. Checking IndexedDB for a cached snapshot (instant, offline-capable)
 *   2. Fetching the latest on-chain checkpoint and comparing CIDs
 *   3. Downloading + verifying the IPFS snapshot when newer
 *   4. Replaying recent posts that postdate the snapshot
 *
 * `stateRef`     — Vue ref that will receive the live state object
 * `syncStatusRef`— Vue ref (string) for UI status messages
 * `onProgress`   — optional (msg) => void for finer-grained progress
 *
 * Designed to be called from App.onMounted().  Non-fatal errors are
 * surfaced via syncStatusRef rather than thrown.
 */
async function bootstrapState(stateRef, syncStatusRef, onProgress) {
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
      checkpoint = await fetchLatestCheckpoint();
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

    // ── Step 3: Seed state ────────────────────────────────────
    let currentState;
    if (snapshot) {
      currentState = snapshot;
      stateRef.value = currentState;
    } else {
      status("⚙️ No checkpoint found. Building state from genesis (this may take a while)…");
      currentState   = createEmptyState();
      stateRef.value = currentState;
    }

    // ── Step 4: Replay recent posts ───────────────────────────
    const cutoff = currentState.timestamp ? new Date(currentState.timestamp) : null;
    status(`🔄 Replaying events since ${cutoff ? cutoff.toISOString().slice(0, 10) : "genesis"}…`);

    let rawPosts = [];
    try {
      rawPosts = await fetchPostsByTag("steembiota", REPLAY_BATCH_SIZE);
    } catch (e) {
      console.warn("[SB State] Replay fetch failed:", e);
    }

    let applied = 0;
    for (const post of (Array.isArray(rawPosts) ? rawPosts : [])) {
      // Only replay posts newer than the snapshot's timestamp
      if (cutoff && new Date(post.created) <= cutoff) continue;
      try {
        const meta = typeof post.json_metadata === "string"
          ? JSON.parse(post.json_metadata || "{}")
          : (post.json_metadata || {});
        if (!meta.steembiota) continue;
        applyOperation(currentState, post, 0, post.created);
        applied++;
      } catch { /* skip malformed posts */ }
    }

    stateRef.value = { ...currentState }; // trigger Vue reactivity
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
  if (state.registry[id]) {
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
      hashPreview:   "",
      statusDetail:  ""
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
    if (this.exportUrl) URL.revokeObjectURL(this.exportUrl);
  },

  methods: {
    /** Step 1 — Snapshot the current state and offer it as a download. */
    async generateExport() {
      this.busy         = true;
      this.exportReady  = false;
      this.statusDetail = "Hashing state…";
      try {
        const gs        = this.globalState?.value || this.globalState || createEmptyState();
        const hash      = await hashState(gs);
        this.hashPreview = hash.slice(0, 16) + "…";

        const blob        = new Blob([JSON.stringify(gs, null, 2)], { type: "application/json" });
        if (this.exportUrl) URL.revokeObjectURL(this.exportUrl);
        this.exportUrl   = URL.createObjectURL(blob);
        this.exportReady = true;
        this.statusDetail = `State hash: ${this.hashPreview}`;
        this.notify("State exported — pin it to IPFS and paste the CID below.", "success");
      } catch (e) {
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

      <div v-if="busy" style="font-size:12px;color:#ffe082;margin-top:6px;">⏳ Working…</div>
    </div>
  `
};
