// ============================================================
// app.js
// SteemBiota — Immutable Evolution
// Vue 3 + Vue Router 4 SPA entry point.
// ============================================================

const { createApp, ref, computed, onMounted, provide, inject, nextTick } = Vue;
const { createRouter, createWebHashHistory, useRoute } = VueRouter;

// ============================================================
// STEEMBIOTA GENOME HELPERS (pure functions, no DOM)
// ============================================================

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function generateGenome() {
  const LIF       = 80 + randomInt(80);
  const FRT_START = Math.min(20 + randomInt(20), LIF - 10);
  // FRT_END must be strictly greater than FRT_START and less than LIF.
  // Anchor the lower bound to FRT_START + 5 so the window is always valid,
  // even when FRT_START was pushed close to LIF by the clamp above.
  const FRT_END   = Math.min(Math.max(60 + randomInt(20), FRT_START + 5), LIF - 1);
  return {
    GEN: randomInt(1000),
    SX:  randomInt(2),      // 0 = male, 1 = female
    MOR: randomInt(9999),
    APP: randomInt(9999),
    ORN: randomInt(9999),
    CLR: randomInt(360),
    LIF,
    FRT_START,
    FRT_END,
    MUT: randomInt(3)       // 0–2 for founders; range 0–5
  };
}

// ============================================================
// STEEMBIOTA BREEDING SYSTEM
// ============================================================

// Seeded PRNG (mulberry32) — ensures same parents + seed → same child.
// Returns a function yielding floats in [0, 1).
function makePrng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive a deterministic integer seed from two genomes.
// Uses a simple hash over all gene values so order-of-paste doesn't matter.
// GEN appears once (shared by both parents after the same-genus check).
// SX is included so that a male×female pair hashes differently from a
// hypothetical female×male call with the same other genes.
function breedSeed(a, b) {
  const vals = [a.GEN,a.SX,a.MOR,a.APP,a.ORN,a.CLR,a.LIF,a.MUT,
                      b.SX,b.MOR,b.APP,b.ORN,b.CLR,b.LIF,b.MUT];
  return vals.reduce((h, v) => (Math.imul(h ^ (v | 0), 0x9e3779b9) >>> 0), 0x12345678);
}

// Mutation probability from both parents' MUT genes.
// base = 1%; scales with combined MUT.
function mutationChance(a, b) {
  return 0.01 * (1 + a.MUT + b.MUT);
}

// Rare speciation: 0.5% chance GEN mutates to an entirely new value.
function maybeSpeciate(rng, gen) {
  if (rng() < 0.005) return Math.floor(rng() * 1000);
  return gen;
}

// Parse a Steem post URL into { author, permlink }.
// Handles steemit.com and plain author/permlink strings.
function parseSteemUrl(url) {
  url = url.trim();
  // Match https://steemit.com/category/@author/permlink
  // or    https://steemit.com/@author/permlink
  const m = url.match(/@([a-z0-9.-]+)\/([a-z0-9-]+)\s*$/i);
  if (!m) throw new Error("Cannot parse Steem URL: " + url);
  return { author: m[1], permlink: m[2] };
}

// Load a genome from a published SteemBiota post.
// Tries json_metadata first (fast), falls back to body regex.
// Returns { genome, author, permlink, age } where age is the creature's
// current age in days (stored age + elapsed days since post.created).
async function loadGenomeFromPost(url) {
  const { author, permlink } = parseSteemUrl(url);
  const post = await fetchPost(author, permlink);
  if (!post) throw new Error("Post not found: " + url);
  // Tombstoned post -- delete_comment sets author to "" on the API
  if (isPhantomPost(post)) throw new Error(
    "This creature is a Phantom (👻). Its post was removed from the visible chain. " +
    "Phantoms cannot be loaded for breeding."
  );
  if (!post.author) throw new Error("Post not found: " + url);

  // Fetch all replies once — used for both genome fallback and permit parsing
  const replies   = await fetchAllReplies(author, permlink);
  const ownership = parseOwnershipChain(replies, post.author);
  const permits   = parseBreedPermitsWithTransfer(
    replies, ownership.effectiveOwner, ownership.permitsValidFrom
  );
  const effectiveOwner = ownership.effectiveOwner;

  // Try json_metadata.steembiota.genome first
  try {
    const meta = JSON.parse(post.json_metadata || "{}");
    if (meta.steembiota && meta.steembiota.genome) {
      const storedAge  = meta.steembiota.age ?? 0;
      const elapsed    = calculateAge(post.created);   // days since post was published
      const currentAge = storedAge + elapsed;
      return { genome: meta.steembiota.genome, author, permlink, age: currentAge, permits, effectiveOwner };
    }
  } catch {}

  // Fallback: parse ```genome ... ``` block from post body
  const match = post.body.match(/```genome\s*([\s\S]*?)```/);
  if (!match) throw new Error("No genome found in post: " + url);
  const genome = JSON.parse(match[1].trim());
  const elapsed = calculateAge(post.created);
  return { genome, author, permlink, age: elapsed, permits, effectiveOwner };
}

// Stable string key that uniquely identifies a genome's content.
// All gene values are included so any copy — founder or offspring — produces the same key.
function genomeFingerprint(g) {
  return [g.GEN, g.SX, g.MOR, g.APP, g.ORN, g.CLR, g.LIF, g.FRT_START, g.FRT_END, g.MUT].join("|");
}

// Given an array of parsed creature posts (must have .fingerprint and .created),
// marks any post whose genome appeared earlier in another post as a duplicate.
// Returns the same array mutated in-place (also sets .isDuplicate and .originalKey).
function markDuplicates(posts) {
  // Map fingerprint → earliest { author, permlink, created }
  const earliest = new Map();
  for (const p of posts) {
    const fp  = p.fingerprint;
    const key = p.author + "/" + p.permlink;
    if (!earliest.has(fp) || p.created < earliest.get(fp).created) {
      earliest.set(fp, { author: p.author, permlink: p.permlink, created: p.created, key });
    }
  }
  for (const p of posts) {
    const first = earliest.get(p.fingerprint);
    const selfKey = p.author + "/" + p.permlink;
    p.isDuplicate    = first.key !== selfKey;
    p.originalAuthor   = p.isDuplicate ? first.author   : null;
    p.originalPermlink = p.isDuplicate ? first.permlink : null;
    p.originalCreated  = p.isDuplicate ? first.created  : null;
  }
  return posts;
}

// Convert a raw Steem post array into creature card data objects.
// Filters to valid SteemBiota posts, newest first.
const PAGE_SIZE = 15;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OWNED_PROFILE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (profile ownership scans are expensive)
const CREATURE_PAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LEADERBOARD_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes (fetch is expensive: 2N RPC calls per author)
const NOTIFICATIONS_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const ACCESSORY_PAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function readListCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.savedAt !== "number") return null;
    if ((Date.now() - parsed.savedAt) > LIST_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

// Evict the oldest steembiota:* localStorage entries until at least `bytesNeeded`
// bytes have been freed, then retry the write. Called only on QuotaExceededError.
function _evictOldestAndRetry(key, serialized) {
  try {
    // Collect every steembiota key with its savedAt timestamp.
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("steembiota:")) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(k));
        entries.push({ k, savedAt: (parsed && parsed.savedAt) ? parsed.savedAt : 0 });
      } catch {
        entries.push({ k, savedAt: 0 });
      }
    }
    // Remove oldest first until the write succeeds or we run out of entries.
    entries.sort((a, b) => a.savedAt - b.savedAt);
    for (const { k } of entries) {
      localStorage.removeItem(k);
      try {
        localStorage.setItem(key, serialized);
        return; // write succeeded after eviction
      } catch {}
    }
    console.warn("SteemBiota cache: localStorage still full after eviction — skipping write for", key);
  } catch (err) {
    console.warn("SteemBiota cache: eviction failed:", err);
  }
}

function _safeSet(key, serialized) {
  try {
    localStorage.setItem(key, serialized);
  } catch (err) {
    if (err && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22)) {
      console.warn("SteemBiota cache: localStorage quota exceeded — evicting old entries and retrying.");
      _evictOldestAndRetry(key, serialized);
    } else {
      console.warn("SteemBiota cache: localStorage write error:", err);
    }
  }
}

function writeListCache(key, data) {
  if (!Array.isArray(data)) return;
  _safeSet(key, JSON.stringify({ savedAt: Date.now(), data }));
}

