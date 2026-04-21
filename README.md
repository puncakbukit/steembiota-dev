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

Files: `index.html`, `blockchain.js`, `components.js`, `accessories.js`, `upload.js`, `app.js`

---

## Creature Genome

Each creature is defined by ten integer genes, plus an optional provenance tag:

| Gene | Description | Range |
|---|---|---|
| `GEN` | Genus ID — species barrier; also determines colour palette family (GEN % 8) and eye style (GEN % 4) | 0–999 |
| `SX` | Sex (0 = Male, 1 = Female) | 0–1 |
| `MOR` | Morphology seed — drives body length (80–110 px), body height (42–60 px), head size (26–38 px), tail curve (0.4–0.9), and tail style (Tapered / Tufted / Plumed) | 0–9999 |
| `APP` | Appendage seed — drives leg length (44–64 px), leg thickness (7–12 px), ear height (22–36 px), ear width (10–16 px), ear style (Pointed / Rounded / Floppy), wing presence (>0.72 threshold), and wing span (24–44 px) | 0–9999 |
| `ORN` | Ornamentation seed — drives glow orb count (2–5), energy ribbon count (1–3), body pattern type (none / spots / dapple), orb hue offset, chest marking presence, mane wisp presence, and fur length (Smooth / Short / Fuzzy / Shaggy) | 0–9999 |
| `CLR` | Hue offset applied on top of the palette base: `finalHue = (paletteBase + CLR) % 360` | 0–359 |
| `LIF` | Lifespan in real days | 80–159 |
| `FRT_START` | Fertility window start (days from birth) | varies |
| `FRT_END` | Fertility window end (days from birth) | varies |
| `MUT` | Mutation tendency — scales per-gene mutation probability for offspring | 0–2 (founders); 0–5 (bred offspring) |
| `_source` | Optional provenance tag — `"image-upload"` for creatures created via the Upload page; absent for random founders and offspring | string or absent |

All ten numeric genes are stored verbatim inside every creature post (in a fenced code block and in `json_metadata.steembiota.genome`), so any client can reconstruct and render the creature entirely from the blockchain.

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

Four visual traits are derived directly from genome integers (not from the seeded PRNG):

| Trait | Source | Values |
|---|---|---|
| Eye style | `GEN % 4` | 0: Round, 1: Slit (reptilian), 2: Almond, 3: Large iris (anime) |
| Tail style | First `MOR` PRNG draw (post body/height) — `floor(rng() * 3)` | 0: Tapered, 1: Tufted, 2: Plumed |
| Ear style | Continuation of `APP` PRNG stream — `floor(rng() * 3)` | 0: Pointed, 1: Rounded, 2: Floppy |
| Fur length | Continuation of `ORN` PRNG stream — `floor(rng() * 4)` | 0: Smooth, 1: Short, 2: Fuzzy, 3: Shaggy |

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

Every creature is rendered procedurally from its genome on a 400×320 HTML5 Canvas (configurable via `canvasW`/`canvasH` props — the Upload preview uses 200×180). The same genome always produces the same base visual. Three sources of per-load variation are layered on top: random facing direction, random pose, and live expression driven by game state.

### Performance: Viewport-Aware Rendering

On pages with large creature grids (Home, Profile), each creature canvas runs its own `requestAnimationFrame` loop at up to 60 fps. To prevent battery drain and scroll jank on mobile, `CreatureCanvasComponent` uses an **`IntersectionObserver`** to pause the rAF loop for any canvas that has scrolled out of the visible viewport and resume it immediately when it scrolls back in. Only canvases that are actually on screen consume CPU and GPU resources. The observer is torn down in `beforeUnmount()` alongside the `ResizeObserver`.

### Off-screen Canvas Reuse

Equipping accessories on creatures requires rendering the accessory into a temporary off-screen canvas before compositing it onto the creature. This canvas is now **created once per component instance** and reused across frames — it is only resized when the accessory's logical dimensions (`accW` × `accH`) change. Prior to this fix a new `HTMLCanvasElement` and 2D context were allocated on every frame (up to 60 times per second per equipped accessory), rapidly exhausting the browser's GPU context limit and causing "context lost" errors, tab crashes, and severe frame-rate drops on creatures wearing multiple accessories.

### Ghost Navigation Protection

`CreatureView` watches `$route.params` (deep) in addition to loading data in `created()`. This covers both permlink-only changes (e.g. navigating between two creatures by the same author) and **author-only changes** (e.g. navigating from `@alice/creature-one` to `@bob/creature-one`). On Steem, permlinks are unique per author — two different authors can publish posts with identical permlinks. The previous watcher only observed `$route.params.permlink`; a navigation where only the author changed left stale content on screen while the URL updated. The current deep watcher fires on any param change and always calls `loadCreature()`.

### Canvas Sizing and DPR

