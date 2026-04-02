# SteemBiota — Immutable Evolution

**SteemBiota** is a decentralised life simulation built on the **Steem blockchain**.

Creatures are generated from deterministic **genomes**, rendered procedurally as canvas paintings, and their entire existence — from birth through feeding, play, walking, breeding, ownership transfer, and fossilisation — is **permanently recorded on-chain**.

SteemBiota also includes an **Accessory system**: users can procedurally generate wearable items, publish them on-chain, browse all accessories, and transfer ownership using the same two-sided handshake protocol used by creatures.

🌐 **Live app:** https://puncakbukit.github.io/steembiota

---

## Concept

SteemBiota explores digital organisms whose evolution is permanently stored on a blockchain.

Each creature has a compact genome that determines its body shape, colour, lifespan, and fertility window. Once published via Steem Keychain, the genome is immutable. A creature's lifecycle plays out in real time measured in days, and every interaction — feeding, playing, walking, breeding — is stored as a blockchain reply. The blockchain becomes the ecosystem's permanent fossil record.

Creatures can be **transferred between owners** via a two-sided on-chain handshake. Ownership is a derived concept — the original `post.author` never changes, but SteemBiota walks the reply history to determine the current effective owner at read time.

---

## Technology Stack

The dApp runs entirely in the browser with no build tools and no backend.

| Layer | Technology |
|---|---|
| Blockchain | Steem (via steem-js) |
| Signing | Steem Keychain browser extension |
| UI Framework | Vue 3 (CDN) + Vue Router 4 (CDN) |
| Routing | Vue Router 4 (CDN, hash mode) |
| Hosting | GitHub Pages |
| Build tools | None |

Files: `index.html`, `blockchain.js`, `components.js`, `accessories.js`, `app.js`

---

## Creature Genome

Each creature is defined by ten integer genes:

| Gene | Description | Range |
|---|---|---|
| `GEN` | Genus ID — species barrier | 0–999 |
| `SX` | Sex (0 = Male, 1 = Female) | 0–1 |
| `MOR` | Morphology seed — body shape and tail style | 0–9999 |
| `APP` | Appendage seed — ear shape, paw shape, wing presence | 0–9999 |
| `ORN` | Ornamentation seed — glow orbs, mane, pattern accent | 0–9999 |
| `CLR` | Colour hue offset | 0–359 degrees |
| `LIF` | Lifespan in real days | 80–159 |
| `FRT_START` | Fertility window start (days) | varies |
| `FRT_END` | Fertility window end (days) | varies |
| `MUT` | Mutation tendency — affects offspring variation | 0–2 (founders); 0–5 (bred offspring) |

The genome is stored inside every creature post in a fenced code block and in `json_metadata`, so any client can reconstruct the creature directly from the blockchain.

### Genus Names

Each GEN value maps to a stable procedurally-generated genus name (e.g. `GEN 42` → *Vyrex*). The name is derived solely from the GEN integer so all creatures of the same genus share the same name regardless of their other genes. Genus names appear in the genome table, on creature cards, in post bodies, and as a filter option on the Home and Profile pages.

---

## Lifecycle

Creature age is measured in **real days** since the post was published. Lifecycle stage is calculated as a percentage of LIF, adjusted for any lifespan bonuses from feeding and walk activity.

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

If a post is deleted on Steem (`delete_comment` op), the API returns the post with an empty `author` field. SteemBiota detects this as a **phantom** — distinct from a fossil (natural end-of-life). The creature page shows a 👻 tombstone screen with a lore explanation. Phantoms cannot be fed, played with, walked, or bred. If any ancestor in a breeding chain is phantom, the breeding attempt is blocked entirely to prevent inbreeding check evasion.

---

## Visual Rendering — Canvas

Every creature is rendered procedurally from its genome on a 400×320 HTML5 Canvas. The same genome always produces the same base visual. Three sources of per-load variation are layered on top: random facing direction, random pose, and live expression driven by game state.

### Anatomy (painter's algorithm, back to front)

Ground shadow → energy ribbons → back legs (dimmed for depth) → tail → torso with gradient → chest marking → body pattern → front legs → neck → mane wisps → head with snout and nose → ears → eye → **face expression overlay** → dorsal wing/fin → glowing orb nodes → fertility aura

### Genome → Visual Mapping