// Dedicated cache for ProfileView ownership tabs.
// Uses a longer TTL than generic lists to avoid repeatedly scanning transfer chains.
function readOwnedProfileCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.savedAt !== "number") return null;
    if ((Date.now() - parsed.savedAt) > OWNED_PROFILE_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeOwnedProfileCache(key, data) {
  if (!Array.isArray(data)) return;
  _safeSet(key, JSON.stringify({ savedAt: Date.now(), data }));
}

function readCreaturePageCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.data) return null;
    if ((Date.now() - parsed.savedAt) > CREATURE_PAGE_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCreaturePageCache(key, data) {
  if (!data || !data.genome) return;
  _safeSet(key, JSON.stringify({ savedAt: Date.now(), data }));
}

function readObjectCache(key, ttlMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.data) return null;
    if ((Date.now() - parsed.savedAt) > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeObjectCache(key, data) {
  if (!data) return;
  _safeSet(key, JSON.stringify({ savedAt: Date.now(), data }));
}

function removeCacheByPrefix(prefix) {
  try {
    // Snapshot all matching keys first — removing items during live iteration
    // can shift indices in some browsers and cause keys to be skipped.
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {}
}

function invalidateGlobalListCaches() {
  removeCacheByPrefix("steembiota:list:");
}

function invalidateOwnedCachesForUser(user) {
  const u = String(user || "").toLowerCase();
  if (!u) return;
  removeCacheByPrefix(`steembiota:owned:creatures:${u}:`);
  removeCacheByPrefix(`steembiota:owned:accessories:${u}:`);
  removeCacheByPrefix(`steembiota:notifications:${u}:`);
}

function invalidateCreatureCache(author, permlink) {
  const a = String(author || "").toLowerCase();
  const p = String(permlink || "").toLowerCase();
  if (!a || !p) return;
  localStorage.removeItem(`steembiota:creature:${a}/${p}:v1`);
}

function invalidateAccessoryCache(author, permlink) {
  const a = String(author || "").toLowerCase();
  const p = String(permlink || "").toLowerCase();
  if (!a || !p) return;
  localStorage.removeItem(`steembiota:accessory:${a}/${p}:v1`);
}

function parseSteembiotaPosts(rawPosts) {
  const results = [];
  for (const p of rawPosts) {
    let meta = {};
    try { meta = JSON.parse(p.json_metadata || "{}"); } catch {}
    if (!meta.steembiota || !meta.steembiota.genome) continue;
    const sb  = meta.steembiota;
    const age = calculateAge(p.created);   // live age — days since post was published
    results.push({
      author:         p.author,
      permlink:       p.permlink,
      name:           sb.name || p.author,
      genome:         sb.genome,
      age,
      lifecycleStage: getLifecycleStage(age, sb.genome),
      type:           sb.type || "founder",
      parentA:        sb.parentA || null,
      parentB:        sb.parentB || null,
      speciated:      sb.speciated || false,
      fingerprint:    genomeFingerprint(sb.genome),
      isDuplicate:    false,
      isPhantom:      false,
      originalAuthor:   null,
      originalPermlink: null,
      originalCreated:  null,
      created:        p.created || ""
    });
  }
  results.sort((a, b) => (b.created > a.created ? 1 : -1));
  markDuplicates(results);
  return results;
}

// ============================================================
// STEEMBIOTA USER LEVEL SYSTEM
//
// Derives XP from on-chain activity and maps it to a named rank.
// Sources:
//   - Founder creatures published (type:"founder")  → 100 XP each
//   - Offspring bred and published (type:"offspring") → 500 XP each
//   - Feed replies sent (type:"feed")               → 10 XP each
//   - Unique genera contributed (distinct GEN values in own creatures) → 25 XP each
//   - Speciation event in own offspring             → 75 XP bonus each
//
// Ranks (cumulative XP thresholds):
//   0    Wanderer      🌿
//   100  Naturalist    🔬
//   300  Cultivator    🌱
//   700  Breeder       🐣
//   1500 Ecologist     🍃
//   3000 Evolutionist  🧬
//   6000 Progenitor    🌳
// ============================================================

const USER_RANKS = [
  { minXp: 6000, title: "Progenitor",   icon: "🌳" },
  { minXp: 3000, title: "Evolutionist", icon: "🧬" },
  { minXp: 1500, title: "Ecologist",    icon: "🍃" },
  { minXp:  700, title: "Breeder",      icon: "🐣" },
  { minXp:  300, title: "Cultivator",   icon: "🌱" },
  { minXp:  100, title: "Naturalist",   icon: "🔬" },
  { minXp:    0, title: "Wanderer",     icon: "🌿" },
];

function computeUserLevel(posts, comments, upvotedCreaturePermlinks = new Set()) {
  // posts    = result of fetchPostsByUser (top-level posts only)
  // comments = result of fetchUserComments (replies/comments)
  // upvotedCreaturePermlinks = Set of "author/permlink" strings for SteemBiota
  //   creature posts the user has upvoted (positive vote only, once per creature).
  const allItems  = [...(posts || []), ...(comments || [])];
  let founders    = 0;
  let offspring   = 0;
  let feedsGiven  = 0;
  let speciated   = 0;
  const genera    = new Set();

  for (const item of allItems) {
    let meta = {};
    try { meta = JSON.parse(item.json_metadata || "{}"); } catch {}
    const sb = meta.steembiota;
    if (!sb) continue;
    if (sb.type === "founder") {
      founders++;
      if (sb.genome) genera.add(sb.genome.GEN);
    } else if (sb.type === "offspring") {
      offspring++;
      if (sb.genome) genera.add(sb.genome.GEN);
      if (sb.speciated) speciated++;
    } else if (sb.type === "feed") {
      feedsGiven++;
    }
  }

  const upvotesGiven = upvotedCreaturePermlinks.size;

  const xpFounders   = founders     * 100;
  const xpOffspring  = offspring    * 500;
  const xpFeeds      = feedsGiven   * 10;
  const xpGenera     = genera.size  * 25;
  const xpSpeciation = speciated    * 75;
  const xpUpvotes    = upvotesGiven * 5;
  const totalXp      = xpFounders + xpOffspring + xpFeeds + xpGenera + xpSpeciation + xpUpvotes;

  const rank = USER_RANKS.find(r => totalXp >= r.minXp) || USER_RANKS[USER_RANKS.length - 1];
  const nextRank = USER_RANKS[USER_RANKS.indexOf(rank) - 1] || null;
  const progressToNext = nextRank
    ? Math.min((totalXp - rank.minXp) / (nextRank.minXp - rank.minXp), 1.0)
    : 1.0;

  return {
    totalXp,
    rank: rank.title,
    icon: rank.icon,
    nextRank: nextRank ? nextRank.title : null,
    nextRankIcon: nextRank ? nextRank.icon : null,
    nextRankXp: nextRank ? nextRank.minXp : null,
    progressToNext,
    breakdown: { founders, offspring, feedsGiven, upvotesGiven, genera: genera.size, speciated }
  };
}

// Breed two genomes into a child genome.
// Returns { child, mutated, speciated } for display purposes.
function breedGenomes(a, b) {
  if (a.GEN !== b.GEN) {
    throw new Error(
      "Genus mismatch: GEN " + a.GEN + " ≠ GEN " + b.GEN +
      ". Only same-genus creatures can breed."
    );
  }
  if (a.SX === b.SX) {
    const sexName = a.SX === 0 ? "Male" : "Female";
    throw new Error(
      "Sex mismatch: both creatures are " + sexName +
      ". Breeding requires one ♂ Male and one ♀ Female."
    );
  }

  const seed  = breedSeed(a, b);
  const rng   = makePrng(seed);
  const mCh   = mutationChance(a, b);

  // Gene inheritance closure — picks one parent's value then optionally mutates.
  // Sets didMutate = true the moment any mutation branch fires.
  // Draws rng() twice (pick + mutRoll), plus a third draw only when mutating.
  let didMutate = false;
  const i = (av, bv, range, min, max) => {
    const picked  = rng() < 0.5 ? av : bv;
    const mutRoll = rng();
    if (mutRoll < mCh) {
      didMutate = true;
      const shifted = picked + Math.floor(rng() * range * 2) - range;
      return Math.max(min, Math.min(max, Math.round(shifted)));
    }
    return Math.max(min, Math.min(max, Math.round(picked)));
  };

  // CLR-specific variant: hue is a circular quantity that wraps at 360°.
  // Clamping to [0, 359] would cause offspring of parents near 0°/359° to
  // pile up at the boundary instead of wrapping naturally across the seam.
  // We apply the mutation shift with modular arithmetic instead.
  const iHue = (av, bv, range) => {
    const picked  = rng() < 0.5 ? av : bv;
    const mutRoll = rng();
    if (mutRoll < mCh) {
      didMutate = true;
      const shift = Math.floor(rng() * range * 2) - range;
      return ((picked + shift) % 360 + 360) % 360;
    }
    return picked;
  };

  const child = {
    GEN:       a.GEN,                                   // same genus (may speciate below)
    SX:        Math.floor(rng() * 2),                   // 50/50 sex
    MOR:       i(a.MOR, b.MOR,  200, 0,    9999),
    APP:       i(a.APP, b.APP,  200, 0,    9999),
    ORN:       i(a.ORN, b.ORN,  200, 0,    9999),
    CLR:       iHue(a.CLR, b.CLR, 10),                 // hue — wraps mod 360, not clamped
    LIF:       i(a.LIF, b.LIF,   10, 40,    200),
    FRT_START: 0,   // recalculated below
    FRT_END:   0,
    // MUT: inherit the base value then apply a balanced ±1 nudge (20% up,
    // 20% down, 60% unchanged) so high-MUT lineages can recover over time
    // rather than ratcheting permanently to the cap of 5.
    MUT: Math.min(5, Math.max(0,
      i(a.MUT, b.MUT, 1, 0, 5) + (rng() < 0.2 ? 1 : rng() < 0.25 ? -1 : 0)
    ))
  };

  // Recalculate FRT bounds from child LIF
  child.FRT_START = Math.min(
    i(a.FRT_START, b.FRT_START, 5, 10, child.LIF - 10),
    child.LIF - 10
  );
  child.FRT_END = Math.min(
    i(a.FRT_END, b.FRT_END, 5, child.FRT_START + 5, child.LIF - 1),
    child.LIF - 1
  );

  // Speciation check — may change GEN to a new value
  const originalGEN = child.GEN;
  child.GEN = maybeSpeciate(rng, child.GEN);
  const speciated = child.GEN !== originalGEN;

  const mutated = speciated || didMutate;

  return { child, mutated, speciated };
}

// ============================================================
// STEEMBIOTA NAMING SYSTEM v3 — Mythic Binomial
//
// Genus   = PREFIX + CORE + ENDING   (driven by GEN, MOR, SX, APP, MUT)
// Species = ROOT + TITLE             (driven by ORN, CLR, MUT)
//
// Each pool is curated for mythical/biological feel.
// All selection is pure modulo — 100% deterministic, no RNG needed.
// ~5.3 million unique combinations; collision probability is negligible.
// ============================================================

const NAME_PREFIX = [
  "Aer","Aera","Aeral","Aether","Aeth",
  "Aur","Aure","Aural","Aurel",
  "Corv","Chron","Caly","Cy","Cyr",
  "Ferr","Grav","Harmo","Hex",
  "Igni","Kair","Lum","Lumi","Lyn",
  "Mnemo","Nyx","Ordin","Prism",
  "Pyro","Seraph","Syn","Tri",
  "Vael","Var","Veyr","Vire",
  "Volt","Vox","Zephyr","Zyph"
];

const NAME_CORE = [
  "a","ae","al","ar","ath",
  "el","en","er",
  "il","ir",
  "ix","yn","yx",
  "or","on","os",
  "ra","ri",
  "th","thor",
  "va","ve"
];

const NAME_ENDING = [
  "ix","yx","is","os","on",
  "ra","ris","ryn",
  "ex","el","ar","or",
  "eus","ion"
];

const NAME_ROOT = [
  "Volt","Vire","Corv","Aurel","Aether",
  "Lumin","Prism","Cipher","Quill",
  "Signal","Echo","Chron","Flux",
  "Gate","Sky","Thread","Strata",
  "Ledger","Ward","Spark","Ripple"
];

const NAME_TITLE = [
  "aris","archivist","whisper","crest",
  "lynx","spire","guard","wing",
  "tail","fox","wolf","claw",
  "mantis","warden","scribe",
  "howl","specter","paw",
  "drift","node","mind"
];

// Safe modulo — always returns a non-negative index even if n is negative.
function namePick(arr, n) {
  return arr[((n % arr.length) + arr.length) % arr.length];
}

// Public API — signature unchanged.
function generateFullName(g) {
  const prefix  = namePick(NAME_PREFIX,  g.GEN);
  const core    = namePick(NAME_CORE,    g.MOR + g.SX);
  const ending  = namePick(NAME_ENDING,  g.APP + g.MUT);
  const genus   = prefix + core + ending;

  const root    = namePick(NAME_ROOT,    g.ORN);
  const title   = namePick(NAME_TITLE,   g.CLR + g.MUT);
  const species = root + title;

  return genus[0].toUpperCase() + genus.slice(1) + " " + species;
}

// Stable genus name derived from GEN only — all other genes fixed to 0.
// Gives every genus a consistent identity regardless of individual creature genes.
function generateGenusName(gen) {
  const prefix = namePick(NAME_PREFIX, gen);
  const core   = namePick(NAME_CORE,   0);
  const ending = namePick(NAME_ENDING, 0);
  const raw    = prefix + core + ending;
  return raw[0].toUpperCase() + raw.slice(1);
}

// ============================================================
// STEEMBIOTA AGING SYSTEM (deterministic from block timestamp)
// ============================================================

// Returns age in whole days from a Steem post.created timestamp.
function calculateAge(birthTimestamp) {
  const now   = new Date();
  const birth = new Date(
    typeof birthTimestamp === "string" && !birthTimestamp.endsWith("Z")
      ? birthTimestamp + "Z"
      : birthTimestamp
  );
  const diffSeconds = (now - birth) / 1000;
  return Math.max(0, Math.floor(diffSeconds / 86400));
}

// Lifecycle stages defined as percentage thresholds of LIF (lifespan).
// Fossil is the post-death state beyond 100%.
const LIFECYCLE_STAGES = [
  { name: "Baby",        from: 0,    icon: "🥚", color: "#90caf9" },
  { name: "Toddler",     from: 0.05, icon: "🐣", color: "#80deea" },
  { name: "Child",       from: 0.12, icon: "🌿", color: "#a5d6a7" },
  { name: "Teenager",    from: 0.25, icon: "🌱", color: "#66bb6a" },
  { name: "Young Adult", from: 0.40, icon: "🌸", color: "#f48fb1" },
  { name: "Middle-Aged", from: 0.60, icon: "🍃", color: "#ffb74d" },
  { name: "Elder",       from: 0.80, icon: "🍂", color: "#ff8a65" },
  // Sentinel — age >= LIF means Fossil
  { name: "Fossil",      from: 1.00, icon: "🦴", color: "#666"    },
];

// Returns the full stage object for the creature's current age.
function getLifecycleStage(age, genome) {
  const pct = age / genome.LIF;
  // Walk backwards to find the highest threshold not exceeded
  for (let i = LIFECYCLE_STAGES.length - 1; i >= 0; i--) {
    if (pct >= LIFECYCLE_STAGES[i].from) return LIFECYCLE_STAGES[i];
  }
  return LIFECYCLE_STAGES[0];
}

function isFossil(age, genome) {
  return age >= genome.LIF;
}

// ============================================================
// STEEMBIOTA FEEDING SYSTEM
// Derives life-state bonuses from blockchain feed events.
// All logic is pure and deterministic — genome never changes.
// ============================================================

// FOOD_EFFECTS — static config, easy to extend for phase-2 types.
const FOOD_EFFECTS = {
  nectar:  { lifespanPerFeed: 1.0, fertilityBoost: 0.00, label: "Nectar",  emoji: "🍯" },
  fruit:   { lifespanPerFeed: 0.5, fertilityBoost: 0.10, label: "Fruit",   emoji: "🍎" },
  crystal: { lifespanPerFeed: 0.0, fertilityBoost: 0.05, label: "Crystal", emoji: "💎" },
};

// Feed-strength weights: owner feeds count 3×, community 1×.
const OWNER_FEED_WEIGHT     = 3;
const COMMUNITY_FEED_WEIGHT = 1;

// computeFeedState — pure function.
// feedEvents : result of parseFeedEvents() — { total, ownerFeeds, communityFeeds, byFeeder }
// genome     : genome object (used to derive the lifespan cap)
// Returns a feedState object consumed by renderers.
function computeFeedState(feedEvents, genome) {
  if (!feedEvents || feedEvents.total === 0) {
    return {
      weightedScore:  0,   // 0–(20*OWNER + 20*COMMUNITY) combined
      lifespanBonus:  0,   // extra days added to effective lifespan
      fertilityBoost: 0,   // additive fraction on fertility window chance
      healthPct:      0,   // 0.0–1.0 visual health level
      label:          "Unfed",
      symbol:         "·"  // unicode health indicator
    };
  }

  const { total, ownerFeeds, communityFeeds } = feedEvents;

  // Weighted score — drives visual health
  const weightedScore =
    ownerFeeds    * OWNER_FEED_WEIGHT +
    communityFeeds * COMMUNITY_FEED_WEIGHT;

  // Max possible score at cap (20 owner feeds = 60, or 20 community = 20)
  const maxScore = 20 * OWNER_FEED_WEIGHT;
  const healthPct = Math.min(weightedScore / maxScore, 1.0);

  // Lifespan bonus: +1 day per feed, capped at 20% of base LIF
  const maxLifespanBonus = Math.floor(genome.LIF * 0.20);
  const lifespanBonus    = Math.min(total, maxLifespanBonus);

  // Fertility boost: flat additive per community feed (owner feeds don't stack here)
  const fertilityBoost = Math.min(communityFeeds * 0.05, 0.25); // max +25%

  // Health label and unicode symbol
  let label, symbol;
  if      (healthPct >= 0.80) { label = "Thriving";  symbol = "✨"; }
  else if (healthPct >= 0.55) { label = "Well-fed";  symbol = "✦";  }
  else if (healthPct >= 0.30) { label = "Nourished"; symbol = "•";  }
  else if (healthPct >  0.00) { label = "Hungry";    symbol = "·";  }
  else                         { label = "Unfed";     symbol = "·";  }

  return { weightedScore, lifespanBonus, fertilityBoost, healthPct, label, symbol };
}

// ============================================================
// STEEMBIOTA UNICODE ART SYSTEM v3 — Side-profile silhouette
//
// Renders a side-facing quadruped matching the canvas renderer:
//   ears · head+snout+eye · torso · tail · four legs+paws
//   + optional mane, dorsal wing, ornament nodes, fertility sparkles
//
// All output is deterministic from the genome. Width grows with age.
// ============================================================

// ---- Glyph palettes ----
// Body fill — MOR % 6 selects a palette; [dense, mid, light] for top/mid/bottom rows
const UNI_BODY_FILLS = [
  ["▓","▒","░"],   // 0 dense shading
  ["█","▉","▊"],   // 1 solid blocks
  ["◆","◇","◈"],   // 2 diamond texture
  ["●","◉","○"],   // 3 dot texture
  ["▣","▤","▦"],   // 4 patterned blocks
  ["◼","◻","▪"],   // 5 mixed density
];
const UNI_TAIL_CHARS  = ["≋","∿","≈","~","⌇","∾"];  // MOR % 6
const UNI_ORN_CHARS   = ["✦","✧","✶","✹","❈","⬡"];  // ORN % 6
const UNI_EYE_CHARS   = ["◉","◎","⊛","⊙"];           // GEN % 4
const UNI_PAW_CHARS   = ["╨","┴","╩","∪"];           // APP % 4
const UNI_EAR_STYLES  = [" /\\", " /^", " /V", " ^^"]; // APP % 4
const UNI_SIGIL_CHARS = ["⟡","✶","❖","✦","◈","✧"];  // GEN % 6
const UNI_FOSSIL_BODY = ["▒","░","▓","╬","╪","╫"];   // GEN % 6
const UNI_FOSSIL_HEAD = ["☉","⊗","⊙","◎"];           // GEN % 4

// ---- Art width scales with lifecycle ----
function unicodeGridSize(pct) {
  if (pct < 0.05) return 14;
  if (pct < 0.12) return 18;
  if (pct < 0.25) return 24;
  if (pct < 0.50) return 30;
  if (pct < 0.80) return 36;
  if (pct < 1.00) return 30;
  return 24; // fossil
}

// ---- Mirror a single unicode art line (reverses char order) ----
// Used to flip the creature to face right instead of left.
function mirrorUnicodeLine(line) {
  // Split on grapheme boundaries as best we can in plain JS.
  // We use the spread operator which handles most multi-byte Unicode correctly.
  return [...line].reverse().join("");
}

// ---- Main builder ----
// pose       : "standing"|"alert"|"playful"|"sitting"|"sleeping" — defaults to "standing"
// facingRight: boolean — when true the creature faces right (mirrored).
function buildUnicodeArt(genome, age, feedState, facingRight = false, pose = "standing") {
  const effectiveLIF = genome.LIF + (feedState ? feedState.lifespanBonus : 0);
  const pct    = Math.min(age / Math.max(effectiveLIF, 1), 1.0);
  const fossil = pct >= 1.0;
  const W      = unicodeGridSize(pct);

  // Genome fractional values for continuous variation
  const morFrac = (genome.MOR % 1000) / 999;
  const appFrac = (genome.APP % 1000) / 999;
  const ornFrac = (genome.ORN % 1000) / 999;

  // ---- Glyph selection ----
  const fillPool = UNI_BODY_FILLS[genome.MOR % UNI_BODY_FILLS.length];
  const fillD    = fillPool[0];   // dense — main body interior
  const fillM    = fillPool[1];   // mid   — body edge / shading
  const fillL    = fillPool[2];   // light — belly / top outline row
  const tailChar = UNI_TAIL_CHARS[genome.MOR % UNI_TAIL_CHARS.length];
  const ornChar  = UNI_ORN_CHARS [genome.ORN % UNI_ORN_CHARS.length];
  const pawChar  = UNI_PAW_CHARS [genome.APP % UNI_PAW_CHARS.length];
  const earStyle = UNI_EAR_STYLES[genome.APP % UNI_EAR_STYLES.length];
  const sigil    = UNI_SIGIL_CHARS[genome.GEN % UNI_SIGIL_CHARS.length];
  const sex      = genome.SX === 0 ? "♂" : "♀";
  const fertile  = age >= genome.FRT_START && age < genome.FRT_END && !fossil;
  const hasMane  = (genome.ORN % 3) > 0;
  const hasWing  = (genome.APP % 5) === 0;   // ~20% of creatures have a dorsal wing
  const showEars = pct >= 0.08;

  // ---- Expression / eye glyph ----
  // Driven by pose first, then health state
  let eyeChar;
  if (pose === "sleeping") {
    eyeChar = "—";                          // closed eye arc
  } else if (pose === "alert") {
    eyeChar = "◎";                          // wide open
  } else if (pose === "playful") {
    eyeChar = "^";                          // excited arc
  } else if (feedState && feedState.healthPct >= 0.80) {
    eyeChar = "◉";                          // thriving — bright full eye
  } else if (feedState && feedState.healthPct >= 0.55) {
    eyeChar = UNI_EYE_CHARS[genome.GEN % UNI_EYE_CHARS.length]; // happy — genome eye
  } else if (feedState && feedState.healthPct < 0.30 && feedState.healthPct > 0) {
    eyeChar = "·";                          // hungry — small downcast dot
  } else if (feedState && feedState.healthPct === 0) {
    eyeChar = "ˇ";                          // sad — inverted arch
  } else {
    eyeChar = UNI_EYE_CHARS[genome.GEN % UNI_EYE_CHARS.length]; // default genome eye
  }

  // ---- Proportions (character columns) ----
  const headW   = Math.max(4, Math.round(W * (0.16 + morFrac * 0.06)));
  const bodyLen = Math.max(6, Math.round(W * (0.42 + morFrac * 0.14)));
  const tailLen = Math.max(3, Math.round(W * (0.20 + appFrac * 0.14)));

  // Layout: creature faces left, tail extends right
  const margin    = 1;
  const headStart = margin;
  const bodyStart = headStart + headW;
  const tailStart = bodyStart + bodyLen;
  const rowWidth  = tailStart + tailLen + 6;

  // ---- String helpers ----
  const sp  = n => " ".repeat(Math.max(0, n));
  const rep = (c, n) => { let s = ""; for (let i = 0; i < Math.max(0, n); i++) s += c; return s; };
  const pad = (s, n) => s.length >= n ? s.slice(0, n) : s + sp(n - s.length);
  const setCol = (arr, col, ch) => { if (col >= 0 && col < arr.length) arr[col] = ch; };

  // Anatomy counts — base for standing; poses override below
  const bodyRows = pct < 0.05 ? 2 : pct < 0.12 ? 3 : pct < 0.4 ? 4 : 5;
  const legH     = pct >= 0.12 ? 2 : 0;
  const ornCol   = Math.round(bodyLen * (0.30 + ornFrac * 0.42));

  const lines = [];

  // ============================================================
  // FOSSIL — flat impression, same for all poses
  // ============================================================
  if (fossil) {
    const fc = UNI_FOSSIL_BODY[genome.GEN % UNI_FOSSIL_BODY.length];
    const fh = UNI_FOSSIL_HEAD[genome.GEN % UNI_FOSSIL_HEAD.length];
    lines.push(sp(headStart) + fh);
    for (let r = 0; r < 3; r++) lines.push(sp(headStart) + rep(fc, headW + bodyLen));
    lines.push("");
    lines.push(" 🦴 Fossil — genome preserved on-chain");
    const bodyLines = facingRight ? lines.map(mirrorUnicodeLine) : lines;
    const header = sigil + sex + " 🦴";
    return header + "\n" + bodyLines.join("\n");
  }

  // ============================================================
  // Helper: build one body row string
  // ============================================================
  function bodyRow(r, totalRows, eyeOverride) {
    const isTop    = r === 0;
    const isBottom = r === totalRows - 1;
    const isMid    = r === Math.floor(totalRows / 2);
    const headRows = Math.max(1, totalRows - 2);
    const headTop  = Math.floor((totalRows - headRows) / 2);
    const hasHead  = r >= headTop && r < headTop + headRows;
    const isEyeRow = hasHead && (r === headTop + Math.floor(headRows / 2));

    const rowD = isTop || isBottom ? fillM : fillD;
    const rowL = isTop ? fillL : isBottom ? fillL : fillM;

    let line = sp(margin);

    // Head
    if (hasHead) {
      if (isEyeRow) {
        const ey = eyeOverride || eyeChar;
        line += pad("." + ey + rep(rowD, Math.max(0, headW - 3)) + ")", headW);
      } else {
        line += rep(rowL, headW);
      }
    } else {
      line += sp(headW);
    }

    // Body
    let bodySeg = "";
    for (let c = 0; c < bodyLen; c++) {
      const isEdge = (c === 0 || c === bodyLen - 1);
      if (isMid && pct >= 0.40 && c === ornCol) bodySeg += ornChar;
      else bodySeg += isEdge ? rowL : rowD;
    }
    line += bodySeg;
    return { line, isMid, isTop, isBottom };
  }

  // ============================================================
  // SLEEPING — body flat on ground, no ears, eye closed, legs as pads
  // ============================================================
  if (pose === "sleeping") {
    // One flat body row, head resting on ground level
    const flatRows = Math.max(1, Math.round(bodyRows * 0.5));
    for (let r = 0; r < flatRows; r++) {
      const { line } = bodyRow(r, flatRows, "—");
      // Tail wraps under — rendered as a short curl on bottom right of body
      const tailCurl = r === flatRows - 1
        ? sp(Math.round(tailLen * 0.3)) + rep(tailChar, Math.round(tailLen * 0.5)) + "ↄ"
        : "";
      lines.push(line + tailCurl);
    }
    // Legs as flat pads — all four compressed into one row
    if (legH > 0) {
      const padRow = Array(rowWidth).fill(" ");
      const legCols = [
        headStart + Math.round(headW * 0.30),
        headStart + Math.round(headW * 0.80),
        bodyStart + Math.round(bodyLen * 0.28),
        bodyStart + Math.round(bodyLen * 0.70),
      ];
      for (const col of legCols) setCol(padRow, col, pawChar);
      lines.push(padRow.join("").trimEnd());
    }

  // ============================================================
  // ALERT — head lifted high, ears prominent, tail swept straight up
  // ============================================================
  } else if (pose === "alert") {
    // Extra blank line above ears to suggest raised head posture
    lines.push(sp(headStart) + "  ↑");   // tail-up indicator above
    if (showEars) {
      let earRow = sp(headStart) + earStyle;
      if (hasMane && pct >= 0.25) earRow = pad(earRow, bodyStart) + rep("'", Math.round(bodyLen * 0.45));
      lines.push(earRow);
    }
    if (hasWing && pct >= 0.4) {
      const wOff = bodyStart + Math.round(bodyLen * 0.28);
      lines.push(sp(wOff) + rep("^", Math.round(bodyLen * 0.35)));
    }
    for (let r = 0; r < bodyRows; r++) {
      const { line, isTop } = bodyRow(r, bodyRows);
      // Tail: swept upward — appears only on the TOP row (instead of mid)
      const tailSeg = isTop
        ? rep("↑", Math.round(tailLen * 0.6)) + rep(tailChar, Math.round(tailLen * 0.4))
        : sp(tailLen);
      lines.push(line + tailSeg);
    }
    if (legH > 0) {
      const legCols = [
        headStart + Math.round(headW * 0.30),
        headStart + Math.round(headW * 0.82),
        bodyStart + Math.round(bodyLen * 0.26),
        bodyStart + Math.round(bodyLen * 0.72),
      ];
      for (let lr = 0; lr < legH; lr++) {
        const chars = Array(rowWidth).fill(" ");
        for (const col of legCols) setCol(chars, col, lr === legH - 1 ? pawChar : "|");
        lines.push(chars.join("").trimEnd());
      }
    }

  // ============================================================
  // PLAYFUL — play-bow: front low, rear high, tail up, orbs scattered
  // ============================================================
  } else if (pose === "playful") {
    if (showEars) {
      // Ears skewed to the rear (body high end)
      const rearEarOff = bodyStart + Math.round(bodyLen * 0.15);
      lines.push(sp(rearEarOff) + earStyle);
    }
    // Rear of body elevated — extra row at back only
    const rearElevRow = Array(rowWidth).fill(" ");
    for (let c = bodyStart + Math.round(bodyLen * 0.4); c < bodyStart + bodyLen; c++) rearElevRow[c] = fillM;
    rearElevRow[bodyStart + bodyLen - 1] = "↑"; // tail base
    lines.push(rearElevRow.join("").trimEnd());

    for (let r = 0; r < bodyRows; r++) {
      const { line, isMid, isTop } = bodyRow(r, bodyRows);
      // Tail high on top row
      const tailSeg = isTop
        ? rep("↑", Math.round(tailLen * 0.7)) + rep(ornChar, 1)
        : isMid
          ? rep(tailChar, tailLen)
          : sp(tailLen);
      lines.push(line + tailSeg);
    }
    // Front legs stretched forward and low (extra row below body)
    if (legH > 0) {
      // Front legs only in the extra low row
      const stretchRow = Array(rowWidth).fill(" ");
      const fL1 = headStart + Math.round(headW * 0.20);
      const fL2 = headStart + Math.round(headW * 0.70);
      setCol(stretchRow, fL1, pawChar);
      setCol(stretchRow, fL2, pawChar);
      lines.push(stretchRow.join("").trimEnd());
      // Back legs normal
      const backRow = Array(rowWidth).fill(" ");
      setCol(backRow, bodyStart + Math.round(bodyLen * 0.26), "|");
      setCol(backRow, bodyStart + Math.round(bodyLen * 0.72), "|");
      lines.push(backRow.join("").trimEnd());
      const backPawRow = Array(rowWidth).fill(" ");
      setCol(backPawRow, bodyStart + Math.round(bodyLen * 0.26), pawChar);
      setCol(backPawRow, bodyStart + Math.round(bodyLen * 0.72), pawChar);
      lines.push(backPawRow.join("").trimEnd());
    }
    // Scattered orbs on the playful row (excitement sparkles)
    if (pct >= 0.40) {
      const orbCount = 2 + Math.floor(ornFrac * 3);
      lines.push(sp(bodyStart) + Array.from({length: orbCount}, (_, i) =>
        sp(Math.round(bodyLen * (0.1 + i * 0.22))) + ornChar
      ).join(""));
    }

  // ============================================================
  // SITTING — rear down, haunches compressed, tail wrapped under
  // ============================================================
  } else if (pose === "sitting") {
    if (showEars) {
      let earRow = sp(headStart) + earStyle;
      if (hasMane && pct >= 0.25) earRow = pad(earRow, bodyStart) + rep("'", Math.round(bodyLen * 0.45));
      lines.push(earRow);
    }
    if (hasWing && pct >= 0.4) {
      const wOff = bodyStart + Math.round(bodyLen * 0.28);
      lines.push(sp(wOff) + rep("^", Math.round(bodyLen * 0.35)));
    }
    // Upper body rows (head + front half) — normal
    const upperRows = Math.max(2, Math.ceil(bodyRows * 0.55));
    for (let r = 0; r < upperRows; r++) {
      const { line, isMid } = bodyRow(r, bodyRows);
      const tailSeg = isMid ? rep(tailChar, Math.round(tailLen * 0.5)) : sp(tailLen);
      lines.push(line + tailSeg);
    }
    // Haunches — two compressed rows at the rear half of the body, no tail (wrapped)
    const haunchRow1 = Array(rowWidth).fill(" ");
    const haunchRow2 = Array(rowWidth).fill(" ");
    const haunchStart = bodyStart + Math.round(bodyLen * 0.45);
    const haunchEnd   = bodyStart + bodyLen;
    for (let c = haunchStart; c < haunchEnd; c++) { haunchRow1[c] = fillD; haunchRow2[c] = fillM; }
    // Tail curled under — short wrap chars after haunch
    const wrapStart = haunchEnd;
    for (let c = 0; c < Math.round(tailLen * 0.6); c++) {
      setCol(haunchRow2, wrapStart + c, tailChar);
    }
    setCol(haunchRow2, wrapStart + Math.round(tailLen * 0.6), "ↄ");
    lines.push(haunchRow1.join("").trimEnd());
    lines.push(haunchRow2.join("").trimEnd());
    // Front legs straight, rear legs folded (short stubs)
    if (legH > 0) {
      const frontLeg1 = headStart + Math.round(headW * 0.30);
      const frontLeg2 = headStart + Math.round(headW * 0.82);
      const rearHaunch1 = haunchStart + Math.round((haunchEnd - haunchStart) * 0.30);
      const rearHaunch2 = haunchStart + Math.round((haunchEnd - haunchStart) * 0.70);
      for (let lr = 0; lr < legH; lr++) {
        const chars = Array(rowWidth).fill(" ");
        setCol(chars, frontLeg1, lr === legH - 1 ? pawChar : "|");
        setCol(chars, frontLeg2, lr === legH - 1 ? pawChar : "|");
        // Rear: just paw nubs, no vertical legs (haunches rest on ground)
        if (lr === legH - 1) {
          setCol(chars, rearHaunch1, pawChar);
          setCol(chars, rearHaunch2, pawChar);
        }
        lines.push(chars.join("").trimEnd());
      }
    }

  // ============================================================
  // STANDING — original layout (default)
  // ============================================================
  } else {
    if (showEars) {
      let earRow = sp(headStart) + earStyle;
      if (hasMane && pct >= 0.25) earRow = pad(earRow, bodyStart) + rep("'", Math.round(bodyLen * 0.45));
      lines.push(earRow);
    }
    if (hasWing && pct >= 0.4) {
      const wOff = bodyStart + Math.round(bodyLen * 0.28);
      lines.push(sp(wOff) + rep("^", Math.round(bodyLen * 0.35)));
    }
    for (let r = 0; r < bodyRows; r++) {
      const { line, isMid, isTop } = bodyRow(r, bodyRows);
      let tailSeg;
      if (isMid) {
        tailSeg = rep(tailChar, tailLen);
        if (pct >= 0.40) {
          const orbCount = 1 + Math.floor(ornFrac * 3);
          for (let o = 0; o < orbCount; o++) tailSeg += " " + ornChar;
        }
      } else {
        const distFromMid = Math.abs(r - Math.floor(bodyRows / 2));
        const taper = 1 - (distFromMid / Math.ceil(bodyRows / 2)) * 0.65;
        const tLen  = Math.round(tailLen * taper);
        tailSeg = sp(tailLen - tLen) + rep(tailChar, tLen);
        if (isTop && pct >= 0.40 && (fertile || (feedState && feedState.healthPct >= 0.55))) {
          tailSeg += " " + ornChar;
        }
      }
      lines.push(line + tailSeg);
    }
    if (legH > 0) {
      const legCols = [
        headStart + Math.round(headW * 0.30),
        headStart + Math.round(headW * 0.82),
        bodyStart + Math.round(bodyLen * 0.26),
        bodyStart + Math.round(bodyLen * 0.72),
      ];
      for (let lr = 0; lr < legH; lr++) {
        const chars = Array(rowWidth).fill(" ");
        for (const col of legCols) setCol(chars, col, lr === legH - 1 ? pawChar : "|");
        lines.push(chars.join("").trimEnd());
      }
    }
  }

  // ---- HEADER line (sigil · sex · health · fertile sparkles) ----
  const healthSym = feedState && feedState.healthPct > 0 ? feedState.symbol + " " : "";
  // Pose accent in header
  const poseAccent = {
    alert:    " 👀",
    playful:  " 🎉",
    sitting:  " 🪑",
    sleeping: " 💤",
    standing: ""
  }[pose] || "";
  const header = fertile
    ? "✦ " + sigil + sex + poseAccent + " ✦"
    : healthSym + sigil + sex + poseAccent;

  // ---- Mirror all lines when facingRight ----
  const bodyLines = facingRight ? lines.map(mirrorUnicodeLine) : lines;

  return header + "\n" + bodyLines.join("\n");
}
// ============================================================
// ROUTE VIEWS
// ============================================================

// ---- HomeView ----
const HomeView = {
  name: "HomeView",
  inject: ["username", "hasKeychain", "notify"],
  components: {
    CreatureCanvasComponent,
    CreatureCardComponent,
    GenomeTableComponent,
    LoadingSpinnerComponent,
    BreedingPanelComponent
  },
  data() {
    return {
      // Founder creation
      genome:         null,
      unicodeArt:     "",
      publishing:     false,
      birthTimestamp: null,
      now:            new Date(),
      feedState:      null,
      customTitle:    "",
      facingRight:    false,
      genusInput:     "",      // user-specified genus (0–999), blank = random
      // All-creatures list + filters
      allCreatures:  [],
      listLoading:   true,
      listError:     "",
      listPage:      1,
      filterGenus:   "",       // "" = all, otherwise genus number as string
      filterSex:     "",       // "" = all, "0" = male, "1" = female
      filterAgeOp:   "",       // "" = off, "<" | "=" | ">"
      filterAgeVal:  ""        // numeric string
    };
  },
  created() {
    this._ageTicker = setInterval(() => { this.now = new Date(); }, 60000);
    this.loadCreatureList();
  },
  beforeUnmount() {
    clearInterval(this._ageTicker);
  },
  computed: {
    creatureName()   { return this.genome ? generateFullName(this.genome) : null; },
    sexLabel()       { return this.genome ? (this.genome.SX === 0 ? "♂ Male" : "♀ Female") : ""; },
    age() {
      if (!this.birthTimestamp) return 0;
      return Math.max(0, Math.floor((this.now - new Date(this.birthTimestamp)) / 86400000));
    },
    lifecycleStage() { return this.genome ? getLifecycleStage(this.age, this.genome) : null; },
    fossil() {
      if (!this.genome) return false;
      return this.age >= this.genome.LIF + (this.feedState ? this.feedState.lifespanBonus : 0);
    },
    lifecycleColor() { return this.lifecycleStage ? this.lifecycleStage.color : "#888"; },
    lifecycleIcon()  { return this.lifecycleStage ? this.lifecycleStage.icon  : "";    },
    genusInputValid() {
      if (this.genusInput === "") return true;   // blank = random, always ok
      const n = Number(this.genusInput);
      return Number.isInteger(n) && n >= 0 && n <= 999;
    },
    availableGenera() {
      const set = new Set(this.allCreatures.map(c => c.genome.GEN));
      return [...set].sort((a, b) => a - b).map(g => ({ id: g, name: generateGenusName(g) }));
    },
    filteredCreatures() {
      const ageVal = this.filterAgeVal !== "" ? Number(this.filterAgeVal) : null;
      return this.allCreatures.filter(c => {
        if (this.filterGenus !== "" && c.genome.GEN !== Number(this.filterGenus)) return false;
        if (this.filterSex   !== "" && c.genome.SX  !== Number(this.filterSex))   return false;
        if (ageVal !== null && !isNaN(ageVal) && this.filterAgeOp !== "") {
          if (this.filterAgeOp === "<" && !(c.age <  ageVal)) return false;
          if (this.filterAgeOp === "=" && !(c.age === ageVal)) return false;
          if (this.filterAgeOp === ">" && !(c.age >  ageVal)) return false;
        }
        return true;
      });
    },
    totalPages()    { return Math.max(1, Math.ceil(this.filteredCreatures.length / PAGE_SIZE)); },
    pagedCreatures() {
      const s = (this.listPage - 1) * PAGE_SIZE;
      return this.filteredCreatures.slice(s, s + PAGE_SIZE);
    }
  },
  watch: {
    age(v)        { if (this.genome) this.unicodeArt = buildUnicodeArt(this.genome, v, this.feedState, this.facingRight, "standing"); },
    feedState(fs) { if (this.genome) this.unicodeArt = buildUnicodeArt(this.genome, this.age, fs, this.facingRight, "standing"); },
    filterGenus()  { this.listPage = 1; },
    filterSex()    { this.listPage = 1; },
    filterAgeOp()  { this.listPage = 1; },
    filterAgeVal() { this.listPage = 1; }
  },
  methods: {
    async loadCreatureList() {
      const cacheKey  = "steembiota:list:creatures:v1";
      const cachedRaw = readListCache(cacheKey);
      if (cachedRaw) {
        this.allCreatures = parseSteembiotaPosts(cachedRaw);
        this.listLoading = false;
      } else {
        this.listLoading = true;
      }
      this.listError   = "";
      try {
        const raw = await fetchPostsByTag("steembiota", 100);
        const safeRaw = Array.isArray(raw) ? raw : [];
        this.allCreatures = parseSteembiotaPosts(safeRaw);
        writeListCache(cacheKey, safeRaw);
      } catch (e) {
        if (!cachedRaw) this.listError = e.message || "Failed to load creatures.";
      }
      this.listLoading = false;
    },
    createFounder() {
      if (!this.username) { this.notify("Please log in first.", "error"); return; }
      if (!this.genusInputValid) { this.notify("Genus must be a whole number from 0 to 999.", "error"); return; }
      this.birthTimestamp = new Date().toISOString();
      this.genome         = generateGenome();
      // Override GEN if the user specified one
      if (this.genusInput !== "") this.genome.GEN = Number(this.genusInput);
      this.facingRight    = Math.random() < 0.5;
      this.feedState      = null;
      this.unicodeArt     = buildUnicodeArt(this.genome, 0, null, this.facingRight, "standing");
      this.customTitle    = buildDefaultTitle(generateFullName(this.genome), new Date(this.birthTimestamp));
    },
    async publishCreature() {
      if (!this.username)         { this.notify("Please log in first.", "error"); return; }
      if (!this.genome)           { this.notify("Create a creature first.", "error"); return; }
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      this.publishing = true;
      publishCreature(this.username, this.genome, this.unicodeArt, this.creatureName, this.age, this.lifecycleStage.name, this.customTitle, generateGenusName(this.genome.GEN), (response) => {
        this.publishing = false;
        if (response.success) {
          invalidateGlobalListCaches();
          invalidateOwnedCachesForUser(this.username);
          this.notify("🌿 " + this.creatureName + " published to the blockchain!", "success");
          this.$router.push("/@" + this.username + "/" + response.permlink);
        } else {
          this.notify("Publish failed: " + (response.message || "Unknown error"), "error");
        }
      });
    },
    prevPage() { if (this.listPage > 1) this.listPage--; },
    nextPage() { if (this.listPage < this.totalPages) this.listPage++; },
    generateGenusName,
    onFacingResolved(dir) {
      this.facingRight = dir;
      if (this.genome) this.unicodeArt = buildUnicodeArt(this.genome, this.age, this.feedState, dir, "standing");
    }
  },

  template: `
    <div style="margin-top:20px;padding:0 16px;">

      <!-- Founder creation — visible to any logged-in user -->
      <div v-if="username">
        <div style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:8px;">
          <label style="font-size:13px;color:#888;">Genus (0–999, blank = random):</label>
          <input
            v-model="genusInput"
            type="number"
            min="0" max="999" step="1"
            placeholder="random"
            style="width:90px;font-size:13px;padding:5px 8px;"
            @keydown.enter="createFounder"
          />
          <span v-if="genusInputValid && genusInput !== ''" style="font-size:12px;color:#66bb6a;font-style:italic;">
            {{ generateGenusName(Number(genusInput)) }}
          </span>
          <button @click="createFounder" :disabled="!genusInputValid">🌱 Create Founder Creature</button>
        </div>

        <div v-if="creatureName" style="margin:16px 0 6px;">
          <div style="font-size:1.3rem;font-weight:bold;color:#a5d6a7;">🧬 {{ creatureName }}</div>
          <div style="font-size:0.9rem;color:#888;margin-top:2px;">{{ sexLabel }}</div>
        </div>

        <creature-canvas-component v-if="genome" :genome="genome" :age="age" :fossil="fossil" :feed-state="feedState"
          @facing-resolved="onFacingResolved"
        ></creature-canvas-component>
        <div v-if="fossil" style="margin:6px 0;color:#666;font-size:0.85rem;">🦴 Fossilised. Genome preserved on-chain.</div>

        <div v-if="genome">
          <h3 style="color:#a5d6a7;margin:16px 0 4px;">Genome</h3>
          <genome-table-component :genome="genome"></genome-table-component>
          <h3 style="color:#a5d6a7;margin:16px 0 4px;">Unicode Render</h3>
          <pre :style="fossil ? { color:'#444', opacity:'0.6' } : {}">{{ unicodeArt }}</pre>
          <div style="margin-top:16px;max-width:520px;margin-left:auto;margin-right:auto;">
            <label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">Post title</label>
            <input v-model="customTitle" type="text" maxlength="255" style="width:100%;font-size:13px;"/>
          </div>
          <br/>
          <button @click="publishCreature" :disabled="publishing||!username" style="background:#1565c0;">
            {{ publishing ? "Publishing…" : "📡 Publish to Steem" }}
          </button>
          <p v-if="!username" style="color:#888;font-size:13px;margin:4px 0;">Log in to publish.</p>
        </div>
        <hr/>
      </div>

      <!-- Breed panel -->
      <breeding-panel-component
        :username="username"
        @notify="(msg,type) => notify(msg,type)"
      ></breeding-panel-component>

      <hr/>

      <!-- ── All Creatures ── -->
      <h3 style="color:#a5d6a7;margin:18px 0 12px;font-size:1rem;letter-spacing:0.04em;">
        🌿 All Creatures
        <span v-if="!listLoading && !listError" style="font-size:0.75rem;color:#555;font-weight:normal;margin-left:8px;">
          ({{ filteredCreatures.length }}{{ filteredCreatures.length !== allCreatures.length ? ' of ' + allCreatures.length : '' }} total)
        </span>
      </h3>

      <loading-spinner-component v-if="listLoading"></loading-spinner-component>
      <div v-else-if="listError" style="color:#ff8a80;font-size:13px;">⚠ {{ listError }}</div>
      <div v-else-if="allCreatures.length === 0" style="color:#555;font-size:13px;">No creatures published yet.</div>

      <template v-else>
        <!-- Filters -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:center;margin-bottom:14px;">
          <select
            v-model="filterGenus"
            style="padding:5px 8px;font-size:13px;background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:6px;font-family:monospace;"
          >
            <option value="">All genera</option>
            <option v-for="g in availableGenera" :key="g.id" :value="String(g.id)">{{ g.name }} ({{ g.id }})</option>
          </select>
          <div style="display:flex;gap:4px;">
            <button
              @click="filterSex = ''"
              :style="{ padding:'4px 10px', fontSize:'12px', background: filterSex==='' ? '#2e7d32' : '#1a1a1a', color: filterSex==='' ? '#fff' : '#888', border:'1px solid #333', borderRadius:'6px' }"
            >All</button>
            <button
              @click="filterSex = '0'"
              :style="{ padding:'4px 10px', fontSize:'12px', background: filterSex==='0' ? '#1565c0' : '#1a1a1a', color: filterSex==='0' ? '#90caf9' : '#888', border:'1px solid #333', borderRadius:'6px' }"
            >♂ Male</button>
            <button
              @click="filterSex = '1'"
              :style="{ padding:'4px 10px', fontSize:'12px', background: filterSex==='1' ? '#880e4f' : '#1a1a1a', color: filterSex==='1' ? '#f48fb1' : '#888', border:'1px solid #333', borderRadius:'6px' }"
            >♀ Female</button>
          </div>
          <!-- Age filter -->
          <div style="display:flex;gap:4px;align-items:center;">
            <span style="font-size:12px;color:#555;">Age</span>
            <button
              v-for="op in ['<','=','>']" :key="op"
              @click="filterAgeOp = (filterAgeOp === op ? '' : op)"
              :style="{ padding:'4px 8px', fontSize:'12px', fontFamily:'monospace', background: filterAgeOp===op ? '#4a3000' : '#1a1a1a', color: filterAgeOp===op ? '#ffb74d' : '#888', border:'1px solid #333', borderRadius:'6px' }"
            >{{ op }}</button>
            <input
              v-model="filterAgeVal"
              type="number"
              min="0"
              placeholder="days"
              style="width:64px;padding:4px 6px;font-size:12px;background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:6px;font-family:monospace;"
            />
            <button
              v-if="filterAgeOp || filterAgeVal"
              @click="filterAgeOp=''; filterAgeVal=''"
              style="padding:4px 7px;font-size:11px;background:#1a1a1a;color:#555;border:1px solid #333;border-radius:6px;"
              title="Clear age filter"
            >✕</button>
          </div>
        </div>

        <div v-if="filteredCreatures.length === 0" style="color:#555;font-size:13px;margin:12px 0;">
          No creatures match the current filter.
        </div>
        <template v-else>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px;max-width:920px;margin:0 auto;">
          <div
            v-for="c in pagedCreatures"
            :key="c.author + '/' + c.permlink"
            style="position:relative;"
          >
            <creature-card-component :post="c" :username="username"></creature-card-component>
            <div
              v-if="c.effectiveOwner && c.effectiveOwner !== c.author"
              style="position:absolute;bottom:6px;left:6px;
                     font-size:0.62rem;padding:2px 6px;border-radius:8px;
                     background:#0d1a0d;border:1px solid #2e7d32;color:#66bb6a;
                     pointer-events:none;"
            >🤝 transferred</div>
          </div>
        </div>

        <div v-if="totalPages > 1" style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:14px;">
          <button @click="prevPage" :disabled="listPage === 1" style="padding:5px 14px;background:#1a2a1a;">◀ Prev</button>
          <span style="font-size:13px;color:#555;">{{ listPage }} / {{ totalPages }}</span>
          <button @click="nextPage" :disabled="listPage === totalPages" style="padding:5px 14px;background:#1a2a1a;">Next ▶</button>
        </div>
        </template>
      </template>

    </div>
  `
};

// ---- AboutView ----
// Fetches README.md from the GitHub repo and renders it as styled HTML.
const AboutView = {
  name: "AboutView",
  components: { LoadingSpinnerComponent },
  data() { return { html: "", loading: true, loadError: "" }; },
  async created() {
    try {
      const res = await fetch(
        "https://raw.githubusercontent.com/puncakbukit/steembiota/main/README.md"
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
      this.html = this.mdToHtml(await res.text());
    } catch (e) {
      this.loadError = e.message || "Could not load documentation.";
    }
    this.loading = false;
  },
  methods: {
    // Minimal Markdown → HTML (no library needed).
    // Handles: h1/h2/h3, bold, italic, inline code, fenced code blocks,
    // links, unordered lists, ordered lists, tables, hr, paragraphs.
    mdToHtml(md) {
      const esc    = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const inline = s => s
        .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
        .replace(/`([^`]+)`/g, "<code style='background:#0a0a0a;padding:1px 5px;border-radius:3px;font-size:0.88em;color:#80deea;'>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong style='color:#eee;'>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener" style="color:#80deea;">$1</a>');

      const lines   = md.split("\n");
      const out     = [];
      let inCode    = false, codeBuf = [];
      let inList    = false, listOl  = false, listBuf = [];
      let inTable   = false, tRows   = [];

      const flushList = () => {
        if (!inList) return;
        const tag = listOl ? "ol" : "ul";
        out.push(`<${tag} style="text-align:left;color:#aaa;padding-left:22px;margin:6px 0;">`);
        listBuf.forEach(li => out.push(`<li style="margin:2px 0;">${inline(li)}</li>`));
        out.push(`</${tag}>`);
        inList = false; listBuf = [];
      };

      const flushTable = () => {
        if (!inTable) return;
        out.push('<div style="overflow-x:auto;margin:10px 0;"><table style="border-collapse:collapse;font-size:13px;color:#ccc;text-align:left;min-width:320px;">');
        tRows.forEach((cells, ri) => {
          out.push("<tr>");
          cells.forEach(cell => {
            const tag = ri === 0 ? "th" : "td";
            const sty = ri === 0
              ? "padding:5px 14px;border-bottom:1px solid #2e7d32;color:#a5d6a7;font-weight:bold;white-space:nowrap;"
              : "padding:4px 14px;border-bottom:1px solid #1e1e1e;";
            out.push(`<${tag} style="${sty}">${inline(cell.trim())}</${tag}>`);
          });
          out.push("</tr>");
        });
        out.push("</table></div>");
        inTable = false; tRows = [];
      };

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];

        // Fenced code block
        if (raw.startsWith("```")) {
          if (!inCode) {
            flushList(); flushTable();
            inCode = true; codeBuf = [];
          } else {
            out.push(`<pre style="background:#0a0a0a;border:1px solid #1e2e1e;border-radius:6px;
              padding:12px 16px;text-align:left;font-size:12px;overflow-x:auto;
              margin:8px 0;color:#a5d6a7;line-height:1.5;"><code>${esc(codeBuf.join("\n"))}</code></pre>`);
            inCode = false;
          }
          continue;
        }
        if (inCode) { codeBuf.push(raw); continue; }

        // Table row
        if (raw.includes("|") && raw.trim().startsWith("|")) {
          flushList();
          const cells = raw.trim().replace(/^\||\|$/g,"").split("|");
          // Skip separator rows like |---|---|
          if (cells.every(c => /^[-: ]+$/.test(c.trim()))) continue;
          if (!inTable) inTable = true;
          tRows.push(cells);
          continue;
        }
        if (inTable) flushTable();

        // Headings
        if (/^### /.test(raw)) {
          flushList();
          out.push(`<h3 style="color:#66bb6a;margin:14px 0 4px;font-size:0.97rem;">${inline(raw.slice(4))}</h3>`);
          continue;
        }
        if (/^## /.test(raw)) {
          flushList();
          out.push(`<h2 style="color:#80deea;margin:20px 0 5px;font-size:1.1rem;border-bottom:1px solid #1a2a1a;padding-bottom:4px;">${inline(raw.slice(3))}</h2>`);
          continue;
        }
        if (/^# /.test(raw)) {
          flushList();
          out.push(`<h1 style="color:#a5d6a7;margin:0 0 8px;font-size:1.4rem;">${inline(raw.slice(2))}</h1>`);
          continue;
        }

        // Horizontal rule
        if (/^---+$/.test(raw.trim())) {
          flushList();
          out.push('<hr style="border:none;border-top:1px solid #1e2e1e;margin:16px 0;">');
          continue;
        }

        // Unordered list
        const ulM = raw.match(/^[-*+] (.+)/);
        if (ulM) {
          if (!inList || listOl)  { flushList(); inList = true; listOl = false; }
          listBuf.push(ulM[1]);
          continue;
        }

        // Ordered list
        const olM = raw.match(/^\d+\. (.+)/);
        if (olM) {
          if (!inList || !listOl) { flushList(); inList = true; listOl = true; }
          listBuf.push(olM[1]);
          continue;
        }

        flushList();

        // Blank line → spacing
        if (raw.trim() === "") { out.push('<div style="height:6px;"></div>'); continue; }

        // Paragraph
        out.push(`<p style="color:#ccc;margin:4px 0;line-height:1.75;">${inline(raw)}</p>`);
      }

      flushList(); flushTable();
      return out.join("\n");
    }
  },
  template: `
    <div style="margin:20px auto;max-width:720px;padding:0 20px 40px;text-align:left;">
      <loading-spinner-component v-if="loading"></loading-spinner-component>
      <div v-else-if="loadError" style="color:#ff8a80;margin-top:24px;">
        ⚠ {{ loadError }}
      </div>
      <div v-else v-html="html"></div>
    </div>
  `
};

// ---- ProfileView ----
// Two tabs: Creatures (owned via transfer chain) and Accessories (owned via transfer chain).
const ProfileView = {
  name: "ProfileView",
  inject: ["username", "notify"],
  components: { CreatureCardComponent, AccessoryCardComponent, LoadingSpinnerComponent },
  data() {
    return {
      activeTab:    "creatures",   // "creatures" | "accessories"
      // Creatures tab
      creatures:    [],
      creaturesLoading: true,
      creaturesError:   "",
      crePage:      1,
      filterGenus:  "",
      filterSex:    "",
      filterAgeOp:  "",
      filterAgeVal: "",
      // Accessories tab
      accessories:      [],
      accessoriesLoading: true,
      accessoriesError:   "",
      accPage:      1,
      filterTemplate: "",
      accTemplates: ACCESSORY_TEMPLATES,
    };
  },

  async created() {
    const user = this.$route.params.user;
    // Load both tabs in parallel — await so errors surface and Vue
    // reactivity picks up the results correctly.
    await Promise.all([
      this.loadCreatures(user),
      this.loadAccessories(user),
    ]);
  },

  computed: {
    profileUser()  { return this.$route.params.user; },

    // ── Creatures ──
    availableGenera() {
      const set = new Set(this.creatures.map(c => c.genome.GEN));
      return [...set].sort((a, b) => a - b).map(g => ({ id: g, name: generateGenusName(g) }));
    },
    filteredCreatures() {
      const ageVal = this.filterAgeVal !== "" ? Number(this.filterAgeVal) : null;
      return this.creatures.filter(c => {
        if (this.filterGenus !== "" && c.genome.GEN !== Number(this.filterGenus)) return false;
        if (this.filterSex   !== "" && c.genome.SX  !== Number(this.filterSex))   return false;
        if (ageVal !== null && !isNaN(ageVal) && this.filterAgeOp !== "") {
          if (this.filterAgeOp === "<" && !(c.age <  ageVal)) return false;
          if (this.filterAgeOp === "=" && !(c.age === ageVal)) return false;
          if (this.filterAgeOp === ">" && !(c.age >  ageVal)) return false;
        }
        return true;
      });
    },
    crePageCount() { return Math.max(1, Math.ceil(this.filteredCreatures.length / PAGE_SIZE)); },
    pagedCreatures() {
      const s = (this.crePage - 1) * PAGE_SIZE;
      return this.filteredCreatures.slice(s, s + PAGE_SIZE);
    },

    // ── Accessories ──
    filteredAccessories() {
      return this.filterTemplate
        ? this.accessories.filter(a => a.template === this.filterTemplate)
        : this.accessories;
    },
    accPageCount() { return Math.max(1, Math.ceil(this.filteredAccessories.length / PAGE_SIZE)); },
    pagedAccessories() {
      const s = (this.accPage - 1) * PAGE_SIZE;
      return this.filteredAccessories.slice(s, s + PAGE_SIZE);
    },
  },

  watch: {
    '$route.params.user': {
      immediate: false,
      async handler(nextUser, prevUser) {
        if (!nextUser || nextUser === prevUser) return;
        this.crePage = 1;
        this.accPage = 1;
        this.filterGenus = "";
        this.filterSex = "";
        this.filterAgeOp = "";
        this.filterAgeVal = "";
        this.filterTemplate = "";
        await Promise.all([
          this.loadCreatures(nextUser),
          this.loadAccessories(nextUser),
        ]);
      }
    },
    filterGenus()    { this.crePage = 1; },
    filterSex()      { this.crePage = 1; },
    filterAgeOp()    { this.crePage = 1; },
    filterAgeVal()   { this.crePage = 1; },
    filterTemplate() { this.accPage = 1; },
  },

  methods: {
    async loadCreatures(user) {
      this.creaturesError = "";
      const cacheKey = `steembiota:owned:creatures:${String(user || "").toLowerCase()}:v2`;
      const cached = readOwnedProfileCache(cacheKey);
      if (cached) {
        this.creatures = cached;
        this.creaturesLoading = false;
        // Refresh in background so cached view is instant but data can still update.
        this.refreshCreatures(user, cacheKey);
        return;
      }
      this.creaturesLoading = true;
      await this.refreshCreatures(user, cacheKey, { setLoadingFalse: true });
    },

    async refreshCreatures(user, cacheKey, opts = {}) {
      const { setLoadingFalse = false } = opts;
      try {
        const owned = await fetchCreaturesOwnedBy(user, 100);
        const mapped = owned.map(({ post: p, meta: sb, effectiveOwner }) => {
          const age = calculateAge(p.created);
          return {
            author: p.author, permlink: p.permlink,
            name: sb.name || p.author, genome: sb.genome, age,
            lifecycleStage: getLifecycleStage(age, sb.genome),
            type: sb.type || "founder",
            parentA: sb.parentA || null, parentB: sb.parentB || null,
            speciated: sb.speciated || false,
            fingerprint: genomeFingerprint(sb.genome),
            isDuplicate: false, isPhantom: false,
            originalAuthor: null, originalPermlink: null, originalCreated: null,
            created: p.created || "", effectiveOwner,
          };
        }).sort((a, b) => new Date(b.created) - new Date(a.created));
        // If we already have data on-screen (usually from cache), do not let an
        // intermittent empty refresh wipe the tab and show a false "No creatures found".
        const keepExisting = this.creatures.length > 0 && mapped.length === 0;
        if (!keepExisting) this.creatures = mapped;
        if (mapped.length > 0 || this.creatures.length === 0) {
          writeOwnedProfileCache(cacheKey, mapped);
        }
      } catch (e) {
        if (!this.creatures.length) this.creaturesError = e.message || "Failed to load creatures.";
      }
      if (setLoadingFalse) this.creaturesLoading = false;
    },

    async loadAccessories(user) {
      this.accessoriesError = "";
      const cacheKey = `steembiota:owned:accessories:${String(user || "").toLowerCase()}:v2`;
      const cached = readOwnedProfileCache(cacheKey);
      if (cached) {
        this.accessories = cached;
        this.accessoriesLoading = false;
        // Refresh in background so cached view is instant but data can still update.
        this.refreshAccessories(user, cacheKey);
        return;
      }
      this.accessoriesLoading = true;
      await this.refreshAccessories(user, cacheKey, { setLoadingFalse: true });
    },

    async refreshAccessories(user, cacheKey, opts = {}) {
      const { setLoadingFalse = false } = opts;
      try {
        const owned = await fetchAccessoriesOwnedBy(user, 100);
        const sorted = owned.sort((a, b) => new Date(b.created) - new Date(a.created));
        // Same protection as creatures tab: avoid replacing a known-good list
        // with a transient empty response from chain scans.
        const keepExisting = this.accessories.length > 0 && sorted.length === 0;
        if (!keepExisting) this.accessories = sorted;
        if (sorted.length > 0 || this.accessories.length === 0) {
          writeOwnedProfileCache(cacheKey, sorted);
        }
      } catch (e) {
        if (!this.accessories.length) this.accessoriesError = e.message || "Failed to load accessories.";
      }
      if (setLoadingFalse) this.accessoriesLoading = false;
    },

    prevCre() { if (this.crePage > 1) this.crePage--; },
    nextCre() { if (this.crePage < this.crePageCount) this.crePage++; },
    prevAcc() { if (this.accPage > 1) this.accPage--; },
    nextAcc() { if (this.accPage < this.accPageCount) this.accPage++; },
  },

  template: `
    <div style="margin-top:20px;padding:0 16px;">

      <h2 style="color:#a5d6a7;margin:0 0 4px;">@{{ profileUser }}</h2>
      <p style="color:#555;font-size:13px;margin:0 0 16px;">
        Items owned by this user <span style="color:#3a3a3a;">(includes transfers)</span>
      </p>

      <!-- Tab bar -->
      <div style="display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid #222;">
        <button
          @click="activeTab='creatures'"
          :style="{
            padding:'8px 20px', fontSize:'13px', borderRadius:'6px 6px 0 0',
            background: activeTab==='creatures' ? '#1a2e1a' : '#111',
            color:      activeTab==='creatures' ? '#a5d6a7' : '#555',
            border:     '1px solid ' + (activeTab==='creatures' ? '#2e7d32' : '#222'),
            borderBottom: activeTab==='creatures' ? '1px solid #1a2e1a' : '1px solid #222',
            marginBottom: '-1px'
          }"
        >🧬 Creatures ({{ creatures.length }})</button>
        <button
          @click="activeTab='accessories'"
          :style="{
            padding:'8px 20px', fontSize:'13px', borderRadius:'6px 6px 0 0',
            background: activeTab==='accessories' ? '#1a0a2e' : '#111',
            color:      activeTab==='accessories' ? '#ce93d8' : '#555',
            border:     '1px solid ' + (activeTab==='accessories' ? '#7b1fa2' : '#222'),
            borderBottom: activeTab==='accessories' ? '1px solid #1a0a2e' : '1px solid #222',
            marginBottom: '-1px'
          }"
        >✨ Accessories ({{ accessories.length }})</button>
      </div>

      <!-- ═══ CREATURES TAB ═══ -->
      <div v-if="activeTab==='creatures'">
        <loading-spinner-component v-if="creaturesLoading"></loading-spinner-component>
        <div v-else-if="creaturesError" style="color:#ff8a80;font-size:13px;">⚠ {{ creaturesError }}</div>
        <div v-else-if="creatures.length===0" style="color:#555;font-size:13px;">
          No creatures found for @{{ profileUser }}.
        </div>
        <template v-else>
          <p style="font-size:12px;color:#444;margin:0 0 12px;">
            {{ filteredCreatures.length }}{{ filteredCreatures.length !== creatures.length ? ' of ' + creatures.length : '' }}
            creature{{ filteredCreatures.length === 1 ? '' : 's' }}
          </p>

          <!-- Creature filters -->
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:center;margin-bottom:14px;">
            <select v-model="filterGenus"
              style="padding:5px 8px;font-size:13px;background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:6px;font-family:monospace;">
              <option value="">All genera</option>
              <option v-for="g in availableGenera" :key="g.id" :value="String(g.id)">{{ g.name }} ({{ g.id }})</option>
            </select>
            <div style="display:flex;gap:4px;">
              <button @click="filterSex=''"
                :style="{padding:'4px 10px',fontSize:'12px',background:filterSex===''?'#2e7d32':'#1a1a1a',color:filterSex===''?'#fff':'#888',border:'1px solid #333',borderRadius:'6px'}">All</button>
              <button @click="filterSex='0'"
                :style="{padding:'4px 10px',fontSize:'12px',background:filterSex==='0'?'#1565c0':'#1a1a1a',color:filterSex==='0'?'#90caf9':'#888',border:'1px solid #333',borderRadius:'6px'}">♂ Male</button>
              <button @click="filterSex='1'"
                :style="{padding:'4px 10px',fontSize:'12px',background:filterSex==='1'?'#880e4f':'#1a1a1a',color:filterSex==='1'?'#f48fb1':'#888',border:'1px solid #333',borderRadius:'6px'}">♀ Female</button>
            </div>
            <div style="display:flex;gap:4px;align-items:center;">
              <span style="font-size:12px;color:#555;">Age</span>
              <button v-for="op in ['<','=','>']" :key="op"
                @click="filterAgeOp=(filterAgeOp===op?'':op)"
                :style="{padding:'4px 8px',fontSize:'12px',fontFamily:'monospace',background:filterAgeOp===op?'#4a3000':'#1a1a1a',color:filterAgeOp===op?'#ffb74d':'#888',border:'1px solid #333',borderRadius:'6px'}">{{ op }}</button>
              <input v-model="filterAgeVal" type="number" min="0" placeholder="days"
                style="width:64px;padding:4px 6px;font-size:12px;background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:6px;font-family:monospace;"/>
              <button v-if="filterAgeOp||filterAgeVal" @click="filterAgeOp='';filterAgeVal=''"
                style="padding:4px 7px;font-size:11px;background:#1a1a1a;color:#555;border:1px solid #333;border-radius:6px;" title="Clear">✕</button>
            </div>
          </div>

          <div v-if="filteredCreatures.length===0" style="color:#555;font-size:13px;margin:12px 0;">No creatures match the filter.</div>
          <template v-else>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px;max-width:920px;margin:0 auto;">
              <creature-card-component v-for="c in pagedCreatures" :key="c.author+'/'+c.permlink"
                :post="c" :username="profileUser"></creature-card-component>
            </div>
            <div v-if="crePageCount>1" style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:14px;">
              <button @click="prevCre" :disabled="crePage===1" style="padding:5px 14px;background:#1a2a1a;">◀ Prev</button>
              <span style="font-size:13px;color:#555;">{{ crePage }} / {{ crePageCount }}</span>
              <button @click="nextCre" :disabled="crePage===crePageCount" style="padding:5px 14px;background:#1a2a1a;">Next ▶</button>
            </div>
          </template>
        </template>
      </div>

      <!-- ═══ ACCESSORIES TAB ═══ -->
      <div v-if="activeTab==='accessories'">
        <loading-spinner-component v-if="accessoriesLoading"></loading-spinner-component>
        <div v-else-if="accessoriesError" style="color:#ff8a80;font-size:13px;">⚠ {{ accessoriesError }}</div>
        <div v-else-if="accessories.length===0" style="color:#555;font-size:13px;">
          No accessories found for @{{ profileUser }}.
        </div>
        <template v-else>
          <p style="font-size:12px;color:#444;margin:0 0 12px;">
            {{ filteredAccessories.length }}{{ filteredAccessories.length !== accessories.length ? ' of ' + accessories.length : '' }}
            accessor{{ filteredAccessories.length === 1 ? 'y' : 'ies' }}
          </p>

          <!-- Accessory template filter -->
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:14px;">
            <button @click="filterTemplate=''"
              :style="{padding:'4px 10px',fontSize:'12px',background:filterTemplate===''?'#4a148c':'#1a1a1a',color:filterTemplate===''?'#ce93d8':'#888',border:'1px solid '+(filterTemplate===''?'#7b1fa2':'#333'),borderRadius:'6px'}">All</button>
            <button v-for="t in accTemplates" :key="t.id"
              @click="filterTemplate=(filterTemplate===t.id?'':t.id)"
              :style="{padding:'4px 10px',fontSize:'12px',background:filterTemplate===t.id?'#4a148c':'#1a1a1a',color:filterTemplate===t.id?'#ce93d8':'#888',border:'1px solid '+(filterTemplate===t.id?'#7b1fa2':'#333'),borderRadius:'6px'}">
              {{ t.icon }} {{ t.label }}
            </button>
          </div>

          <div v-if="filteredAccessories.length===0" style="color:#555;font-size:13px;margin:12px 0;">No accessories match the filter.</div>
          <template v-else>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px;max-width:920px;margin:0 auto;">
              <accessory-card-component v-for="a in pagedAccessories" :key="a.author+'/'+a.permlink"
                :post="a" :username="profileUser"></accessory-card-component>
            </div>
            <div v-if="accPageCount>1" style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:14px;">
              <button @click="prevAcc" :disabled="accPage===1" style="padding:5px 14px;background:#1a0a2e;">◀ Prev</button>
              <span style="font-size:13px;color:#555;">{{ accPage }} / {{ accPageCount }}</span>
              <button @click="nextAcc" :disabled="accPage===accPageCount" style="padding:5px 14px;background:#1a0a2e;">Next ▶</button>
            </div>
          </template>
        </template>
      </div>

    </div>
  `
};

// ---- CreatureView ----
// Route: /@:author/:permlink
// Loads a published SteemBiota post, renders the creature,
// shows a kinship panel (parents, siblings, children),
// and provides Feed + Breed interaction panels.
const CreatureView = {
  name: "CreatureView",
  inject: ["username", "notify"],
  components: {
    CreatureCanvasComponent,
    CreatureCardComponent,
    GenomeTableComponent,
    LoadingSpinnerComponent,
    ActivityPanelComponent,
    BreedingPanelComponent,
    BreedPermitPanelComponent,
    TransferPanelComponent,
    SocialPanelComponent
  },
  data() {
    return {
      loading:       true,
      loadError:     null,
      isPhantom:     false,   // true when post was tombstoned via delete_comment
      genome:        null,
      name:          null,
      author:        null,
      permlink:      null,
      postAge:       null,
      feedState:     null,
      feedEvents:    null,
      alreadyFedToday: false,
      activityState: null,
      permitState:   null,   // { grantees: Set<username> } from parseBreedPermits
      effectiveOwner: null,  // current owner (may differ from post.author after transfers)
      transferState:  null,  // { effectiveOwner, transferHistory, pendingOffer, permitsValidFrom }
      reactionTrigger: 0,
      creatureType:  null,   // "founder" | "offspring"
      speciated:     false,  // true if offspring caused a genus split
      mutated:       false,  // true if offspring had a mutation
      isDuplicate:      false,   // true if an earlier post with identical genome exists
      originalAuthor:   null,    // author of the earliest identical genome post
      originalPermlink: null,    // permlink of the earliest identical genome post
      originalCreated:  null,    // ISO timestamp of the earliest post
      parentA:       null,
      parentB:       null,
      siblings:      [],
      children:      [],
      kinshipLoading: false,
      now:           new Date(),
      facingRight:   false,
      currentPose:   null,
      urlCopied:     false,
      // ── Social data (votes, resteems, comments) ──
      votes:         [],    // from fetchVotes()
      rebloggers:    [],    // from fetchRebloggers()
      socialComments: [],   // non-SteemBiota replies from reply tree
      socialLoading: false, // true while fetching social data
      newComment:    "",    // comment compose box text
      submittingComment: false,
      votingInProgress:    false,  // true while keychain vote request is open
      resteemInProgress:   false,  // true while keychain resteem request is open
      votePickerOpen:      false,  // true when the % slider popover is visible
      votePct:             100,    // last chosen upvote percentage (1–100)
      // Equipped accessory — { template, genome, accAuthor, accPermlink, accName } | null
      wearing:             null,
      // Equipped accessories — newest first
      wearings:            [],
    };
  },
  created() {
    this._ticker = setInterval(() => { this.now = new Date(); }, 60000);
    this.loadCreature();
  },
  beforeUnmount() {
    clearInterval(this._ticker);
  },
  computed: {
    sexLabel()      { return this.genome ? (this.genome.SX === 0 ? "♂ Male" : "♀ Female") : ""; },
    lifecycleStage(){ return this.genome ? getLifecycleStage(this.postAge ?? 0, this.genome) : null; },
    fossil() {
      if (!this.genome) return false;
      return (this.postAge ?? 0) >= this.genome.LIF + (this.feedState ? this.feedState.lifespanBonus : 0);
    },
    unicodeArt()       { return this.genome ? buildUnicodeArt(this.genome, this.postAge ?? 0, this.feedState, this.facingRight, this.currentPose || "standing") : ""; },
    steemitUrl()       {
      if (!this.author || !this.permlink) return null;
      return "https://steemit.com/@" + this.author + "/" + this.permlink;
    },
    breedPrefilledUrl() {
      if (!this.author || !this.permlink) return null;
      return "https://steemit.com/@" + this.author + "/" + this.permlink;
    },
    // ── Provenance analysis ──────────────────────────────────────
    // Priority: duplicate > broken-offspring > offspring > suspicious-founder > founder
    provenanceStatus() {
      if (!this.genome) return null;
      if (this.isPhantom) return "phantom";
      // Timestamp-priority duplicate — strongest signal, overrides everything
      if (this.isDuplicate) return "duplicate";
      const isOffspring = this.creatureType === "offspring";
      const hasParents  = !!(this._rawParentA || this._rawParentB);
      if (isOffspring && hasParents)  return "offspring";
      if (isOffspring && !hasParents) return "broken-offspring";
      // Founder — genome plausibility check
      const g = this.genome;
      // Suspicion heuristics — each flag scores 1 point; >= 3 = warning.
      // MOR/APP/ORN range 0–9999: flag only near-maximum values (>= 9900).
      // MUT range 0–2 for founders: 5 is only reachable via breeding/editing.
      // LIF range 80–159 from generateGenome(): flag truly impossible values.
      const suspicionCount =
        (g.MOR >= 9900 ? 1 : 0) +
        (g.APP >= 9900 ? 1 : 0) +
        (g.MUT === 5   ? 1 : 0) +
        (g.LIF > 159 || g.LIF < 80 ? 1 : 0) +
        (g.ORN >= 9900 ? 1 : 0);
      if (suspicionCount >= 3) return "suspicious-founder";
      return "founder";
    },
    provenanceBadge() {
      switch (this.provenanceStatus) {
        case "phantom":
          return { icon: "👻", label: "Phantom", color: "#9e9e9e", border: "#424242", bg: "#0a0a0a" };
        case "duplicate":
          return { icon: "⚠", label: "Duplicate Genome", color: "#ff8a80", border: "#b71c1c", bg: "#1a0000" };
        case "offspring":
          if (this.speciated) return { icon: "⚡", label: "Speciation Event", color: "#ffb74d", border: "#e65100", bg: "#1a0f00" };
          if (this.mutated)   return { icon: "🧬", label: "Bred — Mutation",  color: "#80deea", border: "#006064", bg: "#001a1c" };
          return                       { icon: "🧬", label: "Bred Offspring",   color: "#80deea", border: "#00838f", bg: "#001a1c" };
        case "broken-offspring":
          return { icon: "⚠", label: "Offspring — Missing Parent Links", color: "#ff8a80", border: "#b71c1c", bg: "#1a0000" };
        case "suspicious-founder":
          return { icon: "⚠", label: "Unverified Origin", color: "#ffb74d", border: "#e65100", bg: "#1a0e00" };
        case "founder":
        default:
          return { icon: "🌱", label: "Origin Creature", color: "#a5d6a7", border: "#2e7d32", bg: "#0d1a0d" };
      }
    },
    isFertile() {
      if (!this.genome || !this.postAge) return false;
      if (this.fossil || this.isPhantom) return false;
      const ext   = this.activityState?.fertilityExtension || 0;
      const boost = this.feedState?.fertilityBoost || 0;
      const windowDays  = this.genome.FRT_END - this.genome.FRT_START;
      const boostDays   = Math.floor(windowDays * boost / 2);
      const effStart    = this.genome.FRT_START - ext - boostDays;
      const effEnd      = this.genome.FRT_END   + ext + boostDays;
      return this.postAge >= effStart && this.postAge < effEnd;
    },
    // True if the logged-in user may use this creature as a breeding parent.
    // Owner always yes; others need an active named permit.
    isPermittedToBread() {
      if (!this.username || !this.effectiveOwner) return false;
      if (this.username === this.effectiveOwner) return true;
      if (!this.permitState) return false;
      return isBreedingPermitted(this.effectiveOwner, this.username, this.permitState);
    },
    // Expose a sorted array of current grantees for the permit manager UI.
    currentGrantees() {
      if (!this.permitState) return [];
      return [...this.permitState.grantees].sort();
    },
    // True if the logged-in user is the EFFECTIVE owner (may differ from post.author).
    isOwner() {
      return !!(this.username && this.effectiveOwner && this.username === this.effectiveOwner);
    },
    // True if the logged-in user has already upvoted this creature's post.
    hasVoted() {
      if (!this.username) return false;
      return this.votes.some(v => v.voter === this.username && v.percent > 0);
    },
    // True if the logged-in user has already resteemed this creature's post.
    hasResteemed() {
      if (!this.username) return false;
      return this.rebloggers.includes(this.username);
    },
    // True if a transfer offer is pending and the logged-in user is the named recipient.
    isPendingRecipient() {
      if (!this.username || !this.transferState?.pendingOffer) return false;
      return this.username === this.transferState.pendingOffer.to;
    },
    lockedA() {
      if (!this.genome || !this.breedPrefilledUrl) return null;
      return {
        url:  this.breedPrefilledUrl,
        name: this.name || this.author,
        sex:  this.genome.SX === 0 ? "♂ Male" : "♀ Female"
      };
    }
  },
  methods: {
    creatureCacheKey(author, permlink) {
      return `steembiota:creature:${String(author || "").toLowerCase()}/${String(permlink || "").toLowerCase()}:v1`;
    },
    applyCachedCreature(cached, author, permlink) {
      if (!cached || !cached.genome) return false;
      this.author       = author;
      this.permlink     = permlink;
      this.genome       = cached.genome;
      this.name         = cached.name || author;
      this.creatureType = cached.creatureType || "founder";
      this.speciated    = !!cached.speciated;
      this.mutated      = !!cached.mutated;
      this._postCreated = cached.postCreated || null;
      this.postAge      = cached.postCreated ? calculateAge(cached.postCreated) : (cached.postAge ?? 0);
      this.feedEvents   = Array.isArray(cached.feedEvents) ? cached.feedEvents : [];
      this.feedState    = cached.feedState || computeFeedState(this.feedEvents, this.genome);
      this.activityState   = cached.activityState || null;
      this.transferState   = cached.transferState || null;
      this.effectiveOwner  = cached.effectiveOwner || author;
      this.permitState     = {
        grantees: new Set(Array.isArray(cached.permitGrantees) ? cached.permitGrantees : [])
      };
      this.alreadyFedToday = !!cached.alreadyFedToday;
      this._rawParentA     = cached.parentA || null;
      this._rawParentB     = cached.parentB || null;
      this.wearing         = cached.wearing || null;
      this.wearings        = Array.isArray(cached.wearings)
        ? cached.wearings
        : (cached.wearing ? [cached.wearing] : []);
      this.isPhantom       = false;
      this.loadError       = null;
      this.loading         = false;
      return true;
    },    

    async loadCreature() {
  this.loading   = true;
  this.loadError = null;

  const { author, permlink } = this.$route.params;
  this.author   = author;
  this.permlink = permlink;

  const cacheKey = this.creatureCacheKey(author, permlink);

  // NEW: Await IndexedDB cache
  const cached = await readCreatureDB(cacheKey);
  if (cached) {
    this.applyCachedCreature(cached, author, permlink);
    // Continue loading in background for fresh data
  }

  try {
    const post = await fetchPost(author, permlink);
    if (!post) throw new Error("Post not found.");

    if (isPhantomPost(post)) {
      this.isPhantom = true;
      this.loading   = false;
      return;
    }

    if (!post.author) throw new Error("Post not found.");

    let meta = {};
    try { meta = JSON.parse(post.json_metadata || "{}"); } catch {}

    if (!meta.steembiota) {
      throw new Error("This post is not a SteemBiota creature.");
    }

    if (meta.steembiota.type === "accessory") {
      this.$router.replace({ name: "AccessoryItemView", params: this.$route.params });
      return;
    }

    const sb = meta.steembiota;

    this.genome       = sb.genome;
    this.name         = sb.name || author;
    this.creatureType = sb.type || "founder";
    this.speciated    = sb.speciated || false;
    this.mutated      = sb.mutated   || false;
    this._postCreated = post.created || null;
    this.postAge      = calculateAge(post.created);

    const replies      = await fetchAllReplies(author, permlink);
    const feedEvents   = parseFeedEvents(replies, author);
    this.feedEvents    = feedEvents;
    this.feedState     = computeFeedState(feedEvents, this.genome);
    this.activityState = computeActivityState(replies, author, this.username);

    const ownership        = parseOwnershipChain(replies, author);
    this.transferState     = ownership;
    this.effectiveOwner    = ownership.effectiveOwner;

    this.permitState = parseBreedPermitsWithTransfer(
      replies,
      ownership.effectiveOwner,
      ownership.permitsValidFrom
    );

    if (this.username) {
      const todayUTC = new Date().toISOString().slice(0, 10);
      this.alreadyFedToday = replies.some(r => {
        if (r.author !== this.username) return false;
        let m = {}; try { m = JSON.parse(r.json_metadata || "{}"); } catch {}
        if (!m.steembiota || m.steembiota.type !== "feed") return false;
        const d = r.created.endsWith("Z") ? r.created : r.created + "Z";
        return new Date(d).toISOString().slice(0, 10) === todayUTC;
      });
    }

    this._rawParentA = sb.parentA || null;
    this._rawParentB = sb.parentB || null;

    // Background accessory fetch
    fetchCreatureWearings(author, permlink, replies).then(async ws => {
      if (!ws || (ws.length === 0 && this.wearings.length > 0)) {
        if (!ws) return;
      }

      this.wearings = ws.map(newItem => {
        if (newItem.networkError) {
          const existing = this.wearings.find(ex => ex.accPermlink === newItem.accPermlink);
          return existing || newItem;
        }
        return newItem;
      });

      this.wearing = this.wearings[0] || null;

      // Write high-confidence state to IndexedDB
      await writeCreatureDB(cacheKey, {
        genome: this.genome,
        name: this.name,
        creatureType: this.creatureType,
        speciated: this.speciated,
        mutated: this.mutated,
        postCreated: this._postCreated,
        postAge: this.postAge,
        feedEvents: this.feedEvents,
        feedState: this.feedState,
        activityState: this.activityState,
        effectiveOwner: this.effectiveOwner,
        transferState: this.transferState,
        permitGrantees: [...(this.permitState?.grantees || [])],
        alreadyFedToday: this.alreadyFedToday,
        parentA: this._rawParentA,
        parentB: this._rawParentB,
        wearing: this.wearing,
        wearings: this.wearings
      }, CREATURE_PAGE_CACHE_TTL_MS);

    }).catch(err => {
      console.error("Accessory sync failed:", err);
    });

    // Immediate snapshot (without unsafe wearings overwrite)
    const snapshot = {
      genome: this.genome,
      name: this.name,
      creatureType: this.creatureType,
      speciated: this.speciated,
      mutated: this.mutated,
      postCreated: this._postCreated,
      postAge: this.postAge,
      feedEvents: this.feedEvents,
      feedState: this.feedState,
      activityState: this.activityState,
      effectiveOwner: this.effectiveOwner,
      transferState: this.transferState,
      permitGrantees: [...(this.permitState?.grantees || [])],
      alreadyFedToday: this.alreadyFedToday,
      parentA: this._rawParentA,
      parentB: this._rawParentB,
      wearing: this.wearing
    };

    if (this.wearings && this.wearings.length > 0) {
      snapshot.wearings = this.wearings;
    }

    // NEW: async IndexedDB write
    await writeCreatureDB(cacheKey, snapshot, CREATURE_PAGE_CACHE_TTL_MS);

  } catch (err) {
    if (!this.genome) {
      this.loadError = err.message || "Failed to load creature.";
    }
  }

  this.loading = false;

  if (!this.loadError) {
    this.loadKinship();
    this.checkDuplicate();
    this.loadSocialData();
  }
},

    // ── Duplicate / timestamp-priority check ────────────────────
    // Fetches all steembiota posts (up to 200, same approach as leaderboard)
    // and looks for any post with an identical genome fingerprint published
    // before this creature. If found, marks this creature as a duplicate.
    async checkDuplicate() {
      if (!this.genome) return;
      const selfFp      = genomeFingerprint(this.genome);
      const selfCreated = this._postCreated;   // raw ISO string stored during load
      if (!selfCreated) return;

      try {
        let allRaw = await fetchPostsByTag("steembiota", 100);
        if (Array.isArray(allRaw) && allRaw.length === 100) {
          const last = allRaw[allRaw.length - 1];
          const page2 = await fetchPostsByTagPaged("steembiota", 100, last.author, last.permlink);
          if (Array.isArray(page2)) allRaw = allRaw.concat(page2.slice(1));
        }
        for (const p of (allRaw || [])) {
          // Skip self
          if (p.author === this.author && p.permlink === this.permlink) continue;
          let meta = {};
          try { meta = JSON.parse(p.json_metadata || "{}"); } catch {}
          if (!meta.steembiota?.genome) continue;
          const fp = genomeFingerprint(meta.steembiota.genome);
          if (fp !== selfFp) continue;
          // Same genome — compare timestamps
          const otherCreated = p.created.endsWith("Z") ? p.created : p.created + "Z";
          const selfCreatedN  = selfCreated.endsWith("Z") ? selfCreated : selfCreated + "Z";
          if (otherCreated < selfCreatedN) {
            // Found an earlier post with identical genome
            this.isDuplicate      = true;
            this.originalAuthor   = p.author;
            this.originalPermlink = p.permlink;
            this.originalCreated  = otherCreated;
            return;
          }
        }
      } catch (e) {
        // Non-fatal — duplicate check is best-effort
        console.warn("Duplicate check failed:", e.message);
      }
    },

    async loadKinship() {
      this.kinshipLoading = true;
      const selfKey = nodeKey(this.author, this.permlink);
      try {
        // --- Parents: fetch individually (cheap, known keys) ---
        const loadParent = async (ref) => {
          if (!ref || !ref.author || !ref.permlink) return null;
          try {
            const node = await fetchSteembiotaPost(ref.author, ref.permlink);
            if (!node) return null;
            // Parent is a phantom (post was deleted)
            if (node.phantom) {
              return {
                author:        ref.author,
                permlink:      ref.permlink,
                name:          ref.author,
                genome:        null,
                age:           null,
                lifecycleStage: null,
                isPhantom:     true,
                created:       ""
              };
            }
            return {
              author:        node.author,
              permlink:      node.permlink,
              name:          node.meta.name || node.author,
              genome:        node.meta.genome,
              age:           node.meta.age ?? 0,
              lifecycleStage: getLifecycleStage(node.meta.age ?? 0, node.meta.genome),
              isPhantom:     false,
              created:       ""
            };
          } catch { return null; }
        };
        const [pA, pB] = await Promise.all([
          loadParent(this._rawParentA),
          loadParent(this._rawParentB)
        ]);
        this.parentA = pA;
        this.parentB = pB;

        // --- Siblings + Children: build a small corpus from this author + parent authors ---
        const authorsToFetch = new Set([this.author]);
        if (this._rawParentA?.author) authorsToFetch.add(this._rawParentA.author);
        if (this._rawParentB?.author) authorsToFetch.add(this._rawParentB.author);

        const corpus = await fetchCorpusByAuthors(authorsToFetch);
        // Seed corpus with the creature itself
        corpus.set(selfKey, {
          key: selfKey, author: this.author, permlink: this.permlink,
          meta: { genome: this.genome, name: this.name, age: this.postAge,
                  parentA: this._rawParentA, parentB: this._rawParentB }
        });

        // Siblings
        const siblingKeys = findSiblings(new Set([selfKey]), corpus);
        this.siblings = [...siblingKeys]
          .filter(k => k !== selfKey)
          .slice(0, 10)
          .map(k => {
            const n = corpus.get(k);
            if (!n) return null;
            return {
              author: n.author, permlink: n.permlink,
              name:   n.meta.name || n.author,
              genome: n.meta.genome, age: n.meta.age ?? 0,
              lifecycleStage: getLifecycleStage(n.meta.age ?? 0, n.meta.genome),
              created: ""
            };
          }).filter(Boolean);

        // Children (direct only)
        const childKeys = findDescendants(new Set([selfKey]), corpus);
        this.children = [...childKeys]
          .slice(0, 10)
          .map(k => {
            const n = corpus.get(k);
            if (!n) return null;
            // Only include direct children (parentA or parentB is selfKey)
            const pA = n.meta.parentA;
            const pB = n.meta.parentB;
            const paKey = pA?.author ? nodeKey(pA.author, pA.permlink) : null;
            const pbKey = pB?.author ? nodeKey(pB.author, pB.permlink) : null;
            if (paKey !== selfKey && pbKey !== selfKey) return null;
            return {
              author: n.author, permlink: n.permlink,
              name:   n.meta.name || n.author,
              genome: n.meta.genome, age: n.meta.age ?? 0,
              lifecycleStage: getLifecycleStage(n.meta.age ?? 0, n.meta.genome),
              created: ""
            };
          }).filter(Boolean);

      } catch { /* kinship is best-effort */ }
      this.kinshipLoading = false;
    },

    onFeedStateUpdated(fs) {
      this.feedState = fs;
      this.alreadyFedToday = true;   // panel only emits this after a successful feed
      this.reactionTrigger++;
    },
    onPermitsUpdated(newPermitState) {
      this.permitState = newPermitState;
    },
    onTransferUpdated(newTransferState) {
      this.transferState  = newTransferState;
      this.effectiveOwner = newTransferState.effectiveOwner;
      invalidateGlobalListCaches();
      invalidateOwnedCachesForUser(this.username);
      invalidateCreatureCache(this.author, this.permlink);
      // Void pre-transfer permits when ownership changes
      this.permitState = parseBreedPermitsWithTransfer(
        [],   // optimistic — full reload will reconcile on next visit
        newTransferState.effectiveOwner,
        newTransferState.permitsValidFrom
      );
    },
    onActivityStateUpdated(as) { this.activityState = as; this.reactionTrigger++; },
    onFacingResolved(dir)  { this.facingRight = dir; },
    onPoseResolved(pose)   { this.currentPose = pose; },

    // ── Social data ─────────────────────────────────────────
    async loadSocialData() {
      if (!this.author || !this.permlink) return;
      this.socialLoading = true;
      try {
        const [votes, rebloggers, allReplies] = await Promise.all([
          fetchVotes(this.author, this.permlink),
          fetchRebloggers(this.author, this.permlink),
          fetchAllReplies(this.author, this.permlink)
        ]);
        this.votes      = votes;
        this.rebloggers = rebloggers;
        // Social comments = top-level replies that have no steembiota game metadata
        // (i.e. not feed/play/walk/birth/transfer/permit events)
        this.socialComments = allReplies
          .filter(r => {
            // Only direct replies (depth === 1 relative to creature post)
            // We check by comparing parent_author/parent_permlink
            if (r.parent_author !== this.author) return false;
            if (r.parent_permlink !== this.permlink) return false;
            // Skip game event replies
            let m = {};
            try { m = JSON.parse(r.json_metadata || "{}"); } catch {}
            if (m.steembiota && m.steembiota.type) return false;
            // Skip empty bodies
            if (!r.body || r.body.trim().length < 2) return false;
            return true;
          })
          .sort((a, b) => new Date(a.created) - new Date(b.created));
      } catch (e) {
        console.warn("Social data load failed:", e);
      }
      this.socialLoading = false;
    },

    onCommentPosted(newReply) {
      // Optimistically prepend the new comment to the list
      this.socialComments = [...this.socialComments, newReply];
      this.newComment = "";
    },

    toggleVotePicker() {
      if (!this.username) { this.notify("Please log in to upvote.", "error"); return; }
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      if (this.hasVoted) { this.notify("You have already upvoted this creature.", "error"); return; }
      this.votePickerOpen = !this.votePickerOpen;
    },

    submitVote() {
      if (!this.username || !window.steem_keychain) return;
      if (this.hasVoted || this.votingInProgress) return;
      this.votePickerOpen   = false;
      this.votingInProgress = true;
      const weight = Math.round(Math.max(1, Math.min(100, this.votePct))) * 100;
      publishVote(this.username, this.author, this.permlink, weight, (res) => {
        this.votingInProgress = false;
        if (res.success) {
          // Optimistic: add synthetic vote entry at the chosen percent
          this.votes = [...this.votes, {
            voter: this.username, percent: weight, weight: 1,
            rshares: 0, reputation: 0, time: new Date().toISOString()
          }];
          this.notify("❤️ Upvoted at " + this.votePct + "%!", "success");
        } else {
          this.notify("Upvote failed: " + (res.message || "Unknown error"), "error");
        }
      });
    },

    submitResteem() {
      if (!this.username) { this.notify("Please log in to resteem.", "error"); return; }
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      if (this.hasResteemed) { this.notify("You have already resteemed this creature.", "error"); return; }
      if (this.resteemInProgress) return;
      this.resteemInProgress = true;
      publishResteem(this.username, this.author, this.permlink, (res) => {
        this.resteemInProgress = false;
        if (res.success) {
          // Optimistic: add username to rebloggers
          this.rebloggers = [...this.rebloggers, this.username];
          this.notify("🔁 Resteemed!", "success");
        } else {
          this.notify("Resteem failed: " + (res.message || "Unknown error"), "error");
        }
      });
    },
    copyUrl() {
      if (!this.steemitUrl) return;
      navigator.clipboard.writeText(this.steemitUrl).then(() => {
        this.urlCopied = true;
        setTimeout(() => { this.urlCopied = false; }, 1800);
      }).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = this.steemitUrl;
        ta.style.position = "fixed";
        ta.style.opacity  = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        this.urlCopied = true;
        setTimeout(() => { this.urlCopied = false; }, 1800);
      });
    }
  },

  template: `
    <div style="margin-top:20px;padding:0 16px;">

      <loading-spinner-component v-if="loading"></loading-spinner-component>

      <!-- ===== PHANTOM STATE ===== -->
      <div v-else-if="isPhantom" style="margin-top:32px;padding:0 16px;">
        <div style="font-size:2.4rem;margin-bottom:12px;">👻</div>
        <div style="font-size:1.2rem;font-weight:bold;color:#9e9e9e;letter-spacing:0.04em;">
          Phantom Creature
        </div>
        <div style="
          margin:16px auto; padding:16px 20px; border-radius:10px; max-width:520px;
          background:#111; border:1px solid #333; color:#888; font-size:0.88rem; line-height:1.6;
        ">
          <p style="margin:0 0 10px;color:#aaa;">
            This creature's post was removed from the visible chain via Steemit's
            delete function. It is now a <strong style="color:#bdbdbd;">Phantom</strong> —
            no longer alive, but not at rest either.
          </p>
          <p style="margin:0 0 10px;">
            Unlike a <strong>Fossil</strong>, which is an honourable end of a full lifecycle,
            a Phantom was erased before its time. Its genome echoes remain permanently
            on the immutable blockchain ledger, but the creature walks no more.
          </p>
          <p style="margin:0;color:#616161;font-size:0.82rem;font-style:italic;">
            Phantoms cannot breed, be fed, or interact. Their lineage is severed.
          </p>
        </div>
        <div style="margin-top:6px;font-size:0.78rem;color:#444;">
          @{{ author }}/{{ permlink }}
        </div>
        <div style="margin-top:16px;">
          <router-link to="/" style="color:#66bb6a;font-size:0.9rem;">← Back to Home</router-link>
        </div>
      </div>

      <div v-else-if="loadError" style="color:#ff8a80;margin-top:24px;">
        ⚠ {{ loadError }}
        <br/><br/>
        <router-link to="/" style="color:#66bb6a;">← Back to Home</router-link>
      </div>

      <template v-else-if="genome">

        <!-- Identity header -->
        <div style="margin-bottom:12px;">
          <div style="font-size:1.3rem;font-weight:bold;color:#a5d6a7;letter-spacing:0.03em;">🧬 {{ name }}</div>
          <div style="font-size:0.9rem;color:#888;margin-top:2px;">
            {{ sexLabel }}
            <span style="color:#444;margin:0 6px;">·</span>
            <router-link :to="'/@' + author" style="color:#80deea;text-decoration:none;font-size:0.85rem;">@{{ author }}</router-link>
          </div>
          <div style="margin-top:8px;display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;">
            <span style="font-size:0.85rem;color:#aaa;">
              Age: <strong style="color:#eee;">{{ postAge }} day{{ postAge === 1 ? '' : 's' }}</strong>
            </span>
            <span v-if="lifecycleStage"
              :style="{ fontSize:'0.82rem', fontWeight:'bold', color:lifecycleStage.color,
                        border:'1px solid '+lifecycleStage.color, borderRadius:'12px', padding:'2px 10px' }"
            >{{ lifecycleStage.icon }} {{ lifecycleStage.name }}</span>
            <span style="font-size:0.8rem;color:#666;">
              Lifespan: {{ genome.LIF + (feedState ? feedState.lifespanBonus : 0) }} days
              <template v-if="feedState && feedState.lifespanBonus > 0">
                <span style="color:#66bb6a;">(+{{ feedState.lifespanBonus }}🍃)</span>
              </template>
              &nbsp;·&nbsp; Fertile: {{ genome.FRT_START }}–{{ genome.FRT_END }}
            </span>
            <span v-if="feedState"
              :style="{
                fontSize:'0.80rem', fontWeight:'bold',
                color: feedState.healthPct >= 0.55 ? '#a5d6a7' : feedState.healthPct >= 0.30 ? '#ffb74d' : '#888',
                border:'1px solid '+(feedState.healthPct >= 0.55 ? '#388e3c' : feedState.healthPct >= 0.30 ? '#f57c00' : '#444'),
                borderRadius:'12px', padding:'2px 10px'
              }"
            >{{ feedState.symbol }} {{ feedState.label }}</span>
            <span v-if="activityState && activityState.moodLabel"
              :style="{
                fontSize:'0.80rem', fontWeight:'bold',
                color: '#ce93d8',
                border: '1px solid #7b1fa2',
                borderRadius:'12px', padding:'2px 10px'
              }"
            >🎮 {{ activityState.moodLabel }}</span>
            <span v-if="activityState && activityState.vitalityLabel"
              :style="{
                fontSize:'0.80rem', fontWeight:'bold',
                color: '#80cbc4',
                border: '1px solid #00695c',
                borderRadius:'12px', padding:'2px 10px'
              }"
            >🦮 {{ activityState.vitalityLabel }}</span>

            <!-- Provenance badge -->
            <span v-if="provenanceBadge" :style="{
              fontSize:'0.80rem', fontWeight:'bold',
              color: provenanceBadge.color,
              border: '1px solid ' + provenanceBadge.border,
              background: provenanceBadge.bg,
              borderRadius:'12px', padding:'2px 10px'
            }">{{ provenanceBadge.icon }} {{ provenanceBadge.label }}</span>
          </div>

          <!-- Provenance warning banner — shown for suspicious or broken creatures -->
          <div v-if="provenanceStatus === 'duplicate'" style="
            margin-top:10px; padding:10px 14px; border-radius:8px;
            background:#1a0000; border:1px solid #b71c1c;
            font-size:12px; color:#ff8a80; text-align:left; max-width:520px; margin-left:auto; margin-right:auto;">
            <strong>⚠ Duplicate Genome Detected</strong><br/>
            An identical genome was published earlier by
            <router-link :to="'/@' + originalAuthor + '/' + originalPermlink"
              style="color:#ff8a80;font-weight:bold;">@{{ originalAuthor }}</router-link>
            on {{ originalCreated ? new Date(originalCreated).toLocaleDateString() : '?' }}.
            By timestamp priority, that post is the original. This creature's genome is a copy
            and has no independent lineage value.
          </div>
          <div v-if="provenanceStatus === 'suspicious-founder'" style="
            margin-top:10px; padding:10px 14px; border-radius:8px;
            background:#1a0e00; border:1px solid #e65100;
            font-size:12px; color:#ffb74d; text-align:left; max-width:520px; margin-left:auto; margin-right:auto;">
            <strong>⚠ Unverified Origin</strong><br/>
            This creature was posted as an origin creature but has an unusually optimal genome.
            Legitimate founders are randomly generated — genomes with multiple maxed-out traits
            may have been manually crafted or copied from another creature.
            Verify this creature's authenticity before interacting with it.
          </div>
          <div v-if="provenanceStatus === 'broken-offspring'" style="
            margin-top:10px; padding:10px 14px; border-radius:8px;
            background:#1a0000; border:1px solid #b71c1c;
            font-size:12px; color:#ff8a80; text-align:left; max-width:520px; margin-left:auto; margin-right:auto;">
            <strong>⚠ Missing Parent Links</strong><br/>
            This post claims to be a bred offspring but contains no parent references in its metadata.
            Legitimate offspring always record both parent posts. This creature's lineage cannot be verified.
          </div>
        </div>

        <!-- Canvas render -->
        <creature-canvas-component :genome="genome" :age="postAge" :fossil="fossil" :feed-state="feedState"
          :activity-state="activityState"
          :reaction-trigger="reactionTrigger"
          :wearing="wearing"
          :wearings="wearings"
          @facing-resolved="onFacingResolved"
          @pose-resolved="onPoseResolved"
        ></creature-canvas-component>
        <!-- Pose label + social counters row -->
        <div style="display:flex;align-items:center;justify-content:space-between;
                    min-height:18px;margin:3px 0 0;">
          <div v-if="currentPose && !fossil"
            style="font-size:0.75rem;color:#444;font-style:italic;letter-spacing:0.04em;">
            {{ { standing:'🐾 standing', sitting:'🪑 sitting', sleeping:'💤 sleeping', alert:'👀 alert', playful:'🎉 playful' }[currentPose] }}
          </div>
          <div v-else></div>
          <!-- Upvote + Resteem counters + action buttons -->
          <div v-if="!socialLoading" style="display:flex;gap:8px;align-items:center;">
            <!-- Upvote -->
            <span style="font-size:0.75rem;color:#ef9a9a;letter-spacing:0.03em;" title="Upvotes">
              ❤️ {{ votes.length }}
            </span>
            <!-- Upvote button + % picker popover -->
            <div v-if="username && !hasVoted" style="position:relative;">
              <button
                @click="toggleVotePicker"
                :disabled="votingInProgress"
                title="Upvote this creature"
                style="padding:1px 6px;font-size:0.7rem;line-height:1.4;
                       background:#1a0a0a;border:1px solid #4a1a1a;color:#ef9a9a;
                       border-radius:4px;cursor:pointer;min-width:0;"
              >{{ votingInProgress ? "…" : "↑" }}</button>

              <!-- Floating % picker — opens above the button -->
              <div
                v-if="votePickerOpen"
                style="position:absolute;bottom:calc(100% + 6px);right:0;
                       background:#111;border:1px solid #3a1a1a;border-radius:8px;
                       padding:10px 12px;min-width:160px;z-index:200;
                       box-shadow:0 4px 16px rgba(0,0,0,0.7);"
              >
                <!-- Close on outside click via a transparent overlay -->
                <div
                  @click.stop="votePickerOpen = false"
                  style="position:fixed;inset:0;z-index:-1;"
                ></div>

                <div style="font-size:0.72rem;color:#ef9a9a;font-weight:bold;
                            margin-bottom:8px;text-align:center;letter-spacing:0.05em;">
                  ❤️ Upvote strength
                </div>

                <!-- Percentage display -->
                <div style="text-align:center;font-size:1rem;font-weight:bold;
                            color:#ef9a9a;margin-bottom:6px;">
                  {{ votePct }}%
                </div>

                <!-- Range slider -->
                <input
                  type="range"
                  v-model.number="votePct"
                  min="1" max="100" step="1"
                  style="width:100%;accent-color:#ef5350;cursor:pointer;"
                />
                <div style="display:flex;justify-content:space-between;
                            font-size:0.62rem;color:#444;margin-top:2px;">
                  <span>1%</span><span>100%</span>
                </div>

                <!-- Confirm button -->
                <button
                  @click.stop="submitVote"
                  style="margin-top:8px;width:100%;background:#3a0a0a;
                         border:1px solid #6a2020;color:#ef9a9a;font-size:0.78rem;
                         border-radius:5px;padding:4px 0;cursor:pointer;"
                >Confirm {{ votePct }}% upvote</button>
              </div>
            </div>
            <span
              v-else-if="username && hasVoted"
              title="You upvoted this"
              style="font-size:0.7rem;color:#ef5350;">✓</span>
            <!-- Resteem -->
            <span style="font-size:0.75rem;color:#80cbc4;letter-spacing:0.03em;margin-left:4px;" title="Resteems">
              🔁 {{ rebloggers.length }}
            </span>
            <button
              v-if="username && !hasResteemed"
              @click="submitResteem"
              :disabled="resteemInProgress"
              title="Resteem this creature"
              style="padding:1px 6px;font-size:0.7rem;line-height:1.4;
                     background:#0a1a1a;border:1px solid #1a3a3a;color:#80cbc4;
                     border-radius:4px;cursor:pointer;min-width:0;"
            >{{ resteemInProgress ? "…" : "↺" }}</button>
            <span
              v-else-if="username && hasResteemed"
              title="You resteemed this"
              style="font-size:0.7rem;color:#26c6da;">✓</span>
          </div>
        </div>
        <div v-if="fossil" style="margin:6px 0;color:#666;font-size:0.85rem;letter-spacing:0.05em;">
          🦴 This creature has fossilised. Its genome is preserved on-chain.
        </div>

        <!-- ── Worn Accessories + Equip Panel ── -->
        <equip-panel-component
          :username="username"
          :creature-author="author"
          :creature-permlink="permlink"
          :creature-name="name"
          :wearings="wearings"
          :is-owner="isOwner"
          @notify="(msg,type) => notify(msg,type)"
          @wearings-updated="ws => { wearings = ws; wearing = ws[0] || null; }"
        ></equip-panel-component>

        <!-- Activity panel (Feed + Play + Walk) -->
        <activity-panel-component
          :username="username"
          :creature-author="author"
          :creature-permlink="permlink"
          :creature-name="name"
          :unicode-art="unicodeArt"
          :ctx-feed-state="feedState"
          :ctx-feed-events="feedEvents"
          :ctx-already-fed="alreadyFedToday"
          :initial-activity-state="activityState"
          @notify="(msg,type) => notify(msg,type)"
          @feed-state-updated="onFeedStateUpdated"
          @activity-state-updated="onActivityStateUpdated"
        ></activity-panel-component>

        <!-- Social panel (upvotes, resteems, comments) — below activities -->
        <social-panel-component
          :username="username"
          :creature-author="author"
          :creature-permlink="permlink"
          :votes="votes"
          :rebloggers="rebloggers"
          :social-comments="socialComments"
          :social-loading="socialLoading"
          @notify="(msg,type) => notify(msg,type)"
          @comment-posted="onCommentPosted"
        ></social-panel-component>

        <hr/>

        <!-- Unicode render -->
        <h3 style="color:#a5d6a7;margin:16px 0 4px;">Unicode Render</h3>
        <pre :key="(currentPose || 'standing') + '_' + (feedState ? feedState.healthPct : 0)" :style="fossil ? { color:'#444', opacity:'0.6' } : {}">{{ unicodeArt }}</pre>

        <!-- Genome table -->
        <h3 style="color:#a5d6a7;margin:16px 0 4px;">Genome</h3>
        <genome-table-component :genome="genome"></genome-table-component>

        <!-- Steem post link + copy button -->
        <div v-if="steemitUrl" style="margin:16px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;">
          <!-- Effective owner indicator (shown when different from post author) -->
          <span v-if="effectiveOwner && effectiveOwner !== author"
            style="font-size:0.78rem;padding:2px 10px;border-radius:12px;
                   background:#0d1a0d;border:1px solid #2e7d32;color:#66bb6a;">
            🤝 Owned by
            <router-link :to="'/@' + effectiveOwner"
              style="color:#a5d6a7;font-weight:bold;">@{{ effectiveOwner }}</router-link>
          </span>
          <a :href="steemitUrl" target="_blank" style="font-size:13px;color:#80deea;">
            📄 View on Steemit
          </a>
          <span style="color:#333;font-size:13px;">·</span>
          <span style="font-size:12px;color:#444;">@{{ author }}/{{ permlink }}</span>
          <button
            @click="copyUrl"
            :style="{
              padding: '4px 12px',
              fontSize: '12px',
              background: urlCopied ? '#1b3a1b' : '#1a1a1a',
              color: urlCopied ? '#66bb6a' : '#555',
              border: '1px solid ' + (urlCopied ? '#2e7d32' : '#2a2a2a'),
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }"
            title="Copy Steemit URL to clipboard"
          >{{ urlCopied ? "✓ Copied!" : "📋 Copy URL" }}</button>
        </div>

        <hr/>

        <!-- ── Kinship Panel ── -->
        <div style="margin:8px 0 20px;">
          <h3 style="color:#a5d6a7;margin:0 0 12px;font-size:1rem;">🌿 Family</h3>

          <div v-if="kinshipLoading" style="color:#555;font-size:13px;margin:8px 0;">
            ⏳ Loading kinship…
          </div>
          <template v-else>

            <!-- Parents -->
            <template v-if="parentA || parentB">
              <div style="font-size:0.78rem;color:#66bb6a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Parents</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:10px;max-width:500px;">
                <template v-if="parentA">
                  <creature-card-component v-if="!parentA.isPhantom" :post="parentA"></creature-card-component>
                  <div v-else style="border:1px solid #333;border-radius:10px;padding:16px;text-align:center;background:#0a0a0a;color:#555;">
                    <div style="font-size:1.8rem;">👻</div>
                    <div style="font-size:0.78rem;margin-top:6px;">Phantom Parent</div>
                    <div style="font-size:0.68rem;color:#3a3a3a;margin-top:4px;">@{{ parentA.author }}</div>
                    <div style="font-size:0.65rem;color:#2a2a2a;margin-top:4px;font-style:italic;">Post removed from visible chain</div>
                  </div>
                </template>
                <template v-if="parentB">
                  <creature-card-component v-if="!parentB.isPhantom" :post="parentB"></creature-card-component>
                  <div v-else style="border:1px solid #333;border-radius:10px;padding:16px;text-align:center;background:#0a0a0a;color:#555;">
                    <div style="font-size:1.8rem;">👻</div>
                    <div style="font-size:0.78rem;margin-top:6px;">Phantom Parent</div>
                    <div style="font-size:0.68rem;color:#3a3a3a;margin-top:4px;">@{{ parentB.author }}</div>
                    <div style="font-size:0.65rem;color:#2a2a2a;margin-top:4px;font-style:italic;">Post removed from visible chain</div>
                  </div>
                </template>
              </div>
            </template>
            <div v-else style="font-size:12px;color:#333;margin-bottom:8px;">No parent data (origin creature)</div>

            <!-- Children -->
            <template v-if="children.length > 0">
              <div style="font-size:0.78rem;color:#66bb6a;text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 6px;">
                Children ({{ children.length }})
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:10px;max-width:920px;">
                <creature-card-component v-for="c in children" :key="c.author+'/'+c.permlink" :post="c"></creature-card-component>
              </div>
            </template>

            <!-- Siblings -->
            <template v-if="siblings.length > 0">
              <div style="font-size:0.78rem;color:#66bb6a;text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 6px;">
                Siblings ({{ siblings.length }})
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:10px;max-width:920px;">
                <creature-card-component v-for="s in siblings" :key="s.author+'/'+s.permlink" :post="s"></creature-card-component>
              </div>
            </template>

          </template>
        </div>

        <!-- Permit Manager — owner only, always visible while creature is alive -->
        <template v-if="isOwner && !fossil && !isPhantom">
          <hr/>
          <breed-permit-panel-component
            :username="username"
            :creature-author="author"
            :creature-permlink="permlink"
            :creature-name="name"
            :current-grantees="currentGrantees"
            @notify="(msg,type) => notify(msg,type)"
            @permits-updated="onPermitsUpdated"
          ></breed-permit-panel-component>
          <!-- Note: BreedPermitPanel publishes replies authored by username.
               parseBreedPermitsWithTransfer already filters by effectiveOwner,
               so permits from previous owners are automatically excluded. -->
        </template>

        <!-- Transfer Panel — shown to owner OR to pending recipient -->
        <template v-if="(isOwner || isPendingRecipient) && !isPhantom">
          <hr/>
          <transfer-panel-component
            :username="username"
            :creature-author="author"
            :creature-permlink="permlink"
            :creature-name="name"
            :transfer-state="transferState"
            :is-owner="isOwner"
            :is-pending-recipient="isPendingRecipient"
            @notify="(msg,type) => notify(msg,type)"
            @transfer-updated="onTransferUpdated"
          ></transfer-panel-component>
        </template>

        <!-- Breed panel — shown while fertile AND current user is permitted -->
        <template v-if="isFertile && isPermittedToBread">
          <hr/>
          <breeding-panel-component
            :username="username"
            :locked-a="lockedA"
            @notify="(msg,type) => notify(msg,type)"
          ></breeding-panel-component>
        </template>

        <!-- Breed locked notice — fertile but user not permitted -->
        <template v-if="isFertile && !isPermittedToBread && username && !isOwner">
          <hr/>
          <div style="margin-top:24px;padding:14px 16px;border-radius:8px;
               background:#0a0a0a;border:1px solid #333;max-width:480px;margin-left:auto;margin-right:auto;">
            <div style="font-size:0.95rem;color:#888;margin-bottom:6px;">🔒 Breeding Locked</div>
            <p style="font-size:0.82rem;color:#555;margin:0;">
              This creature is in its fertile window, but only @{{ effectiveOwner || author }} or
              users with an active breed permit may use it as a parent.
              Contact @{{ effectiveOwner || author }} to request a permit.
            </p>
          </div>
        </template>

      </template>

    </div>
  `
};