Canvas backing-store dimensions are calculated once in `mounted()` via `_applyDpr()` and only recalculated when the CSS size or `devicePixelRatio` actually changes (monitored by a `ResizeObserver`). This prevents the browser from re-initialising the backing buffer on every frame — a significant source of CPU and memory overhead on high-DPR displays and during pinch-zoom.

### Mobile Interaction Deadlock Prevention

`CreatureCanvasComponent` accepts an `interactionsBlocked` prop (Boolean, default `false`). When `true`, the canvas receives `pointer-events: none` and its `z-index` is dropped to 0. `CreatureView` sets this via a `canvasInteractionsBlocked` computed property that is `true` whenever `actionPanelOpen` or `votePickerOpen` is active. The interact-tab panel area raises `actionPanelOpen` via `@pointerenter` / `@pointerleave`. This prevents the bobbing creature canvas from intercepting touch events aimed at Feed, Play, Walk, and other UI buttons positioned near the canvas on small screens.

### Phenotype Derivation (`buildPhenotype`)

All renderable traits are derived in a single `buildPhenotype(genome, age, feedState)` call before any drawing occurs. Three seeded mulberry32 PRNGs are instantiated — one per seed gene — and consumed in a fixed order so the mapping from genome integer to visual output is always identical:

| PRNG seed | Traits derived (in draw order) |
|---|---|
| `MOR` | `bodyLen` (80–110 px), `bodyH` (42–60 px), `headSize` (26–38 px), `tailCurve` (0.4–0.9), `tailStyle` (0–2) |
| `APP` | `legLen` (44–64 px), `legThick` (7–12 px), `earH` (22–36 px), `earW` (10–16 px), `hasWings` (>0.72), `wingSpan` (24–44 px), `earStyle` (0–2) |
| `ORN` | `glowOrbs` (2–5), `ribbons` (1–3), `patternType` (0–2), `orbHue`, `hasChestMark`, `hasMane`, `furLength` (0–3) |

Non-PRNG traits derived directly from gene integers: `finalHue = (paletteBase[GEN%8] + CLR) % 360`, `eyeStyle = GEN % 4`, `eyeRadius` (9 px at Baby, 7 px at all later stages).

### Lifecycle Scalars

Body scale and ornament visibility evolve continuously through the lifecycle:

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

1. **Fossil shortcut** — if the creature is fossilised, a single grey ellipse with procedural crack lines (`MOR+11` seed) is drawn instead and the function returns early.
2. **Ground shadow** — radial gradient ellipse scaled per pose (`shadowScale`).
3. **Energy ribbons** — bezier curves trailing from the torso tail-side; drawn only when `ornamentScale > 0.3`; colour derived from `orbHue`.
4. **Back legs (depth)** — drawn at 62% alpha for perceived depth; two back legs in standing pose, or pose/gait override.
5. **Front legs** — full alpha; two front legs in standing pose, or pose/gait override.
6. **Tail** — `_drawTailPosed` (curved bezier, gradient tip) or `_drawTailWrap` (curled under body) depending on pose.
7. **Torso** — three-stop vertical linear gradient ellipse, rotated by `torsoAngle` (pose-dependent).
8. **Chest marking** — radial gradient spot clipped to the torso ellipse; present when `hasChestMark` and `ornamentScale > 0.2`.
9. **Body pattern** — spots (10 circles) or dapple (5 ellipses) clipped to torso; present when `patternType > 0` and `patternOpacity > 0.1`.
10. **Worn wings accessory** — composited from a reused off-screen canvas before neck so the torso occludes wing roots.
11. **Necklace underlay** — composited before neck/head so creature geometry naturally occludes the top arc. Rendering uses `destination-over` compositing against the already-drawn body rather than re-drawing the neck bezier geometry. This eliminates visible seams and "ghost edges" that appeared on creatures with extreme MOR values when the repainted neck path did not align perfectly with the original.
12. **Neck** — bezier quad fill connecting torso to head, angle driven by `neckAngle` pose transform.
13. **Mane wisps** — 7 short angled strokes along the neck/back ridge; drawn when `hasMane` and `ornamentScale > 0.2`.
14. **Head** — radial gradient circle.
15. **Snout** — lighter ellipse offset left from head centre; nose dot on snout.
16. **Ears** — two ears (front and behind), style driven by `earStyle` (Pointed / Rounded / Floppy).
17. **Eye** — iris shape driven by `eyeStyle` (Round / Slit / Almond / Large iris), with radial iris gradient, pupil, dual highlight dots. Sleeping pose substitutes a curved arc.
18. **Face expression overlay** — brow line, mouth arc, extras (sparkles, teardrop, rosy cheeks); only rendered at Toddler stage and beyond (`pct >= 0.05`).
19. **Dorsal wing/fin** — rendered when `hasWings` and `ornamentScale > 0.35`.
20. **Glowing orb nodes** — rendered when `ornamentScale > 0.4`.
21. **Fertility aura** — full-body radial glow when the creature is within its effective fertility window.
22. **Worn hat / crown accessories** — composited on top of everything using the reused off-screen canvas.

