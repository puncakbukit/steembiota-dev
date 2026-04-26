# SteemBiota — Immutable Evolution

**SteemBiota** is a decentralised life simulation built on the **Steem blockchain**.

Creatures are generated from deterministic **genomes**, rendered procedurally as canvas paintings, and their entire existence — from birth through feeding, play, walking, breeding, ownership transfer, and fossilisation — is **permanently recorded on-chain**.

SteemBiota also includes an **Accessory system**: users can procedurally generate wearable items, publish them on-chain, browse all accessories, and transfer ownership using the same two-sided handshake protocol used by creatures.

Creatures and accessories are treated as **NFTs**: each is uniquely identified by its `author/permlink` key, its ownership and equip state are tracked by a Global State Machine that is snapshotted to IPFS and anchored on-chain, and all state transitions are deterministic and cryptographically verifiable.

🌐 **Live app:** https://puncakbukit.github.io/steembiota

---

## Concept

SteemBiota explores digital organisms whose evolution is permanently stored on a blockchain.

Each creature has a compact genome that determines its body shape, colour, lifespan, and fertility window. Once published via Steem Keychain, the genome is immutable. A creature's lifecycle plays out in real time measured in days, and every interaction — feeding, playing, walking, breeding — is stored as a blockchain reply. The blockchain becomes the ecosystem's permanent fossil record.

Creatures can be **transferred between owners** via a two-sided on-chain handshake. Ownership is tracked by the **Global State Machine** (see below), which delivers O(1) local lookups instead of scanning reply chains on every render.

---

## Technology Stack

The dApp runs entirely in the browser with no build tools and no backend.

| Layer | Technology |
|---|---|
| Blockchain | Steem (via steem-js) |
| Signing | Steem Keychain browser extension |
| UI Framework | Vue 3 (CDN) + Vue Router 4 (CDN) |
| Routing | Vue Router 4 (CDN, hash mode) |
| State snapshot storage | IPFS (public gateways + Pinata / web3.storage) |
| Hosting | GitHub Pages |
| Build tools | None |

Files: `index.html`, `blockchain.js`, `state.js`, `components.js`, `accessories.js`, `upload.js`, `app.js`

---

## NFT State Machine & Checkpoint System

SteemBiota treats every creature and accessory as an **NFT** identified by its canonical `author/permlink` key. Instead of scanning reply chains on every page load to determine who owns a creature or what an accessory is equipped on, the app maintains a **Global State Machine (GSM)** — a single in-memory object that is the authoritative source of truth for ownership and equip state across the entire session.

### State Schema

```js
// Vue-reactive ref (globalState.value) — fields that drive UI rendering:
{
  version:   1,
  block_num: 0,          // Steem block number of the last processed event
                         // NOTE: only advances when a positive integer blockNum is available;
                         // getDiscussionsByCreated does not return block numbers, so this
                         // may lag behind real chain height during replay-only boots.
  timestamp: null,       // ISO-8601 string, canonical form "YYYY-MM-DDTHH:mm:ss" (no Z, no ms)
  ownership: {},         // "author/permlink" → current owner username
  equipped:  {}          // "accAuthor/accPermlink" → "creatureAuthor/creaturePermlink"
}

// Module-level Map — kept OUTSIDE the reactive ref to avoid Vue observer overhead at scale:
_nftRegistry             // "author/permlink" → { type: "creature"|"accessory" }
```

