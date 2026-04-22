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

Each creature is defined by ten integer genes, plus optional provenance tags:

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
| `_severedLineage` | Optional trait flag — `true` when the child was bred from a lineage containing a Phantom ancestor. Stored in `json_metadata` only; has no effect on gameplay but is displayed as a badge on the creature page. | boolean or absent |

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

### Fertility Indicator

The creature detail page shows an explicit **🌸 Fertile Now** text badge next to the creature's age whenever it is within its effective fertility window. The badge is announced via `aria-live="polite"` for screen readers and is present independently of the lifecycle stage colour and icon — ensuring fertility status is not conveyed by colour or icon alone. It accounts for play-based fertility window extension and feed-based fertility boosts.

### Phantom Creatures

If a post is deleted on Steem (`delete_comment` op), the API returns the post with an empty `author` field. SteemBiota detects this as a **phantom** — distinct from a fossil (natural end-of-life). The creature page shows a 👻 tombstone screen with a lore explanation. Phantoms cannot be fed, played with, walked, or bred.

If a **non-direct ancestor** in a breeding chain is phantom, breeding is no longer blocked. Instead, the child genome is stamped with `_severedLineage: true` and an amber informational banner is shown in the breed preview. This prevents one user's old deletion from permanently poisoning all downstream descendants of a healthy creature pair. See [Kinship: Severed Lineage](#kinship-severed-lineage) below.

---

## Visual Rendering — Canvas

Every creature is rendered procedurally from its genome on a 400×320 HTML5 Canvas (configurable via `canvasW`/`canvasH` props — the Upload preview uses 200×180). The same genome always produces the same base visual. Three sources of per-load variation are layered on top: random facing direction, random pose, and live expression driven by game state.

### Performance: Viewport-Aware Rendering

On pages with large creature grids (Home, Profile), each creature canvas runs its own `requestAnimationFrame` loop at up to 60 fps. To prevent battery drain and scroll jank on mobile, `CreatureCanvasComponent` uses an **`IntersectionObserver`** to pause the rAF loop for any canvas that has scrolled out of the visible viewport and resume it immediately when it scrolls back in. Only canvases that are actually on screen consume CPU and GPU resources. The observer is torn down in `beforeUnmount()` alongside the `ResizeObserver`.

### Off-screen Canvas Reuse

Equipping accessories on creatures requires rendering the accessory into a temporary off-screen canvas before compositing it onto the creature. This canvas is **created once per component instance** and reused across frames — it is only resized when the accessory's logical dimensions (`accW` × `accH`) change. Prior to this fix a new `HTMLCanvasElement` and 2D context were allocated on every frame (up to 60 times per second per equipped accessory), rapidly exhausting the browser's GPU context limit and causing "context lost" errors, tab crashes, and severe frame-rate drops on creatures wearing multiple accessories.

### Ghost Navigation Protection

`CreatureView` watches `$route.params` (deep) in addition to loading data in `created()`. This covers both permlink-only changes (e.g. navigating between two creatures by the same author) and **author-only changes** (e.g. navigating from `@alice/creature-one` to `@bob/creature-one`). On Steem, permlinks are unique per author — two different authors can publish posts with identical permlinks. The previous watcher only observed `$route.params.permlink`; a navigation where only the author changed left stale content on screen while the URL updated. The current deep watcher fires on any param change and always calls `loadCreature()`.

### Kinship Load-Generation Guard

`loadCreature()` increments a monotonic counter (`_loadGeneration`) each time it runs. `loadKinship()` snapshots this counter as `currentGen` at the very start of its execution. Because loading kinship involves multiple sequential RPC calls — parent fetches and a full corpus sweep across parent authors — it can take several seconds to complete. If the user navigates to a different creature before `loadKinship()` finishes, the counter will have incremented. Two guard checkpoints test `this._loadGeneration !== currentGen`:

1. **After parent fetches resolve** — before writing `this.parentA` / `this.parentB`.
2. **After corpus fetch resolves** — before writing `this.siblings` / `this.children`.

At either checkpoint, if the generation has advanced, the function returns immediately without writing any data. This prevents stale kinship data from a previously viewed creature popping into the current creature's Family tab several seconds after navigation.

### Canvas Sizing and DPR

Canvas backing-store dimensions are calculated once in `mounted()` via `_applyDpr()` and only recalculated when the CSS size or `devicePixelRatio` actually changes (monitored by a `ResizeObserver`). This prevents the browser from re-initialising the backing buffer on every frame — a significant source of CPU and memory overhead on high-DPR displays and during pinch-zoom.

### Mobile Interaction Deadlock Prevention