### Genome → Visual Summary

| Gene | Visual effects |
|---|---|
| `GEN` | Colour palette family (8 groups); eye style (Round / Slit / Almond / Large iris) |
| `MOR` | Body length and height (body aspect ratio); head size; tail curl depth; tail style (Tapered / Tufted / Plumed) |
| `APP` | Leg length and thickness; ear height, width, and style (Pointed / Rounded / Floppy); wing presence and span |
| `ORN` | Glow orb count and hue; energy ribbon count; chest marking; mane wisps; body pattern (none / spots / dapple); fur length (Smooth / Short / Fuzzy / Shaggy) |
| `CLR` | Hue offset applied on top of palette base: `finalHue = (base + CLR) % 360` |
| `LIF` / age | Body scale (45% Baby → 100% Young Adult → 75% Fossil); ornament visibility |
| Feed health | Colour saturation boost (up to ±15) and lightness boost (up to ±8) applied to the whole body |

### Facing Direction

On each page load the creature is mirrored left or right at random via a canvas `scale(-1, 1)` transform. The direction is stable for the lifetime of that component instance and is also updated dynamically by the autonomous movement loop (the creature flips to face its direction of travel).

### Poses

On each page load the creature is assigned one of five poses at random. The pose is stable for the lifetime of that component instance.

| Pose | Description | Key transform values |
|---|---|---|
| 🐾 Standing | Default upright side profile | `torsoAngle = -0.08`, no overrides |
| 👀 Alert | Torso raised, head lifted high, tail swept up | Head +10 px up, `neckAngle = 0.4`, `tailCurlMul = 0.3`, `shadowScale = 0.9` |
| 🎉 Playful | Play-bow: front legs stretched forward and low, rear elevated | Head +12 px down, `neckAngle = -0.5`, `tailUp = 1.0`, custom `legOverride` |
| 🪑 Sitting | Torso tilted rear-down ~22°, folded haunches on ground | `torsoAngle = 0.30`, rear haunches at dropped Y, tail wrapped (`tailCurlMul = 1.6`) |
| 💤 Sleeping | Body flat and low, head resting on ground, legs tucked | `oyDelta = +28*sc`, head +18 px down, eye closed arc, `tailCurlMul = 2.0` |

Fossil creatures always render with the flat fossilised ellipse+cracks form regardless of pose.

### Eye Styles

The eye iris shape, pupil shape, and scaling all vary by `eyeStyle`:

| Style | `GEN % 4` | Iris shape | Pupil shape |
|---|---|---|---|
| Round | 0 | Circle | Standard oval offset |
| Slit | 1 | Tall ellipse (0.7× wide) | Vertical reptilian slit |
| Almond | 2 | Wide ellipse (1.2× wide, 0.7× tall, 0.2 rad tilt) | Standard oval |
| Large iris | 3 | Circle | Large oval (0.7×0.75 of `eyeR`) |

Alert expression scales `eyeR × 1.15` regardless of style. Sad and hungry expressions shift the pupil 0.14 `eyeR` downward.

### Face Expressions

Expressions are derived from live game state (`feedState` + `activityState`) and re-evaluated whenever data reloads. Pose overrides take highest priority.

| Expression | Trigger | Visual |
|---|---|---|
| 😴 Sleepy | Sleeping pose | Closed-eye arc (no iris drawn), drooped brow at 60% alpha, tiny neutral mouth at 45% alpha |
| 👀 Alert | Alert pose | Eye scaled ×1.15, straight raised brow, neutral mouth |
| 🎉 Excited | Playful pose | Wide open smile + tongue dot, arched brow, two star glints beside eye |
| ✨ Thriving | Boosted health ≥ 80% | Big open smile + tongue, arched brow, rosy cheek blush, two star glints |
| 😊 Happy | Boosted health ≥ 55% | Gentle curved smile, relaxed raised brow |
| 😐 Content | Boosted health ≥ 30% or no data | Neutral straight-line mouth, flat brow |
| 😟 Hungry | Health > 0% but boosted < 30% | Downward-corner frown, one-sided worried brow, pupil shifted down |
| 😢 Sad | Health = 0% (completely unfed) | Pronounced frown, inward V-brow, teardrop ellipse below eye, pupil down |

Play mood adds up to +25% to the effective health score before expression selection (`boosted = min(health + moodPct * 0.25, 1.0)`). Expressions only appear from Toddler stage onward (`pct >= 0.05`).

### Anticipation Pose

