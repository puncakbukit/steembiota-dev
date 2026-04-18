// ============================================================
// accessories.js
// SteemBiota — Accessory System
//
// An accessory is a wearable item created by a user, stored as
// a Steem post with its own on-chain record.  The design mirrors
// the creature system:
//
//   accessoryGenome  → deterministic parameters (colour, shape, size)
//   template         → one of 4 types: hat | crown | necklace | wings
//   AccessoryCanvasComponent → renders the accessory on a 400×320 canvas
//   AccessoryCardComponent   → compact card for the browse grid
//   AccessoriesView          → /#/accessories browse page + creator tool
//
// json_metadata shape:
//   { steembiota: { version:"1.0", type:"accessory",
//     accessory: { template, name, genome: AccessoryGenome } } }
//
// No Vue, no DOM dependencies in the pure helper functions below.
// ============================================================

// ============================================================
// ACCESSORY GENOME
//
// Ten integer parameters, analogous to creature genes.
// All values are deterministic — the same genome always renders
// the same accessory.
//
// CLR  0–359   Primary hue (degrees)
// SAT  0–100   Colour saturation
// LIT  10–90   Colour lightness
// SZ   20–100  Overall size scalar (% of max)
// VAR  0–9999  Shape variation seed (drives fine details)
// ACC  0–9999  Accent seed (secondary colour, trim pattern)
// STR  0–9999  Structure seed (thickness, proportions)
// ORN  0–9999  Ornament seed (gems, studs, embroidery)
// SHN  0–100   Shininess / metallic level
// SYM  0–1     Symmetry axis (0=left-heavy, 1=right-heavy, mid=balanced)
// ============================================================

function generateAccessoryGenome() {
  const ri = max => Math.floor(Math.random() * max);
  return {
    CLR: ri(360),
    SAT: 40 + ri(61),       // 40–100
    LIT: 30 + ri(51),       // 30–80
    SZ:  40 + ri(61),       // 40–100
    VAR: ri(10000),
    ACC: ri(10000),
    STR: ri(10000),
    ORN: ri(10000),
    SHN: ri(101),
    SYM: Math.random()
  };
}

// Seeded PRNG — same as creature system (mulberry32)
function accPrng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Safe modulo for name picking
function accPick(arr, n) {
  return arr[((Math.round(n) % arr.length) + arr.length) % arr.length];
}

// ============================================================
// ACCESSORY NAMING SYSTEM
//
// Names combine a material adjective with a type-specific noun.
// Entirely deterministic from the genome.
// ============================================================

const ACC_MATERIALS = [
  "Gilded","Silver","Obsidian","Crimson","Azure",
  "Verdant","Ember","Frosted","Shadow","Radiant",
  "Arcane","Woven","Crystal","Ashen","Ivory",
  "Bronze","Cobalt","Scarlet","Viridian","Onyx"
];

const ACC_NOUNS = {
  hat:      ["Cap","Brim","Topper","Slouch","Fedora","Cloche","Bonnet","Pork Pie"],
  crown:    ["Crown","Tiara","Diadem","Circlet","Wreath","Coronet","Halo","Aureole"],
  necklace: ["Pendant","Choker","Chain","Torque","Amulet","Locket","Collar","Beads"],
  wings:    ["Wings","Plumes","Vanes","Pinions","Sails","Fins","Fans","Feathers"]
};

function generateAccessoryName(template, genome) {
  const mat  = accPick(ACC_MATERIALS, genome.CLR + genome.SAT);
  const noun = accPick(ACC_NOUNS[template] || ACC_NOUNS.hat, genome.VAR);
  return `${mat} ${noun}`;
}

// ============================================================
// ACCESSORY TEMPLATES — 4 renderers
//
// Each renderer is a pure function:
//   drawXxx(ctx, genome, W, H, opts)
//   opts = { selected: bool }  — for editor highlight ring
//
// All use the canvas coordinate system:
//   centre = (W*0.5, H*0.5)
//
// Colour helpers are inlined so this file has no dependencies.
// ============================================================

function _hsl(h, s, l, a = 1) {
  return a < 1 ? `hsla(${h},${s}%,${l}%,${a})` : `hsl(${h},${s}%,${l}%)`;
}
function _linGrad(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([t, c]) => g.addColorStop(t, c));
  return g;
}
function _radGrad(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([t, c]) => g.addColorStop(t, c));
  return g;
}