`CreatureCanvasComponent` accepts an `interactionsBlocked` prop (Boolean, default `false`). When `true`, the canvas receives `pointer-events: none` and its `z-index` is dropped to 0. `CreatureView` sets this via a `canvasInteractionsBlocked` computed property that is `true` whenever `actionPanelOpen` or `votePickerOpen` is active. The interact-tab panel area raises `actionPanelOpen` via `@pointerenter` / `@pointerleave`. This prevents the bobbing creature canvas from intercepting touch events aimed at Feed, Play, Walk, and other UI buttons positioned near the canvas on small screens.

**Mobile Vertical Scroll Priority**

The creature canvas carries `touch-action: pan-y` in its inline style. This tells the browser's touch handling layer to always treat vertical swipe gestures over the canvas as scroll events rather than JavaScript click events. Without this, a user swiping down to scroll the page while their finger crosses the canvas could trigger a spurious poke reaction, causing the creature to bob unexpectedly and fighting the scroll gesture.

### Vote Picker Z-Index Isolation

The vote-strength popover (the `%` slider that opens above the ❤️ upvote button) uses `z-index: 200`. On some mobile browsers, the creature canvas's bobbing animation is hardware-accelerated in a separate GPU compositing layer. Depending on how the browser resolves competing stacking contexts, this layer could flicker through absolute-positioned siblings.

The **pose label and social counters row** (which contains the upvote button, vote-picker popover, and resteem button) is now wrapped in a dedicated `<div style="position:relative;z-index:10;">` container. This creates a self-contained stacking context, guaranteeing that all UI elements in this row — including the floating vote-picker — are always rendered above the hardware-accelerated canvas animation layer, regardless of the mobile browser's compositing strategy.

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

- **On success** — the full celebratory reaction animation plays, pre-empting the anticipation pose.
- **On rejection or failure** — the pose is cleared immediately and the autonomous behaviour loop resumes.
- **On silent close (60-second timeout)** — if the user dismisses the Keychain popup via the browser's window "X" button without using the in-extension Cancel button, some Keychain versions never fire the callback. A 60-second self-cancelling timeout guard fires in this case, resets all publishing flags, rolls back any optimistic state, clears the anticipation pose, and shows a "Transaction timed out or was closed" notification. The guard uses a `_callbackFired` boolean so that if the real callback fires first, the timeout is cleared and has no effect — and vice versa.

If a Feed transaction is rejected or times out, `ActivityPanelComponent` emits a `feed-failed` event. `CreatureView` handles this by resetting its own `alreadyFedToday` ref immediately, ensuring the Feed button returns to its enabled state without waiting for a blockchain re-fetch.

### Reaction Animation

Whenever a creature is successfully fed, played with, or walked, the canvas plays a short reaction sequence. The creature cycles through four fixed pose+expression pairs — Standing/Alert → Alert/Alert → Playful/Excited → Sitting/Happy — repeated 2 or 3 times at random, with each step lasting 2000–3000 ms. The autonomous behaviour loop is paused for the duration (velocities zeroed, position preserved). After the sequence finishes both `animPose` and `animExpression` are cleared and autonomous behaviour resumes. Any in-progress animation is cancelled and restarted cleanly if another interaction fires while it is running.

### Click Interaction

Clicking the canvas triggers a hit test against the body ellipse using the standard ellipse equation `(dx/a)² + (dy/b)² ≤ 1`. A hit on the body fires a **poke reaction** — a short 1.2–1.5 s flash through three moods cycling in order: Surprised, Happy, Grumpy. A click on empty canvas space triggers **walk-to**: the creature walks directly toward the clicked point at 40 px/s, arriving within 6 px before returning to idle.

**Touch ripple feedback:** every tap on the canvas — whether it hits the body or not — triggers a brief expanding ring animation at the exact tap coordinates. The ring expands from 0 to 28 px over 200 ms while fading from 55% to 0% opacity, giving mobile users immediate visual confirmation that their touch registered before the hit-test result is determined. The ripple is drawn directly onto the canvas context by `_drawTouchRipple()` using a `requestAnimationFrame` loop; the next `draw()` call clears it naturally so no cleanup is required.

**Mobile tap dead-zone:** taps within 1.5× the body ellipse radius of the creature's current centre are treated as missed pokes rather than walk-to commands. The creature's bobbing motion between the draw call and the touch event would otherwise misclassify edge taps as empty-space clicks.

**Mobile scroll vs. poke threshold:** on high-sensitivity touchscreens a finger-lift at the end of a tap often includes a 1–2 px slide. The browser can classify this micro-scroll as a pan gesture and suppress the click event entirely, making the creature feel unresponsive. `CreatureCanvasComponent` listens to `touchstart` (passive) and `touchend` in addition to `click`. On `touchend`, the Euclidean distance between start and end touch coordinates is computed. If the delta is **less than 5 px** the event is treated as a tap and `onCanvasClick` is called synthetically; if it is 5 px or more the gesture is a genuine scroll and passes through untouched. `event.preventDefault()` is called on qualifying taps to suppress the browser's delayed synthetic click (300 ms tap-delay), preventing double-firing.

