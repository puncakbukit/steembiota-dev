// ============================================================
// upload.js
// SteemBiota — Image-Inspired Creature Upload
//
// Approach A: extract visual traits from a user-uploaded image,
// fit genome values that produce a creature sharing the image's
// colour family and rough proportions, then publish as a standard
// "founder" creature via the existing publishCreature() call.
//
// Pipeline:
//   FileReader → <img> → 64×64 analysis canvas → pixel stats
//   → hue fit (best GEN+CLR pair) → MOR search (aspect ratio)
//   → APP/ORN from texture entropy → LIF/FRT randomised → genome
//
// Dependencies (must be loaded before this file):
//   blockchain.js  — publishCreature, buildPermlink
//   app.js         — generateFullName, buildUnicodeArt, generateGenusName,
//                    buildDefaultTitle, getLifecycleStage
//   components.js  — CreatureCanvasComponent (registered globally)
// ============================================================

"use strict";

// ============================================================
// IMAGE ANALYSIS — pure functions, no DOM side-effects
// ============================================================

/**
 * Load a File/Blob into an HTMLImageElement.
 * Resolves with the element; rejects on decode failure.
 */
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode image.")); };
    img.src = url;
  });
}

/**
 * Sample a pixel grid from an image.
 * Downsamples to SAMPLE_SIZE × SAMPLE_SIZE for speed.
 * Returns a Uint8ClampedArray (RGBA).
 */
const SAMPLE_SIZE = 64;
function samplePixels(img) {
  const canvas = document.createElement("canvas");
  canvas.width  = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  // Release the GPU backing store immediately — the canvas is never attached
  // to the DOM but the browser still holds a texture allocation until we
  // zero the dimensions or drop all references.
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

/**
 * Convert sRGB [0,255] to HSL.
 * Returns { h: 0–360, s: 0–100, l: 0–100 }.
 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l   = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Generates a stable 32-bit hash from the pixel data (FNV-1a, 32-bit).
 * Placed here with the other pure pixel helpers so it is always defined
 * before imageToGenome, which calls it.  (Function declarations are hoisted
 * by JS, but this ordering avoids the pitfall if the file is ever converted
 * to ES module syntax where hoisting does not apply.)
 */
function hashPixels(data) {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0;
}

/**
 * Derive aggregate colour statistics from the pixel sample.
 *
 * Returns:
 *   dominantHue      — circular-mean hue of non-grey pixels (0–360)
 *   meanSat          — mean saturation of non-grey pixels (0–100)
 *   meanLit          — mean lightness of all pixels (0–100)
 *   litVariance      — variance of lightness (proxy for contrast/texture)
 *   aspectRatio      — silhouette bounding-box aspect ratio W/H (1.0 = square)
 *   edgeDensity      — fraction of high-gradient pixels (0–1, proxy for detail)
 *   colourfulness    — fraction of pixels with sat > 20 (0–1)
 */
function analysePixels(data, imgW, imgH) {
  const n = SAMPLE_SIZE * SAMPLE_SIZE;

  // --- Colour stats ---
  let sinSum = 0, cosSum = 0, satSum = 0, litSum = 0;
  let colourCount = 0;
  const lits = [];

  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    if (a < 32) continue; // skip transparent

    const { h, s, l } = rgbToHsl(r, g, b);
    lits.push(l);
    litSum += l;

    if (s > 12) { // non-grey
      const rad = h * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
      satSum += s;
      colourCount++;
    }
  }

  const meanLit = litSum / lits.length;
  const litVariance = lits.reduce((acc, l) => acc + (l - meanLit) ** 2, 0) / lits.length;

  // Circular mean hue
  const dominantHue = colourCount === 0
    ? 0
    : Math.round((Math.atan2(sinSum / colourCount, cosSum / colourCount) * 180 / Math.PI + 360) % 360);

  const meanSat     = colourCount === 0 ? 0 : Math.round(satSum / colourCount);
  const colourfulness = colourCount / lits.length;

  // --- Silhouette aspect ratio ---
  // Estimate from the non-near-white pixel bounding box on the analysis canvas.
  let minX = SAMPLE_SIZE, maxX = 0, minY = SAMPLE_SIZE, maxY = 0;
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let x = 0; x < SAMPLE_SIZE; x++) {
      const idx = (y * SAMPLE_SIZE + x) * 4;
      const a = data[idx + 3];
      if (a < 32) continue;
      const { l } = rgbToHsl(data[idx], data[idx + 1], data[idx + 2]);
      if (l < 90) { // exclude near-white background
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const silW = Math.max(1, maxX - minX);
  const silH = Math.max(1, maxY - minY);

  // FIX 5: Low-contrast guard.
  // A plain bounds check (minX < maxX) is not enough — a white cat on a white
  // background may produce a bounding box of only a handful of shadow pixels,
  // technically non-empty but covering < 5 % of the canvas area. In that case
  // silW/silH is effectively 1.0 (square) regardless of the actual creature shape.
  //
  // Two-tier fallback:
  //   1. If the box is empty → use raw image aspect ratio (pre-existing behaviour).
  //   2. If the box is non-empty but occupies < 5 % of the canvas → same fallback
  //      AND set lowContrast=true so the caller can notify the user.
  const boxValid   = minX < maxX && minY < maxY;
  const silArea    = silW * silH;
  const canvasArea = SAMPLE_SIZE * SAMPLE_SIZE;
  const lowContrast = !boxValid || (silArea / canvasArea < 0.05);
  const aspectRatio = lowContrast ? (imgW / imgH) : (silW / silH);

  // --- Edge density (Sobel, lightness channel) ---
  // Build a greyscale matrix from lits
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    grey[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  }
  let edgeCount = 0;
  const S = SAMPLE_SIZE;
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const gx =
        -grey[(y-1)*S+(x-1)] + grey[(y-1)*S+(x+1)]
        -2*grey[y*S+(x-1)]   + 2*grey[y*S+(x+1)]
        -grey[(y+1)*S+(x-1)] + grey[(y+1)*S+(x+1)];
      const gy =
        -grey[(y-1)*S+(x-1)] - 2*grey[(y-1)*S+x] - grey[(y-1)*S+(x+1)]
        +grey[(y+1)*S+(x-1)] + 2*grey[(y+1)*S+x] + grey[(y+1)*S+(x+1)];
      if (Math.sqrt(gx*gx + gy*gy) > 0.18) edgeCount++;
    }
  }
  const edgeDensity = edgeCount / ((S - 2) * (S - 2));

  return { dominantHue, meanSat, meanLit, litVariance, aspectRatio, edgeDensity, colourfulness, lowContrast };
}