> **Design note:** `_nftRegistry` is a plain JS `Map` that lives in module scope. At 100 k+ entries, placing it inside the reactive object would cause Vue to re-observe the entire tree on every Feed/Wear operation. The registry is serialised and merged into the exported JSON at snapshot time so the Proxy and IPFS snapshot consumers always receive a complete `registry` key (see [Checkpoint Broadcasting](#checkpoint-broadcasting)).

### Snapshot Payload

All three code paths that produce a snapshot payload — `hashState()`, `autoUploadCheckpoint()`, and `generateExport()` — delegate to a single shared helper, `_buildSnapshotPayload(state, registry)`. This eliminates the risk of one path silently including or omitting a field that the others do not, which would cause hash mismatches for all clients verifying the snapshot.

The canonical five-field payload is:

```js
{
  version:   Number,   // always coerced
  block_num: Number,   // always coerced
  timestamp: String,   // "YYYY-MM-DDTHH:mm:ss" — no Z, no milliseconds
  registry:  Object,   // compact: { "author/permlink": { t: "c"|"a", o: "owner" } }
  equipped:  Object    // "accId" → "creatureId"
}
```

`ownership` is intentionally absent as a top-level field — it is fully encoded in `registry.o`. Any future developer adding `ownership` back to the payload would break verification for all prior checkpoints; this is explicitly documented in the helper's JSDoc.

### State Transitions

All transitions are handled by `applyOperation(state, op, blockNum, timestamp)` in `state.js`. The function is **deterministic and idempotent** — replaying the same event twice has no effect. Supported operation types:

| Operation type | Effect |
|---|---|
| `founder` / `offspring` | Mint creature NFT; record `{ type: "creature" }` in registry; set owner to `op.author` |
| `accessory` | Mint accessory NFT; record `{ type: "accessory" }` in registry; set owner to `op.author` |
| `transfer_accept` | Transfer ownership of the referenced NFT to `op.author` (the accepting party) |
| `wear_on` | Record accessory as equipped on creature; enforces exclusivity (removes any prior creature assignment) |
| `wear_off` | Remove equip record |

All other reply types (`feed`, `play`, `walk`, `breed_permit`, etc.) do not affect NFT state and are ignored by the GSM.

#### transfer_accept: RPC-gap handling and anti-spoofing

When `transfer_accept` references an NFT not yet in `_nftRegistry` (e.g. because a temporary RPC failure prevented the original mint post from being fetched), the GSM synthesises a `_synthetic` placeholder rather than silently skipping the transfer. This preserves determinism: two clients where one had an RPC gap on the mint post will still both apply the ownership change and produce the same state hash.

Before creating a placeholder the GSM checks whether the current block height is covered by `CHECKPOINT_ROOTS`:

- If no roots exist at all, a `console.warn` labelled **SECURITY NOTICE** is emitted explaining that the root-validation circuit-breaker is inactive. Operators should populate `CHECKPOINT_ROOTS` to close this window.
- If roots exist but the op's block height exceeds the latest root, a separate warning prompts adding a new root entry.

In both cases the placeholder is still created — refusing it would reintroduce the determinism fork that the original fix was designed to prevent.

### Boot Sequence

On every page load, `bootstrapState()` runs the following sequence asynchronously, updating the `syncStatus` Vue ref at each step (displayed as a slim banner until the sync is complete):

1. **Check IndexedDB** — if a previously persisted snapshot exists, load it instantly (offline-capable, zero RPC calls).
2. **Fetch on-chain checkpoint** — scan account history for `custom_json` ops with id `steembiota_checkpoint` using the deep paginated scanner (see [Checkpoint Discovery](#checkpoint-discovery) below). Community checkpoints from all publishers are considered, not only `@steembiota`.
3. **Compare CIDs** — if the on-chain checkpoint references the same CID as the IDB snapshot, skip the IPFS download; otherwise download and verify.
4. **Verify IPFS snapshot** — compute `SHA-256` of the downloaded JSON (with keys canonically sorted against a strictly-defined minimal object) and compare against `state_hash` in the checkpoint. A mismatch means the IPFS node served a tampered file — the snapshot is rejected and the IDB cache is used as fallback.
5. **Persist to IndexedDB** — save the verified snapshot. `persistSnapshot()` returns `true` on success and `false` on failure. On failure a warning is logged and `window._sbPersistOk = false` is set so follower tabs can detect the gap (see [Multi-Tab Sync](#multi-tab-sync)).
6. **Exhaustive replay** — fetch **all** posts tagged `steembiota` whose `created` timestamp postdates the snapshot using `_fetchAllPostsSince()`, a cursor-based paginator that walks backwards through `getDiscussionsByCreated` pages until it reaches the cutoff. Reply-based operations (`transfer_accept`, `wear_on`, `wear_off`) are collected separately by `_fetchReplyOpsSince()`, which scans the account history of every author found in the top-level posts **and** every account currently listed in the `ownership` map.
7. **Single atomic state update** — the entire replay runs against a local `currentState` variable; `stateRef.value` is assigned exactly **once** at the very end, eliminating UI flicker during large replays.
8. **Expose to Vue** — `globalState` and `syncStatus` are provided to all child components.

### Multi-Tab Sync

`bootstrapState()` is designed to run in exactly one browser tab at a time. A boot lock (`BOOT_LOCK_KEY` in `localStorage`) prevents duplicate bootstraps when multiple tabs are open simultaneously.

**Lock acquisition** (`_acquireBootLock`): after writing the lock, the function immediately reads it back. If the stored `owner` differs from the current tab's `myBootTabId`, another tab wrote concurrently and won the race — the current tab yields without calling `bootstrapState()`. This post-write read-back is a best-effort mitigation; `localStorage` has no true atomic compare-and-set, but the race is harmless because both tabs produce the same deterministic state.

**Follower tabs** wait via three mechanisms (tried in order of preference):

1. **BroadcastChannel** — the primary tab posts `{ type: "sb_state_ready" }` when `onReady` fires.
2. **storage event** — `_releaseBootLock()` removes the lock key from `localStorage`, firing a `storage` event in all same-origin tabs.
3. **Polling fallback** — a 500 ms interval checks whether the lock has expired (`BOOT_LOCK_MAX_AGE`).

In all three paths, the follower tab calls `loadPersistedSnapshot()` and verifies the loaded snapshot is non-empty. If `window._sbPersistOk === false` (primary tab's IDB write failed) or the loaded registry is empty, the follower tab falls back to calling `bootstrapState()` independently rather than rendering a blank UI.

### Checkpoint Discovery

`fetchLatestCheckpoint()` performs an exhaustive, multi-account scan:

- **Deep history scan** — `_scanAccountCheckpoints()` walks the Steem account history in pages of up to 1 000 ops, advancing a cursor backward until the target `minBlockNum` is reached or genesis is hit. The loop correctly processes the batch containing sequence number 0 before stopping, ensuring a checkpoint published as an account's very first operation is never missed.
- **Community publishers** — in addition to `@steembiota`, any account that has ever posted with the `steembiota` tag is scanned for checkpoint ops. Discovery uses `_fetchAllPostsSince(null)` (full paginated history, no cap) rather than a single 100-post API call, so community publishers are never silently missed even on a large network.
- **Scoring** — candidates are grouped by `(block_num, state_hash)`. Each group is scored by: a large trust bonus for `@steembiota` (1 000 000 points), a normalised reputation score (floored integer to eliminate floating-point divergence across JS engines), and a recency bonus equal to `floor(block_num / 1000)`. The highest-scoring group wins.
- **Root validation** — candidates whose `block_num` is at or below any entry in `CHECKPOINT_ROOTS` but whose `state_hash` does not match that root are rejected unconditionally, closing the poisoned-checkpoint attack surface.

### CHECKPOINT_ROOTS

`CHECKPOINT_ROOTS` is a hard-coded array of genesis anchors that acts as a circuit-breaker against poisoned checkpoints. An entry looks like:

```js
{ block_num: 105514380, state_hash: "sha256hex…", snapshot_cid: "QmXyz…", note: "…" }
```

A candidate checkpoint is **rejected** if its `block_num` is ≤ any root's `block_num` but its `state_hash` does not match that root's `state_hash`.

**How to add a new root** — after broadcasting a checkpoint via `/#/checkpoint`, run `hashState(await loadPersistedSnapshot().then(p => p.snapshot))` in the browser console, note the hex digest and the pinned CID, and append an entry to the array. Roots should be added monotonically and never removed.

### State Hashing

`hashState(state)` delegates to `_buildSnapshotPayload()` so the hashed object is byte-for-byte identical to what `autoUploadCheckpoint()` pins to IPFS. Before serialising, all keys inside each sub-object are sorted recursively. The `timestamp` is canonicalised to `"YYYY-MM-DDTHH:mm:ss"` (no trailing `Z`, no milliseconds). Vue observer internals and `_source` upload tags are excluded by the explicit field list.

### IPFS Snapshot Distribution

Three public IPFS gateways are tried in order using a **two-stage timeout** strategy:

- **Connect timeout (5 s):** how long to wait for TCP connection and HTTP response headers. HTTP 429 / 503 / 504 responses trigger immediate failover.
- **Body timeout (30 s):** additional time allowed for the full body once headers are received. Implemented as `Promise.race([res.text(), timeoutRejection])` — the `AbortController` approach is intentionally not used here because `fetch()` already received a response; only the body read needs to be bounded.

Gateways tried in order:

1. `https://cloudflare-ipfs.com/ipfs/` (most reliable for cold hits)
2. `https://ipfs.io/ipfs/`
3. `https://gateway.pinata.cloud/ipfs/`

Any verified snapshot is persisted to the `sb_state_snapshot` IndexedDB store so that subsequent boots do not require an IPFS round-trip.

**CID format validation** — before attempting any gateway fetch, the CID string is validated against a regex that accepts CIDv0 (`Qm…`, 46 chars) and CIDv1 (`bafy…`, 59+ chars). A malformed CID fails immediately without consuming gateway quota.

### Checkpoint Broadcasting

Any logged-in user can publish a checkpoint. The `CheckpointManager` component (available at `/#/checkpoint`) supports two flows:

**One-click (recommended):**

1. Click **⚡ One-Click — Upload & Broadcast**.
2. The component builds the export payload via `_buildSnapshotPayload()`, POSTs it to the Cloudflare Worker proxy (which pins it to IPFS and returns a CID).
3. The CID is immediately passed to `submitCheckpoint()` and broadcast on-chain via Keychain.

**Manual (for users who self-pin):**

1. Export the current GSM state as `steembiota-state.json` via `generateExport()`.
2. Pin the file to IPFS and obtain the CID.
3. Paste the CID into the Checkpoint Authority panel and click **📡 Broadcast**.

Both flows use the same `publishCheckpoint()` function, which broadcasts a `custom_json` op:

```json
{
  "id": "steembiota_checkpoint",
  "json": {
    "version": 1,
    "block_num": 12345678,
    "state_hash": "sha256hexdigest…",
    "snapshot_cid": "QmXyz…or bafyXyz…"
  }
}
```

> **Security note:** The Cloudflare Worker shared secret visible in `state.js` is a rate-limit guard, not an authentication token. The actual security comes from on-chain hash verification. The Worker's Pinata account should be configured with server-side rate limits (e.g. max 1 upload per minute per IP) to prevent exhaustion.

### GSM Convenience Helpers

`state.js` exports several helpers consumed by `CreatureView` and `ProfileView`:

| Helper | Purpose |
|---|---|
| `stateOwnerOf(state, author, permlink, fallback)` | O(1) ownership lookup; returns `fallback` when not yet in registry |
| `stateEquippedOn(state, accAuthor, accPermlink)` | Returns `"author/permlink"` key of the wearing creature, or `null` |
| `statePatchOwner(state, author, permlink, newOwner)` | Hot-patches the GSM immediately after a confirmed transfer |
| `statePatchEquip(state, …)` | Hot-patches the GSM immediately after a confirmed `wear_on` |
| `statePatchUnequip(state, …)` | Hot-patches the GSM immediately after a confirmed `wear_off` |

### IndexedDB Schema

All persistent data shares a single IndexedDB database (`SteemBiotaDB`, current version: **3**). The schema version is the single source of truth in `blockchain.js`; `state.js` delegates to `openSBDB()` (defined in `blockchain.js`) rather than opening its own version, eliminating the version-conflict race that could cause one tab to block another during an upgrade.

| Object store | Key | Contents |
|---|---|---|
| `creature_pages` | `id` (author/permlink) | Full creature post + metadata, TTL 10 min |
| `ancestry_cache` | `id` (author/permlink) | Ancestor BFS results: `{ parentA, parentB, isPhantom, ts }` |
| `list_cache` | `id` | Creature list arrays, TTL 5 min |
| `sb_state_snapshot` | `id` ("latest") | Verified GSM snapshot + CID + hash |

---

## Breeding & Kinship System

### Compatibility Rules

Two creatures can breed if: same `GEN`; opposite sex; both within their effective fertility window; neither is fossil or phantom; breeder has permission for both parents; pair passes the kinship check (no shared recent ancestors).

### Early Genus Mismatch Detection

When a Parent B URL is pasted into the Breed panel, the app fetches both genomes (debounced 800 ms) and checks `GEN` equality before running the full ancestor walk. If the genera differ, an inline error is shown immediately.

### Kinship Check

`checkBreedingCompatibility(resA, resB)` in `blockchain.js` walks up to twelve generations of ancestry via BFS, using a cache-first strategy (IndexedDB → live RPC). The underlying `fetchAncestors()` function has two layers of hang-prevention:

**Layer 1 — `writeAncestryDB` commits before proceeding.** Each ancestry cache write now awaits `tx.oncomplete` before returning. Previously `store.put()` was fire-and-forget: the function returned before the IDB transaction committed, so the next `readAncestryDB()` call on the same key raced the uncommitted write, got `null`, triggered a redundant RPC call, and — under rate-limiting or node errors — returned `null` again. The old `if (!node) continue` then skipped the node without enqueuing its children, leaving those children permanently stranded in the BFS queue. The `while (queue.length > 0)` loop never drained, and the **"Checking ancestry and family relationships…"** message stayed on screen forever. The IDB connection is closed in a `finally` block after each write to prevent handle accumulation that triggered `onblocked` events.

**Layer 2 — per-node timeout.** Each BFS node's work (cache read + optional RPC + cache write) is raced against a 12-second `Promise.race` timeout. If the budget is exceeded the node is treated as a severed phantom and the BFS continues. Unfetchable nodes are also written to the cache as phantoms rather than silently skipped, so they are not refetched on every subsequent boot.

Results from the early URL-paste check are cached in `kinshipPreview` and reused at Breed time if still valid. The Breed button is disabled while `kinshipPreview === "checking"` to prevent duplicate concurrent ancestor walks.

If the check fails mid-way due to rate-limiting or timeout, `kinshipPreview` is set to an error object so the button returns to idle rather than freezing permanently in "Verifying…".

### Kinship: Severed Lineage

If `fetchAncestors` encounters a **phantom** (deleted) ancestor post, it records the node as `{ severed: true }` and sets `visited._hasSeveredLineage = true`, then continues traversal (the phantom has no fetchable parents, so the BFS simply does not enqueue further nodes from that branch).

`checkBreedingCompatibility` returns `{ severedLineage: true, warning: "…" }` when either ancestry walk encountered a phantom. Breeding is **not blocked** — the child genome is stamped with `_severedLineage: true`, and an amber informational banner is shown in the breed preview panel.

### Matchmaker

The **🔍 Find Compatible Partner** button fetches up to 200 recent posts plus the localStorage list cache, filters to same-genus / opposite-sex / currently-fertile / non-duplicate candidates, and presents up to 5 partner cards. Selecting a card uses a two-tap confirm pattern to prevent accidental taps.

---

## Creature Genome

Each creature is defined by ten integer genes, plus optional provenance tags:

| Gene | Description | Range |
|---|---|---|
| `GEN` | Genus ID — species barrier; also determines colour palette family (GEN % 8) and eye style (GEN % 4) | 0–999 |
| `SX` | Sex (0 = Male, 1 = Female) | 0–1 |
| `MOR` | Morphology seed — drives body length, body height, head size, tail curve, and tail style | 0–9999 |
| `APP` | Appendage seed — drives leg length, leg thickness, ear dimensions, ear style, wing presence and span | 0–9999 |
| `ORN` | Ornamentation seed — drives glow orb count, energy ribbon count, body pattern, orb hue offset, chest marking, mane wisp presence, fur length | 0–9999 |
| `CLR` | Hue offset: `finalHue = (paletteBase + CLR) % 360` | 0–359 |
| `LIF` | Lifespan in real days | 80–159 |
| `FRT_START` | Fertility window start (days from birth) | varies |
| `FRT_END` | Fertility window end (days from birth) | varies |
| `MUT` | Mutation tendency | 0–2 (founders); 0–5 (bred) |
| `_source` | Optional provenance tag — `"image-upload"` for creatures created via the Upload page | string or absent |
| `_severedLineage` | `true` when the child was bred from a lineage containing a Phantom ancestor | boolean or absent |

### Colour Palette System

GEN selects one of eight fixed palette bases, and CLR offsets the hue within that palette:

| Palette index (GEN % 8) | Base hue |
|---|---|
| 0 | 160° (cyan-green) |
| 1 | 200° (blue-green) |
| 2 | 280° (violet) |
| 3 | 30° (orange) |
| 4 | 340° (pink-red) |
| 5 | 100° (yellow-green) |
| 6 | 240° (blue) |
| 7 | 55° (yellow) |

### Derived Visual Traits

| Trait | Source | Values |
|---|---|---|
| Eye style | `GEN % 4` | 0: Round, 1: Slit, 2: Almond, 3: Large iris |
| Tail style | First `MOR` PRNG draw | 0: Tapered, 1: Tufted, 2: Plumed |
| Ear style | `APP` PRNG stream | 0: Pointed, 1: Rounded, 2: Floppy |
| Fur length | `ORN` PRNG stream | 0: Smooth, 1: Short, 2: Fuzzy, 3: Shaggy |

### Genus Names

Each GEN value maps to a stable procedurally-generated genus name. The name is derived solely from the GEN integer so all creatures of the same genus share the same name.

---

## Lifecycle

Creature age is measured in **real days** since the post was published.

| Stage | Age % | Icon |
|---|---|---|
| Baby | 0–4% | 🥚 |
| Toddler | 5–11% | 🐣 |
| Child | 12–24% | 🌱 |
| Teenager | 25–39% | 🌿 |
| Young Adult | 40–59% | 🌸 |
| Middle-Aged | 60–79% | 🍃 |
| Elder | 80–99% | 🍂 |
| Fossil | 100%+ | 🦴 |

Once the lifespan is exceeded the creature becomes a **Fossil**. Its genome and history remain permanently on-chain but it can no longer be fed, played with, walked, or used in breeding.

### Phantom Creatures

If a post is deleted on Steem (`delete_comment` op), the API returns the post with an empty `author` field. SteemBiota detects this as a **phantom**. Phantoms cannot be fed, played with, walked, or bred. Non-direct phantom ancestors in a breeding chain produce a Severed Lineage trait rather than blocking breeding.

---

## Visual Rendering — Canvas

Every creature is rendered procedurally from its genome on a 400×320 HTML5 Canvas. The same genome always produces the same base visual. Three sources of per-load variation are layered on top: random facing direction, random pose, and live expression driven by game state.

### Performance: Viewport-Aware Rendering

Each creature canvas runs its own `requestAnimationFrame` loop. An **`IntersectionObserver`** pauses the rAF loop for any canvas that has scrolled out of the visible viewport and resumes it immediately when it scrolls back in.

### Off-screen Canvas Reuse

The accessory compositing canvas is **created once per component instance** and reused across frames, preventing GPU context exhaustion.

### Phenotype Derivation (`buildPhenotype`)

All renderable traits are derived in a single `buildPhenotype(genome, age, feedState)` call before any drawing occurs. Three seeded mulberry32 PRNGs are instantiated — one per seed gene — and consumed in a fixed order.

| PRNG seed | Traits derived |
|---|---|
| `MOR` | `bodyLen`, `bodyH`, `headSize`, `tailCurve`, `tailStyle` |
| `APP` | `legLen`, `legThick`, `earH`, `earW`, `hasWings`, `wingSpan`, `earStyle` |
| `ORN` | `glowOrbs`, `ribbons`, `patternType`, `orbHue`, `hasChestMark`, `hasMane`, `furLength` |

### Lifecycle Scalars

| Stage | Age % | `bodyScale` | `ornamentScale` | `patternOpacity` |
|---|---|---|---|---|
| Baby | 0–4% | 0.45 | 0.00 | 0.10 |
| Toddler | 5–11% | 0.60 | 0.15 | 0.30 |
| Child | 12–24% | 0.78 | 0.40 | 0.60 |
| Teenager | 25–39% | 0.90 | 0.75 | 0.90 |
| Young Adult | 40–59% | 1.00 | 1.00 | 1.00 |
| Middle-Aged | 60–79% | 0.98 | 0.88 | 0.90 |
| Elder | 80–99% | 0.92 | 0.70 | 0.75 |
| Fossil | 100%+ | 0.75 | 0.00 | 0.00 |

### Painter's Algorithm (draw order, back to front)

1. Fossil shortcut — grey ellipse + procedural crack lines
2. Ground shadow
3. Energy ribbons
4. Back legs (62% alpha for depth)
5. Front legs
6. Tail
7. Torso
8. Chest marking
9. Body pattern (spots / dapple)
10. Worn wings accessory (off-screen canvas composite)
11. Necklace underlay (`destination-over` compositing — eliminates seams)
12. Neck
13. Mane wisps
14. Head
15. Snout + nose
16. Ears
17. Eye (iris, pupil, highlights)
18. Face expression overlay
19. Dorsal wing/fin
20. Glowing orb nodes
21. Fertility aura
22. Worn hat / crown accessories

### Poses

| Pose | Description |
|---|---|
| 🐾 Standing | Default upright side profile |
| 👀 Alert | Torso raised, head lifted high, tail swept up |
| 🎉 Playful | Play-bow: front legs stretched forward and low |
| 🪑 Sitting | Torso tilted rear-down ~22°, tail wrapped |
| 💤 Sleeping | Body flat and low, head resting, legs tucked |

### Face Expressions

| Expression | Trigger |
|---|---|
| 😴 Sleepy | Sleeping pose |
| 👀 Alert | Alert pose |
| 🎉 Excited | Playful pose |
| ✨ Thriving | Boosted health ≥ 80% |
| 😊 Happy | Boosted health ≥ 55% |
| 😐 Content | Boosted health ≥ 30% or no data |
| 😟 Hungry | Health > 0% but boosted < 30% |
| 😢 Sad | Health = 0% |

### Accessibility

- Canvas carries `tabindex="0"`; **Enter** key triggers poke reaction
- Genome bars carry `role="progressbar"` with `aria-valuenow/min/max`
- `<pre>` unicode art blocks carry `aria-hidden="true"` with a visually-hidden text summary
- **🌸 Fertile Now** badge communicates fertility as explicit text
- `--clr-muted` is `#949494` (4.6:1 contrast on `#111`) — WCAG AA compliant

---

## Visual Rendering — Unicode

Used inside Steem post bodies so the creature's form is stored permanently on-chain as plain text. Art width grows with lifecycle stage (14 chars at Baby up to 36 at Young Adult).

---

## Accessory System

SteemBiota supports procedurally generated, on-chain **accessories**.

- Accessory creation and browsing live on `/#/accessories`.
- Published accessories are regular Steem posts with `json_metadata.steembiota.type = "accessory"`.
- Accessories support the same transfer offer / accept / cancel ownership flow as creatures.
- Accessory ownership and equip state are tracked by the GSM alongside creature ownership.

### Accessory Templates

Four templates currently implemented: 🎩 Hat, 👑 Crown, 📿 Necklace, 🪽 Wings.

### Accessory Genome (10 parameters)

| Parameter | Description | Range |
|---|---|---|
| `CLR` | Primary hue | 0–359 |
| `SAT` | Saturation | 0–100 |
| `LIT` | Lightness | 10–90 |
| `SZ` | Size scalar | 20–100 |
| `VAR` | Shape variation seed | 0–9999 |
| `ACC` | Accent seed | 0–9999 |
| `STR` | Structure seed | 0–9999 |
| `ORN` | Ornament seed | 0–9999 |
| `SHN` | Shininess / metallic level | 0–100 |
| `SYM` | Symmetry bias | 0–1 |

### Wearing Accessories on Creatures

#### Permission Model

Accessory owners control wear access with on-chain replies: `wear_request`, `wear_grant`, `wear_revoke`, `wear_public`, `wear_private`. Accessory owner is always implicitly permitted; public mode allows anyone to equip.

#### Equip State Model

The **Global State Machine** (not the raw reply chain) is the primary source of truth for equip state. `stateEquippedOn()` delivers an O(1) lookup.

---

## Image Upload — Genome Derivation

The `/upload` page generates a genome whose visual output approximates the uploaded image.

| Step | Algorithm |
|---|---|
| Colour extraction | Sample N pixels, dominant hue via circular mean |
| Body shape extraction | Sobel edge detection → bounding box → aspect ratio |
| MOR fit | Full linear scan of all 10,000 MOR values; closest aspect ratio |
| CLR fit | `(dominantHue - paletteBase[bestGEN%8] + 360) % 360` |
| GEN selection | Nearest palette base to dominant hue |

---

## Ownership Transfer

Creature ownership is transferred via a **two-sided on-chain handshake**. Creatures cannot be forced on unwilling recipients.

### Protocol

**Offer** → **Accept** → (optional) **Cancel**. Every `transfer_offer` permlink includes `Date.now()` to guarantee uniqueness across repeated offers.

### Effective Owner

1. **GSM fast path** — `stateOwnerOf()` delivers an O(1) lookup.
2. **Reply-chain fallback** — `parseOwnershipChain()` scans replies; result is immediately hot-patched into the GSM via `statePatchOwner()`.

### Ownership Rules

- Only the effective owner may publish a transfer offer; only the named recipient may accept.
- **Recipient account verification** — `getAccounts` is called before publishing to prevent typo-induced lock-outs.
- **Accept pre-flight check** — the offer is re-verified on-chain before the Keychain popup opens.
- **Cancel pre-flight check** — the offer is re-verified before cancellation; if already accepted, local state is synced immediately.

---

## Caching

| Cache | Storage | TTL | Scope |
|---|---|---|---|
| NFT state snapshot | IndexedDB (`sb_state_snapshot`) | Until superseded by newer on-chain checkpoint | Global |
| Creature list (Home grid) | IndexedDB | 5 min | Global |
| Creature page | IndexedDB | 10 min | Per creature |
| Ancestry graph | IndexedDB | persistent | Per creature |
| Profile owned creatures | localStorage | 30 min | Per user |
| Profile owned accessories | localStorage | 30 min | Per user |
| Notifications | localStorage | 60 s | Per user |
| Leaderboard | localStorage | 24 h | Global (manual-refresh burstable) |
| Per-author XP detail | localStorage | 24 h | Per author |

---

## App Routes

| URL | View |
|---|---|
| `/#/` | Home — creature grid with filters, founder creator |
| `/#/upload` | Upload — image-inspired creature creator (login required) |
| `/#/accessories` | Accessories — accessory creator + browse grid |
| `/#/about` | About page |
| `/#/leaderboard` | Global XP leaderboard |
| `/#/notifications` | Notifications — activity feed and pending transfer accepts (login required) |
| `/#/checkpoint` | Checkpoint Authority — export GSM state, pin to IPFS, broadcast on-chain |
| `/#/@user` | Profile — tabbed inventory of owned creatures and accessories |
| `/#/@author/permlink` | Creature — canvas, activities, equip panel, breed panel, transfer panel |
| `/#/acc/@author/permlink` | Accessory — canvas, wear-permission manager, social panel, transfer panel |

---

## Blockchain Post Structure

### Creature post (`json_metadata.steembiota`)

```json
{
  "version": "1.0",
  "type": "founder",
  "genome": { "GEN": 42, "SX": 0, "MOR": 1234, "APP": 5678, "ORN": 9012, "CLR": 180, "LIF": 100, "FRT_START": 30, "FRT_END": 70, "MUT": 1 },
  "name": "Vyrex Nymwhisper",
  "genusName": "Vyrex",
  "age": 0,
  "lifecycleStage": "Baby"
}
```

Offspring adds: `"type": "offspring"`, `"parentA"`, `"parentB"`, `"mutated"`, `"speciated"`.
Image-inspired founders add `"_source": "image-upload"` inside the genome object.
Offspring bred through a severed lineage add `"_severedLineage": true` inside the genome object.

### Accessory post

```json
{
  "version": "1.0",
  "type": "accessory",
  "accessory": {
    "template": "crown",
    "name": "Radiant Diadem",
    "genome": { "CLR": 280, "SAT": 76, "LIT": 58, "SZ": 84, "VAR": 9021, "ACC": 4422, "STR": 7811, "ORN": 1103, "SHN": 67, "SYM": 0.42 }
  }
}
```

### Checkpoint broadcast (`custom_json`)

```json
{
  "id": "steembiota_checkpoint",
  "json": {
    "version": 1,
    "block_num": 12345678,
    "state_hash": "sha256hexdigest…",
    "snapshot_cid": "QmXyz…or bafyXyz…"
  }
}
```

### Reply types

| `type` | Post | Purpose |
|---|---|---|
| `feed` | creature | Feeding event |
| `play` | creature | Play activity |
| `walk` | creature | Walk activity |
| `breed_permit` / `breed_revoke` | creature | Grant / revoke breed permit |
| `transfer_offer` / `transfer_accept` / `transfer_cancel` | creature or accessory | Two-sided ownership handshake |
| `wear_request` / `wear_grant` / `wear_revoke` / `wear_public` / `wear_private` | accessory | Wear permission management |
| `wear_on` / `wear_off` | creature | Equip / unequip accessory |

---

## Social Interactions

On creature and accessory detail pages: **Upvote** (adjustable vote %), **Resteem**, **Comments** (on-chain), live vote/reblog counts.

---

## User Levels & XP

| Action | XP |
|---|---|
| Publish a founder creature | 100 |
| Publish an offspring | 500 |
| Each unique genus contributed | 25 |
| Each speciation event in own offspring | 75 |
| Feed a creature | 10 |
| Upvote a SteemBiota creature post (once per creature) | 5 |

| Rank | Min XP | Icon |
|---|---|---|
| Wanderer | 0 | 🌿 |
| Naturalist | 100 | 🔬 |
| Cultivator | 300 | 🌱 |
| Breeder | 700 | 🐣 |
| Ecologist | 1 500 | 🍃 |
| Evolutionist | 3 000 | 🧬 |
| Progenitor | 6 000 | 🌳 |

---

## Leaderboard

The `/leaderboard` page ranks all known SteemBiota participants by XP. Per-author XP data is cached for 24 hours. A **🔄 Refresh Rankings** button evicts the cache and triggers a full re-fetch (rate-limited to once per 10 minutes).

---

## Provenance & Copy Detection

### Provenance Badges

| Badge | Meaning |
|---|---|
| 👻 Phantom | Post was tombstoned on-chain |
| ⚠ Duplicate | Identical genome exists in an earlier post |
| ⚠ No parents | Claims to be offspring but has no parent links |
| ⚠ Unverified Origin | Founder with ≥ 3 simultaneously maxed traits |
| ⚡ Speciation | Legitimately bred offspring that created a new genus |
| 🧬 Bred / Bred — Mutation | Legitimately bred offspring with valid parent links |
| 🌱 Origin Creature | Legitimate founder (random or image-inspired) |
| 🌿 Severed Lineage | Bred offspring whose lineage contains a Phantom ancestor |

---

## Key Principles

**Immutability** — All genomes and life events are stored on-chain and cannot be altered.

**Determinism** — The same genome always renders the same creature. The same two parents always produce the same child. The same sequence of operations always produces the same GSM state.

**Single payload source** — `_buildSnapshotPayload()` is the sole constructor for the canonical five-field snapshot object. `hashState`, `autoUploadCheckpoint`, and `generateExport` all call it, so the hashed object, the uploaded object, and the exported object are provably identical.

**UTC time** — All timestamps use UTC to match the Steem blockchain clock.

**Client-side only** — All logic runs in the browser. No servers or external databases.

**Global State Machine** — Ownership and equip state for all NFTs are maintained in a single in-memory object seeded from a cryptographically verified IPFS snapshot and replayed exhaustively forward from the Steem chain.

**Lean registry** — The GSM registry stores only `{ type }` per NFT. Genomes are never written into the snapshot.

**Exhaustive replay** — `_fetchAllPostsSince` pages through `getDiscussionsByCreated` with no fixed limit. Community authors are discovered via exhaustive paginated history, not a capped 100-post window.

**Complete genesis scan** — `_scanAccountCheckpoints` processes Steem account history down to sequence number 0, ensuring a checkpoint published as an account's very first operation is never silently skipped.

**Atomic IDB writes** — All IndexedDB writes (ancestry cache, state snapshot) await `tx.oncomplete` before returning. Fire-and-forget puts are never used, as they cause read-after-write races in the same or subsequent transactions.

**Safe block-height tracking** — `applyOperation` only advances `state.block_num` when the caller supplies a positive integer.

**Tamper-evident snapshots** — Every IPFS checkpoint snapshot is verified against a SHA-256 hash. A mismatch causes the snapshot to be rejected and a fallback used. `CHECKPOINT_ROOTS` provides unconditional lower bounds for historical state.

**Non-blocking lineage** — A deleted ancestor post (Phantom) degrades gracefully to a Severed Lineage trait rather than blocking breeding for all downstream descendants.

**Breed hang prevention** — `fetchAncestors` guards against indefinite hangs via committed IDB writes (Layer 1) and a 12-second per-node `Promise.race` timeout (Layer 2). Unfetchable nodes are written to the cache as phantoms to avoid repeat RPC calls on future boots.

**Multi-tab safety** — The boot lock uses a post-write read-back to reduce (but not eliminate) the simultaneous-write race. Follower tabs verify the loaded IDB snapshot is non-empty and fall back to an independent `bootstrapState()` if the primary tab's IDB write silently failed.

**Anti-dumping ownership** — Transfers require the recipient's explicit on-chain acceptance.

**Stale-result safety** — All multi-step async operations use generation counters to discard superseded results.

**Keychain timeout resilience** — All Keychain publishing operations carry a 60-second self-cancelling timeout guard.

**Optimal MOR search** — `fitMor()` performs a full linear scan of all 10,000 MOR values to find the globally optimal body aspect ratio match.

**WCAG AA contrast** — `--clr-muted` is `#949494` (4.6:1 on `#111`), meeting WCAG AA.

**Unique transfer permlinks** — Transfer offer permlinks always include a `Date.now()` timestamp suffix, guaranteeing distinct identifiers even for repeated offers months apart.

---

## License

Open source. Community experimentation and forks are encouraged.

---

## Author

Created for the Steem blockchain ecosystem by @puncakbukit.