// ============================================================
// LEADERBOARD HELPERS
// ============================================================

// Compute per-author XP from a flat array of raw Steem posts (no comments).
// Returns an array of { author, xp, breakdown } sorted by XP descending.
// feedsByAuthor (optional)   : { [author]: feedsGiven }   — feed reply counts per user
// upvotesByAuthor (optional) : { [author]: upvotesGiven } — distinct creature upvote counts per user
// Both are fetched separately in LeaderboardView since they require per-user scans.
function computeLeaderboardEntries(rawPosts, feedsByAuthor = {}, upvotesByAuthor = {}) {
  const byAuthor = {};   // author -> { founders, offspring, genera:Set, speciated }

  for (const p of (rawPosts || [])) {
    let meta = {};
    try { meta = JSON.parse(p.json_metadata || "{}"); } catch {}
    const sb = meta.steembiota;
    if (!sb) continue;
    const a = p.author;
    if (!byAuthor[a]) byAuthor[a] = { founders: 0, offspring: 0, genera: new Set(), speciated: 0 };
    if (sb.type === "founder") {
      byAuthor[a].founders++;
      if (sb.genome) byAuthor[a].genera.add(sb.genome.GEN);
    } else if (sb.type === "offspring") {
      byAuthor[a].offspring++;
      if (sb.genome) byAuthor[a].genera.add(sb.genome.GEN);
      if (sb.speciated) byAuthor[a].speciated++;
    }
  }

  return Object.entries(byAuthor).map(([author, d]) => {
    const feedsGiven   = feedsByAuthor[author]   || 0;
    const upvotesGiven = upvotesByAuthor[author] || 0;
    const xp =
      d.founders   * 100 +
      d.offspring  * 500 +
      feedsGiven   * 10  +
      d.genera.size * 25 +
      d.speciated  * 75  +
      upvotesGiven * 5;
    const rank = USER_RANKS.find(r => xp >= r.minXp) || USER_RANKS[USER_RANKS.length - 1];
    return {
      author,
      xp,
      rank:    rank.title,
      icon:    rank.icon,
      breakdown: {
        founders:  d.founders,
        offspring: d.offspring,
        feedsGiven,
        upvotesGiven,
        genera:    d.genera.size,
        speciated: d.speciated
      }
    };
  }).sort((a, b) => b.xp - a.xp);
}