**Panel overlap guard:** when the user's pointer enters the activity panel area, the canvas's `pointer-events` are disabled entirely so buttons always receive touch priority over the bobbing canvas hit-area.

**Vertical scroll guard:** `touch-action: pan-y` ensures downward swipe gestures over the canvas are always interpreted as page scrolls, never as canvas clicks.

### Autonomous Behaviour

Beyond static posing, the creature canvas runs a continuous movement loop (`requestAnimationFrame`) for all non-fossil creatures. The loop is automatically suspended by the `IntersectionObserver` when the canvas is off-screen.

- **Idle** — creature stands still; transitions to walk/run/jump/sleep after a random delay (staggered 0–3 s on mount to avoid lockstep on multi-creature pages).
- **Walk** — horizontal + vertical velocity; leg cycle at 2.5 Hz; body bob at 1.1 Hz amplitude 5 px.
- **Run** — faster leg cycle (4.5 Hz); body bob at 1.8 Hz amplitude 3 px; wider stride (0.52 rad vs 0.32 rad).
- **Jump** — upward impulse decaying under 520 px/s² gravity; alert pose on landing, then idle.
- **Sleep** — creature enters sleeping pose for 6–18 seconds.
- **Walk-to** — directed walk toward a canvas-offset target (from canvas click); arrives within 6 px then idles.

Edge bounce: the creature flips facing direction and reverses velocity at ±38% of canvas width or height. Position is persisted in `sessionStorage` keyed on `sb_pos_{GEN}_{MOR}`.

### Accessibility

- **Keyboard navigation** — the creature canvas carries `tabindex="0"` so keyboard-only users can focus it using the Tab key. Pressing **Enter** while the canvas is focused synthesises a click at the creature's current visual centre, triggering the normal poke reaction. The `aria-label` is updated to mention "press Enter to interact" for sighted keyboard users.
- **Genome bar accessibility** — every genome visualisation bar (`sb-genome-bar-track`) now carries `role="progressbar"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, and an `aria-label` that includes both the raw value and the percentage of range (e.g. "Morphology: 4500 (45% of range)"). Previously screen readers announced only the label and the raw number with no indication of where the value sat within its valid range.
- **Screen reader support for Unicode art** — all `<pre>` unicode art blocks carry `aria-hidden="true"`. A visually-hidden `<span class="sb-sr-only">` immediately follows each block with a concise text summary of the creature's name, sex, lifecycle stage, and health state.
- **Fertility text badge** — the **🌸 Fertile Now** badge communicates fertility status as explicit text, independent of the Young Adult stage colour (#f48fb1) and the 🌸 lifecycle icon.
- **Focus management** — when navigating from a creature grid to a creature detail page, keyboard focus is shifted programmatically to the creature name heading (`<h2 data-focus-target tabindex="-1">`). Screen-reader users hear the creature name announced immediately on arrival.
- **Text contrast** — `--clr-muted` (used for secondary labels, card metadata, and the genome table dimension text) is `#949494`, achieving a contrast ratio of 4.6:1 against the `#111` dark background — meeting the WCAG AA minimum of 4.5:1. The previous value of `#888` produced only 4.1:1 and failed WCAG AA. `.sb-dimmer-2` and `.sb-phantom-author` use `#767676` (4.54:1), also meeting WCAG AA.
- **Genome bar height** — the genome visualisation bars were increased from 6 px to 10 px for improved colour legibility on low-contrast displays.
- **Visually-hidden utility class** — `.sb-sr-only` (1×1 px, clipped, off-screen margin) is used wherever a text alternative must be provided for non-text content without disrupting the visual layout.

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

### Accessory Templates

Four templates are currently implemented and renderable on creatures:

- 🎩 Hat
- 👑 Crown
- 📿 Necklace
- 🪽 Wings

The "Shirt" template was removed from `ACCESSORY_TEMPLATES` because no renderer exists for it. A defensive early-return guard in `_drawAccessoryOnCreature` catches any legacy shirt genomes still on-chain.

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

### Parameter Input Controls

Each genome parameter in the Create Accessory panel is controlled by a **paired range + number input**. The range slider allows quick "vibe" adjustments by dragging. The adjacent `<input type="number">` allows typing an exact integer, which is essential for hitting precise values (e.g. a specific hue of exactly 142°) on mobile devices where the slider thumb cannot be positioned with sufficient precision. Both inputs share the same `updateGenome(key, value)` handler and stay in sync at all times.

### Accessory Browse Pagination

The `/#/accessories` page supports template filter buttons (Hat, Crown, Necklace, Wings) and page-by-page pagination.