| Gene | Visual effect |
|---|---|
| `GEN` | Colour palette family (8 palette groups) |
| `MOR` | Body length, body height, head size, tail curl |
| `APP` | Leg length, leg thickness, ear height/width, wing presence |
| `ORN` | Glow orb count and hue, chest marking, mane wisps, body pattern type |
| `CLR` | Hue offset applied on top of palette base |
| `LIF` / age | Body scale (45% at birth → 100% at Young Adult → 75% at Fossil) |
| Feed health | Colour saturation and lightness boost |

### Facing Direction

On each page load the creature is mirrored left or right at random via a canvas transform. The direction is stable for the lifetime of that component instance.

### Poses

On each page load the creature is assigned one of five poses at random. The pose is stable for the lifetime of that component instance.

| Pose | Description |
|---|---|
| 🐾 Standing | Default upright side profile |
| 👀 Alert | Torso raised, head lifted high, tail swept straight up |
| 🎉 Playful | Play-bow: front legs stretched forward and low, rear elevated, tail up |
| 🪑 Sitting | Torso tilted rear-down (~17°), folded haunches resting on the ground, front legs straight, tail wrapped under body |
| 💤 Sleeping | Body flat and low, head resting on ground, all legs tucked as flat pads, tail curled under, eye closed |

The torso ellipse rotation, haunch/leg positions, head and neck angle, tail shape, and shadow scale are all adjusted per pose. Fossil creatures always render in a flat fossilised form regardless of pose. A small italic label below the canvas shows the active pose.

### Face Expressions

Expressions are derived from live game state (feedState + activityState) and re-evaluated whenever data reloads. Pose overrides take highest priority.

| Expression | Trigger | Visual |
|---|---|---|
| 😴 Sleepy | Sleeping pose | Closed-eye arc, drooped heavy brow, tiny neutral mouth |
| 👀 Alert | Alert pose | Enlarged eye (×1.15), raised straight brow, neutral mouth |
| 🎉 Excited | Playful pose | Wide open smile + tongue dot, arched brow, star glints beside eye |
| ✨ Thriving | Health ≥ 80% (or play-boosted) | Big smile + tongue, raised brow, rosy cheek blush, star glints |
| 😊 Happy | Health ≥ 55% | Gentle smile, relaxed raised brow |
| 😐 Content | Health ≥ 30% or no data yet | Neutral straight mouth, flat brow |
| 😟 Hungry | Health > 0% but < 30% | Slight frown, one-sided worried brow, pupil shifted down |
| 😢 Sad | Completely unfed (health = 0%) | Pronounced frown, inward V-brow, teardrop below eye, pupil down |

Play activity adds up to +25% to the effective health score before picking the expression, so a well-played but underfed creature can still appear happier. Expressions only appear from Toddler stage onward.

### Reaction Animation

Whenever a creature is successfully fed, played with, or walked, the canvas plays a short reaction sequence. The creature cycles through four pose+expression pairs (Standing→Alert→Playful→Sitting, paired with Alert→Alert→Excited→Happy), repeated 2–3 times at random, each step lasting 2–3 seconds. After the sequence finishes the creature returns to its resting pose and normal game-state expression. Any in-progress animation is cancelled and restarted if another interaction completes while it is running.

---

## Visual Rendering — Unicode

Used inside Steem post bodies so the creature's form is stored permanently on-chain as plain text.

Art width grows with lifecycle stage (14 chars at Baby up to 36 at Young Adult, back to 30 at Elder, 24 at Fossil). Row structure: ears and mane above, optional dorsal wing, body rows (head / body / tail zones), leg columns below. Fertile creatures show sparkle characters in the header line.

| Gene | Unicode effect |
|---|---|
| `MOR` mod 6 | Body fill palette and tail character style |
| `APP` mod 4 | Ear and paw shape |
| `APP` mod 5 | Dorsal wing presence (rare) |
| `ORN` mod 6 | Ornament and orb glyph |
| `ORN` mod 3 | Mane presence |
| `ORN` continuous | Orb count (1–4) and position |
| `GEN` mod 4 | Eye glyph |
| `GEN` mod 6 | Header sigil |

---

## Accessory System

SteemBiota supports procedurally generated, on-chain **accessories** in addition to creatures.

- Accessory creation and browsing live on `/#/accessories`.
- Each accessory has its own deterministic **Accessory Genome** and render template.
- Published accessories are regular Steem posts with `json_metadata.steembiota.type = "accessory"`.
- Accessories support the same transfer offer / accept / cancel ownership flow as creatures.
- Accessory item pages live at `/#/acc/@author/permlink`.