When a Steem Keychain popup opens for a Feed, Play, or Walk transaction, the creature immediately switches to the **alert** pose and expression as a visual cue that a transaction is pending. This anticipation pose is cleared as soon as the Keychain response arrives:

- **On success** — the full celebratory reaction animation plays (see below), pre-empting the anticipation pose.
- **On rejection or failure** — the pose is cleared immediately and the autonomous behaviour loop resumes. The creature does not stay frozen waiting for the 12-second timeout.

### Reaction Animation

Whenever a creature is successfully fed, played with, or walked, the canvas plays a short reaction sequence. The creature cycles through four fixed pose+expression pairs — Standing/Alert → Alert/Alert → Playful/Excited → Sitting/Happy — repeated 2 or 3 times at random (chosen per trigger), with each step lasting 2000–3000 ms at random. The autonomous behaviour loop is paused for the duration (velocities zeroed, position preserved). After the sequence finishes, both `animPose` and `animExpression` are cleared and autonomous behaviour resumes. Any in-progress animation is cancelled and restarted cleanly if another interaction fires while it is running.

### Click Interaction

Clicking the canvas triggers a hit test against the body ellipse using the standard ellipse equation `(dx/a)² + (dy/b)² ≤ 1`. A hit on the body fires a **poke reaction** — a short 1.2–1.5 s flash through three moods cycling in order: Surprised (alert/alert), Happy (playful/happy), Grumpy (sitting/hungry). A click on empty canvas space triggers **walk-to**: the creature walks directly toward the clicked point at 40 px/s using a delta-time loop, arriving within 6 px before returning to idle.

**Mobile tap dead-zone:** taps that land within 1.5× the body ellipse radius of the creature's current centre are treated as missed pokes rather than walk-to commands. Without this guard, the creature's bobbing motion between the draw call and the touch event causes edge taps to be misclassified as empty-space clicks, making the creature walk away from the user's finger just as they try to interact with it.

**Panel overlap guard:** when the user's pointer enters the activity panel area (Feed / Play / Walk cards) below the canvas, the canvas's `pointer-events` are disabled entirely so buttons always receive touch priority over the bobbing canvas hit-area. This is handled via the `interactionsBlocked` prop (see Mobile Interaction Deadlock Prevention above).

### Autonomous Behaviour

Beyond static posing, the creature canvas runs a continuous movement loop (`requestAnimationFrame`) for all non-fossil creatures. The loop is automatically suspended by the `IntersectionObserver` when the canvas is off-screen (see Performance section above).

- **Idle** — creature stands still; transitions to walk/run/jump/sleep after a random delay (staggered 0–3 s on mount to avoid lockstep on multi-creature pages).
- **Walk** — horizontal + vertical velocity; leg cycle at 2.5 Hz; body bob at 1.1 Hz amplitude 5 px.
- **Run** — faster leg cycle (4.5 Hz); body bob at 1.8 Hz amplitude 3 px; wider stride (0.52 rad vs 0.32 rad); more leg air-time.
- **Jump** — upward impulse decaying under 520 px/s² gravity; alert pose on landing, then idle.
- **Sleep** — autonomous sleep state; creature enters sleeping pose.
- **Walk-to** — directed walk toward a canvas-offset target (from canvas click); arrives within 6 px then idles.

Edge bounce: the creature flips facing direction and reverses velocity when it reaches ±38% of canvas width or height. Position is persisted in `sessionStorage` keyed on `sb_pos_{GEN}_{MOR}` so the creature remembers where it was between route changes within the same browsing session.

### Accessibility

- **Screen reader support for Unicode art** — the `<pre>` unicode art block has `aria-hidden="true"` so screen readers skip the raw box-drawing characters. A visually-hidden `<span>` immediately following it provides a concise text summary: creature name, sex, lifecycle stage, and health state.
- **Focus management** — when navigating from a creature grid to a creature detail page, keyboard focus is shifted programmatically to the creature name heading (`<h2 data-focus-target>`). This uses `tabindex="-1"` so the heading is focusable without entering the natural tab order. Screen-reader users hear the creature name announced immediately on arrival rather than being left at the originating link or document body.
- **Genome bar height** — the genome visualisation bars were increased from 6 px to 10 px. At 6 px the MOR (green) and APP (teal) bars were nearly indistinguishable for users with colour-vision deficiency or on low-contrast displays. 10 px provides enough surface area for the colour to read clearly while remaining compact.
- **Visually-hidden utility class** — a `.sb-sr-only` CSS class (1×1 px, clipped, off-screen margin) is used wherever a text alternative must be provided for non-text content without disrupting the visual layout.

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
- Navigating directly between two accessory pages (via notifications or browser back/forward) always reloads the correct accessory data, because `AccessoryItemView` watches `$route.params.permlink` in addition to loading on `created()`.

### Accessory Templates

Four templates are currently implemented and renderable on creatures:

- 🎩 Hat
- 👑 Crown
- 📿 Necklace
- 🪽 Wings

The "Shirt" template was removed from `ACCESSORY_TEMPLATES` because no renderer exists for it. Creating a shirt accessory would produce an item that is permanently invisible on any creature. A defensive early-return guard in `_drawAccessoryOnCreature` catches any legacy shirt genomes that may already exist on-chain.

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

Accessory names are generated deterministically from template + genome (material adjective + type-specific noun).

### Wearing Accessories on Creatures

Accessories are not just collectible posts — they can be equipped on creature canvases and rendered directly on the creature body.

#### Permission Model (on accessory post replies)

Accessory owners control wear access with on-chain replies:

- `wear_request` — user asks permission to wear
- `wear_grant` — owner grants a specific username
- `wear_revoke` — owner revokes a specific username
- `wear_public` — owner opens the accessory to everyone
- `wear_private` — owner returns to private mode (grants required)

Rules:

- Permissions are user-based (not creature-based).
- Accessory owner is always implicitly permitted.
- Public mode allows anyone to equip without explicit grant.

#### Equip State Model (on creature post replies)

Creature owners control what is currently worn by publishing:

- `wear_on` — equip accessory
- `wear_off` — remove accessory

The creature post is the source of truth for current equip state. For each accessory, the latest `wear_on`/`wear_off` event by the creature's effective owner determines whether it is equipped.

#### UI Behaviour

- Creature page shows a **Wear / Equip panel** for owners.
- Owners can paste an accessory URL or pick from a "closet" (owned accessories) to equip.
- The app checks permission before equipping, and prevents equipping if that accessory is already worn by another creature.
- **Revoked permissions (lapsed):** if permission is revoked after equipping, a "⚠ Lapsed" badge is displayed next to the accessory in the Equip panel. The accessory is **no longer rendered on the creature canvas** — `_normalizedWearings()` filters out any item with `permissionLapsed: true`. Only the Remove button remains so the owner can formally unequip it and return the accessory to its original owner's access model.
- **Closet pagination** — the closet renders at most 20 accessories at a time with a "Load More" button. Each `AccessoryCanvasComponent` allocates a GPU-backed canvas; rendering hundreds simultaneously causes GPU memory exhaustion and severe jank on mobile.
- **Ghost accessory state** — all transient equip-panel UI (URL input, preview, search query, visible count) is reset automatically when the user navigates from one creature to another, so state from a previous creature's panel never bleeds through.
- **Fossil accessories** — the equip form is hidden when a creature is a fossil, but the Remove button remains visible so owners can retrieve accessories from fossilised creatures. When a fossil is transferred, the new owner sees an explicit notice listing how many accessories are currently "trapped" in the fossil and instructing them to use the Remove button to recover each one to their closet.
- **Wear exclusivity** — before equipping, the app checks the accessory post's own reply history (not the current owner's creature list) to determine whether the accessory is already worn. This catches the case where an accessory is still logically worn by a creature that was transferred to a different user — preventing two creatures from wearing the same accessory simultaneously.
- **Post-transfer lock-out ("Panic Reset")** — after receiving an accessory via transfer, the new owner may find it is still equipped on a creature they don't own (or a phantom creature whose post was deleted). The accessory page detects both conditions and surfaces a **🚨 Force Unequip** button, letting the new owner publish a `wear_off` reply and reclaim the accessory without needing access to the other creature's page.
- **Public domain confirmation** — the "Make Public" (`wear_public`) action is guarded by a browser confirmation dialog that explains the consequences: any user who equips the accessory while it is public retains that equip even if the owner later reverts to private mode. This prevents accidental irreversible broadcasts.
- **Layer reorder** — when multiple accessories are worn simultaneously, the owner can reorder their draw layers using ▲/▼ controls in the equip panel. Items later in the list are drawn on top.

---

## Activities

All three creature interactions — feeding, play, and walking — are presented in a single unified **🌿 Activities** panel on the creature page, directly below the canvas so reactions are visible while interacting. Each action is published as a blockchain reply. Fossil creatures cannot receive any activities.

### Feed 🍃

Feeding improves the creature's **health**, which affects its canvas expression, lifespan, and fertility window.

**Food types:**

| Food | Lifespan bonus | Fertility boost |
|---|---|---|
| 🍯 Nectar | +1 day per feed | none |
| 🌿 Herbs | none | +5% window extension per feed |
| 🍖 Meat | +0.5 day per feed | +2% window extension per feed |

Health score is `feedEvents.total / 20` (capped at 1.0). Expression, saturation, and lightness track health continuously. The daily feed limit resets at UTC midnight.

### Play 🎮

Playing boosts the creature's **mood**, which adds up to +25% to the effective health score for expression calculation and extends the fertility window.