- Switching filter resets to page 1 (watched via `filterTemplate` watcher).
- After a fresh fetch from the chain, `listPage` is also reset to 1, ensuring that a user browsing a deep page of "All Accessories" is not left on an empty page after the total item count changes.

### Wearing Accessories on Creatures

#### Permission Model (on accessory post replies)

Accessory owners control wear access with on-chain replies:

- `wear_request` — user asks permission to wear
- `wear_grant` — owner grants a specific username
- `wear_revoke` — owner revokes a specific username
- `wear_public` — owner opens the accessory to everyone
- `wear_private` — owner returns to private mode (grants required)

Rules: permissions are user-based (not creature-based); accessory owner is always implicitly permitted; public mode allows anyone to equip without explicit grant.

#### Equip State Model (on creature post replies)

Creature owners control what is currently worn by publishing:

- `wear_on` — equip accessory
- `wear_off` — remove accessory

The creature post is the source of truth for current equip state.

#### UI Behaviour

- Creature page shows a **Wear / Equip panel** for owners.
- Owners can paste an accessory URL or pick from a "closet" (owned accessories) to equip.
- The app checks permission before equipping, and prevents equipping if that accessory is already worn by another creature.
- **Revoked permissions (lapsed):** a "⚠ Lapsed" badge is displayed; the accessory stops rendering on the creature canvas (`_normalizedWearings()` filters `permissionLapsed: true`); only Remove remains.
- **Fossil accessory retrieval:** the equip form is hidden for fossil creatures, but Remove buttons remain for every equipped item. The fossil notice explicitly lists any accessories whose permission has lapsed — these are invisible on the canvas because lapsed items are filtered from `_normalizedWearings()`, so owners might not realise they are still locked in the fossil's metadata and need to be Removed to return them to the closet.
- **Phantom/deleted accessories** — if an accessory owner deletes their post (`delete_comment`), `fetchCreatureWearings` detects the tombstoned post via `isPhantomPost()` and silently skips it. The equip slot is freed so the creature owner can attach a replacement without first having to "Remove" an item that is no longer visible.
- **Closet thumbnails** — each accessory in the closet grid is rendered by `ClosetThumbComponent`, which draws the accessory once into an off-screen canvas, then converts it to a PNG via the async `canvas.toBlob()` API and stores the result as a `blob:` object URL. Zero live GPU contexts are held per closet item. Renders are staggered through a module-level `requestIdleCallback` queue (`_closetThumbQueue`) so thumbnails populate gradually during browser idle slices. The closet retains a **Load More** button that reveals 20 additional thumbnails at a time.
- **Ghost accessory state** — all transient equip-panel UI is reset automatically on creature navigation.
- **Wear exclusivity** — the app checks the accessory's reply history before equipping to prevent two creatures wearing the same accessory simultaneously.
- **Double-spend guard** — when a `wear_on` broadcast is dispatched, the accessory ID is added to `window._sbPendingEquips` (a session-level Set shared across all instances). Any concurrent second call for the same ID is rejected immediately.
- **Post-transfer lock-out ("Panic Reset")** — the accessory page surfaces a **🚨 Force Unequip** button when the new owner finds the accessory still equipped on a creature they don't own.
- **Public domain confirmation** — the `wear_public` action is guarded by a browser confirmation dialog explaining that equips made during the public window persist even if the owner later reverts to private.
- **Layer reorder** — owners can reorder draw layers using ▲/▼ controls in the equip panel.

---

## Activities

All three creature interactions — feeding, play, and walking — are presented in a single unified **🌿 Activities** panel on the creature page, directly below the canvas. Each action is published as a blockchain reply. Fossil creatures cannot receive any activities.

### Feed 🍃

Feeding improves the creature's **health**, which affects its canvas expression, lifespan, and fertility window.

**Food types:**

| Food | Lifespan bonus | Fertility boost |
|---|---|---|
| 🍯 Nectar | +1 day per feed | none |
| 🌿 Herbs | none | +5% window extension per feed |
| 🍖 Meat | +0.5 day per feed | +2% window extension per feed |

Health score is `feedEvents.total / 20` (capped at 1.0). The daily feed limit resets at UTC midnight.

### Play 🎮

Playing boosts the creature's **mood**, which adds up to +25% to the effective health score for expression calculation and extends the fertility window. One play per user per day. Mood score is `activityState.playTotal / 15` (capped at 1.0).

### Walk 🦮

Walking boosts **vitality**, which adds lifespan days proportional to `activityState.walkTotal`. One walk per user per day. Vitality score is `activityState.walkTotal / 15` (capped at 1.0).

### Keychain Timeout Guard

All three activity actions (Feed, Play, Walk) and offspring publishing share a **60-second Keychain timeout guard**. If the user dismisses the Steem Keychain popup using the browser's window close button rather than the in-extension Cancel button, some Keychain versions silently drop the callback, leaving the UI in a permanent "Feeding…" / "Playing…" / "Walking…" / "Publishing…" state with no way to recover short of a page refresh.