### Accessory templates

Five templates are currently implemented:

- 🎩 Hat
- 👑 Crown
- 📿 Necklace
- 👕 Shirt
- 🪽 Wings

### Accessory genome (10 parameters)

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

Accessory names are generated deterministically from template + genome (material adjective + type-specific noun).

---

## Activities

All three creature interactions — feeding, play, and walking — are presented in a single unified **🌿 Activities** panel on the creature page, directly below the canvas so reactions are visible while interacting. Each action is published as a blockchain reply. Fossil creatures cannot receive any activities.

### Feed 🍃

Feeding improves the creature's **health**, which affects its canvas expression, lifespan, and fertility window.

**Food types:**

| Food | Lifespan bonus | Fertility boost |
|---|---|---|
| 🍯 Nectar | +1 day per feed | none |
| 🍎 Fruit | +0.5 days per feed | +10% per feed |
| 💎 Crystal | none | +5% per feed |

**Feed rules:**

- Each feeder is counted at most once per UTC day (anti-spam).
- Total feeds are capped at 20 per creature lifetime.
- Owner feeds count 3× toward the health score; community feeds count 1×.
- Maximum lifespan bonus from feeding: +20% of base LIF.
- Maximum fertility boost from community feeding: +25% of the base window width.

**Health states:**

| State | Threshold |
|---|---|
| ✨ Thriving | 80%+ |
| ✦ Well-fed | 55%+ |
| • Nourished | 30%+ |
| · Hungry | above 0% |
| · Unfed | 0% |

### Play 🎮

Playing improves the creature's **mood**, which widens its effective fertility window and boosts its canvas expression.

- Each player is counted at most once per UTC day (anti-spam). Lifetime cap: 15 play events.
- Owner plays count 2×; community plays count 1×.
- **Mood score** (0–100%) scales linearly from total weighted play count.
- **Fertility extension**: up to +10 days added to each side of the fertility window at max mood.
- Mood label shown as a purple badge in the creature page header.

### Walk 🦮

Walking builds the creature's **vitality**, which extends its effective lifespan.

- Each walker is counted at most once per UTC day (anti-spam). Lifetime cap: 15 walk events.
- Owner walks count 2×; community walks count 1×.
- **Vitality score** (0–100%) scales linearly from total weighted walk count.
- **Lifespan bonus**: up to +10 extra days at max vitality.
- Vitality label shown as a teal badge in the creature page header.

### Panel Layout

The Activities panel shows a health bar and a stats row (feeds · play · walk counts) above three side-by-side action cards (green / purple / teal). Each card shows the current daily status and disables its button once the daily limit has been used. A "Come back tomorrow!" message appears after a successful action.

---

## Breeding

Users pair two compatible creatures to produce an offspring. On the creature page, **Parent A is locked to the current creature** and only Parent B needs to be entered. The breeding section only appears when the current creature is within its **effective fertility window** — the base window (`FRT_START`–`FRT_END`) expanded on both sides by any play mood bonus and feed fertility boost. The child genome is generated deterministically and published as a new Steem post.

### Compatibility Rules

All of the following must be true:

1. Same GEN (same genus)
2. Opposite SX (one Male, one Female)
3. Both creatures are within their effective fertility window at the time of breeding
4. Neither creature is the other's close relative (see Kinship Rules below)
5. The user has a valid breed permit for both creatures (see Breed Permits below)

### Gene Inheritance

Each gene is inherited from one parent chosen at random (50/50), then potentially mutated. Mutation probability per gene = 1% × (1 + MUT_A + MUT_B). Breeding is deterministic: the same two parents always produce the same child, using a seeded PRNG (mulberry32) keyed on both parent genomes.

### Speciation

There is a 0.5% chance per breeding event that the child's GEN mutates to an entirely new value, creating a new genus. Speciated offspring cannot breed with their parents' genus.

### Kinship Rules

SteemBiota walks the blockchain ancestry graph before allowing a breed. A creature cannot breed with:

1. Its own and its partner's parents, grandparents, and all ancestors upward
2. Its own and its partner's siblings (full or half — any creature sharing at least one parent)
3. Its own and its partner's children, grandchildren, and all descendants downward
4. Its own and its partner's parents' siblings (aunts and uncles)
5. Its own and its partner's siblings' children and all descendants downward

The check is entirely client-side using BFS ancestry traversal (up to 12 generations). If blocked, the UI names the specific relationship that prevents breeding.

---

## Breed Permits