One play per user per day (UTC midnight reset). Mood score is `activityState.playTotal / 15` (capped at 1.0).

### Walk 🦮

Walking boosts **vitality**, which adds lifespan days proportional to `activityState.walkTotal`.

One walk per user per day (UTC midnight reset). Vitality score is `activityState.walkTotal / 15` (capped at 1.0).

---

## Upload: Image-Inspired Creatures

The `/upload` page converts any image into a deterministic creature genome.

### Image Analysis Pipeline

1. The image is downsampled to at most 120×120 px via an off-screen canvas.
2. Every pixel is classified as silhouette or background using a lightness threshold.
3. Six statistics are extracted: `dominantHue`, `meanSat`, `meanLit`, `litVariance`, `aspectRatio`, `edgeDensity`, `colourfulness`, `lowContrast`.

### Genome Fitting

| Stat | Target gene | Method |
|---|---|---|
| `dominantHue` | `GEN`, `CLR` | Best-fit palette search via `fitHue()` |
| `aspectRatio` | `MOR` | Coarse+fine scan of MOR space via `fitMor()` |
| `edgeDensity` | `APP` | Linear mapping + RNG jitter via `fitApp()` |
| `colourfulness` + `litVariance` + `edgeDensity` | `ORN` | Weighted blend + bounded jitter via `fitOrn()` |
| RNG stream | `SX`, `LIF`, `FRT_START`, `FRT_END`, `MUT` | Drawn from a master seed (`pixelHash ^ rerollIndex`) |

### Reroll

The **🎲 Reroll** button increments `rerollIndex` and regenerates the genome from the same image. When `rerollIndex > 0`, small deterministic offsets are applied to the detected `aspectRatio` (±15% per reroll unit, strength capped at ×3) and `dominantHue` (±25° per unit) before they are fed into `fitMor()` and `fitHue()`. This gives each reroll a visibly different body shape and colour palette, rather than only varying the RNG-driven genes (APP, ORN). `rerollIndex = 0` is always the pure image-faithful result so the first preview is unchanged.

### UI Flow

1. **Pick** — drag-and-drop zone or file browser (JPG, PNG, GIF, WebP); optional genus pre-override
2. **Analyse** — brief spinner while the browser downsamples and runs pixel stats + genome fitting
3. **Preview** — side-by-side: source image left, generated creature canvas (200×180) right; stats table showing each detected trait and its genome mapping; low-contrast warning if applicable; editable post title; genus override; **🎲 Reroll**, **🌿 Publish Creature**, and **✕ Start over** buttons
4. **Published** — on success, navigates directly to the new creature's page

---

## Ownership Transfer

Creature ownership can be transferred between users via a **two-sided on-chain handshake**. This prevents "pet dumping" — a creature cannot be forced on an unwilling recipient.

### Protocol

**Step 1 — Offer:** The current effective owner publishes a `transfer_offer` reply on the creature's post naming the recipient. Only one pending offer may exist at a time; a new offer replaces the previous one.

**Step 2 — Accept:** The named recipient publishes a `transfer_accept` reply on the same creature post, referencing the exact `offer_permlink`. This is the moment effective ownership changes.

**Cancellation:** The current effective owner can publish a `transfer_cancel` reply at any time before acceptance to withdraw the offer.

### Effective Owner

The original `post.author` never changes on-chain. SteemBiota derives the **effective owner** by walking the reply history via `parseOwnershipChain()`. The effective owner governs:

- Who can publish breed permits and revocations
- Who sees the Permit Manager panel and the Transfer panel
- Whose profile the creature appears on
- Whether the breed panel appears (effective owner is always permitted to breed)

When a creature has been transferred, the creature page shows a 🤝 "Owned by @newowner" badge beneath the name header.

### Home Feed and Transferred Creatures

The Home grid (`parseSteembiotaPosts`) does not scan reply trees for transfers during bulk loading — doing so would require hundreds of extra RPC calls. Instead, when a transfer is confirmed on the creature detail page, `patchListCacheOwner()` annotates the affected raw post object in the creature list cache with a `_effectiveOwner` field. On the next render of the Home grid, `parseSteembiotaPosts` reads this annotation and includes it in each result's `effectiveOwner` field, surfacing the "🤝 Transferred" badge without any extra network calls.

### Ownership Rules

- Only the effective owner at the time of an offer may publish it.
- Only the named recipient may accept.
- Permits issued before a completed transfer are voided automatically (`permitsValidFrom` timestamp).
- Transfer history is stored on-chain and displayed in the Transfer panel's history log.
- When checking whether a pending offer has been cancelled, only `transfer_cancel` replies with a timestamp **strictly after** the offer's timestamp are considered. This prevents an old cancellation from hiding a newer valid offer by the same owner.
- **Recipient account verification** — before publishing a `transfer_offer`, the app calls `getAccounts` to verify the recipient username exists on Steem. A typo (e.g. `@hibbit` instead of `@hubbit`) would otherwise leave the creature permanently stuck in "Pending Transfer" state until the owner manually cancels. The verification adds ~100 ms but prevents this entire class of stuck-creature bugs.