// ---- LeaderboardView ----
const LeaderboardView = {
  name: "LeaderboardView",
  inject: ["notify"],
  components: { LoadingSpinnerComponent },
  data() {
    return {
      entries:   [],   // sorted leaderboard rows with profile data merged
      loading:   true,
      loadError: "",
      topXp:     1     // used to scale XP bars
    };
  },
  async created() {
    this.loading   = true;
    this.loadError = "";
    const cacheKey = "steembiota:leaderboard:v1";
    const cached = readObjectCache(cacheKey, LEADERBOARD_CACHE_TTL_MS);
    if (cached && Array.isArray(cached.entries)) {
      this.entries = cached.entries;
      this.topXp = Math.max(1, cached.topXp ?? (cached.entries[0]?.xp ?? 1));
      this.loading = false;
    }
    try {
      // getDiscussionsByCreated has a hard limit of 100 per call.
      // Fetch two pages using start_author/start_permlink cursor to get ~200 posts.
      const page1 = await fetchPostsByTag("steembiota", 100);
      let allRaw = Array.isArray(page1) ? [...page1] : [];

      // Only fetch page 2 if page 1 was full (there may be more)
      if (allRaw.length === 100) {
        const last = allRaw[allRaw.length - 1];
        const page2 = await fetchPostsByTagPaged("steembiota", 100, last.author, last.permlink);
        if (Array.isArray(page2)) {
          // The first result of page2 overlaps with the last of page1 — skip it
          const fresh = page2.slice(1);
          allRaw = allRaw.concat(fresh);
        }
      }

      // First pass — compute entries without feed/upvote XP to get the author list
      const basePassed = computeLeaderboardEntries(allRaw);

      if (basePassed.length === 0) {
        this.entries = [];
        this.loading = false;
        return;
      }

      // Build a Set of known SteemBiota creature permlinks from the corpus already fetched.
      const creaturePermlinks = new Set(
        allRaw
          .filter(p => { try { return !!JSON.parse(p.json_metadata || "{}").steembiota; } catch { return false; } })
          .map(p => `${p.author}/${p.permlink}`)
      );

      // Fetch each author's feed replies AND account votes in parallel.
      // Comments: up to 100 recent; voters: up to ~1000 recent votes from Steem API.
      const authors = basePassed.map(e => e.author);
      const [commentResults, voteResults] = await Promise.all([
        Promise.allSettled(authors.map(a => fetchUserComments(a, 100))),
        Promise.allSettled(authors.map(a => fetchAccountVotes(a))),
      ]);

      // Count feed replies per author
      const feedsByAuthor = {};
      commentResults.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        let count = 0;
        for (const c of (result.value || [])) {
          let meta = {};
          try { meta = JSON.parse(c.json_metadata || "{}"); } catch {}
          if (meta.steembiota?.type === "feed") count++;
        }
        if (count > 0) feedsByAuthor[authors[i]] = count;
      });

      // Count distinct SteemBiota creature upvotes per author
      const upvotesByAuthor = {};
      voteResults.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        const count = (result.value || [])
          .filter(v => creaturePermlinks.has(`${v.author}/${v.permlink}`))
          .length;
        if (count > 0) upvotesByAuthor[authors[i]] = count;
      });

      // Re-compute with feed and upvote XP included
      const computed = computeLeaderboardEntries(allRaw, feedsByAuthor, upvotesByAuthor);

      // Batch-fetch all author profiles in one API call
      const profiles = await fetchAccountsBatch(authors);

      this.entries = computed.map(e => ({
        ...e,
        profile: profiles[e.author] || { username: e.author, displayName: e.author, profileImage: "", about: "" }
      }));
      this.topXp = Math.max(1, this.entries[0]?.xp ?? 1);
      writeObjectCache(cacheKey, { entries: this.entries, topXp: this.topXp });
    } catch (e) {
      if (!cached) this.loadError = e.message || "Failed to load leaderboard.";
    }
    this.loading = false;
  },
  methods: {
    safeUrl(url) {
      try { return new URL(url).protocol === "https:" ? url : ""; } catch { return ""; }
    },
    medalColor(rank) {
      if (rank === 1) return "#ffd700";
      if (rank === 2) return "#c0c0c0";
      if (rank === 3) return "#cd7f32";
      return "#444";
    },
    rankColor(rankTitle) {
      const colors = {
        "Progenitor":   "#ffd700",
        "Evolutionist": "#80deea",
        "Ecologist":    "#a5d6a7",
        "Breeder":      "#f48fb1",
        "Cultivator":   "#66bb6a",
        "Naturalist":   "#90caf9",
        "Wanderer":     "#555"
      };
      return colors[rankTitle] || "#555";
    }
  },
  template: `
    <div style="margin-top:20px;padding:0 16px 40px;">
      <h2 style="color:#a5d6a7;margin:0 0 4px;font-size:1.1rem;letter-spacing:0.05em;">🏆 Leaderboard</h2>
      <p style="font-size:12px;color:#444;margin:0 0 20px;">
        Ranked by XP from founders, offspring, feeds given, upvotes cast, genera contributed &amp; speciation events.
      </p>

      <loading-spinner-component v-if="loading"></loading-spinner-component>
      <div v-else-if="loadError" style="color:#ff8a80;font-size:13px;">⚠ {{ loadError }}</div>
      <div v-else-if="entries.length === 0" style="color:#555;font-size:13px;">No activity on-chain yet.</div>

      <div v-else style="max-width:700px;margin:0 auto;display:flex;flex-direction:column;gap:10px;">
        <router-link
          v-for="(entry, idx) in entries"
          :key="entry.author"
          :to="'/@' + entry.author"
          style="text-decoration:none;"
        >
          <div :style="{
            background: idx === 0 ? 'linear-gradient(135deg,#1a2a0a,#0f1a0f)' : '#111',
            border: '1px solid ' + (idx < 3 ? medalColor(idx+1) : '#222'),
            borderRadius: '10px',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            transition: 'background 0.15s',
            cursor: 'pointer'
          }"
          @mouseover="$event.currentTarget.style.background='#1a2a1a'"
          @mouseleave="$event.currentTarget.style.background = idx===0 ? 'linear-gradient(135deg,#1a2a0a,#0f1a0f)' : '#111'"
          >
            <!-- Position number -->
            <div :style="{
              minWidth: '28px',
              textAlign: 'center',
              fontWeight: 'bold',
              fontSize: idx < 3 ? '1.2rem' : '0.85rem',
              color: medalColor(idx+1),
              flexShrink: 0
            }">
              {{ idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx+1) }}
            </div>

            <!-- Avatar -->
            <img
              v-if="safeUrl(entry.profile.profileImage)"
              :src="safeUrl(entry.profile.profileImage)"
              @error="$event.target.style.display='none'"
              style="width:38px;height:38px;border-radius:50%;object-fit:cover;border:1px solid #333;flex-shrink:0;"
            />
            <div v-else style="width:38px;height:38px;border-radius:50%;background:#1a2e1a;border:1px solid #333;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1rem;">
              🌿
            </div>

            <!-- Name + rank + XP bar -->
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
                <span style="font-size:0.9rem;font-weight:bold;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">
                  {{ entry.profile.displayName }}
                </span>
                <span style="font-size:0.72rem;color:#555;">@{{ entry.author }}</span>
                <span :style="{
                  fontSize: '0.7rem',
                  color: rankColor(entry.rank),
                  background: '#111',
                  border: '1px solid #2a2a2a',
                  borderRadius: '10px',
                  padding: '1px 7px',
                  whiteSpace: 'nowrap'
                }">{{ entry.icon }} {{ entry.rank }}</span>
              </div>

              <!-- XP bar -->
              <div style="margin-top:5px;background:#1a1a1a;border-radius:4px;height:5px;overflow:hidden;max-width:360px;">
                <div :style="{
                  width: Math.round((entry.xp / topXp) * 100) + '%',
                  height: '100%',
                  background: 'linear-gradient(90deg,#2e7d32,#66bb6a)',
                  borderRadius: '4px'
                }"></div>
              </div>

              <!-- Activity breakdown -->
              <div style="font-size:0.68rem;color:#444;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                <span style="color:#66bb6a;font-weight:bold;">{{ entry.xp }} XP</span>
                &nbsp;·&nbsp; 🌱 {{ entry.breakdown.founders }}
                &nbsp;·&nbsp; 🐣 {{ entry.breakdown.offspring }}
                <template v-if="entry.breakdown.feedsGiven > 0">
                  &nbsp;·&nbsp; 🍯 {{ entry.breakdown.feedsGiven }} feeds
                </template>
                <template v-if="entry.breakdown.upvotesGiven > 0">
                  &nbsp;·&nbsp; ❤️ {{ entry.breakdown.upvotesGiven }} upvotes
                </template>
                &nbsp;·&nbsp; 🔬 {{ entry.breakdown.genera }} genera
                <template v-if="entry.breakdown.speciated > 0">
                  &nbsp;·&nbsp; ⚡ {{ entry.breakdown.speciated }} spec.
                </template>
              </div>
            </div>
          </div>
        </router-link>
      </div>
    </div>
  `
};