// ── HAT ───────────────────────────────────────────────────────
function drawHat(ctx, g, W, H) {
  const cx   = W * 0.5, cy = H * 0.5;
  const sz   = g.SZ / 100;
  const rng  = accPrng(g.VAR);
  const rngA = accPrng(g.ACC);
  const rngS = accPrng(g.STR);
  const rngO = accPrng(g.ORN);

  const hue  = g.CLR, sat = g.SAT, lit = g.LIT;
  const aHue = (hue + 40 + rngA() * 60) % 360;

  // Proportions
  const brimW  = (90 + rng()  * 40) * sz;
  const brimH  = (10 + rng()  * 8)  * sz;
  const crownW = (46 + rngS() * 20) * sz;
  const crownH = (55 + rngS() * 30) * sz;
  const crownTopW = crownW * (0.7 + rngS() * 0.25);

  const brimY  = cy + 30 * sz;
  const crownB = brimY - brimH * 0.5;
  const crownT = crownB - crownH;

  // Shadow under brim
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(cx, brimY + 6 * sz, brimW * 0.9, brimH * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  // Brim
  const brimGr = _linGrad(ctx, cx, brimY - brimH, cx, brimY + brimH,
    [[0, _hsl(hue, sat, lit + 8)], [0.5, _hsl(hue, sat, lit)], [1, _hsl(hue, sat, lit - 12)]]
  );
  ctx.fillStyle = brimGr;
  ctx.strokeStyle = _hsl(hue, sat, lit - 18);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(cx, brimY, brimW, brimH, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  // Crown body (trapezoid drawn as bezier)
  const crownGr = _linGrad(ctx, cx - crownW, crownT, cx + crownW, crownB,
    [[0, _hsl(hue, sat, lit + 5)], [0.4, _hsl(hue, sat, lit)], [1, _hsl(hue, sat, lit - 15)]]
  );
  ctx.fillStyle = crownGr;
  ctx.strokeStyle = _hsl(hue, sat, lit - 20);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - crownTopW, crownT);
  ctx.bezierCurveTo(cx - crownW * 0.9, crownT + crownH * 0.25, cx - crownW, crownB - brimH * 0.3, cx - crownW, crownB);
  ctx.lineTo(cx + crownW, crownB);
  ctx.bezierCurveTo(cx + crownW, crownB - brimH * 0.3, cx + crownW * 0.9, crownT + crownH * 0.25, cx + crownTopW, crownT);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Crown top (slight rounded cap)
  ctx.fillStyle = _hsl(hue, sat, lit + 6);
  ctx.beginPath();
  ctx.ellipse(cx, crownT, crownTopW, crownH * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hat band
  const bandH  = (7 + rngO() * 5) * sz;
  const bandY  = crownB - bandH;
  ctx.fillStyle = _hsl(aHue, sat + 15, lit - 5);
  ctx.strokeStyle = _hsl(aHue, sat, lit - 22);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - crownW, crownB);
  ctx.lineTo(cx - crownW, bandY);
  ctx.bezierCurveTo(cx - crownW * 0.95, bandY - 2 * sz, cx + crownW * 0.95, bandY - 2 * sz, cx + crownW, bandY);
  ctx.lineTo(cx + crownW, crownB);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Ornament: optional gem on band
  if (rngO() > 0.4) {
    const gemX = cx + (rngO() - 0.5) * crownW * 0.6;
    const gemR = (5 + rngO() * 5) * sz;
    const gemGr = _radGrad(ctx, gemX - gemR * 0.3, bandY + bandH * 0.4, 0, gemR,
      [[0, _hsl(aHue, 80, 90)], [0.5, _hsl(aHue, 100, 65)], [1, _hsl(aHue, 80, 35)]]
    );
    ctx.fillStyle = gemGr;
    ctx.strokeStyle = _hsl(aHue, 60, 30, 0.8);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(gemX, bandY + bandH * 0.5, gemR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // Specular
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.arc(gemX - gemR * 0.3, bandY + bandH * 0.3, gemR * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Shininess highlight on crown
  if (g.SHN > 30) {
    ctx.globalAlpha = g.SHN / 200;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.ellipse(cx - crownW * 0.2, crownT + crownH * 0.18, crownW * 0.25, crownH * 0.06, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ── CROWN ─────────────────────────────────────────────────────
function drawCrown(ctx, g, W, H) {
  const cx  = W * 0.5, cy = H * 0.5;
  const sz  = g.SZ / 100;
  const rng = accPrng(g.VAR);
  const rngA = accPrng(g.ACC);
  const rngS = accPrng(g.STR);
  const rngO = accPrng(g.ORN);

  const hue = g.CLR, sat = g.SAT, lit = g.LIT;
  const aHue = (hue + 180) % 360;  // complementary for gems

  const baseW = (80 + rng()  * 30) * sz;
  const baseH = (16 + rngS() * 8)  * sz;
  const points = 3 + Math.floor(rngS() * 3);  // 3–5 spires
  const spikeH = (40 + rng() * 30) * sz;

  const baseY = cy + 20 * sz;
  const baseTop = baseY - baseH;

  // Base band gradient (gold/silver/gem-coloured)
  const baseGr = _linGrad(ctx, cx, baseTop, cx, baseY,
    [[0, _hsl(hue, sat, lit + 12)], [0.5, _hsl(hue, sat, lit)], [1, _hsl(hue, sat, lit - 10)]]
  );
  ctx.fillStyle = baseGr;
  ctx.strokeStyle = _hsl(hue, sat, lit - 22);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(cx - baseW, baseTop, baseW * 2, baseH);
  ctx.fill(); ctx.stroke();

  // Spires
  const spireGr = _linGrad(ctx, cx, baseTop - spikeH, cx, baseTop,
    [[0, _hsl(hue, sat, lit + 18)], [0.6, _hsl(hue, sat, lit + 4)], [1, _hsl(hue, sat, lit - 8)]]
  );
  ctx.fillStyle = spireGr;
  ctx.strokeStyle = _hsl(hue, sat, lit - 20);
  ctx.lineWidth = 1.2;

  for (let i = 0; i < points; i++) {
    const t      = i / (points - 1);
    const spireX = cx - baseW + t * baseW * 2;
    // Centre spire is tallest; outer ones shorter
    const htMul  = 1 - Math.abs(t - 0.5) * (0.4 + rng() * 0.3);
    const h      = spikeH * htMul;
    const w      = (8 + rngS() * 8) * sz;
    ctx.beginPath();
    ctx.moveTo(spireX - w, baseTop);
    ctx.lineTo(spireX, baseTop - h);
    ctx.lineTo(spireX + w, baseTop);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Gem at tip
    const gemR = (4 + rngO() * 4) * sz * htMul;
    const gemGr = _radGrad(ctx, spireX - gemR * 0.3, baseTop - h + gemR * 0.3, 0, gemR * 1.1,
      [[0, _hsl(aHue, 90, 90)], [0.5, _hsl(aHue, 100, 60)], [1, _hsl(aHue, 80, 30)]]
    );
    ctx.fillStyle = gemGr;
    ctx.beginPath();
    ctx.arc(spireX, baseTop - h, gemR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.beginPath();
    ctx.arc(spireX - gemR * 0.3, baseTop - h - gemR * 0.25, gemR * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Base filigree dots
  const dots = 4 + Math.floor(rngO() * 5);
  for (let i = 0; i < dots; i++) {
    const dx = cx - baseW * 0.85 + (i / (dots - 1)) * baseW * 1.7;
    const dy = baseTop + baseH * 0.5;
    const dr = (2.5 + rngO() * 2.5) * sz;
    ctx.fillStyle = _hsl(aHue, sat + 20, lit + 20);
    ctx.beginPath(); ctx.arc(dx, dy, dr, 0, Math.PI * 2); ctx.fill();
  }

  // Metallic sheen on base
  if (g.SHN > 20) {
    ctx.globalAlpha = g.SHN / 180;
    ctx.fillStyle = _hsl(hue, 20, 96);
    ctx.beginPath();
    ctx.ellipse(cx, baseTop + baseH * 0.25, baseW * 0.7, baseH * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ── NECKLACE ──────────────────────────────────────────────────
function drawNecklace(ctx, g, W, H) {
  const cx  = W * 0.5, cy = H * 0.5;
  const sz  = g.SZ / 100;
  const rng = accPrng(g.VAR);
  const rngA = accPrng(g.ACC);
  const rngS = accPrng(g.STR);
  const rngO = accPrng(g.ORN);

  const hue = g.CLR, sat = g.SAT, lit = g.LIT;
  const aHue = (hue + 150 + rngA() * 80) % 360;

  // Ring sized/positioned to read as neckwear (encircling the neck),
  // not a loose hanging chain.
  const ringRx   = (56 + rng()  * 26) * sz;
  const ringRy   = (18 + rngS() * 10) * sz;
  const ringY    = cy - (18 + rngS() * 6) * sz;
  const ringThk  = (3.2 + rngS() * 2.2) * sz;
  const links    = 10 + Math.floor(rngS() * 8);

  // Back half of the necklace (darker) to imply it wraps behind neck.
  ctx.strokeStyle = _hsl(hue, Math.max(25, sat - 12), lit - 24, 0.72);
  ctx.lineWidth   = ringThk * 0.9;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.ellipse(cx, ringY, ringRx, ringRy, 0, Math.PI, Math.PI * 2, false);
  ctx.stroke();

  // Front lower half: brighter and thicker.
  const frontGr = _linGrad(ctx, cx - ringRx, ringY - ringRy, cx + ringRx, ringY + ringRy,
    [[0, _hsl(hue, sat, lit - 10)], [0.5, _hsl(hue, sat, lit + 8)], [1, _hsl(hue, sat, lit - 12)]]
  );
  ctx.strokeStyle = frontGr;
  ctx.lineWidth   = ringThk;
  ctx.beginPath();
  ctx.ellipse(cx, ringY, ringRx, ringRy, 0, 0, Math.PI, false);
  ctx.stroke();

  // Beads/links only on visible front arc.
  for (let i = 0; i <= links; i++) {
    const t = i / links;
    const ang = Math.PI - t * Math.PI; // left (π) to right (0) along front half
    const bx = cx + Math.cos(ang) * ringRx;
    const by = ringY + Math.sin(ang) * ringRy;
    const br = (2.4 + rng() * 2.8) * sz;
    const beadHue = rng() > 0.5 ? hue : aHue;
    const beadGr  = _radGrad(ctx, bx - br * 0.28, by - br * 0.28, 0, br,
      [[0, _hsl(beadHue, sat + 10, lit + 24)], [0.6, _hsl(beadHue, sat, lit)], [1, _hsl(beadHue, sat, lit - 20)]]
    );
    ctx.fillStyle   = beadGr;
    ctx.strokeStyle = _hsl(beadHue, sat, lit - 26, 0.7);
    ctx.lineWidth   = 0.55;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    if (g.SHN > 25) {
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath(); ctx.arc(bx - br * 0.3, by - br * 0.3, br * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Central pendant hangs only slightly below the ring so necklace still reads as a collar.
  const pendX = cx;
  const pendY = ringY + ringRy + (8 + rngO() * 8) * sz;
  const pendR = (8 + rngO() * 8) * sz;
  const pendStyle = Math.floor(rngO() * 3); // 0=circle 1=diamond 2=teardrop

  const pendGr = _radGrad(ctx, pendX - pendR * 0.3, pendY - pendR * 0.3, 0, pendR * 1.2,
    [[0, _hsl(aHue, 90, lit + 30)], [0.5, _hsl(aHue, 100, lit + 5)], [1, _hsl(aHue, 80, lit - 15)]]
  );
  ctx.fillStyle   = pendGr;
  ctx.strokeStyle = _hsl(aHue, sat, lit - 22);
  ctx.lineWidth   = 1.2;

  if (pendStyle === 0) {
    ctx.beginPath(); ctx.arc(pendX, pendY, pendR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  } else if (pendStyle === 1) {
    ctx.beginPath();
    ctx.moveTo(pendX, pendY - pendR);
    ctx.lineTo(pendX + pendR * 0.75, pendY);
    ctx.lineTo(pendX, pendY + pendR);
    ctx.lineTo(pendX - pendR * 0.75, pendY);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(pendX, pendY - pendR * 0.5);
    ctx.bezierCurveTo(pendX + pendR, pendY - pendR * 0.5, pendX + pendR, pendY + pendR * 0.8, pendX, pendY + pendR);
    ctx.bezierCurveTo(pendX - pendR, pendY + pendR * 0.8, pendX - pendR, pendY - pendR * 0.5, pendX, pendY - pendR * 0.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  // Specular on pendant
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.beginPath();
  ctx.ellipse(pendX - pendR * 0.28, pendY - pendR * 0.28, pendR * 0.22, pendR * 0.14, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

// ── WINGS ─────────────────────────────────────────────────────
// --- Updated drawWings signature and logic ---
function drawWings(ctx, g, W, H, opts = {}) {
  const cx  = W * 0.5, cy = H * 0.5;
  const sz  = g.SZ / 100;
  const rng = accPrng(g.VAR);
  const rngA = accPrng(g.ACC);
  const rngS = accPrng(g.STR);
  const rngO = accPrng(g.ORN);

  const hue = g.CLR, sat = g.SAT, lit = g.LIT;
  const aHue = (hue + 25 + rngA() * 50) % 360;

  const wingStyle = Math.floor(rng() * 3); // 0=feather 1=bat 2=fairy

  const span  = (85 + rng()  * 45) * sz;
  const wingH = (55 + rngS() * 35) * sz;
  const rootY = cy + 5 * sz;

  function drawWingSide(flip) {
    const dir = flip ? -1 : 1; // eslint-disable-line no-unused-vars
    ctx.save();
    if (flip) { ctx.scale(-1, 1); ctx.translate(-W, 0); }

    // After the ctx.scale(-1,1) + translate(-W,0) flip, the canvas is mirrored
    // so that positive-x still points rightward relative to the wing.
    // wingRootX is the x-coordinate of the torso attachment point in the
    // (possibly reflected) coordinate space.  Because cx = W*0.5, both the
    // flipped and unflipped calls produce the same numeric value (W - cx = cx),
    // which is intentional: the flip transform handles the mirroring, so this
    // point always sits at the canvas centre in the local coordinate space.
    const wingRootX = W - cx;
    const wx = wingRootX + 8 * sz * (flip ? -1 : 1);

    if (wingStyle === 0) {
      // Feathered wing — layered ellipses
      const layers = 3 + Math.floor(rngS() * 2);
      for (let l = layers - 1; l >= 0; l--) {
        const t    = l / (layers - 1);
        const lSpan = span * (0.45 + t * 0.55);
        const lH   = wingH * (0.3 + t * 0.7);
        const lAngle = -0.25 - t * 0.35;
        const alpha = 0.55 + t * 0.35;
        const lHue  = t > 0.5 ? hue : aHue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle   = _hsl(lHue, sat, lit + 10 - l * 5);
        ctx.strokeStyle = _hsl(lHue, sat, lit - 15, 0.6);
        ctx.lineWidth   = 0.8;
        ctx.beginPath();
        ctx.ellipse(wx + lSpan * 0.38, rootY - lH * 0.25, lSpan * 0.62, lH * 0.45, lAngle, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;

    } else if (wingStyle === 1) {
      // Bat wing — membrane with spars
      const sparCount = 3 + Math.floor(rngS() * 2);
      const wingGr = _linGrad(ctx, wx, rootY, wx + span, rootY - wingH,
        [[0, _hsl(hue, sat, lit - 5, 0.85)], [0.5, _hsl(hue, sat, lit + 5, 0.7)], [1, _hsl(hue, sat, lit + 15, 0.4)]]
      );
      ctx.fillStyle   = wingGr;
      ctx.strokeStyle = _hsl(hue, sat, lit - 20, 0.8);
      ctx.lineWidth   = 1.2;
      ctx.beginPath();
      ctx.moveTo(wx, rootY);
      // Top curve
      ctx.bezierCurveTo(wx + span * 0.2, rootY - wingH * 0.8, wx + span * 0.7, rootY - wingH, wx + span, rootY - wingH * 0.55);
      // Bottom scallops
      for (let s = sparCount; s >= 0; s--) {
        const t  = s / sparCount;
        const bx = wx + t * span;
        const by = rootY + Math.sin(t * Math.PI) * wingH * 0.18;
        ctx.quadraticCurveTo(bx + span / sparCount * 0.55, by + wingH * 0.12, bx, by);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();

      // Spars
      ctx.strokeStyle = _hsl(hue, sat, lit - 12, 0.7);
      ctx.lineWidth = 1;
      for (let s = 0; s < sparCount; s++) {
        const t = (s + 0.5) / sparCount;
        ctx.beginPath();
        ctx.moveTo(wx, rootY);
        ctx.lineTo(wx + t * span * 1.05, rootY - wingH * (0.4 + t * 0.55));
        ctx.stroke();
      }

    } else {
      // Fairy wing — translucent gossamer ellipses with shimmer
      const wingGr = _radGrad(ctx, wx + span * 0.35, rootY - wingH * 0.4, 0, span * 0.75,
        [[0, _hsl(hue, sat + 30, lit + 30, 0.75)], [0.5, _hsl(aHue, sat + 20, lit + 15, 0.45)], [1, _hsl(hue, sat, lit, 0)]]
      );
      ctx.fillStyle   = wingGr;
      ctx.strokeStyle = _hsl(hue, sat + 20, lit + 10, 0.5);
      ctx.lineWidth   = 1;
      // Upper lobe
      ctx.beginPath();
      ctx.ellipse(wx + span * 0.35, rootY - wingH * 0.38, span * 0.55, wingH * 0.42, -0.22, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // Lower lobe
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.ellipse(wx + span * 0.22, rootY + wingH * 0.08, span * 0.32, wingH * 0.22, 0.15, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;

      // Shimmer veins
      if (g.SHN > 20) {
        ctx.strokeStyle = `rgba(255,255,255,${g.SHN / 300})`;
        ctx.lineWidth = 0.7;
        for (let v = 0; v < 5; v++) {
          const vx = wx + (0.1 + rngO() * 0.7) * span;
          const vy = rootY - (0.1 + rngO() * 0.7) * wingH;
          ctx.beginPath();
          ctx.moveTo(wx, rootY);
          ctx.lineTo(vx, vy);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  drawWingSide(false);
  drawWingSide(true);

  // NEW: Only draw the central attachment point if NOT being worn.
  // This allows the wings to "emerge" from the creature's torso naturally.
  if (!opts.isWorn) {
    const hue = g.CLR, sat = g.SAT, lit = g.LIT;
    ctx.fillStyle   = _hsl(hue, sat - 10, lit - 8);
    ctx.strokeStyle = _hsl(hue, sat, lit - 22);
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 5 * sz, 8 * sz, 12 * sz, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
}

// Dispatch table — maps template name → draw function
const ACCESSORY_RENDERERS = { hat: drawHat, crown: drawCrown, necklace: drawNecklace, wings: drawWings };

// Master draw entry point — draws the accessory centred on the canvas
// and optionally draws a soft selection ring around it.
// --- Updated master entry point to pass opts ---
function drawAccessory(ctx, template, genome, W, H, opts = {}) {
  const renderer = ACCESSORY_RENDERERS[template] || drawHat;
  ctx.clearRect(0, 0, W, H);

  if (!opts.transparentBackground) {
    const bg = _radGrad(ctx, W * 0.5, H * 0.5, 0, Math.max(W, H) * 0.6,
      [[0, "rgba(30,30,30,0.6)"], [1, "rgba(10,10,10,0)"]]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }

  // Pass opts through to renderer
  renderer(ctx, genome, W, H, opts);

  if (opts.selected) {
    ctx.strokeStyle = "rgba(102,187,106,0.55)";
    ctx.lineWidth   = 3;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(6, 6, W - 12, H - 12);
    ctx.setLineDash([]);
  }
}

// ============================================================
// ACCESSORY UNICODE ART
//
// A compact text representation stored in the post body.
// Each template has a small fixed-width ASCII silhouette
// decorated with Unicode glyphs driven by the genome.
// ============================================================

const UNI_ACC_GLYPHS = {
  hat:      ["🎩","👒","🪖","⛑","🎓"],
  crown:    ["👑","✨","💎","⭐","🔱"],
  necklace: ["📿","💍","✦","❋","◈"],
  wings:    ["🦋","🕊","🦅","✈","🪽"],
};

function buildAccessoryUnicodeArt(template, genome) {
  const emoji = accPick(UNI_ACC_GLYPHS[template] || UNI_ACC_GLYPHS.hat, genome.VAR);
  const gem   = accPick(["💎","✦","❋","◈","✶","⬡"], genome.ORN);
  const hueLabel = `CLR:${genome.CLR}° SAT:${genome.SAT} LIT:${genome.LIT}`;
  const szLabel  = `SZ:${genome.SZ}%  SHN:${genome.SHN}`;

  const lines = [
    `${emoji}  ${template.toUpperCase()}`,
    `${"─".repeat(24)}`,
    `  ${gem} ${hueLabel}`,
    `  ${gem} ${szLabel}`,
    `${"─".repeat(24)}`,
    `  VAR:${genome.VAR}  ACC:${genome.ACC}`,
    `  STR:${genome.STR}  ORN:${genome.ORN}`,
  ];
  return lines.join("\n");
}

// ============================================================
// ACCESSORY TEMPLATES CATALOGUE
// Static list of the base templates shown in the creator UI.
// ============================================================

const ACCESSORY_TEMPLATES = [
  { id: "hat",      label: "Hat",      icon: "🎩", desc: "Classic headwear — caps, fedoras, toppers" },
  { id: "crown",    label: "Crown",    icon: "👑", desc: "Regal headpiece — crowns, tiaras, circlets" },
  { id: "necklace", label: "Necklace", icon: "📿", desc: "Neck ornament — pendants, chains, chokers"  },
  { id: "wings",    label: "Wings",    icon: "🦋", desc: "Feathered, bat, or fairy wing pairs"        },
];

// ============================================================
// AccessoryCanvasComponent
// Renders one accessory on a <canvas> element.
// Props: template (String), genome (Object), canvasW, canvasH
// ============================================================

const AccessoryCanvasComponent = {
  name: "AccessoryCanvasComponent",
  props: {
    template: { type: String,  default: "hat"  },
    genome:   { type: Object,  default: null   },
    canvasW:  { type: Number,  default: 400    },
    canvasH:  { type: Number,  default: 320    },
    selected: { type: Boolean, default: false  },
  },
  watch: {
    template() { this.$nextTick(() => this.draw()); },
    genome()   { this.$nextTick(() => this.draw()); },
    selected() { this.$nextTick(() => this.draw()); },
  },
  mounted() { this.draw(); },
  methods: {
    draw() {
      const canvas = this.$refs.canvas;
      if (!canvas || !this.genome) return;
      const ctx = canvas.getContext("2d");
      drawAccessory(ctx, this.template, this.genome, canvas.width, canvas.height, { selected: this.selected });
    }
  },
  template: `<canvas ref="canvas" :width="canvasW" :height="canvasH" style="max-width:100%;display:block;"></canvas>`
};

// ============================================================
// AccessoryCardComponent
// Compact card for the browse grid — mirrors CreatureCardComponent.
// prop: post — { author, permlink, name, template, genome, created }
// ============================================================

const AccessoryCardComponent = {
  name: "AccessoryCardComponent",
  components: { AccessoryCanvasComponent },
  props: {
    post:     { type: Object, required: true },
    username: { type: String, default: "" },
  },
  data() { return { copied: false }; },
  computed: {
    routePath()  { return "/acc/@" + this.post.author + "/" + this.post.permlink; },
    steemitUrl() { return "https://steemit.com/@" + this.post.author + "/" + this.post.permlink; },
    templateInfo() {
      return ACCESSORY_TEMPLATES.find(t => t.id === this.post.template) || ACCESSORY_TEMPLATES[0];
    },
  },
  methods: {
    copyUrl(e) {
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.writeText(this.steemitUrl).then(() => {
        this.copied = true; setTimeout(() => { this.copied = false; }, 1800);
      }).catch(() => {});
    }
  },
  template: `
    <router-link :to="routePath" style="text-decoration:none;color:inherit;display:block;">
      <div
        style="background:#111;border:1px solid #222;border-radius:10px;padding:10px;
               text-align:center;cursor:pointer;transition:border-color 0.18s;position:relative;"
        @mouseenter="$event.currentTarget.style.borderColor='#7b1fa2'"
        @mouseleave="$event.currentTarget.style.borderColor='#222'"
      >
        <accessory-canvas-component
          :template="post.template"
          :genome="post.genome"
          :canvas-w="180"
          :canvas-h="144"
          style="display:block;margin:0 auto;"
        ></accessory-canvas-component>

        <div style="font-size:0.82rem;font-weight:bold;color:#ce93d8;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px;">
          {{ templateInfo.icon }} {{ post.name }}
        </div>

        <div style="font-size:0.70rem;margin-top:4px;color:#888;display:flex;
                    gap:6px;justify-content:center;align-items:center;flex-wrap:wrap;">
          <span>{{ templateInfo.label }}</span>
          <span style="color:#444;">·</span>
          <span>@{{ post.author }}</span>
        </div>

        <div style="font-size:0.65rem;color:#444;margin-top:3px;">
          {{ post.created ? post.created.slice(0,10) : "" }}
        </div>

        <!-- Copy link -->
        <div style="position:absolute;top:6px;right:8px;" @click.prevent.stop="copyUrl($event)">
          <span style="font-size:0.65rem;color:#555;cursor:pointer;" :title="copied ? 'Copied!' : 'Copy Steemit URL'">
            {{ copied ? "✓" : "🔗" }}
          </span>
        </div>
      </div>
    </router-link>
  `
};

// ============================================================
// AccessoriesView — route /#/accessories
//
// Two panels:
//   Left  → Creator: pick template, randomise/edit genome params, preview, publish
//   Right → Browse: paginated grid of all published accessories
// ============================================================

const AccessoriesView = {
  name: "AccessoriesView",
  inject: ["username", "hasKeychain", "notify"],
  components: { AccessoryCanvasComponent, AccessoryCardComponent, LoadingSpinnerComponent },

  data() {
    return {
      // ── Creator state ──
      selectedTemplate: "hat",
      genome:           null,
      accessoryName:    "",
      customTitle:      "",
      publishing:       false,

      // ── Browse state ──
      allAccessories:  [],
      listLoading:     true,
      listError:       "",
      listPage:        1,
      filterTemplate:  "",

      // Static catalogue exposed to template
      templates: ACCESSORY_TEMPLATES,
    };
  },

  computed: {
    pagedAccessories() {
      const list = this.filterTemplate
        ? this.allAccessories.filter(a => a.template === this.filterTemplate)
        : this.allAccessories;
      const s = (this.listPage - 1) * PAGE_SIZE;
      return list.slice(s, s + PAGE_SIZE);
    },
    filteredCount() {
      return this.filterTemplate
        ? this.allAccessories.filter(a => a.template === this.filterTemplate).length
        : this.allAccessories.length;
    },
    totalPages() { return Math.max(1, Math.ceil(this.filteredCount / PAGE_SIZE)); },
  },

  watch: {
    filterTemplate() { this.listPage = 1; },
  },

  created() {
    this.loadAccessoryList();
    this.createNew("hat");
  },

  methods: {
    // ── Creator ──────────────────────────────────────────────
    createNew(template) {
      this.selectedTemplate = template || this.selectedTemplate;
      this.genome           = generateAccessoryGenome();
      this.accessoryName    = generateAccessoryName(this.selectedTemplate, this.genome);
      this.customTitle      = `${this.accessoryName} — SteemBiota Accessory`;
    },

    randomise() { this.createNew(this.selectedTemplate); },

    selectTemplate(id) {
      this.selectedTemplate = id;
      this.accessoryName    = generateAccessoryName(id, this.genome);
      this.customTitle      = `${this.accessoryName} — SteemBiota Accessory`;
    },

    async publishAccessory() {
      if (!this.username)         { this.notify("Please log in first.", "error"); return; }
      if (!this.genome)           { this.notify("Generate an accessory first.", "error"); return; }
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      this.publishing = true;
      const unicodeArt = buildAccessoryUnicodeArt(this.selectedTemplate, this.genome);
      publishAccessory(
        this.username,
        this.selectedTemplate,
        this.genome,
        this.accessoryName,
        unicodeArt,
        this.customTitle,
        (response) => {
          this.publishing = false;
          if (response.success) {
            if (typeof invalidateGlobalListCaches === "function") invalidateGlobalListCaches();
            if (typeof invalidateOwnedCachesForUser === "function") invalidateOwnedCachesForUser(this.username);
            this.notify(`✨ ${this.accessoryName} published!`, "success");
            this.$router.push("/acc/@" + this.username + "/" + response.permlink);
          } else {
            this.notify("Publish failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    // ── Genome parameter editing ──────────────────────────────
    updateGenome(key, value) {
      this.genome = { ...this.genome, [key]: Number(value) };
    },

    // ── Browse ────────────────────────────────────────────────
    async loadAccessoryList() {
      const cacheKey = "steembiota:list:accessories:v1";
      const canUseCache = (typeof readListCache === "function" && typeof writeListCache === "function");
      const cachedRaw = canUseCache ? readListCache(cacheKey) : null;
      if (cachedRaw) {
        this.allAccessories = parseSteembiotaAccessories(cachedRaw);
        this.listLoading = false;
      } else {
        this.listLoading = true;
      }
      this.listError   = "";
      try {
        const raw = await fetchPostsByTag("steembiota", 100);
        const safeRaw = Array.isArray(raw) ? raw : [];
        this.allAccessories = parseSteembiotaAccessories(safeRaw);
        if (canUseCache) writeListCache(cacheKey, safeRaw);
      } catch (e) {
        if (!cachedRaw) this.listError = e.message || "Failed to load accessories.";
      }
      this.listLoading = false;
    },

    prevPage() { if (this.listPage > 1) this.listPage--; },
    nextPage() { if (this.listPage < this.totalPages) this.listPage++; },
  },

  template: `
    <div style="padding:0 16px;max-width:980px;margin:0 auto;">

      <!-- ===== CREATOR PANEL ===== -->
      <h2 style="color:#ce93d8;margin:20px 0 12px;font-size:1.1rem;letter-spacing:0.04em;">
        ✨ Create Accessory
      </h2>

      <!-- Template picker -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:16px;">
        <button
          v-for="t in templates"
          :key="t.id"
          @click="selectTemplate(t.id)"
          :style="{
            background: selectedTemplate === t.id ? '#4a148c' : '#1a1a1a',
            color:      selectedTemplate === t.id ? '#ce93d8' : '#888',
            border:     '1px solid ' + (selectedTemplate === t.id ? '#7b1fa2' : '#333'),
            padding: '6px 14px', borderRadius: '6px', fontSize: '13px'
          }"
        >{{ t.icon }} {{ t.label }}</button>
      </div>

      <!-- Preview -->
      <div v-if="genome" style="text-align:center;margin-bottom:8px;">
        <div style="font-size:1.2rem;font-weight:bold;color:#ce93d8;margin-bottom:6px;">
          {{ accessoryName }}
        </div>
        <accessory-canvas-component
          :template="selectedTemplate"
          :genome="genome"
          :canvas-w="400"
          :canvas-h="320"
          style="margin:0 auto;background:#111;border-radius:8px;border:1px solid #2a2a2a;"
        ></accessory-canvas-component>
      </div>

      <!-- Parameter sliders -->
      <div v-if="genome" style="max-width:460px;margin:12px auto 0;text-align:left;">
        <div style="font-size:0.75rem;color:#666;margin-bottom:8px;letter-spacing:0.06em;">
          PARAMETERS
        </div>

        <template v-for="[key, min, max, label] in [
          ['CLR', 0, 359, 'Hue °'],
          ['SAT', 0, 100, 'Saturation'],
          ['LIT', 10, 90, 'Lightness'],
          ['SZ',  20, 100,'Size %'],
          ['SHN', 0, 100, 'Shininess'],
          ['VAR', 0, 9999,'Shape Var'],
          ['ACC', 0, 9999,'Accent'],
          ['STR', 0, 9999,'Structure'],
          ['ORN', 0, 9999,'Ornament'],
        ]" :key="key">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:0.72rem;color:#777;width:82px;flex-shrink:0;">{{ label }}</span>
            <input type="range" :min="min" :max="max" :value="genome[key]"
              @input="updateGenome(key, $event.target.value)"
              style="flex:1;accent-color:#7b1fa2;"
            />
            <span style="font-size:0.72rem;color:#555;width:36px;text-align:right;">
              {{ genome[key] }}
            </span>
          </div>
        </template>

        <!-- Post title -->
        <div style="margin-top:12px;">
          <label style="display:block;font-size:0.72rem;color:#666;margin-bottom:4px;">Post title</label>
          <input v-model="customTitle" type="text" maxlength="255"
            style="width:100%;font-size:13px;background:#111;color:#ccc;
                   border:1px solid #333;border-radius:6px;padding:6px 10px;box-sizing:border-box;"
          />
        </div>

        <div style="display:flex;gap:8px;margin-top:14px;justify-content:center;">
          <button @click="randomise"
            style="background:#1a2a1a;border:1px solid #2e7d32;color:#a5d6a7;padding:7px 16px;font-size:13px;">
            🎲 Randomise
          </button>
          <button @click="publishAccessory" :disabled="publishing || !username"
            style="background:#4a148c;border:1px solid #7b1fa2;color:#ce93d8;padding:7px 16px;font-size:13px;">
            {{ publishing ? "Publishing…" : "📡 Publish to Steem" }}
          </button>
        </div>
        <p v-if="!username" style="font-size:12px;color:#555;text-align:center;margin-top:6px;">
          Log in to publish.
        </p>
      </div>

      <hr style="margin:28px 0;border:none;border-top:1px solid #222;"/>

      <!-- ===== BROWSE PANEL ===== -->
      <h2 style="color:#ce93d8;margin:0 0 12px;font-size:1.1rem;letter-spacing:0.04em;">
        🗂 All Accessories
        <span v-if="!listLoading && !listError"
          style="font-size:0.75rem;color:#555;font-weight:normal;margin-left:8px;">
          ({{ filteredCount }}{{ filteredCount !== allAccessories.length ? " of " + allAccessories.length : "" }} total)
        </span>
      </h2>

      <!-- Template filter -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:14px;">
        <button
          @click="filterTemplate = ''"
          :style="{
            background: filterTemplate==='' ? '#4a148c' : '#1a1a1a',
            color: filterTemplate==='' ? '#ce93d8' : '#888',
            border: '1px solid ' + (filterTemplate==='' ? '#7b1fa2' : '#333'),
            padding:'4px 10px',fontSize:'12px',borderRadius:'6px'
          }"
        >All</button>
        <button
          v-for="t in templates" :key="t.id"
          @click="filterTemplate = (filterTemplate === t.id ? '' : t.id)"
          :style="{
            background: filterTemplate===t.id ? '#4a148c' : '#1a1a1a',
            color: filterTemplate===t.id ? '#ce93d8' : '#888',
            border: '1px solid ' + (filterTemplate===t.id ? '#7b1fa2' : '#333'),
            padding:'4px 10px',fontSize:'12px',borderRadius:'6px'
          }"
        >{{ t.icon }} {{ t.label }}</button>
      </div>

      <loading-spinner-component v-if="listLoading"></loading-spinner-component>
      <div v-else-if="listError" style="color:#ff8a80;font-size:13px;">⚠ {{ listError }}</div>
      <div v-else-if="allAccessories.length === 0"
        style="color:#555;font-size:13px;text-align:center;padding:24px 0;">
        No accessories published yet. Be the first!
      </div>

      <template v-else>
        <div v-if="pagedAccessories.length === 0"
          style="color:#555;font-size:13px;text-align:center;padding:24px 0;">
          No accessories match the current filter.
        </div>
        <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));
                           gap:12px;max-width:920px;margin:0 auto;">
          <accessory-card-component
            v-for="a in pagedAccessories"
            :key="a.author + '/' + a.permlink"
            :post="a"
            :username="username"
          ></accessory-card-component>
        </div>

        <div v-if="totalPages > 1"
          style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:14px;">
          <button @click="prevPage" :disabled="listPage === 1"
            style="padding:5px 14px;background:#1a1a2a;">◀ Prev</button>
          <span style="font-size:13px;color:#555;">{{ listPage }} / {{ totalPages }}</span>
          <button @click="nextPage" :disabled="listPage === totalPages"
            style="padding:5px 14px;background:#1a1a2a;">Next ▶</button>
        </div>
      </template>

    </div>
  `
};

// ============================================================
// ============================================================
// WearPanelComponent  (v2 — per-user grants + public domain)
//
// Shown on the AccessoryItemView. Handles two audiences:
//   A) Any logged-in user — can request a per-user grant, and
//      once permitted can equip/remove the accessory on any of
//      their creatures directly from this page.
//   B) Accessory owner — can grant/revoke per-user permissions
//      and toggle the accessory between private and public domain.
//
// Props:
//   username       — logged-in user (or "")
//   accAuthor      — accessory post author
//   accPermlink    — accessory post permlink
//   accName        — display name of the accessory
//   permissions    — result of parseAccessoryPermissions()
//                    { isPublic, grantedUsers, pendingRequests }
//   isAccOwner     — true when username === effectiveOwner
//
// Emits:
//   notify(msg, type)
//   permissions-updated(newPermissions)  — after any owner action
// ============================================================
const WearPanelComponent = {
  name: "WearPanelComponent",
  props: {
    username:    { type: String,  default: "" },
    accAuthor:   { type: String,  required: true },
    accPermlink: { type: String,  required: true },
    accName:     { type: String,  default: "this accessory" },
    permissions: {
      type: Object,
      default: () => ({
        isPublic: false,
        grantedUsers: new Set(),
        pendingRequests: new Map(),
        owner: ""
      })
    },
    isAccOwner:  { type: Boolean, default: false },
  },

  emits: ["notify", "permissions-updated"],

  data() {
    return {
      expanded:   false,
      publishing: false,
    };
  },

  computed: {
    isPublic()        { return this.permissions?.isPublic ?? false; },
    grantedUsers()    { return this.permissions?.grantedUsers ?? new Set(); },
    pendingRequests() { return this.permissions?.pendingRequests ?? new Map(); },
    owner()           { return this.permissions?.owner ?? ""; },

    hasPermission() {
      if (!this.username) return false;
      return isWearPermitted(this.permissions, this.username);
    },

    hasPendingRequest() {
      if (!this.username) return false;
      return this.pendingRequests.has(this.username.trim().toLowerCase());
    },

    grantedList() { return [...this.grantedUsers]; },
    pendingList() { return [...this.pendingRequests.keys()]; },
  },

  methods: {
    async sendRequest() {
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain not installed.", "error");
        return;
      }
      if (!this.username) {
        this.$emit("notify", "Please log in first.", "error");
        return;
      }

      this.publishing = true;

      publishWearRequest(
        this.username, this.accAuthor, this.accPermlink, this.accName,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", "👗 Wear request sent!", "success");

            const newPending = new Map(this.pendingRequests);
            newPending.set(this.username.trim().toLowerCase(), { requestedAt: new Date() });

            this.$emit("permissions-updated", {
              ...this.permissions,
              pendingRequests: newPending
            });
          } else {
            this.$emit("notify", "Request failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },

    async grantUser(grantee) {
      if (!window.steem_keychain) return;

      this.publishing = true;

      publishWearGrant(
        this.username, this.accAuthor, this.accPermlink, this.accName, grantee,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", `✅ Granted @${grantee}.`, "success");

            const newGranted = new Set(this.grantedUsers);
            const newPending = new Map(this.pendingRequests);

            newGranted.add(grantee.trim().toLowerCase());
            newPending.delete(grantee.trim().toLowerCase());

            this.$emit("permissions-updated", {
              ...this.permissions,
              grantedUsers: newGranted,
              pendingRequests: newPending
            });
          } else {
            this.$emit("notify", "Grant failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },

    async revokeUser(grantee) {
      if (!window.steem_keychain) return;

      this.publishing = true;

      publishWearRevoke(
        this.username, this.accAuthor, this.accPermlink, this.accName, grantee,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", `🚫 Revoked @${grantee}.`, "success");

            const newGranted = new Set(this.grantedUsers);
            const newPending = new Map(this.pendingRequests);

            newGranted.delete(grantee.trim().toLowerCase());
            newPending.delete(grantee.trim().toLowerCase());

            this.$emit("permissions-updated", {
              ...this.permissions,
              grantedUsers: newGranted,
              pendingRequests: newPending
            });
          } else {
            this.$emit("notify", "Revoke failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },

    async setPublic() {
      if (!window.steem_keychain) return;

      this.publishing = true;

      publishWearPublic(
        this.username, this.accAuthor, this.accPermlink, this.accName,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", "🌐 Accessory is now public domain!", "success");
            this.$emit("permissions-updated", {
              ...this.permissions,
              isPublic: true
            });
          } else {
            this.$emit("notify", "Failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },

    async setPrivate() {
      if (!window.steem_keychain) return;

      this.publishing = true;

      publishWearPrivate(
        this.username, this.accAuthor, this.accPermlink, this.accName,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", "🔒 Accessory is now private.", "success");
            this.$emit("permissions-updated", {
              ...this.permissions,
              isPublic: false
            });
          } else {
            this.$emit("notify", "Failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },
  },

  template: `
    <div style="max-width:480px;margin:0 auto 20px;">

      <!-- Header toggle -->
      <div @click="expanded=!expanded"
        style="display:flex;align-items:center;justify-content:space-between;
               cursor:pointer;padding:10px 14px;border-radius:8px;
               background:#0a0a1a;border:1px solid #1a1a3a;user-select:none;">
        <span style="font-size:0.88rem;color:#ce93d8;font-weight:bold;">
          👗 Wear Permissions
          <span v-if="isPublic"
            style="font-weight:normal;color:#a5d6a7;font-size:0.80rem;margin-left:8px;">
            🌐 public domain
          </span>
          <span v-else-if="grantedList.length > 0"
            style="font-weight:normal;color:#80cbc4;font-size:0.80rem;margin-left:8px;">
            {{ grantedList.length }} user{{ grantedList.length===1?"":"s" }} permitted
          </span>
          <span v-else style="font-weight:normal;color:#555;font-size:0.80rem;margin-left:8px;">
            private
          </span>
        </span>
        <span style="color:#444;font-size:0.78rem;">{{ expanded ? "▲" : "▼" }}</span>
      </div>

      <div v-if="expanded"
        style="border:1px solid #1a1a3a;border-top:none;border-radius:0 0 8px 8px;
               background:#08080f;padding:14px;">

        <!-- PUBLIC DOMAIN -->
        <div v-if="isPublic"
          style="padding:10px 12px;border-radius:6px;background:#0d1a0d;
                 border:1px solid #2e7d32;margin-bottom:14px;">
          <div style="font-size:0.82rem;color:#a5d6a7;font-weight:bold;margin-bottom:4px;">
            🌐 Public Domain
          </div>
          <p style="font-size:0.75rem;color:#666;margin:0;line-height:1.5;">
            Anyone may freely equip this accessory without approval.
          </p>
          <button v-if="isAccOwner" @click="setPrivate" :disabled="publishing"
            style="margin-top:10px;background:#1a0a0a;color:#ff8a80;
                   border:1px solid #3b0000;font-size:0.75rem;">
            {{ publishing ? "…" : "🔒 Make Private" }}
          </button>
        </div>

        <!-- PRIVATE MODE -->
        <template v-else>

          <!-- Owner toggle -->
          <div v-if="isAccOwner"
            style="margin-bottom:14px;padding:10px 12px;border-radius:6px;
                   background:#0a0a12;border:1px solid #1a1a2e;">
            <div style="font-size:0.75rem;color:#666;margin-bottom:8px;">
              🔒 Private — only users you grant below may wear this.
            </div>
            <button @click="setPublic" :disabled="publishing"
              style="background:#0d1a0d;color:#a5d6a7;border:1px solid #2e7d32;font-size:0.75rem;">
              {{ publishing ? "…" : "🌐 Make Public Domain" }}
            </button>
          </div>

          <!-- Request -->
          <div v-if="!isAccOwner && username && !hasPermission && !hasPendingRequest"
            style="margin-bottom:14px;text-align:center;">
            <p style="font-size:0.75rem;color:#555;margin-bottom:8px;">
              Request permission to wear this.
            </p>
            <button @click="sendRequest" :disabled="publishing"
              style="background:#1a0a2e;color:#ce93d8;border:1px solid #7b1fa2;">
              👗 Request Permission
            </button>
          </div>

          <!-- Already permitted -->
          <div v-if="!isAccOwner && hasPermission"
            style="margin-bottom:14px;padding:8px;border:1px solid #2e7d32;background:#0d1a0d;">
            <span style="color:#a5d6a7;">✅ You have permission.</span>
          </div>

          <!-- Pending -->
          <div v-if="!isAccOwner && hasPendingRequest && !hasPermission"
            style="margin-bottom:14px;padding:8px;border:1px solid #3a2800;background:#1a1200;">
            <span style="color:#ffb74d;">⏳ Pending approval.</span>
          </div>

        </template>

        <!-- Pending requests -->
        <template v-if="isAccOwner && pendingList.length > 0">
          <div style="color:#ce93d8;margin-bottom:8px;">
            Pending Requests ({{ pendingList.length }})
          </div>

          <div v-for="user in pendingList" :key="'req-'+user"
            style="display:flex;justify-content:space-between;padding:6px 0;">
            <span>@{{ user }}</span>

            <div v-if="user !== owner" style="display:flex;gap:6px;">
              <button @click="grantUser(user)">✅</button>
              <button @click="revokeUser(user)">❌</button>
            </div>

            <span v-else style="color:#444;">Owner</span>
          </div>
        </template>
        
    <template v-else>
       <!-- PENDING STATE: Prominent UI -->
       <div v-if="!isAccOwner && hasPendingRequest && !hasPermission"
         style="margin-bottom:14px; padding:16px; border:1px solid #f57c00; 
                background:linear-gradient(135deg, #1a1200 0%, #0a0800 100%); 
                border-radius:8px; text-align:center; animation: SBpulse 2s infinite;">
         <div style="font-size:1.2rem; margin-bottom:8px;">⏳</div>
         <div style="color:#ffb74d; font-weight:bold; font-size:0.9rem; margin-bottom:4px;">
           Request Sent to @{{ accAuthor }}
         </div>
         <p style="font-size:0.75rem; color:#888; margin:0;">
           Your request is pending. Once the owner approves, you can equip this item from any of your creatures' pages.
         </p>
       </div>
       
       <!-- CSS injected into the page -->
       <style>
         @keyframes SBpulse {
           0% { border-color: #3a2800; }
           50% { border-color: #f57c00; box-shadow: 0 0 10px rgba(245, 124, 0, 0.2); }
           100% { border-color: #3a2800; }
         }
       </style>
       <!-- ... -->
    </template>

        <!-- Granted -->
        <template v-if="isAccOwner && grantedList.length > 0">
          <div style="color:#80cbc4;margin-top:10px;">
            Permitted Users ({{ grantedList.length }})
          </div>

          <div v-for="user in grantedList" :key="'grant-'+user"
            style="display:flex;justify-content:space-between;padding:6px 0;">
            <span>@{{ user }}</span>

            <button v-if="user !== owner" @click="revokeUser(user)">🚫</button>
            <span v-else style="color:#444;">Owner</span>
          </div>
        </template>

      </div>
    </div>
  `
}; 

// ============================================================
// AccessoryItemView  — route /@:author/:permlink (accessory posts)
//
// Detected by CreatureView when json_metadata.steembiota.type === "accessory".
// Shows the canvas, parameter table, transfer panel (owner + recipient),
// social interactions, and unicode art.
// ============================================================

const AccessoryItemView = {
  name: "AccessoryItemView",
  inject: ["username", "notify"],
  components: { AccessoryCanvasComponent, LoadingSpinnerComponent, WearPanelComponent },

  data() {
    return {
      loading:        true,
      loadError:      null,
      genome:         null,
      accTemplate:    "hat",
      accName:        "",
      author:         null,
      permlink:       null,
      created:        null,
      effectiveOwner: null,
      transferState:  null,
      // Social
      votes:          [],
      rebloggers:     [],
      socialLoading:  false,
      // Transfer UI
      transferExpanded:  false,
      recipientInput:    "",
      transferPublishing: false,
      urlCopied:         false,
      // Wear permissions (v2: per-user grants + public domain)
      permissions: { isPublic: false, grantedUsers: new Set(), pendingRequests: new Map() },
    };
  },

  created() { this.loadAccessory(); },

  computed: {
    isOwner() {
      return !!(this.username && this.effectiveOwner &&
                this.username === this.effectiveOwner);
    },
    isPendingRecipient() {
      if (!this.username || !this.transferState?.pendingOffer) return false;
      return this.username === this.transferState.pendingOffer.to;
    },
    pendingOffer()    { return this.transferState?.pendingOffer    || null; },
    transferHistory() { return this.transferState?.transferHistory || [];  },
    hasHistory()      { return this.transferHistory.length > 0; },
    steemitUrl() {
      if (!this.author || !this.permlink) return null;
      return `https://steemit.com/@${this.author}/${this.permlink}`;
    },
    templateInfo() {
      return ACCESSORY_TEMPLATES.find(t => t.id === this.accTemplate)
          || ACCESSORY_TEMPLATES[0];
    },
    unicodeArt() {
      if (!this.genome) return "";
      return buildAccessoryUnicodeArt(this.accTemplate, this.genome);
    },
  },

  methods: {
    accessoryCacheKey(author, permlink) {
      return `steembiota:accessory:${String(author || "").toLowerCase()}/${String(permlink || "").toLowerCase()}:v1`;
    },
    applyCachedAccessory(cached, author, permlink) {
      if (!cached || !cached.genome) return false;
      this.author         = author;
      this.permlink       = permlink;
      this.genome         = cached.genome;
      this.accTemplate    = cached.accTemplate || "hat";
      this.accName        = cached.accName || author;
      this.created        = cached.created || null;
      this.effectiveOwner = cached.effectiveOwner || author;
      this.transferState  = cached.transferState || null;
      this.permissions    = {
        isPublic: !!cached.permissions?.isPublic,
        grantedUsers: new Set(Array.isArray(cached.permissions?.grantedUsers) ? cached.permissions.grantedUsers : []),
        pendingRequests: new Map(Array.isArray(cached.permissions?.pendingRequests) ? cached.permissions.pendingRequests : [])
      };
      this.loadError      = null;
      this.loading        = false;
      return true;
    },
    async loadAccessory() {
      this.loading   = true;
      this.loadError = null;
      const { author, permlink } = this.$route.params;
      this.author   = author;
      this.permlink = permlink;
      const cacheKey = this.accessoryCacheKey(author, permlink);
      const cached   = (typeof readObjectCache === "function")
        ? readObjectCache(cacheKey, ACCESSORY_PAGE_CACHE_TTL_MS)
        : null;
      this.applyCachedAccessory(cached, author, permlink);
      try {
        const post = await fetchPost(author, permlink);
        if (!post || !post.author) throw new Error("Post not found.");
        let meta = {};
        try { meta = JSON.parse(post.json_metadata || "{}"); } catch {}
        const sb = meta.steembiota;
        if (!sb || sb.type !== "accessory" || !sb.accessory)
          throw new Error("This post is not a SteemBiota accessory.");

        this.accTemplate = sb.accessory.template || "hat";
        this.genome      = sb.accessory.genome;
        this.accName     = sb.accessory.name || author;
        this.created     = post.created || null;

        // Ownership chain
        const replies       = await fetchAllReplies(author, permlink);
        const ownership     = parseOwnershipChain(replies, author);
        this.transferState  = ownership;
        this.effectiveOwner = ownership.effectiveOwner;

        // Permission state — who is allowed to wear this accessory.
        this.permissions = parseAccessoryPermissions(replies, author);
        if (typeof writeObjectCache === "function") {
          writeObjectCache(cacheKey, {
            genome: this.genome,
            accTemplate: this.accTemplate,
            accName: this.accName,
            created: this.created,
            effectiveOwner: this.effectiveOwner,
            transferState: this.transferState,
            permissions: {
              isPublic: this.permissions.isPublic,
              grantedUsers: [...this.permissions.grantedUsers],
              pendingRequests: [...this.permissions.pendingRequests.entries()]
            }
          });
        }

      } catch (err) {
        this.loadError = err.message || "Failed to load accessory.";
      }
      this.loading = false;

      if (!this.loadError) this.loadSocial();
    },

    async loadSocial() {
      this.socialLoading = true;
      try {
        const [v, r] = await Promise.all([
          fetchVotes(this.author, this.permlink),
          fetchRebloggers(this.author, this.permlink),
        ]);
        this.votes      = v;
        this.rebloggers = r;
      } catch {}
      this.socialLoading = false;
    },

    formatDate(ts) {
      if (!ts) return "?";
      return new Date(ts).toLocaleDateString(undefined,
        { year: "numeric", month: "short", day: "numeric" });
    },

    copyUrl() {
      if (!this.steemitUrl) return;
      navigator.clipboard.writeText(this.steemitUrl).then(() => {
        this.urlCopied = true;
        setTimeout(() => { this.urlCopied = false; }, 1800);
      }).catch(() => {});
    },

    // ── Transfer actions ──────────────────────────────────────
    async sendOffer() {
      const to = this.recipientInput.trim().toLowerCase();
      if (!to)             { this.notify("Please enter a recipient username.", "error"); return; }
      if (to === this.username) { this.notify("You cannot transfer to yourself.", "error"); return; }
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      this.transferPublishing = true;
      publishTransferOffer(
        this.username, this.author, this.permlink, this.accName, to,
        (res) => {
          this.transferPublishing = false;
          if (res.success) {
            this.notify(`🤝 Transfer offer sent to @${to}.`, "success");
            this.recipientInput = "";
            this.transferState = {
              ...(this.transferState || {}),
              pendingOffer: { to, offerPermlink: res.permlink || "pending", offeredBy: this.username, ts: new Date() },
            };
          } else {
            this.notify("Offer failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },

    async cancelOffer() {
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      this.transferPublishing = true;
      publishTransferCancel(
        this.username, this.author, this.permlink, this.accName,
        (res) => {
          this.transferPublishing = false;
          if (res.success) {
            this.notify("❌ Transfer offer cancelled.", "success");
            this.transferState = { ...(this.transferState || {}), pendingOffer: null };
          } else {
            this.notify("Cancel failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },

    async acceptOffer() {
      if (!this.pendingOffer) return;
      if (!window.steem_keychain) { this.notify("Steem Keychain is not installed.", "error"); return; }
      this.transferPublishing = true;
      publishTransferAccept(
        this.username, this.author, this.permlink, this.accName,
        this.pendingOffer.offerPermlink,
        (res) => {
          this.transferPublishing = false;
          if (res.success) {
            if (typeof invalidateGlobalListCaches === "function") invalidateGlobalListCaches();
            if (typeof invalidateOwnedCachesForUser === "function") invalidateOwnedCachesForUser(this.username);
            if (typeof invalidateAccessoryCache === "function") invalidateAccessoryCache(this.author, this.permlink);
            this.notify("✅ Ownership accepted! This accessory is now yours.", "success");
            this.effectiveOwner = this.username;
            this.transferState = {
              ...(this.transferState || {}),
              effectiveOwner:  this.username,
              pendingOffer:    null,
              transferHistory: [
                ...(this.transferHistory),
                { from: this.pendingOffer.offeredBy, to: this.username, ts: new Date() }
              ],
            };
          } else {
            this.notify("Accept failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    },
  },

  template: `
    <div style="padding:20px 16px;max-width:680px;margin:0 auto;">

      <loading-spinner-component v-if="loading"></loading-spinner-component>

      <div v-else-if="loadError"
        style="color:#ff8a80;font-size:14px;text-align:center;padding:40px 0;">
        ⚠ {{ loadError }}
      </div>

      <template v-else>

        <!-- Header -->
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:1.4rem;font-weight:bold;color:#ce93d8;margin-bottom:4px;">
            {{ templateInfo.icon }} {{ accName }}
          </div>
          <div style="font-size:0.78rem;color:#666;">
            {{ templateInfo.label }} · @{{ author }}
            <span v-if="created"> · {{ created.slice(0,10) }}</span>
          </div>
          <div style="font-size:0.75rem;margin-top:4px;">
            <span style="color:#555;">Owner: </span>
            <span style="color:#ce93d8;">@{{ effectiveOwner }}</span>
          </div>
        </div>

        <!-- Canvas -->
        <div style="text-align:center;margin-bottom:20px;">
          <accessory-canvas-component
            :template="accTemplate"
            :genome="genome"
            :canvas-w="400"
            :canvas-h="320"
            style="margin:0 auto;background:#111;border-radius:8px;
                   border:1px solid #2a1a2a;display:block;"
          ></accessory-canvas-component>
        </div>

        <!-- Parameter table -->
        <div style="max-width:400px;margin:0 auto 20px;background:#0a0a0a;
                    border:1px solid #1e1e1e;border-radius:8px;padding:14px;">
          <div style="font-size:0.72rem;color:#666;letter-spacing:0.06em;margin-bottom:10px;">
            PARAMETERS
          </div>
          <div v-for="[key, label] in [
              ['CLR','Hue'],['SAT','Saturation'],['LIT','Lightness'],
              ['SZ','Size %'],['SHN','Shininess'],['VAR','Shape Var'],
              ['ACC','Accent'],['STR','Structure'],['ORN','Ornament']
            ]" :key="key"
            style="display:flex;justify-content:space-between;
                   font-size:0.75rem;padding:3px 0;border-bottom:1px solid #111;">
            <span style="color:#666;">{{ label }}</span>
            <span style="color:#aaa;font-family:monospace;">{{ genome[key] }}</span>
          </div>
        </div>

        <!-- Pending recipient accept panel -->
        <div v-if="isPendingRecipient && pendingOffer"
          style="max-width:480px;margin:0 auto 16px;padding:16px 18px;border-radius:10px;
                 background:#0d1a0d;border:1px solid #2e7d32;">
          <div style="font-size:1rem;font-weight:bold;color:#a5d6a7;margin-bottom:8px;">
            🤝 Ownership Transfer Offer
          </div>
          <p style="font-size:0.83rem;color:#888;margin:0 0 14px;line-height:1.5;">
            @{{ pendingOffer.offeredBy || "The current owner" }} is offering to transfer
            <strong style="color:#eee;">{{ accName }}</strong> to you.
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button @click="acceptOffer" :disabled="transferPublishing"
              style="background:#1a3a1a;">
              {{ transferPublishing ? "Publishing…" : "✅ Accept Ownership" }}
            </button>
          </div>
        </div>

        <!-- Owner transfer panel -->
        <div v-if="isOwner" style="max-width:480px;margin:0 auto 16px;">
          <div @click="transferExpanded = !transferExpanded"
            style="display:flex;align-items:center;justify-content:space-between;
                   cursor:pointer;padding:10px 14px;border-radius:8px;
                   background:#0a0a12;border:1px solid #1a1a2e;user-select:none;">
            <span style="font-size:0.88rem;color:#80cbc4;font-weight:bold;">
              🤝 Transfer Ownership
              <span v-if="pendingOffer"
                style="font-weight:normal;color:#ffb74d;font-size:0.80rem;margin-left:8px;">
                ⏳ pending → @{{ pendingOffer.to }}
              </span>
              <span v-else-if="hasHistory"
                style="font-weight:normal;color:#555;font-size:0.80rem;margin-left:8px;">
                {{ transferHistory.length }} transfer{{ transferHistory.length===1?"":"s" }}
              </span>
            </span>
            <span style="color:#444;font-size:0.78rem;">
              {{ transferExpanded ? "▲ collapse" : "▼ manage" }}
            </span>
          </div>

          <div v-if="transferExpanded"
            style="border:1px solid #1a1a2e;border-top:none;border-radius:0 0 8px 8px;
                   background:#08080f;padding:14px;">
            <div v-if="pendingOffer"
              style="padding:12px;border-radius:8px;background:#1a1200;
                     border:1px solid #3a2800;margin-bottom:14px;">
              <div style="font-size:0.80rem;color:#ffb74d;font-weight:bold;margin-bottom:6px;">
                ⏳ Pending → @{{ pendingOffer.to }}
              </div>
              <button @click="cancelOffer" :disabled="transferPublishing"
                style="background:#1a0000;color:#ff8a80;border:1px solid #3b0000;font-size:0.78rem;">
                {{ transferPublishing ? "Publishing…" : "❌ Cancel Offer" }}
              </button>
            </div>
            <template v-else>
              <div style="font-size:0.75rem;color:#80cbc4;text-transform:uppercase;
                          letter-spacing:0.07em;margin-bottom:8px;">Send Transfer Offer</div>
              <div style="display:flex;flex-direction:column;gap:8px;">
                <input v-model="recipientInput" type="text"
                  placeholder="Recipient username (without @)"
                  style="font-size:13px;width:100%;"
                  @keydown.enter="sendOffer"
                />
                <button @click="sendOffer"
                  :disabled="transferPublishing || !recipientInput.trim()"
                  style="background:#0d1a2e;">
                  {{ transferPublishing ? "Publishing…" : "🤝 Send Offer" }}
                </button>
              </div>
            </template>

            <template v-if="hasHistory">
              <div style="font-size:0.75rem;color:#80cbc4;text-transform:uppercase;
                          letter-spacing:0.07em;margin:14px 0 8px;">Transfer History</div>
              <div v-for="(t, i) in transferHistory" :key="i"
                style="font-size:0.75rem;color:#555;padding:5px 0;
                       border-bottom:1px solid #111;display:flex;gap:8px;align-items:center;">
                <span style="color:#3a3a3a;">{{ formatDate(t.ts) }}</span>
                <span style="color:#444;">@{{ t.from }}</span>
                <span style="color:#2a2a2a;">→</span>
                <span style="color:#80cbc4;">@{{ t.to }}</span>
              </div>
            </template>
          </div>
        </div>

        <!-- Wear permissions panel — visible to all logged-in users -->
        <wear-panel-component
          :username="username"
          :acc-author="author"
          :acc-permlink="permlink"
          :acc-name="accName"
          :permissions="permissions"
          :is-acc-owner="isOwner"
          @notify="(msg,type) => notify(msg,type)"
          @permissions-updated="p => { permissions = p; }"
        ></wear-panel-component>

        <!-- Social bar -->
        <div style="max-width:480px;margin:0 auto 16px;display:flex;gap:14px;
                    align-items:center;justify-content:center;font-size:0.78rem;color:#666;">
          <span v-if="!socialLoading">❤️ {{ votes.length }} vote{{ votes.length===1?"":"s" }}</span>
          <span v-if="!socialLoading">🔁 {{ rebloggers.length }} resteem{{ rebloggers.length===1?"":"s" }}</span>
          <span v-if="steemitUrl">
            <a :href="steemitUrl" target="_blank" style="color:#7b1fa2;font-size:0.75rem;">
              View on Steemit ↗
            </a>
          </span>
          <button @click="copyUrl"
            style="font-size:0.72rem;background:#1a1a1a;color:#555;
                   border:1px solid #2a2a2a;padding:3px 10px;">
            {{ urlCopied ? "✓ Copied" : "🔗 Copy URL" }}
          </button>
        </div>

        <!-- Unicode art -->
        <div style="max-width:480px;margin:0 auto;">
          <div style="font-size:0.72rem;color:#444;letter-spacing:0.06em;margin-bottom:6px;">
            UNICODE RENDER
          </div>
          <pre style="background:#000;padding:14px;border-radius:6px;color:#afa;
                      font-size:13px;line-height:1.4;display:block;overflow-x:auto;">{{ unicodeArt }}</pre>
        </div>

      </template>
    </div>
  `
};


// Filters raw Steem posts down to accessory posts, newest first.
// NOTE: effectiveOwner after transfers is NOT derived here — doing a
// per-post reply scan for every grid item would be too expensive.
// The card shows post.author; the detail page (AccessoryItemView)
// fetches replies and shows the true effective owner.
// ============================================================

function parseSteembiotaAccessories(rawPosts) {
  const results = [];
  for (const p of rawPosts) {
    let meta = {};
    try { meta = JSON.parse(p.json_metadata || "{}"); } catch {}
    const sb = meta.steembiota;
    if (!sb || sb.type !== "accessory" || !sb.accessory) continue;
    const acc = sb.accessory;
    results.push({
      author:         p.author,
      permlink:       p.permlink,
      name:           acc.name     || p.author,
      template:       acc.template || "hat",
      genome:         acc.genome,
      created:        p.created    || "",
      // Use post.author as the displayed creator; real owner is on detail page
      effectiveOwner: p.author,
    });
  }
  results.sort((a, b) => new Date(b.created) - new Date(a.created));
  return results;
}