---

## Notifications

The **🔔 Notifications** page (`/#/notifications`) aggregates all on-chain events relevant to the logged-in user. It is accessible only when logged in.

### Event Types

| Event | Description |
|---|---|
| 🍖 Feed | Someone fed one of your creatures |
| 🎾 Play | Someone played with one of your creatures |
| 🐾 Walk | Someone walked one of your creatures |
| 🐣 Birth | Someone bred an offspring from one of your creatures |
| 🧬 Breed | Someone used your creature's lineage to breed a new creature |
| 🤝 Transfer offer | Someone is offering you ownership of a creature |

### Pending Transfer Offers

Incoming transfer offers are highlighted in a dedicated banner at the top of the Notifications page with a one-click **✅ Accept** button — no need to navigate to the individual item page. This includes both creatures and accessories. Accepting publishes a `transfer_accept` reply via Steem Keychain and immediately updates the UI.

### Notification Badge

A red badge on the 🔔 nav icon shows the number of pending transfer offers. The count is refreshed on login and polled every 5 minutes while the user is logged in.

### How Events Are Discovered

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
| 🌱 Origin Creature | Legitimate founder (random or image-inspired) |

Image-uploaded founders carry a `_source: "image-upload"` tag in their genome and display as 🌱 Origin Creature — they are full participants in the ecosystem with no special treatment or restrictions.

### Warning Banners

On the creature page the two most serious cases display an expanded warning banner below the header stats row:

- **Duplicate genome**: names the original author, links to their post, and states the original publication date.
- **Missing parent links**: explains that legitimate offspring always record both parents and that this creature's lineage cannot be verified.

---

## User Levels & XP

Every on-chain action earns XP for the acting user. XP totals are computed client-side from blockchain history and displayed on each user's profile page and the global leaderboard.

| Action | XP |
|---|---|
| Publish a founder creature (random or image-inspired) | 100 |
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

**Rate-limit protection** — RPC calls for each author's comment and vote data are made with a concurrency limit of 3 in-flight requests at a time (via `_throttledMap`). Previously, `Promise.allSettled` fired all 20 authors' requests simultaneously (up to 40+ concurrent RPC calls), reliably hitting the public node's rate limit and causing the leaderboard to hang or show a load error halfway through.

**Per-author XP caching** — each author's comment and vote data is cached individually for 24 hours. On revisits the leaderboard can reconstruct itself entirely from cache without any RPC calls, eliminating the 429 errors that previously triggered on every page load. The overall leaderboard TTL was raised from 15 minutes to 24 hours for the same reason.

**Partial-result retry** — when some authors' XP data fails to load (typically due to a rate-limit on the public RPC node), a partial-result banner is shown and a **Retry** button appears. Clicking it re-fetches only the failed authors at a reduced concurrency of 2. Authors whose data was already successfully fetched and cached are not re-requested.

---

## Caching

SteemBiota caches blockchain data client-side to reduce RPC load and improve perceived performance. All caches are keyed under `steembiota:*` in localStorage or IndexedDB.

| Cache | Storage | TTL | Scope |
|---|---|---|---|
| Creature list (Home grid) | IndexedDB | 5 min | Global |
| Creature page | IndexedDB | 10 min | Per creature |
| Ancestry graph | IndexedDB | persistent | Per creature |
| Profile owned creatures | localStorage | 30 min | Per user |
| Profile owned accessories | localStorage | 30 min | Per user |
| Notifications | localStorage | 60 s | Per user |
| Leaderboard | localStorage | 24 h | Global |
| Per-author XP detail | localStorage | 24 h | Per author |

**IndexedDB for the creature list** — the global creature list was moved from localStorage to IndexedDB so it is not evicted by other dApps sharing the same `github.io` localStorage quota. localStorage remains a fallback if IndexedDB is unavailable.

**Global invalidation stamp** — `invalidateGlobalListCaches()` writes a version timestamp to `steembiota:global:version`. Every `readListCache()` call compares this stamp against the entry's `savedAt`. Any cache entry written before the most recent invalidation event (e.g. a completed transfer) is treated as stale immediately, regardless of its own TTL. This ensures the "All Creatures" grid never shows a stale owner after a transfer.

**Surgical cache patching** — after a successful ownership transfer, only the affected item's `effectiveOwner` field is patched in the creature list cache and both owners' profile caches, instead of evicting all caches and forcing a full re-fetch. The previous owner's cache has the entry removed; the new owner's cache has the updated entry prepended. The raw post object in the list cache is also annotated with `_effectiveOwner` so that the next call to `parseSteembiotaPosts` can surface the "🤝 Transferred" badge in the Home grid without any RPC calls.