The guard works as follows: immediately after `publishFeed` / `publishPlay` / `publishWalk` / `publishOffspring` is called, a `setTimeout` is set for 60 seconds. A `_callbackFired` boolean is shared between the real callback and the timeout handler. Whichever fires first sets the flag to `true`; the other is then a no-op. If the timeout fires first, all publishing flags are reset, any optimistic state is rolled back, the anticipation pose is cleared, and the user sees a "Transaction timed out or was closed — please try again." notification.

---

## Upload: Image-Inspired Creatures

The `/upload` page converts any image into a deterministic creature genome.

### Image Analysis Pipeline

1. The image is downsampled to at most 120×120 px via an off-screen canvas.
2. Every pixel is classified as silhouette or background using a lightness threshold.
3. Six statistics are extracted: `dominantHue`, `meanSat`, `meanLit`, `litVariance`, `aspectRatio`, `edgeDensity`, `colourfulness`, `lowContrast`.

### Non-Blocking Analysis

The pixel downsampling (`samplePixels`) and Sobel edge detection + HSL conversion (`analysePixels`) are synchronous and can block the main thread for 200–500 ms on large source images. Before either function runs, the app yields back to the browser via `requestAnimationFrame(() => setTimeout(resolve, 0))`. This guarantees the "Analysing…" spinner is composited to screen before the heavy work begins.

### Genome Fitting

| Stat | Target gene | Method |
|---|---|---|
| `dominantHue` | `GEN`, `CLR` | Best-fit palette search via `fitHue()` |
| `aspectRatio` | `MOR` | Full linear scan of all 10,000 MOR values via `fitMor()` — guarantees the global optimum regardless of PRNG basin width (see below) |
| `edgeDensity` | `APP` | Linear mapping + RNG jitter via `fitApp()` |
| `colourfulness` + `litVariance` + `edgeDensity` | `ORN` | Weighted blend + bounded jitter via `fitOrn()` |
| RNG stream | `SX`, `LIF`, `FRT_START`, `FRT_END`, `MUT` | Drawn from master seed (`pixelHash ^ rerollIndex`) |

**MOR search — full scan:** `fitMor()` performs a single linear pass over all 10,000 MOR values (`for m in 0..9999`) and returns the one whose rendered body aspect ratio is closest to the image's silhouette ratio. The mulberry32 PRNG used by the creature renderer is highly non-linear; the mapping from MOR integer to aspect ratio contains narrow "basins of attraction" — contiguous ranges as small as 1–3 values that produce a given ratio. A previous coarse-step approach (step size 7, then ±200 fine scan) could land in the wrong basin for very tall or wide images, producing a noticeably incorrect body shape. A full scan of 10,000 values takes approximately 10–15 ms on a modern phone and runs inside a non-blocking `requestAnimationFrame`, so there is no UX cost to the exhaustive approach.

### Reroll

The **🎲 Reroll** button increments `rerollIndex` and regenerates the genome from the same image. Small deterministic offsets are applied to `aspectRatio` (±15% per unit) and `dominantHue` (±25° per unit) before fitting, giving each reroll a visibly different body shape and colour palette. `rerollIndex = 0` always produces the pure image-faithful result.

The button is disabled for 300 ms after each click (`rerolling` flag) to prevent double-tap CPU stalls.

### Genus Override (Preview Step)

The Genus Override field is available both before and after image analysis. In the preview step, editing the field calls `applyGenusOnly()` rather than `reroll()`. This updates only `genome.GEN` — and regenerates the creature's name accordingly — without incrementing `rerollIndex`. The body shape and colour palette that the user was happy with are preserved.

### UI Flow

1. **Pick** — drag-and-drop zone or file browser (JPG, PNG, GIF, WebP)
2. **Analyse** — spinner renders before pixel analysis runs (non-blocking via `requestAnimationFrame`)
3. **Preview** — source image left, generated creature canvas right; stats table; low-contrast warning if applicable; editable post title; **🎲 Reroll**, **🌿 Publish**, **✕ Start over**
4. **Published** — navigates directly to the new creature's page

---

## Ownership Transfer

Creature ownership can be transferred between users via a **two-sided on-chain handshake**. Creatures cannot be forced on unwilling recipients.

### Protocol

**Offer:** The effective owner publishes a `transfer_offer` reply naming the recipient. **Accept:** The recipient publishes a `transfer_accept` reply referencing the exact `offer_permlink`. **Cancel:** The owner can publish `transfer_cancel` at any time before acceptance.

### Permlink Uniqueness