Creatures are **closed to external breeding by default**. Only the effective owner can authorise specific users to use their creature as a breeding parent.

### How it works

The owner publishes a `breed_permit` reply on the creature's post naming the grantee and an optional expiry period. A `breed_revoke` reply cancels an existing permit. The latest action per grantee wins; expired permits are treated as revoked. Permits are visible to all users in the **Permit Manager** panel on the creature page (owner-only).

- The effective owner always has implicit breed permission on their own creatures.
- Permits granted before a completed ownership transfer are **automatically voided** — the new owner starts with a clean permit slate.

### Permit reply structure (`json_metadata.steembiota`)

```json
{
  "version": "1.0",
  "type": "breed_permit",
  "creature": { "author": "alice", "permlink": "vyrex-nymwhisper-..." },
  "grantee": "carol",
  "expires_days": 7
}
```

Set `expires_days` to `0` for a permanent (non-expiring) permit. A `breed_revoke` reply uses the same shape with `"type": "breed_revoke"` and no `expires_days` field.

---

## Ownership Transfer

Creature ownership can be transferred between users via a **two-sided on-chain handshake**. This prevents "pet dumping" — a creature cannot be forced on an unwilling recipient.

### Protocol

**Step 1 — Offer:** The current effective owner publishes a `transfer_offer` reply on the creature's post naming the recipient. Only one pending offer may exist at a time; a new offer replaces the previous one.

**Step 2 — Accept:** The named recipient publishes a `transfer_accept` reply on the same creature post, referencing the exact `offer_permlink`. This is the moment effective ownership changes.

**Cancellation:** The current effective owner can publish a `transfer_cancel` reply at any time before acceptance to withdraw the offer.

### Effective owner

The original `post.author` never changes on-chain. SteemBiota derives the **effective owner** by walking the reply history via `parseOwnershipChain()`. The effective owner governs:

- Who can publish breed permits and revocations
- Who sees the Permit Manager panel and the Transfer panel
- Whose profile the creature appears on
- Whether the breed panel appears (effective owner is always permitted to breed)

When a creature has been transferred, the creature page shows a 🤝 "Owned by @newowner" badge beneath the name header.

### Ownership rules

- Only the effective owner at the time of an offer may publish it.
- Only the named recipient may accept.
- Permits issued before a completed transfer are voided automatically (`permitsValidFrom` timestamp).
- Transfer history is stored on-chain and displayed in the Transfer panel's history log.

### Transfer reply structures (`json_metadata.steembiota`)

```json
{ "version": "1.0", "type": "transfer_offer",  "creature": { "author": "alice", "permlink": "..." }, "to": "bob",   "ts": "2026-03-01T12:00:00Z" }
{ "version": "1.0", "type": "transfer_accept", "creature": { "author": "alice", "permlink": "..." }, "offer_permlink": "steembiota-transfer-offer-bob-...", "ts": "..." }
{ "version": "1.0", "type": "transfer_cancel", "creature": { "author": "alice", "permlink": "..." }, "ts": "2026-03-02T08:00:00Z" }
```

---

## Notifications

The **🔔 Notifications** page (`/#/notifications`) aggregates all on-chain events relevant to the logged-in user. It is accessible only when logged in.

### Event types

| Event | Description |
|---|---|
| 🍖 Feed | Someone fed one of your creatures |
| 🎾 Play | Someone played with one of your creatures |
| 🐾 Walk | Someone walked one of your creatures |
| 🐣 Birth | Someone bred an offspring from one of your creatures |
| 🧬 Breed | Someone used your creature's lineage to breed a new creature |
| 🤝 Transfer offer | Someone is offering you ownership of a creature |

### Pending transfer offers

Incoming transfer offers are highlighted in a dedicated banner at the top of the Notifications page with a one-click **✅ Accept** button — no need to navigate to the individual item page. This includes both creatures and accessories. Accepting publishes a `transfer_accept` reply via Steem Keychain and immediately updates the UI.

### Notification badge

A red badge on the 🔔 nav icon shows the number of pending transfer offers. The count is refreshed on login and polled every 5 minutes while the user is logged in.

### How events are discovered

Because Steem has no server-side notification API, events are discovered entirely client-side:

1. The user's own creature posts are fetched and their reply trees are scanned for `feed`, `play`, `walk`, `birth`, and `transfer_offer` events.
2. All recent steembiota-tagged posts authored by others are scanned for pending `transfer_offer` replies naming the user as recipient.
3. Recent steembiota offspring posts are checked for cases where the user's creature appears as a parent (`breed` notifications).