// ============================================================
// GENOME FITTING — map image stats → genome integers
// ============================================================

/**
 * The same 8-palette table used by buildPhenotype() in components.js.
 * Reproduced here so this file is self-contained.
 */
const PALETTES = [
  { base: 160 }, { base: 200 }, { base: 280 }, { base:  30 },
  { base: 340 }, { base: 100 }, { base: 240 }, { base:  55 },
];

/**
 * Circular distance between two hue values (0–360).
 */
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Find the (GEN, CLR) pair whose rendered finalHue is closest to targetHue.
 *
 * For each of the 8 palette bases, CLR must satisfy:
 *   (base + CLR) % 360 ≈ targetHue
 *   CLR = (targetHue - base + 360) % 360
 *
 * GEN is then chosen as any value in [0, 999] that maps to this palette index:
 *   GEN % 8 === paletteIndex
 * We pick a GEN that also incorporates some randomness for variety.
 *
 * Now accepts an rng function for deterministic selection.
 *
 * Returns { GEN, CLR }.
 */
function fitHue(targetHue, rng) {
  let bestGen = 0, bestClr = 0, bestDist = Infinity;

  for (let pi = 0; pi < PALETTES.length; pi++) {
    const base = PALETTES[pi].base;
    const clr  = (targetHue - base + 360) % 360;
    const final = (base + clr) % 360;
    const dist  = hueDist(final, targetHue);

    if (dist < bestDist) {
      bestDist = dist;
      bestClr  = clr;

      // Pick a GEN in [0,999] that maps to this palette index using rng()
      const base_gen = pi + Math.floor(rng() * 125) * 8;
      bestGen = Math.min(999, base_gen);
    }
  }

  return { GEN: bestGen, CLR: bestClr };
}

/**
 * Seeded mulberry32 PRNG — matches the creature renderer exactly,
 * so we can simulate what buildPhenotype() will produce for a given MOR seed.
 */