Every `transfer_offer` reply permlink is generated by `buildPermlink()`, which appends `Date.now()` to the slugified title string (e.g. `steembiota-transfer-offer-bob-1750000000000`). This guarantees that repeated offers to the same recipient — even after months have elapsed — always produce distinct permlinks. Steem does not allow two comments with the same author+permlink pair; a static slug without a timestamp would cause the second offer to fail with a "permlink already exists" node error.

### Pending Transfer Visibility

Creatures with an open transfer offer display a **🤝 Pending → @recipient** amber badge directly on their card in the Home grid and Profile page.

### Username Validation

All username inputs (Transfer Panel recipient, Breed Permit grantee) strip leading `@` symbols and surrounding whitespace before processing. A regex check (`/^[a-z0-9.-]+$/`) enforces Steem's valid username character set. Both sanitisation and validation are applied before the `getAccounts` existence check and before any Keychain call, preventing malformed names from reaching the blockchain and causing impossible-to-accept offer states.

### Self-Transfer Guard

The Send Offer button is disabled and an inline warning is shown whenever the recipient input field contains the logged-in user's own username. This check is reactive — it is evaluated on every keystroke via a computed property (`isSelfTransfer`).

### Effective Owner

The original `post.author` never changes on-chain. SteemBiota derives the **effective owner** by walking the reply history via `parseOwnershipChain()`. The effective owner governs who can manage permits, who sees the Transfer panel, and whose profile the creature appears on.

### Ownership Rules

- Only the effective owner at the time of an offer may publish it; only the named recipient may accept.
- Permits issued before a completed transfer are voided automatically (`permitsValidFrom` timestamp).
- **Recipient account verification** — before publishing a `transfer_offer`, the app calls `getAccounts` to verify the recipient exists on Steem, preventing typo-induced permanent lock-outs.
- **Accept pre-flight check** — before the Keychain popup opens for a `transfer_accept`, the app re-fetches the creature's latest replies and re-runs `parseOwnershipChain`. If the pending offer's `offer_permlink` no longer matches the chain's current active offer, the accept is blocked with a clear error message.
- **Cancel pre-flight check** — before the Keychain popup opens for a `transfer_cancel`, the app similarly re-fetches the latest reply set and verifies the offer is still active. If the recipient already accepted, the cancel is aborted and local state is synced immediately.

---

## Breeding

### Compatibility Rules

Two creatures can breed if: same `GEN`; opposite sex; both within their effective fertility window; neither is fossil or phantom; breeder has permission for both parents; pair passes the kinship check (no shared recent ancestors).

### Early Genus Mismatch Detection

When a Parent B URL is pasted into the Breed panel, the app fetches both genomes (debounced 800 ms) and checks `GEN` equality before running the full ancestor walk. If the genera differ, an inline error is shown immediately. This prevents the user from waiting through the full kinship check only to see a genus error at the final Breed button click.

### Kinship Check

`checkBreedingCompatibility(resA, resB)` walks up to twelve generations of ancestry via BFS, using a cache-first strategy (IndexedDB → live RPC) to avoid redundant network calls for already-visited ancestors. Results from the early URL-paste check are cached in `kinshipPreview` and reused at Breed time if still valid, halving total RPC cost for the common case. The Breed button is disabled while `kinshipPreview === "checking"` to prevent duplicate concurrent ancestor walks.

If the check fails mid-way due to a public node rate-limit (HTTP 429) or a CORS timeout, the `kinshipPreview` state is explicitly set to an error object before the exception propagates. This ensures the Breed button returns to its normal idle state with a readable error message rather than staying permanently frozen in "Verifying…".

### Kinship: Severed Lineage

If `fetchAncestors` encounters a **phantom** (deleted) ancestor post during the BFS traversal, it no longer throws an error. Instead, it records the phantom node as `{ severed: true }` and sets `visited._hasSeveredLineage = true`, then continues traversal past it (the phantom has no fetchable parents, so the BFS simply does not enqueue further nodes from that branch).

`checkBreedingCompatibility` returns `{ severedLineage: true, warning: "…" }` instead of `null` when either ancestry walk encountered a phantom. Breeding is **not blocked** — the kinship check still verifies that the two immediate parents are not too closely related based on the reachable portion of the tree. The child genome is stamped with `_severedLineage: true` in its `json_metadata`, and an amber informational banner is displayed in the breed preview panel. This prevents one user's long-ago post deletion from permanently poisoning all downstream creatures who descend from that lineage.

### Matchmaker

The **🔍 Find Compatible Partner** button fetches up to 200 recent posts plus the localStorage list cache, filters to same-genus / opposite-sex / currently-fertile / non-duplicate candidates, and presents up to 5 partner cards. Selecting a card uses a two-tap confirm pattern (first tap stages, second tap confirms and breeds) to prevent accidental taps.

---

## Tab State Persistence