---

## Social Interactions

On creature and accessory detail pages, SteemBiota includes a social panel powered by Steem primitives:

- **Upvote** via Steem Keychain (adjustable vote percentage)
- **Resteem** (reblog)
- **Comments** (compose and publish on-chain)
- Live counts/listing of votes, rebloggers, and non-SteemBiota social replies

User XP and leaderboard scores include upvotes cast on SteemBiota creature posts (counted once per creature).

---

## Provenance & Copy Detection

Because Steem is a public blockchain, genome data is readable by anyone and could in principle be copy-pasted into a new post. SteemBiota surfaces inauthentic creatures via provenance indicators on every creature card and on the creature page.

### Genome Fingerprint

Every creature carries a stable fingerprint: a pipe-delimited string of all ten gene values (`GEN|SX|MOR|APP|ORN|CLR|LIF|FRT_START|FRT_END|MUT`). Two posts that share an identical fingerprint have identical genomes regardless of author, claimed type, or parent links.

### Timestamp Priority

If two posts share an identical genome fingerprint, the post with the **earlier publication timestamp** is the original. Any later post with the same genome is flagged as a duplicate — this catches both copy-pasted founders and copy-pasted offspring (even if the copier included the original parent links).

In list and grid views, `markDuplicates()` compares fingerprints across the loaded post set and marks later matches in memory. On the creature page, `checkDuplicate()` runs as a background fetch (up to 200 recent `steembiota`-tagged posts) after the main render and updates the UI reactively when a match is found.

### Provenance Badges

Every creature card and the creature page header show a provenance badge. Priority order (highest first):

| Badge | Meaning |
|---|---|
| 👻 Phantom | Post was tombstoned on-chain (`post.author` is empty) — creature no longer exists |
| ⚠ Duplicate | Identical genome exists in an earlier post — this is a copy |
| ⚠ No parents | Claims to be a bred offspring but contains no parent links in metadata |
| ⚠ Unverified Origin | Posted as a founder but genome has ≥ 3 simultaneously maxed traits (statistically implausible from random generation) |
| ⚡ Speciation | Legitimately bred offspring that created a new genus |
| 🧬 Bred / Bred — Mutation | Legitimately bred offspring with valid parent links |
| 🌱 Origin Creature | Legitimate randomly-generated founder |

### Warning Banners

On the creature page the two most serious cases display an expanded warning banner below the header stats row:

- **Duplicate genome**: names the original author, links to their post, and states the original publication date.
- **Missing parent links**: explains that legitimate offspring always record both parents and that this creature's lineage cannot be verified.

---

## User Levels & XP

Every on-chain action earns XP for the acting user. XP totals are computed client-side from blockchain history and displayed on each user's profile page and the global leaderboard.

| Action | XP |
|---|---|
| Publish a founder creature | 100 |
| Publish an offspring | 500 |
| Each unique genus contributed (distinct GEN values across own creatures) | 25 |
| Each speciation event in own offspring | 75 |
| Feed a creature | 10 |
| Upvote a SteemBiota creature post (once per creature) | 5 |

Breeding an offspring is worth **5× more XP than a founder** because it requires two compatible, fertile, unrelated creatures to exist simultaneously — a significantly higher coordination barrier.

**Rank thresholds (cumulative XP):**

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