function makePrngFit(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compute the rendered body aspect ratio for a given MOR seed.
 * Mirrors the MOR block in buildPhenotype():
 *   bodyLen = 80 + rng() * 30
 *   bodyH   = 42 + rng() * 18
 *   ratio   = bodyLen / bodyH
 */
function morAspectRatio(mor) {
  const rng     = makePrngFit(mor);
  const bodyLen = 80 + rng() * 30;
  const bodyH   = 42 + rng() * 18;
  return bodyLen / bodyH;
}

/**
 * Search the MOR space [0, 9999] for the value whose rendered body
 * aspect ratio is closest to targetRatio.
 *
 * bodyLen and bodyH are both drawn from the same MOR-seeded PRNG, so they
 * are correlated — the true achievable aspect-ratio space is not a simple
 * Cartesian product of [80,110] × [42,60] and cannot be described by a
 * pair of analytical min/max constants.  We therefore skip the pre-clamp
 * entirely and let the full coarse+fine scan find the closest achievable
 * value directly.  The search already returns the best match for any input,
 * even targets outside the achievable range, so the clamp was only masking
 * edge cases without improving accuracy.
 *
 * Uses a coarse scan (every 37 steps ≈ 270 probes) then refines
 * around the best candidate.  Runs in < 1 ms in all modern browsers.
 *
 * Returns MOR integer.
 */
function fitMor(targetRatio) {
  let bestMor = 0, bestDist = Infinity;

  // FIX 2C: Reduced coarse scan step from 37 → 7.
  // mulberry32 is non-linear, so the aspect-ratio curve through MOR space has
  // local optima with widths sometimes narrower than 37 units.  A step of 37
  // could skip an entire "sweet spot" — for very tall or very wide images the
  // coarse winner would land in the wrong basin of attraction, and the ±200
  // fine scan would never reach the true optimum.  A step of 7 costs ~14×
  // more iterations (1428 vs 270) but is still microseconds on modern CPUs,
  // and guarantees no basin narrower than 7 MOR units is missed.
  for (let m = 0; m < 10000; m += 7) {
    const dist = Math.abs(morAspectRatio(m) - targetRatio);
    if (dist < bestDist) { bestDist = dist; bestMor = m; }
  }

  // Fine scan ±200 around the coarse winner
  const lo = Math.max(0, bestMor - 200);
  const hi = Math.min(9999, bestMor + 200);
  for (let m = lo; m <= hi; m++) {
    const dist = Math.abs(morAspectRatio(m) - targetRatio);
    if (dist < bestDist) { bestDist = dist; bestMor = m; }
  }

  return bestMor;
}

/**
 * Map edge density (0–1) to APP seed.
 * High edge density → higher APP (more varied appendages, e.g., complex ears/wings).
 * APP is in [0, 9999].
 *
 * Now accepts an rng function for deterministic jitter.
 */
function fitApp(edgeDensity, rng) {
  // Linear mapping to full range
  const base = Math.round(edgeDensity * 9999);

  // Slightly reduced jitter for more stability while still allowing variation
  const jitter = Math.floor(rng() * 2000) - 1000;

  return Math.max(0, Math.min(9999, base + jitter));
}

/**
 * Map colourfulness + litVariance + edgeDensity to ORN seed.
 * High colourfulness + contrast + detail → richer ornamentation / fur texture.
 *
 * Now accepts an rng function for deterministic jitter.
 *
 * The jitter is scaled to the available headroom on each side so it always
 * has real effect even when the base lands near 0 or 9999.  Without this,
 * a near-monochromatic or near-fully-saturated image produces a base close
 * to a boundary, the ±500 jitter is entirely clamped away, and every such
 * image maps to the same ORN value — reducing ornament diversity.
 */
function fitOrn(colourfulness, litVariance, edgeDensity, rng) {
  // Normalize lighting variance (~0–800 → 0–1)
  const normLit = Math.min(litVariance / 800, 1.0);

  // Blend edge detail + contrast into a texture driver
  const textureScore = (edgeDensity * 0.7) + (normLit * 0.3);

  // Final weighted combination
  const base = Math.round(
    (colourfulness * 0.4 + textureScore * 0.6) * 9999
  );

  // Scale the maximum jitter to the smaller of the two headroom values so the
  // shifted result is always within [0, 9999] and the full ±range is usable.
  const maxJitter = Math.min(base, 9999 - base, 500);
  const jitter = Math.floor(rng() * (maxJitter * 2 + 1)) - maxJitter;

  return Math.max(0, Math.min(9999, base + jitter));
}

/**
 * Full image-to-genome conversion (deterministic with reroll support).
 *
 * @param {HTMLImageElement} img  — decoded image element
 * @param {number} rerollIndex    — optional reroll seed modifier
 * @returns {object} genome       — valid SteemBiota genome object
 */
function imageToGenome(img, rerollIndex = 0) {
  const data  = samplePixels(img);
  const stats = analysePixels(data, img.naturalWidth, img.naturalHeight);

  // Create deterministic seed from pixel hash + reroll index
  const pixelHash = hashPixels(data);
  const masterSeed = (pixelHash ^ rerollIndex) >>> 0;
  const rng = makePrngFit(masterSeed);

  // BUG FIX 6: Reroll Visual Variety.
  // fitMor() is derived purely from the image's aspectRatio and fitHue() from
  // dominantHue — both are locked to the image stats, so clicking "Reroll" only
  // varied APP/ORN (jitter-based) while MOR and CLR stayed identical every time.
  // Fix: on reroll (rerollIndex > 0), apply a small deterministic random offset to
  // aspectRatio (±15 % of the detected value) and dominantHue (±25 °) so the body
  // shape and colour palette shift visibly without completely ignoring the image.
  // rerollIndex === 0 is always the "pure" image-faithful result so the first
  // preview is unchanged; subsequent rerolls explore nearby genome space.
  let effectiveRatio = stats.aspectRatio;
  let effectiveHue   = stats.dominantHue;

  if (rerollIndex > 0) {
    // Offset range grows slightly with each reroll (capped at ×3) so early
    // rerolls stay close to the image while later ones explore wider.
    const strength = Math.min(rerollIndex, 3);
    // rng() is already advanced past hue/mor usage below, so we consume two
    // dedicated values here at the top of the RNG stream (before fitHue/fitMor).
    const ratioOffset = (rng() - 0.5) * 2 * 0.15 * strength;  // ±15 % per unit
    const hueOffset   = (rng() - 0.5) * 2 * 25   * strength;  // ±25 ° per unit
    effectiveRatio = Math.max(0.5, effectiveRatio * (1 + ratioOffset));
    effectiveHue   = ((effectiveHue + hueOffset) % 360 + 360) % 360;
  }

  // Deterministic gene fitting using shared RNG stream
  const { GEN, CLR } = fitHue(effectiveHue, rng);
  const MOR           = fitMor(effectiveRatio); // already deterministic
  const APP           = fitApp(stats.edgeDensity, rng);
  const ORN           = fitOrn(
    stats.colourfulness,
    stats.litVariance,
    stats.edgeDensity,
    rng
  );

  // Deterministic lifespan and fertility
  const LIF       = 80 + Math.floor(rng() * 80);
  const FRT_START = Math.min(20 + Math.floor(rng() * 20), LIF - 10);
  const FRT_END   = Math.min(60 + Math.floor(rng() * 20), LIF - 1);

  return {
    GEN,
    SX: Math.floor(rng() * 2),
    MOR,
    APP,
    ORN,
    CLR,
    LIF,
    FRT_START,
    FRT_END,
    MUT: Math.floor(rng() * 3),
    // Provenance tag — not used by renderer but visible in genome table
    _source: "image-upload"
  };
}

// ============================================================
// UploadView — Vue 3 component
// Route: /upload
// ============================================================

const UploadView = {
  name: "UploadView",
  inject: ["username", "hasKeychain", "notify"],
  components: { CreatureCanvasComponent },

data() {
  return {
    // Step management: "pick" | "analyse" | "preview" | "published"
    step:          "pick",

    // Image state
    imageFile:          null,
    imageDataUrl:       null,    // for <img> preview
    imageEl:            null,    // decoded HTMLImageElement
    analysisError:      "",
    lowContrastWarning: false,   // true when silhouette < 5% of canvas (white-on-white)

    // Derived genome + render inputs
    genome:        null,
    imageStats:    null,    // raw stats from analysePixels()
    facingRight:   false,
    unicodeArt:    "",
    customTitle:   "",
    genusInput:    "",      // optional genus override (0–999)

    // Publishing
    publishing:    false,

    // Drag state
    isDragging:    false,

    // Reroll tracking
    rerollIndex:   0,
    // FIX 3B: Debounce flag — set to true for 300ms after each reroll click so
    // mashing the button can't queue multiple simultaneous imageToGenome calls
    // (which are CPU-heavy and will freeze the canvas on each invocation).
    rerolling:     false,
  };
},

  computed: {
  creatureName()  { return this.genome ? generateFullName(this.genome) : ""; },
  genusName()     { return this.genome ? generateGenusName(this.genome.GEN) : ""; },
  sexLabel()      { return this.genome ? (this.genome.SX === 0 ? "♂ Male" : "♀ Female") : ""; },
  lifecycleStage(){ return this.genome ? getLifecycleStage(0, this.genome) : null; },
  canPublish()    { return !!this.username && !!this.genome && !!window.steem_keychain && !this.publishing; },
  genusInputValid() {
    if (this.genusInput === "") return true;
    const n = Number(this.genusInput);
    return Number.isInteger(n) && n >= 0 && n <= 999;
  },
  statRows() {
    if (!this.imageStats) return [];
    const s = this.imageStats;
    return [
      { label: "Dominant hue",   value: s.dominantHue + "°",                 desc: "→ CLR / GEN palette" },
      { label: "Mean saturation",value: s.meanSat + "%",                      desc: "→ colour richness" },
      { label: "Mean lightness", value: s.meanLit.toFixed(1) + "%",           desc: "→ shade" },
      { label: "Contrast",       value: s.litVariance.toFixed(0),             desc: "→ Fur texture" }, // UPDATED
      { label: "Edge density",   value: (s.edgeDensity * 100).toFixed(1) + "%", desc: "→ Ear & Tail styles" }, // UPDATED
      { label: "Colourfulness",  value: (s.colourfulness * 100).toFixed(1) + "%", desc: "→ ORN ornament seed" },
      { label: "Aspect ratio",   value: s.aspectRatio.toFixed(2),             desc: "→ Body shape" }, // UPDATED
    ];
  }
},

methods: {
  // ----------------------------------------------------------
  // File input handling
  // ----------------------------------------------------------
  onFileInputChange(e) {
    const file = e.target.files && e.target.files[0];
    if (file) this.startAnalysis(file);
  },

  onDrop(e) {
    e.preventDefault();
    this.isDragging = false;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) this.startAnalysis(file);
  },

  onDragOver(e) { e.preventDefault(); this.isDragging = true; },
  onDragLeave()  { this.isDragging = false; },

  triggerFileInput() { this.$refs.fileInput.click(); },

  // ----------------------------------------------------------
  // Core analysis pipeline
  // ----------------------------------------------------------
  async startAnalysis(file) {
    this.rerollIndex        = 0; // NEW: reset reroll index
    this.imageFile          = file;
    this.analysisError      = "";
    this.lowContrastWarning = false;
    this.genome             = null;
    this.imageStats         = null;
    this.step               = "analyse";

    // Show image preview immediately
    const reader = new FileReader();
    reader.onload = e => { this.imageDataUrl = e.target.result; };
    reader.readAsDataURL(file);

    try {
      const img      = await loadImageFile(file);
      this.imageEl   = img;

      // FIX 2B (Main-Thread Image Analysis): samplePixels() draws a potentially
      // large image onto a 64×64 canvas and analysePixels() runs Sobel edge
      // detection + HSL conversion — both are synchronous and can block the main
      // thread for 200–500ms on large (10MB+) photos.  Wrapping them in a
      // requestAnimationFrame allows the browser to commit the "Analysing…"
      // spinner to the screen BEFORE the heavy work starts, so the UI doesn't
      // appear frozen.  We then await a small setTimeout(0) after rAF to ensure
      // the spinner paint has been flushed by the compositor.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

      const data   = samplePixels(img);
      const stats  = analysePixels(data, img.naturalWidth, img.naturalHeight);
      this.imageStats = stats;

      // FIX 5: Notify user when silhouette detection fell back to full-image
      // proportions due to low contrast (e.g. white cat on white background).
      if (stats.lowContrast) this.lowContrastWarning = true;

      // UPDATED: pass rerollIndex
      const genome = imageToGenome(img, this.rerollIndex);

      // Apply genus override if provided
      if (this.genusInput !== "" && this.genusInputValid) {
        genome.GEN = Number(this.genusInput);
      }

      this.genome      = genome;
      this.facingRight = Math.random() < 0.5;
      this.unicodeArt  = buildUnicodeArt(genome, 0, null, this.facingRight, "standing");
      this.customTitle = buildDefaultTitle(generateFullName(genome), new Date());
      this.step        = "preview";
    } catch (err) {
      this.analysisError = err.message || "Failed to analyse image.";
      this.step = "pick";
    }
  },

  // ----------------------------------------------------------
  // Reroll — regenerate genome keeping the same image
  // ----------------------------------------------------------
  reroll() {
    if (!this.imageEl) return;
    // FIX 3B: Prevent double-click CPU stall.
    // imageToGenome() touches every pixel of the image and runs a PRNG-heavy
    // genome fitting loop.  If the user mashes the button, queuing several of
    // these in rapid succession will freeze the canvas for hundreds of ms.
    // A 300ms lockout lets the current frame finish painting before the next
    // call is accepted.
    if (this.rerolling) return;
    this.rerolling = true;
    setTimeout(() => { this.rerolling = false; }, 300);

    this.rerollIndex++; // increment index

    // UPDATED: pass rerollIndex
    const genome = imageToGenome(this.imageEl, this.rerollIndex);

    if (this.genusInput !== "" && this.genusInputValid) {
      genome.GEN = Number(this.genusInput);
    }

    this.genome      = genome;
    this.unicodeArt  = buildUnicodeArt(genome, 0, null, this.facingRight, "standing");
    this.customTitle = buildDefaultTitle(generateFullName(genome), new Date());
  },

  // FIX 4 — Genus-only redraw: apply the genus override (or remove it) without
  // touching rerollIndex.  Called when the user edits the Genus field in the
  // preview step.  This lets the user lock in a specific genus while keeping the
  // image-matched shape and colours they were happy with — only GEN changes.
  applyGenusOnly() {
    if (!this.imageEl || !this.genome) return;
    if (!this.genusInputValid) return;
    const genome = { ...this.genome };
    if (this.genusInput !== "") {
      genome.GEN = Number(this.genusInput);
    } else {
      // Blank input: restore the genome's original GEN from the image analysis
      // (re-derive without touching rerollIndex).
      const fresh = imageToGenome(this.imageEl, this.rerollIndex);
      genome.GEN  = fresh.GEN;
    }
    this.genome      = genome;
    this.unicodeArt  = buildUnicodeArt(genome, 0, null, this.facingRight, "standing");
    this.customTitle = buildDefaultTitle(generateFullName(genome), new Date());
  },

  // ----------------------------------------------------------
  // Publish
  // ----------------------------------------------------------
  async publish() {
    if (!this.canPublish) return;
    if (!this.genusInputValid) {
      this.notify("Genus must be a whole number from 0 to 999.", "error");
      return;
    }
    this.publishing = true;
    publishCreature(
      this.username,
      this.genome,
      this.unicodeArt,
      this.creatureName,
      0,
      this.lifecycleStage.name,
      this.customTitle,
      this.genusName,
      (response) => {
        this.publishing = false;
        if (response.success) {
          invalidateGlobalListCaches();
          invalidateOwnedCachesForUser(this.username);
          this.notify("🌿 " + this.creatureName + " published to the blockchain!", "success");
          this.$router.push("/@" + this.username + "/" + response.permlink);
        } else {
          this.notify("Publish failed: " + (response.message || "Unknown error"), "error");
        }
      }
    );
  },

  // ----------------------------------------------------------
  // Reset back to image picker
  // ----------------------------------------------------------
  reset() {
    this.step          = "pick";
    this.imageFile     = null;
    this.imageDataUrl  = null;
    this.imageEl       = null;
    this.genome        = null;
    this.imageStats    = null;
    this.analysisError = "";
    this.genusInput    = "";
    this.rerollIndex   = 0; // OPTIONAL: reset here too
    if (this.$refs.fileInput) this.$refs.fileInput.value = "";
  },

  onFacingResolved(dir) {
    this.facingRight = dir;
    if (this.genome) {
      this.unicodeArt = buildUnicodeArt(this.genome, 0, null, dir, "standing");
    }
  },

  hueSwatchStyle(hue) {
    return `background: hsl(${hue}, 60%, 55%); width:16px; height:16px; border-radius:50%; display:inline-block; vertical-align:middle; margin-right:6px; flex-shrink:0;`;
  },
},

  template: `
    <div style="margin-top:20px;padding:0 16px 60px;max-width:700px;margin-left:auto;margin-right:auto;">

      <!-- Page header -->
      <h2 style="color:#a5d6a7;margin:0 0 4px;font-size:1.05rem;letter-spacing:0.04em;">
        📸 Upload-Inspired Creature
      </h2>
      <p style="font-size:13px;color:#555;margin:0 0 20px;line-height:1.6;">
        Upload any image — a photo, illustration, or sketch — and SteemBiota will extract its
        colour, texture, and proportions to inspire a new creature genome. The result is a real,
        valid founder that lives permanently on the Steem blockchain.
      </p>

      <!-- Login gate -->
      <div v-if="!username" style="padding:20px;border:1px solid #333;border-radius:10px;background:#111;text-align:center;color:#888;font-size:14px;">
        Please log in to upload an image and publish a creature.
      </div>

      <template v-else>

        <!-- ══════════════════════════════════════════════════════
             STEP 1: IMAGE PICKER
        ══════════════════════════════════════════════════════ -->
        <div v-if="step === 'pick'">

          <!-- Error banner from a prior failed analysis -->
          <div v-if="analysisError"
            style="margin-bottom:14px;padding:10px 14px;border-radius:8px;
                   background:#3b0000;border:1px solid #b71c1c;color:#ff8a80;font-size:13px;">
            ⚠ {{ analysisError }}
          </div>

          <!-- Drop zone -->
          <div
            @click="triggerFileInput"
            @drop="onDrop"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            :style="{
              border: '2px dashed ' + (isDragging ? '#66bb6a' : '#333'),
              borderRadius: '12px',
              padding: '48px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: isDragging ? '#0d1a0d' : '#0a0a0a',
              transition: 'all 0.18s',
              userSelect: 'none'
            }"
          >
            <div style="font-size:2.6rem;margin-bottom:12px;line-height:1;">📸</div>
            <div style="font-size:15px;color:#a5d6a7;font-weight:bold;margin-bottom:6px;">
              Drop an image here
            </div>
            <div style="font-size:12px;color:#555;">
              or click to browse — JPG, PNG, GIF, WebP
            </div>
          </div>

          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            style="display:none;"
            @change="onFileInputChange"
          />

          <!-- Optional genus override -->
          <div style="margin-top:20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;">
            <label style="font-size:13px;color:#888;">Genus override (0–999, blank = auto):</label>
            <input
              v-model="genusInput"
              type="number"
              min="0" max="999" step="1"
              placeholder="auto"
              style="width:90px;font-size:13px;padding:5px 8px;"
            />
            <span v-if="genusInput !== '' && !genusInputValid" style="font-size:12px;color:#ff8a80;">
              Must be 0–999
            </span>
          </div>

          <!-- What to expect callout -->
          <div style="margin-top:24px;padding:14px 16px;border-radius:10px;
                      background:#0d1a0d;border:1px solid #1a3a1a;font-size:12px;
                      color:#666;line-height:1.7;text-align:left;">
            <strong style="color:#a5d6a7;">How it works</strong><br/>
            The dApp analyses your image's dominant colour, contrast, texture complexity,
            and silhouette proportions. It then searches the genome parameter space for
            values that produce a creature sharing those traits — same colour family, similar
            body shape, matching ornament complexity. The creature is algorithmically inspired
            by your image, not a direct conversion of it.
          </div>
        </div>

        <!-- ══════════════════════════════════════════════════════
             STEP 2: ANALYSING
        ══════════════════════════════════════════════════════ -->
        <div v-else-if="step === 'analyse'" style="text-align:center;padding:40px 0;">
          <div v-if="imageDataUrl" style="margin-bottom:20px;">
            <img :src="imageDataUrl"
              style="max-width:200px;max-height:180px;border-radius:10px;
                     border:1px solid #333;object-fit:contain;background:#111;" />
          </div>
          <div style="display:inline-block;width:32px;height:32px;
            border:3px solid #333;border-top-color:#66bb6a;
            border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:12px;"></div>
          <p style="color:#888;font-size:14px;margin:0;">Analysing image traits…</p>
          <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        </div>

        <!-- ══════════════════════════════════════════════════════
             STEP 3: PREVIEW & PUBLISH
        ══════════════════════════════════════════════════════ -->
        <div v-else-if="step === 'preview' && genome">

          <!-- FIX 5: Low-contrast warning — shown when the silhouette detector
               fell back to full-image proportions because the subject blends
               into the background (e.g. white cat on white background). -->
          <div v-if="lowContrastWarning"
            style="margin-bottom:14px;padding:10px 14px;border-radius:8px;
                   background:#2a1f00;border:1px solid #7a5800;color:#ffe082;font-size:13px;">
            ⚠ Low contrast detected — your creature's outline was hard to distinguish
            from the background, so the body shape was inferred from the full image
            proportions instead. For the best results, try uploading a photo with a
            plain dark or coloured background.
          </div>

          <!-- Two-column layout: image | creature canvas -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;align-items:start;">

            <!-- Source image -->
            <div style="text-align:center;">
              <div style="font-size:11px;color:#444;letter-spacing:0.06em;margin-bottom:6px;text-transform:uppercase;">
                Source image
              </div>
              <img :src="imageDataUrl"
                style="max-width:100%;max-height:220px;border-radius:8px;
                       border:1px solid #222;object-fit:contain;background:#0a0a0a;" />
            </div>

            <!-- Creature canvas -->
            <div style="text-align:center;">
              <div style="font-size:11px;color:#444;letter-spacing:0.06em;margin-bottom:6px;text-transform:uppercase;">
                Inspired creature
              </div>
              <creature-canvas-component
                :genome="genome"
                :age="0"
                :fossil="false"
                :canvas-w="200"
                :canvas-h="180"
                @facing-resolved="onFacingResolved"
                style="margin:0 auto;display:block;border-radius:8px;border:1px solid #222;"
              ></creature-canvas-component>
            </div>
          </div>

          <!-- Creature identity -->
          <div style="margin-bottom:16px;padding:12px 16px;border-radius:10px;
                      background:#0d1a0d;border:1px solid #1a3a1a;text-align:center;">
            <div style="font-size:1.15rem;font-weight:bold;color:#a5d6a7;letter-spacing:0.03em;">
              🧬 {{ creatureName }}
            </div>
            <div style="font-size:13px;color:#888;margin-top:4px;">
              {{ sexLabel }}
              <span style="color:#333;margin:0 8px;">·</span>
              <span :style="{ color: lifecycleStage && lifecycleStage.color }">
                {{ lifecycleStage && lifecycleStage.icon }} {{ lifecycleStage && lifecycleStage.name }}
              </span>
              <span style="color:#333;margin:0 8px;">·</span>
              Lifespan {{ genome.LIF }} days
            </div>
          </div>

          <!-- Image analysis stats -->
          <div style="margin-bottom:16px;">
            <div style="font-size:11px;color:#444;letter-spacing:0.06em;margin-bottom:8px;text-transform:uppercase;">
              Image traits detected
            </div>
            <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;overflow:hidden;">
              <div v-for="row in statRows" :key="row.label"
                style="display:flex;justify-content:space-between;align-items:center;
                       padding:6px 12px;border-bottom:1px solid #111;font-size:12px;">
                <span style="color:#555;display:flex;align-items:center;">
                  <span v-if="row.label === 'Dominant hue'"
                    :style="hueSwatchStyle(imageStats.dominantHue)"></span>
                  {{ row.label }}
                </span>
                <span style="color:#aaa;font-family:monospace;">
                  {{ row.value }}
                  <span style="color:#333;font-size:11px;margin-left:6px;">{{ row.desc }}</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Post title edit -->
          <div style="margin-bottom:16px;">
            <label style="font-size:12px;color:#555;display:block;margin-bottom:4px;text-align:left;">
              Post title
            </label>
            <input
              v-model="customTitle"
              type="text"
              maxlength="120"
              style="width:100%;font-size:13px;padding:7px 10px;box-sizing:border-box;"
            />
          </div>

          <!-- Genus override (editable in preview too) -->
          <div style="margin-bottom:20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <label style="font-size:12px;color:#555;">Genus override (0–999):</label>
            <input
              v-model="genusInput"
              type="number"
              min="0" max="999" step="1"
              placeholder="auto"
              style="width:80px;font-size:13px;padding:5px 8px;"
              @change="applyGenusOnly"
            />
            <!-- FIX 4 — Genus change no longer calls reroll(), so the rerollIndex is
                 not incremented and the creature's shape/colour stays stable. -->
            <span v-if="genusInput !== '' && !genusInputValid" style="font-size:12px;color:#ff8a80;">
              Must be 0–999
            </span>
          </div>

          <!-- Action buttons -->
          <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:20px;">

            <!-- Reroll -->
            <!-- FIX 3B: :disabled="rerolling" prevents CPU stalls from rapid re-clicks -->
            <button
              @click="reroll"
              :disabled="rerolling"
              style="background:#1a2a1a;border:1px solid #2e7d32;color:#a5d6a7;"
              title="Regenerate a different creature from the same image"
            >🎲 Reroll</button>

            <!-- Publish -->
            <button
              @click="publish"
              :disabled="!canPublish"
              :style="{
                background: canPublish ? '#2e7d32' : '#1a1a1a',
                color: canPublish ? '#fff' : '#444',
                fontWeight: 'bold',
                minWidth: '140px'
              }"
            >
              {{ publishing ? "Publishing…" : "🌿 Publish Creature" }}
            </button>

            <!-- Start over -->
            <button @click="reset" style="background:#1a1a1a;color:#555;border:1px solid #2a2a2a;">
              ✕ Start over
            </button>
          </div>

          <!-- No keychain notice -->
          <div v-if="!hasKeychain"
            style="font-size:12px;color:#ff8a80;text-align:center;margin-top:-8px;margin-bottom:16px;">
            ⚠ Steem Keychain extension is not installed — publishing unavailable.
          </div>

          <!-- Honesty notice -->
          <div style="padding:12px 14px;border-radius:8px;background:#0d0a00;
                      border:1px solid #2a2000;font-size:12px;color:#666;line-height:1.7;">
            <strong style="color:#ffb74d;">Note:</strong>
            The creature is <em>inspired</em> by your image, not a direct conversion.
            It shares your image's colour palette and approximate body proportions,
            but remains a procedural SteemBiota creature — generated by genome, not pixels.
            The source image is not stored on-chain; only the genome is published.
          </div>
        </div>

      </template>
    </div>
  `
};