`CreatureView` uses five tabs: Interact, Family, Stats, Manage, and Social. The active tab is persisted in the URL as `?tab=stats` (within the hash — e.g. `/#/@alice/creature?tab=stats`) so that:

- **Browser Back / Forward** navigates between tabs as expected.
- **Shared links** land on the correct tab.
- **Creature-to-creature navigation** reads the tab from the new URL, defaulting to Interact.

The URL is updated via `history.replaceState()` on every tab click, avoiding extra browser history entries.

---

## Notifications

The **🔔 Notifications** page (`/#/notifications`) aggregates all on-chain events relevant to the logged-in user.

| Event | Description |
|---|---|
| 🍖 Feed | Someone fed one of your creatures |
| 🎾 Play | Someone played with one of your creatures |
| 🐾 Walk | Someone walked one of your creatures |
| 🐣 Birth | Someone bred an offspring from one of your creatures |
| 🧬 Breed | Someone used your creature's lineage to breed |
| 🤝 Transfer offer | Someone is offering you ownership of a creature |

Incoming transfer offers are highlighted at the top of the page with a one-click **✅ Accept** button. A red badge on the 🔔 nav icon shows the count of pending offers, refreshed on login and polled every 5 minutes.

**Immediate badge sync** — when a transfer offer is accepted on the Notifications page, the nav-bar badge count is decremented immediately without waiting for the next 5-minute poll. `NotificationsView` calls the injected `updateNotifBadge(count)` function provided by the App root, passing the count of remaining pending offers after removal.

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

### Genome Fingerprint

Every creature carries a stable fingerprint: a pipe-delimited string of all ten gene values. Two posts sharing an identical fingerprint have identical genomes regardless of author, claimed type, or parent links.

### Timestamp Priority

The post with the **earlier publication timestamp** is the original. Any later post with the same genome fingerprint is flagged as a duplicate.

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
| 🌿 Severed Lineage | Bred offspring whose lineage contains a Phantom ancestor; breeding was permitted but full ancestry could not be verified |

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

**Rank thresholds:**

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

The `/leaderboard` page ranks all known SteemBiota participants by XP. It fetches up to 200 creature posts via cursor-based pagination, then fetches each author's comment and vote history. RPC calls are rate-limited to 3 concurrent requests via `_throttledMap`. Per-author XP data is cached for 24 hours. Failed authors can be retried individually via a **Retry** button at reduced concurrency.

**Manual Refresh** — a **🔄 Refresh Rankings** button is shown in the leaderboard header. Clicking it evicts the 24-hour leaderboard cache and triggers a full re-fetch from the chain, allowing a player who has just bred a speciated offspring (earning ~575 XP) or joined for the first time to see their updated ranking immediately. The button is rate-limited to once every 10 minutes per browser session to protect public RPC nodes; attempting to refresh too soon shows a timed message with the remaining wait in minutes.

---

## Caching

| Cache | Storage | TTL | Scope |
|---|---|---|---|
| Creature list (Home grid) | IndexedDB | 5 min | Global |
| Creature page | IndexedDB | 10 min | Per creature |
| Ancestry graph | IndexedDB | persistent | Per creature |
| Profile owned creatures | localStorage | 30 min | Per user |
| Profile owned accessories | localStorage | 30 min | Per user |
| Notifications | localStorage | 60 s | Per user |
| Leaderboard | localStorage | 24 h | Global (manual-refresh burstable) |
| Per-author XP detail | localStorage | 24 h | Per author |

**Global invalidation stamp** — `invalidateGlobalListCaches()` writes a version timestamp; any cache entry written before it is treated as stale immediately.

**Surgical cache patching** — after a transfer, only the affected item's `effectiveOwner` is patched in the list cache and both owners' profile caches.

**localStorage quota eviction** — on `QuotaExceededError`, the oldest `steembiota:*` entries are evicted one by one until the write succeeds.

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
| `/#/@user` | Profile — tabbed inventory of owned creatures and accessories |
| `/#/@author/permlink` | Creature — canvas, activities, equip panel, breed panel, transfer panel, Stats/Family/Social tabs. Active tab persisted in `?tab=` query param. |
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

## Key Principles

**Immutability** — All genomes and life events are stored on-chain and cannot be altered.

**Determinism** — The same genome always renders the same creature. The same two parents always produce the same child.

**UTC time** — All timestamps use UTC to match the Steem blockchain clock.

**Client-side only** — All logic runs in the browser. No servers or external databases.

**Diversity enforcement** — The kinship system prevents same-bloodline farming. Genus mismatch is detected at URL-paste time, not just at final submission.

**Provenance transparency** — Genome fingerprinting and timestamp-priority checks expose copy-pasted creatures publicly without requiring any trusted authority.

**Anti-dumping ownership** — Transfers require the recipient's explicit on-chain acceptance. Pending offers are visible on creature cards in list views.