The `/leaderboard` page ranks all known SteemBiota participants by XP. It fetches up to 200 creature posts via cursor-based pagination (Steem's API hard-limits responses to 100 posts per call), then fetches each author's recent comment history and account vote history in parallel. All six XP sources — founders, offspring, feeds given, upvotes cast, genera contributed, and speciation events — are included in the ranking. Comment history is fetched up to a limit of 100; account votes up to the last ~1000 as returned by the Steem API. Very prolific feeders or voters may be slightly under-counted, but this keeps leaderboard load time reasonable. The breakdown line beneath each entry shows 🌱 founders · 🐣 offspring · 🍯 feeds (if any) · ❤️ upvotes (if any) · 🔬 genera, and ⚡ speciation events.

---

## Creature Grid Filters

Both the Home page and individual Profile pages include a filter bar above the creature grid:

- **Genus** — filter by genus name (e.g. show only *Vyrex* creatures)
- **Sex** — filter by Male / Female
- **Age** — filter by age in days using `<`, `=`, or `>` operators with a numeric input

Filters can be combined and are cleared individually. Pagination resets automatically when a filter changes.

---

## App Routes

| URL | View |
|---|---|
| `/#/` | Home — creature grid with filters, founder creator |
| `/#/accessories` | Accessories — accessory creator + global accessory browse grid (template filters) |
| `/#/about` | About page |
| `/#/leaderboard` | Global XP leaderboard |
| `/#/notifications` | Notifications — activity feed and pending transfer offer accepts (login required) |
| `/#/@user` | Profile — tabbed inventory of all items **currently owned** by the user (Creatures + Accessories), including received transfers; creature/accessory filters, level/XP badge, Steem profile header |
| `/#/@author/permlink` | Creature — canvas + reaction animation, unified activities panel (feed/play/walk), breed permit manager (owner only), breed panel (fertile window + permitted users only), ownership transfer panel (owner and pending recipient), unicode render, genome table, family/kinship panel, provenance badges and banners |
| `/#/acc/@author/permlink` | Accessory — deterministic accessory canvas, parameter table, unicode render, social panel, ownership transfer panel (owner and pending recipient) |

---

## Blockchain Post Structure

### Creature post (`json_metadata.steembiota`)

Founder:

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

Offspring (additional fields only):

```json
{
  "type": "offspring",
  "parentA": { "author": "alice", "permlink": "vyrex-nymwhisper-..." },
  "parentB": { "author": "bob",   "permlink": "vyrex-shadowpaw-..." },
  "mutated": false,
  "speciated": false
}
```

### Accessory post (`json_metadata.steembiota`)

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

### Feed reply

```json
{
  "version": "1.0",
  "type": "feed",
  "creature": { "author": "alice", "permlink": "vyrex-nymwhisper-..." },
  "feeder": "carol",
  "food": "nectar",
  "ts": "2026-01-03T07:00:00Z"
}
```

### Activity reply

```json
{
  "version": "1.0",
  "type": "play",
  "creature": { "author": "alice", "permlink": "vyrex-nymwhisper-..." },
  "player": "carol",
  "ts": "2026-01-03T07:30:00Z"
}
```

`type` is `"play"` or `"walk"`. Walk replies use `"walker"` in place of `"player"`.

### Breed permit reply

```json
{
  "version": "1.0",
  "type": "breed_permit",
  "creature": { "author": "alice", "permlink": "vyrex-nymwhisper-..." },
  "grantee": "carol",
  "expires_days": 7
}
```

Use `"type": "breed_revoke"` to cancel a permit. Set `expires_days` to `0` for a permanent grant.

### Ownership transfer replies

```json
{ "version": "1.0", "type": "transfer_offer",  "creature": { "author": "alice", "permlink": "..." }, "to": "bob",   "ts": "2026-03-01T12:00:00Z" }
{ "version": "1.0", "type": "transfer_accept", "creature": { "author": "alice", "permlink": "..." }, "offer_permlink": "steembiota-transfer-offer-bob-...", "ts": "..." }
{ "version": "1.0", "type": "transfer_cancel", "creature": { "author": "alice", "permlink": "..." }, "ts": "2026-03-02T08:00:00Z" }
```

### Post titles

Default title format (UTC time, user-editable before publishing):

```
Vyrex Nymwhisper — born at 7 in the morning UTC on Monday, January 3, 2026
```

### Permlinks

Derived from the post title: lowercased, whitespace becomes hyphens, non-alphanumeric stripped, truncated at 200 chars, then a millisecond timestamp appended. Always unique.

---

## Key Principles

**Immutability** — All genomes and life events are stored on-chain and cannot be altered.

**Determinism** — The same genome always renders the same creature. The same two parents always produce the same child.

**UTC time** — All timestamps use UTC to match the Steem blockchain clock.

**Client-side only** — All logic runs in the browser. No servers or external databases.

**Diversity enforcement** — The kinship system prevents same-bloodline farming and encourages cross-community breeding partnerships.

**Provenance transparency** — Genome fingerprinting and timestamp-priority checks expose copy-pasted creatures publicly without requiring any trusted authority.

**Anti-dumping ownership** — Transfers require the recipient's explicit on-chain acceptance. Creatures cannot be forced on unwilling users.

**Opt-in breeding** — Creatures are closed to external breeding by default. Owners must explicitly grant named permits, preventing unsolicited use of their creatures as parents.

---

## License

Open source. Community experimentation and forks are encouraged.

---

## Author

Created for the Steem blockchain ecosystem by @puncakbukit.