**localStorage quota eviction** — on `QuotaExceededError`, the oldest `steembiota:*` entries are evicted one by one (sorted by `savedAt`) until the write succeeds or all entries are exhausted. A warning is logged if space cannot be recovered.

Both the Home page and individual Profile pages include a filter bar above the creature grid:

- **Genus** — filter by genus name (e.g. show only *Vyrex* creatures)
- **Sex** — filter by Male / Female
- **Age** — filter by age in days using `<`, `=`, or `>` operators with a numeric input

Filters can be combined and are cleared individually. Pagination resets to page 1 automatically whenever any filter changes — preventing the case where a user on a high page number applies a narrow filter and sees an empty grid even though results exist on page 1.

---

## App Routes

| URL | View |
|---|---|
| `/#/` | Home — creature grid with filters, founder creator |
| `/#/upload` | Upload — image-inspired creature creator (login required) |
| `/#/accessories` | Accessories — accessory creator + global accessory browse grid (template filters) |
| `/#/about` | About page |
| `/#/leaderboard` | Global XP leaderboard |
| `/#/notifications` | Notifications — activity feed and pending transfer offer accepts (login required) |
| `/#/@user` | Profile — tabbed inventory of all items **currently owned** by the user (Creatures + Accessories), including received transfers; creature/accessory filters, level/XP badge, Steem profile header |
| `/#/@author/permlink` | Creature — canvas + reaction animation, unified activities panel (feed/play/walk), **accessory wear/equip panel** (owner only), breed permit manager (owner only), breed panel (fertile window + permitted users only), ownership transfer panel (owner and pending recipient), unicode render, genome table, family/kinship panel, provenance badges and banners |
| `/#/acc/@author/permlink` | Accessory — deterministic accessory canvas, parameter table, unicode render, **wear-permission manager** (request/grant/revoke/public/private), social panel, ownership transfer panel (owner and pending recipient) |

---

## Blockchain Post Structure

### Creature post (`json_metadata.steembiota`)

Founder (random):

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

Founder (image-inspired) — identical shape, with one additional genome field:

```json
{
  "version": "1.0",
  "type": "founder",
  "genome": { "GEN": 42, "SX": 1, "MOR": 3871, "APP": 6204, "ORN": 7115, "CLR": 218, "LIF": 112, "FRT_START": 28, "FRT_END": 74, "MUT": 0, "_source": "image-upload" },
  "name": "Vyrex Voltwhisper",
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

### Wear permission replies (accessory post)

```json
{ "version": "1.0", "type": "wear_request", "accessory": { "author": "alice", "permlink": "..." }, "requester": "carol", "ts": "..." }
{ "version": "1.0", "type": "wear_grant",   "accessory": { "author": "alice", "permlink": "..." }, "grantee": "carol",  "ts": "..." }
{ "version": "1.0", "type": "wear_revoke",  "accessory": { "author": "alice", "permlink": "..." }, "grantee": "carol",  "ts": "..." }
{ "version": "1.0", "type": "wear_public",  "accessory": { "author": "alice", "permlink": "..." }, "ts": "..." }
{ "version": "1.0", "type": "wear_private", "accessory": { "author": "alice", "permlink": "..." }, "ts": "..." }
```

### Wear equip replies (creature post)

```json
{ "version": "1.0", "type": "wear_on",  "creature": { "author": "bob", "permlink": "..." }, "accessory": { "author": "alice", "permlink": "..." }, "ts": "..." }
{ "version": "1.0", "type": "wear_off", "creature": { "author": "bob", "permlink": "..." }, "accessory": { "author": "alice", "permlink": "..." }, "ts": "..." }
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

**Mobile-first interactions** — Hover effects on creature cards are restricted to devices that support true hover (via `@media (hover: hover)`), preventing "sticky" highlight borders on touch screens after a tap. Canvas tap hit-testing includes a dead-zone around the creature body to compensate for bobbing motion between draw and touch events. The canvas is fully blocked from receiving pointer events whenever the user's pointer enters the activity panel below it, preventing the bobbing creature from intercepting Feed / Play / Walk button taps.

**Defensive caching** — Multi-tier caching (IndexedDB → localStorage → live fetch) with global invalidation stamps, surgical patching after transfers, and quota-exceeded eviction ensures the UI stays responsive and consistent across slow connections and shared-origin storage constraints.

**Resilient URL parsing** — All Steem URL inputs strip zero-width Unicode characters and tolerate trailing query parameters and fragments, so URLs copied from any Steem frontend work without user intervention.

---

## License

Open source. Community experimentation and forks are encouraged.

---

## Author

Created for the Steem blockchain ecosystem by @puncakbukit.