**Stale-result safety** — All multi-step async operations that write to component state use generation counters or equivalent guards to discard results that were superseded by a subsequent navigation before they completed. This applies to creature loading, kinship loading, ProfileView background refreshes, and AccessoriesView filter fetches.

**On-chain pre-flight verification** — Before opening the Keychain popup for a transfer accept, the app re-fetches the latest reply set and verifies the offer is still current.

**Opt-in breeding** — Creatures are closed to external breeding by default. Owners must explicitly grant named permits.

**Username sanitisation** — All raw username inputs strip leading `@` symbols, trim whitespace, and validate against Steem's allowed character set (`/^[a-z0-9.-]+$/`) before any RPC call or Keychain operation. This prevents malformed names (e.g. `@alice` instead of `alice`) from producing unacceptable transfer offers or invalid permit grants.

**Non-blocking lineage** — A deleted ancestor post (Phantom) degrades gracefully to a "Severed Lineage" trait on the child rather than permanently blocking breeding for all downstream descendants. The kinship inbreeding check still runs on the reachable portion of the tree.

**Immediate UI feedback** — Accepting a transfer offer immediately decrements the nav-bar notification badge without waiting for the 5-minute poll interval. Rejecting a Feed Keychain prompt immediately re-enables the Feed button without waiting for a blockchain re-fetch.

**Keychain timeout resilience** — All Keychain publishing operations (Feed, Play, Walk, Publish Offspring) carry a 60-second self-cancelling timeout guard. If the browser-native "X" on the Keychain popup is used rather than the in-extension Cancel button, the callback may never fire; the timeout ensures the UI always recovers to a clean state.

**Optimal MOR search** — The image upload genome-fitting function performs a full linear scan of all 10,000 MOR values to find the body aspect ratio closest to the source image's silhouette, guaranteeing the global optimum is always found regardless of how narrow the PRNG's local basins are.

**Mobile-first interactions** — Canvas tap dead-zones compensate for bobbing motion. `pointer-events: none` is applied when activity panels overlap the canvas. `touch-action: pan-y` ensures vertical scroll gestures always take priority over canvas click handlers. A dedicated stacking context (`position:relative; z-index:10`) wraps the social counters and vote-picker popover so the GPU-composited canvas animation layer can never flicker through it on mobile Chrome/Safari. A `touchstart`/`touchend` distance threshold (< 5 px) distinguishes genuine taps from micro-scroll gestures on high-sensitivity touchscreens. A touch ripple (expanding ring at the tap point, 200 ms) provides immediate visual feedback on every tap.

**Keyboard accessibility** — The creature canvas is focusable via Tab (`tabindex="0"`) and interactive via Enter key (`@keyup.enter`), allowing keyboard-only users to poke the creature without a mouse or touchscreen.

**Precision controls** — Every genome slider in the Accessory creator is paired with a number input so users can reach exact integer values on touch screens without relying on dragging accuracy.

**Surgical genome edits** — In the Upload preview, changing the Genus Override field updates only `GEN` without altering the visual reroll index. The shape and colour the user selected via 🎲 Reroll are preserved.

**Defensive caching** — Multi-tier caching (IndexedDB → localStorage → live fetch) with global invalidation stamps, surgical patching after transfers, quota-exceeded eviction, and a user-triggered manual refresh on the leaderboard (rate-limited to once per 10 minutes).

**Resilient URL parsing** — All Steem URL inputs strip zero-width Unicode characters and tolerate trailing query parameters and fragments.

**Non-blocking UI** — Heavy synchronous operations (image pixel analysis, Sobel edge detection) yield control back to the browser via `requestAnimationFrame` before running, so loading spinners are visible before work begins. Closet thumbnail rendering is staggered through a `requestIdleCallback` queue to avoid mount-time frame drops on large accessory collections.

**GPU context hygiene** — Closet accessory thumbnails use a render-once-to-blob strategy (`ClosetThumbComponent` with async `toBlob()`) rather than maintaining live canvas GPU contexts per item. The session-level `_sbPendingEquips` set prevents race conditions when the same accessory is being equipped from multiple browser tabs simultaneously.

**WCAG AA contrast** — `--clr-muted` is `#949494` (4.6:1 on `#111`), meeting WCAG AA. All text used for critical game information (provenance badges, transfer history, phantom labels) also meets the 4.5:1 minimum contrast ratio.

**Unique transfer permlinks** — Transfer offer permlinks always include a `Date.now()` timestamp suffix (via `buildPermlink()`), guaranteeing distinct identifiers even for repeated offers to the same recipient months apart, and preventing "permlink already exists" node errors on the second offer.

---

## License

Open source. Community experimentation and forks are encouraged.

---

## Author

Created for the Steem blockchain ecosystem by @puncakbukit.