// ---- NotificationsView ----
// Shows all recent on-chain interactions relevant to the logged-in user:
// feed, play, walk, birth (offspring from user's creature), breed (someone
// used user's creature as a parent), and transfer_offer (pending ownership
// handoffs where this user is the named recipient).
const NotificationsView = {
  name: "NotificationsView",
  inject: ["username", "notify"],
  data() {
    return {
      loading:       true,
      loadError:     "",
      notifications: [],
      accepting:     {},   // offerPermlink → true while publishing accept
    };
  },
  async created() {
    if (!this.username) {
      this.loading = false;
      return;
    }
    this.loading = true;
    const cacheKey = `steembiota:notifications:${String(this.username).toLowerCase()}:v1`;
    const cached = readObjectCache(cacheKey, NOTIFICATIONS_CACHE_TTL_MS);
    if (cached && Array.isArray(cached.notifications)) {
      this.notifications = cached.notifications;
      this.loading = false;
    }
    try {
      const fresh = await fetchNotificationsForUser(this.username, 50);
      this.notifications = Array.isArray(fresh) ? fresh : [];
      writeObjectCache(cacheKey, { notifications: this.notifications });
    } catch (e) {
      if (!cached) this.loadError = e.message || "Failed to load notifications.";
    }
    this.loading = false;
  },
  computed: {
    hasAny() { return this.notifications.length > 0; },
    pendingOffers() {
      return this.notifications.filter(n => n.type === "transfer_offer");
    }
  },
  methods: {
    icon(type) {
      return {
        feed:           "🍖",
        play:           "🎾",
        walk:           "🐾",
        birth:          "🐣",
        breed:          "🧬",
        transfer_offer: "🤝"
      }[type] || "📢";
    },
    label(n) {
      const clink = `/#/@${n.creatureAuthor}/${n.creaturePermlink}`;
      const cname = n.creatureName || n.creatureAuthor;
      switch (n.type) {
        case "feed":
          return `@${n.actor} fed <strong>${cname}</strong> (${n.extra?.food || "food"})`;
        case "play":
          return `@${n.actor} played with <strong>${cname}</strong>`;
        case "walk":
          return `@${n.actor} walked <strong>${cname}</strong>`;
        case "birth":
          return `@${n.actor} bred an offspring from <strong>${cname}</strong>`;
        case "breed":
          return `@${n.actor} used <strong>${cname}</strong>'s lineage to breed a new creature`;
        case "transfer_offer":
          return `@${n.actor} is offering you ownership of <strong>${cname}</strong>`;
        default:
          return `@${n.actor} interacted with <strong>${cname}</strong>`;
      }
    },
    timeAgo(ts) {
      const diff = (Date.now() - new Date(ts)) / 1000;
      if (diff < 60)    return Math.round(diff) + "s ago";
      if (diff < 3600)  return Math.round(diff / 60) + "m ago";
      if (diff < 86400) return Math.round(diff / 3600) + "h ago";
      return Math.round(diff / 86400) + "d ago";
    },
    async acceptOffer(n) {
      if (!window.steem_keychain) {
        this.notify("Steem Keychain not installed.", "error");
        return;
      }
      const key = n.extra.offerPermlink;
      this.accepting = { ...this.accepting, [key]: true };
      publishTransferAccept(
        this.username,
        n.creatureAuthor,
        n.creaturePermlink,
        n.creatureName,
        n.extra.offerPermlink,
        (res) => {
          const accepting = { ...this.accepting };
          delete accepting[key];
          this.accepting = accepting;
          if (res.success) {
            invalidateGlobalListCaches();
            invalidateOwnedCachesForUser(this.username);
            invalidateCreatureCache(n.creatureAuthor, n.creaturePermlink);
            this.notify(`✅ You now own ${n.creatureName}! Visit your profile to see it.`, "success");
            // Remove this offer from the list
            this.notifications = this.notifications.filter(
              x => !(x.type === "transfer_offer" &&
                     x.creatureAuthor === n.creatureAuthor &&
                     x.creaturePermlink === n.creaturePermlink)
            );
            const cacheKey = `steembiota:notifications:${String(this.username).toLowerCase()}:v1`;
            writeObjectCache(cacheKey, { notifications: this.notifications });
          } else {
            this.notify("Accept failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    }
  },
  template: `
    <div style="margin-top:20px;padding:0 16px;max-width:720px;margin-left:auto;margin-right:auto;">

      <h2 style="color:#a5d6a7;margin:0 0 4px;">🔔 Notifications</h2>

      <div v-if="!username" style="color:#555;font-size:14px;margin-top:16px;">
        Please log in to see your notifications.
      </div>

      <loading-spinner-component v-else-if="loading"></loading-spinner-component>

      <div v-else-if="loadError" style="color:#ff8a80;font-size:13px;">⚠ {{ loadError }}</div>

      <template v-else>

        <!-- Pending transfer offers banner — shown at top for urgency -->
        <div
          v-if="pendingOffers.length"
          style="margin-bottom:20px;padding:14px 16px;border-radius:10px;
                 background:#0d1a0d;border:1px solid #2e7d32;"
        >
          <div style="font-size:0.9rem;font-weight:bold;color:#a5d6a7;margin-bottom:10px;">
            🤝 {{ pendingOffers.length }} Pending Transfer Offer{{ pendingOffers.length > 1 ? "s" : "" }}
          </div>
          <div
            v-for="n in pendingOffers"
            :key="n.creatureAuthor + n.creaturePermlink"
            style="padding:10px 0;border-bottom:1px solid #1a2a1a;display:flex;
                   align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;"
          >
            <div>
              <span style="font-size:0.85rem;color:#ccc;">
                @{{ n.actor }} → <strong style="color:#a5d6a7;">{{ n.creatureName }}</strong>
              </span>
              <div style="font-size:0.72rem;color:#555;margin-top:2px;">
                <router-link :to="'/@' + n.creatureAuthor + '/' + n.creaturePermlink"
                  style="color:#555;text-decoration:underline;">
                  view creature page
                </router-link>
              </div>
            </div>
            <button
              @click="acceptOffer(n)"
              :disabled="accepting[n.extra.offerPermlink]"
              style="background:#1a3a1a;font-size:0.8rem;padding:6px 14px;
                     border:1px solid #2e7d32;border-radius:6px;"
            >
              {{ accepting[n.extra.offerPermlink] ? "Publishing…" : "✅ Accept" }}
            </button>
          </div>
        </div>

        <div v-if="!hasAny" style="color:#555;font-size:13px;margin-top:8px;">
          No notifications yet. When others feed, play with, or breed from your
          creatures — or offer you a transfer — it will appear here.
        </div>

        <!-- Full activity feed -->
        <div v-else>
          <p style="font-size:12px;color:#444;margin:0 0 12px;">
            {{ notifications.length }} recent event{{ notifications.length === 1 ? "" : "s" }}
          </p>
          <div
            v-for="(n, i) in notifications"
            :key="i"
            style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;
                   border-bottom:1px solid #151515;"
          >
            <!-- Icon -->
            <div style="font-size:1.3rem;line-height:1;padding-top:2px;flex-shrink:0;">
              {{ icon(n.type) }}
            </div>
            <!-- Body -->
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.84rem;color:#ccc;line-height:1.4;" v-html="label(n)"></div>
              <div style="display:flex;gap:12px;align-items:center;margin-top:5px;flex-wrap:wrap;">
                <span style="font-size:0.72rem;color:#444;">{{ timeAgo(n.ts) }}</span>
                <router-link
                  :to="'/@' + n.creatureAuthor + '/' + n.creaturePermlink"
                  style="font-size:0.72rem;color:#555;text-decoration:underline;"
                >
                  view creature
                </router-link>
                <router-link
                  v-if="n.type === 'birth' && n.extra.childAuthor"
                  :to="'/@' + n.extra.childAuthor + '/' + n.extra.childPermlink"
                  style="font-size:0.72rem;color:#555;text-decoration:underline;"
                >
                  view offspring
                </router-link>
              </div>
            </div>
            <!-- Inline accept for transfer offers in the feed -->
            <div v-if="n.type === 'transfer_offer'" style="flex-shrink:0;">
              <button
                @click="acceptOffer(n)"
                :disabled="accepting[n.extra.offerPermlink]"
                style="background:#1a3a1a;font-size:0.75rem;padding:5px 10px;
                       border:1px solid #2e7d32;border-radius:6px;"
              >
                {{ accepting[n.extra.offerPermlink] ? "…" : "✅ Accept" }}
              </button>
            </div>
          </div>
        </div>
      </template>

    </div>
  `
};

const routes = [
  { path: "/",                                      component: HomeView          },
  { path: "/accessories",                           component: AccessoriesView   },
  { path: "/about",                                 component: AboutView         },
  { path: "/leaderboard",                           component: LeaderboardView   },
  { path: "/notifications",                         component: NotificationsView },
  { path: "/@:author/:permlink",  name: "CreatureView",     component: CreatureView      },
  { path: "/acc/@:author/:permlink", name: "AccessoryItemView", component: AccessoryItemView },
  { path: "/@:user",              component: ProfileView       },
  { path: "/upload", component: UploadView },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

// ============================================================
// ROOT APP
// ============================================================

const App = {
  components: {
    AppNotificationComponent,
    AuthComponent,
    UserProfileComponent,
    LoadingSpinnerComponent,
    CreatureCanvasComponent,
    GenomeTableComponent,
    GlobalProfileBannerComponent
  },

  setup() {
    const username      = ref(localStorage.getItem("steem_user") || "");
    const hasKeychain   = ref(false);
    const keychainReady = ref(false);
    const loginError    = ref("");
    const showLoginForm = ref(false);
    const isLoggingIn   = ref(false);
    const notification  = ref({ message: "", type: "error" });
    const profileData   = ref(null);
    const userLevel     = ref(null);   // computed from on-chain activity

    async function loadProfile(user) {
      if (!user) {
        // No logged-in user — show @steembiota's profile as the site identity
        profileData.value = await fetchAccount("steembiota");
        userLevel.value   = null;
        return;
      }
      profileData.value = await fetchAccount(user);
      // Load level data in parallel (best-effort — failure is non-fatal)
      try {
        const [posts, comments, accountVotes] = await Promise.all([
          fetchPostsByUser(user, 100),
          fetchUserComments(user, 100),
          fetchAccountVotes(user)
        ]);

        // Build a set of SteemBiota creature permlinks the user has upvoted.
        // accountVotes contains { author, permlink } for every post they voted on.
        // We cross-reference against the user's own post list plus all steembiota
        // posts visible on the home feed to identify which are creature posts.
        // For the profile banner we use a lightweight approach: fetch the tag corpus
        // and mark any vote whose target has steembiota json_metadata.
        // To keep this fast we resolve only against the already-fetched posts list
        // (the user's own creatures) plus a shared tag corpus fetch.
        const ownPermlinks = new Set(
          (Array.isArray(posts) ? posts : []).map(p => `${p.author}/${p.permlink}`)
        );

        // Fetch the broader corpus of steembiota posts to resolve foreign votes
        let corpusPermlinks = new Set();
        try {
          const page1 = await fetchPostsByTag("steembiota", 100);
          const corpus = Array.isArray(page1) ? [...page1] : [];
          if (corpus.length === 100) {
            const last = corpus[corpus.length - 1];
            const page2 = await fetchPostsByTagPaged("steembiota", 100, last.author, last.permlink);
            if (Array.isArray(page2)) corpus.push(...page2.slice(1));
          }
          corpusPermlinks = new Set(
            corpus
              .filter(p => { try { return !!JSON.parse(p.json_metadata || "{}").steembiota; } catch { return false; } })
              .map(p => `${p.author}/${p.permlink}`)
          );
        } catch { /* non-fatal — fall back to own posts only */ }

        const allCreaturePermlinks = new Set([...ownPermlinks, ...corpusPermlinks]);
        const upvotedCreaturePermlinks = new Set(
          (accountVotes || [])
            .map(v => `${v.author}/${v.permlink}`)
            .filter(key => allCreaturePermlinks.has(key))
        );

        userLevel.value = computeUserLevel(
          Array.isArray(posts)    ? posts    : [],
          Array.isArray(comments) ? comments : [],
          upvotedCreaturePermlinks
        );
      } catch (e) {
        console.warn("Level load failed:", e);
        userLevel.value = null;
      }
    }

    // ── Notification badge — count of pending transfer offers ──
    // Polled on login + every 5 minutes. Lightweight: only fetches the
    // user's own creature posts then scans their replies for pending offers.
    const notifBadgeCount = ref(0);
    let _notifPollTimer = null;

    async function refreshNotifBadge(user) {
      if (!user) { notifBadgeCount.value = 0; return; }
      try {
        const notifs = await fetchNotificationsForUser(user, 50);
        notifBadgeCount.value = notifs.filter(n => n.type === "transfer_offer").length;
      } catch { /* non-fatal */ }
    }

    function notify(message, type = "error") {
      notification.value = { message, type };
    }
    function dismissNotification() {
      notification.value = { message: "", type: "error" };
    }

    onMounted(() => {
      setRPC(0);
      // Always load a profile — logged-in user's own, or @steembiota as fallback
      loadProfile(username.value || "");
      // Start notification badge polling if already logged in
      if (username.value) {
        refreshNotifBadge(username.value);
        _notifPollTimer = setInterval(() => refreshNotifBadge(username.value), 5 * 60 * 1000);
      }
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (window.steem_keychain || attempts > 10) {
          clearInterval(interval);
          hasKeychain.value   = !!window.steem_keychain;
          keychainReady.value = true;
        }
      }, 100);
    });

    function login(user) {
      loginError.value = "";
      if (!window.steem_keychain) {
        loginError.value = "Steem Keychain extension is not installed.";
        return;
      }
      if (!user) return;
      isLoggingIn.value = true;
      keychainLogin(user, (res) => {
        isLoggingIn.value = false;
        if (!res.success) {
          loginError.value = "Keychain sign-in was rejected.";
          return;
        }
        const verified = res.data?.username || res.username;
        if (verified !== user) {
          loginError.value = "Signed account does not match entered username.";
          return;
        }
        username.value      = user;
        hasKeychain.value   = true;
        localStorage.setItem("steem_user", user);
        loginError.value    = "";
        showLoginForm.value = false;
        notify("Logged in as @" + user, "success");
        loadProfile(user);
        // Start notification badge polling on login
        refreshNotifBadge(user);
        if (_notifPollTimer) clearInterval(_notifPollTimer);
        _notifPollTimer = setInterval(() => refreshNotifBadge(user), 5 * 60 * 1000);
      });
    }

    function logout() {
      username.value = "";
      localStorage.removeItem("steem_user");
      showLoginForm.value = false;
      notifBadgeCount.value = 0;
      if (_notifPollTimer) { clearInterval(_notifPollTimer); _notifPollTimer = null; }
      loadProfile(""); // fall back to @steembiota
    }

    provide("username",    username);
    provide("hasKeychain", hasKeychain);
    provide("notify",      notify);
    provide("profileData", profileData);

    return {
      username, hasKeychain, keychainReady,
      loginError, showLoginForm, isLoggingIn,
      notification, notify, dismissNotification,
      login, logout, profileData, userLevel,
      notifBadgeCount
    };
  },

  template: `
    <h1>🌿 SteemBiota — Immutable Evolution</h1>

    <!-- Navigation -->
    <nav>
      <router-link to="/"            exact-active-class="nav-active">Home</router-link>
      <router-link to="/accessories" exact-active-class="nav-active">✨ Accessories</router-link>
      <router-link v-if="username" to="/upload" exact-active-class="nav-active">📸 Upload</router-link>
      <router-link
        v-if="username"
        :to="'/@' + username"
        exact-active-class="nav-active"
      >Profile</router-link>
      <router-link to="/leaderboard" exact-active-class="nav-active">🏆 Leaderboard</router-link>
      <router-link to="/about"       exact-active-class="nav-active">About</router-link>

      <!-- Notifications link — only shown when logged in, with badge for pending offers -->
      <router-link
        v-if="username"
        to="/notifications"
        exact-active-class="nav-active"
        style="position:relative;"
      >
        🔔
        <span
          v-if="notifBadgeCount > 0"
          style="position:absolute;top:-6px;right:-10px;
                 background:#e53935;color:#fff;font-size:0.6rem;font-weight:bold;
                 border-radius:50%;min-width:16px;height:16px;line-height:16px;
                 text-align:center;padding:0 2px;"
        >{{ notifBadgeCount }}</span>
      </router-link>

      <a v-if="!username" href="#" @click.prevent="showLoginForm = !showLoginForm">Login</a>
      <a v-else           href="#" @click.prevent="logout">Logout (@{{ username }})</a>
    </nav>

    <!-- Inline login form -->
    <div v-if="!username && showLoginForm" style="margin:8px 0;">
      <auth-component
        :username="username"
        :has-keychain="hasKeychain"
        :login-error="loginError"
        :is-logging-in="isLoggingIn"
        @login="login"
        @logout="logout"
        @close="showLoginForm = false"
      ></auth-component>
    </div>

    <!-- Keychain not detected notice -->
    <div v-if="keychainReady && !hasKeychain" class="keychain-notice">
      <strong>Read-only mode</strong> — Install the
      <a href="https://www.google.com/search?q=steem+keychain" target="_blank" style="color:#ffe082;">
        Steem Keychain
      </a>
      browser extension to publish creatures.
    </div>

    <!-- Global notification -->
    <app-notification-component
      :message="notification.message"
      :type="notification.type"
      @dismiss="dismissNotification"
    ></app-notification-component>

    <!-- Global profile banner — logged-in user, or @steembiota as fallback -->
    <global-profile-banner-component
      :profile-data="profileData"
      :user-level="userLevel"
      :is-logged-in="!!username"
    ></global-profile-banner-component>

    <hr/>

    <!-- Page content -->
    <router-view></router-view>
  `
};

// ============================================================
// MOUNT
// ============================================================

const vueApp = createApp(App);

vueApp.component("AppNotificationComponent",    AppNotificationComponent);
vueApp.component("AuthComponent",               AuthComponent);
vueApp.component("UserProfileComponent",        UserProfileComponent);
vueApp.component("LoadingSpinnerComponent",     LoadingSpinnerComponent);
vueApp.component("CreatureCanvasComponent",     CreatureCanvasComponent);
vueApp.component("AccessoryCanvasComponent",    AccessoryCanvasComponent);
vueApp.component("AccessoryCardComponent",      AccessoryCardComponent);
vueApp.component("WearPanelComponent",          WearPanelComponent);
vueApp.component("EquipPanelComponent",         EquipPanelComponent);
vueApp.component("AccessoryItemView",           AccessoryItemView);
vueApp.component("GenomeTableComponent",        GenomeTableComponent);
vueApp.component("BreedingPanelComponent",      BreedingPanelComponent);
vueApp.component("BreedPermitPanelComponent",   BreedPermitPanelComponent);
vueApp.component("TransferPanelComponent",       TransferPanelComponent);
vueApp.component("SocialPanelComponent",          SocialPanelComponent);
vueApp.component("GlobalProfileBannerComponent", GlobalProfileBannerComponent);
vueApp.component("ActivityPanelComponent",      ActivityPanelComponent);
vueApp.component("CreatureView",                CreatureView);
vueApp.component("LeaderboardView",             LeaderboardView);
vueApp.component("UploadView", UploadView);

vueApp.use(router);
vueApp.mount("#app");
