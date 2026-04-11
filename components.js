// ============================================================
// components.js
// Reusable Vue 3 components.
// Includes template base components + SteemBiota components.
// ============================================================

// ---- AppNotificationComponent ----
const AppNotificationComponent = {
  name: "AppNotificationComponent",
  props: {
    message: String,
    type: { type: String, default: "error" }
  },
  emits: ["dismiss"],
  data() { return { timer: null }; },
  watch: {
    message(val) {
      clearTimeout(this.timer);
      if (val && this.type !== "error") {
        this.timer = setTimeout(() => this.$emit("dismiss"), 3500);
      }
    }
  },
  beforeUnmount() { clearTimeout(this.timer); },
  computed: {
    styles() {
      const base = {
        display: "flex", alignItems: "center",
        justifyContent: "space-between",
        margin: "10px auto", padding: "10px 14px",
        borderRadius: "6px", maxWidth: "640px",
        fontSize: "14px", gap: "10px"
      };
      if (this.type === "success")
        return { ...base, background: "#1b2e1b", border: "1px solid #388e3c", color: "#a5d6a7" };
      if (this.type === "info")
        return { ...base, background: "#0d1a2e", border: "1px solid #1565c0", color: "#90caf9" };
      return   { ...base, background: "#3b0000", border: "1px solid #b71c1c", color: "#ff8a80" };
    },
    icon() {
      if (this.type === "success") return "✅";
      if (this.type === "info")    return "ℹ️";
      return "⚠️";
    }
  },
  template: `
    <div v-if="message" :style="styles" role="alert">
      <span>{{ icon }} {{ message }}</span>
      <button
        @click="$emit('dismiss')"
        style="background:none;border:none;cursor:pointer;font-size:16px;padding:0;color:inherit;line-height:1;"
        aria-label="Dismiss"
      >✕</button>
    </div>
  `
};

// ---- AuthComponent ----
const AuthComponent = {
  name: "AuthComponent",
  props: {
    username:    String,
    hasKeychain: Boolean,
    loginError:  String,
    isLoggingIn: { type: Boolean, default: false }
  },
  emits: ["login", "logout", "close"],
  data() { return { usernameInput: "" }; },
  watch: {
    username(val) { if (val) this.$emit("close"); }
  },
  methods: {
    submit() {
      const val = this.usernameInput.trim().toLowerCase();
      if (!val) return;
      this.$emit("login", val);
    },
    onKeydown(e) {
      if (e.key === "Enter")  this.submit();
      if (e.key === "Escape") this.$emit("close");
    }
  },
  template: `
    <div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;margin:8px 0;">
      <template v-if="!username">
        <input
          v-model="usernameInput"
          type="text"
          placeholder="Steem username"
          autocomplete="username"
          @keydown="onKeydown"
        />
        <button @click="submit" :disabled="!usernameInput.trim() || isLoggingIn">
          {{ isLoggingIn ? "Signing in…" : "Login with Keychain" }}
        </button>
        <button @click="$emit('close')" style="background:#555;">Cancel</button>
        <div v-if="loginError" style="width:100%;color:#ff8a80;font-size:13px;margin-top:4px;">
          {{ loginError }}
        </div>
      </template>
      <template v-else>
        <span style="font-size:14px;">Logged in as <strong>@{{ username }}</strong></span>
        <button @click="$emit('logout')" style="background:#555;">Logout</button>
      </template>
    </div>
  `
};

// ---- LoadingSpinnerComponent ----
const LoadingSpinnerComponent = {
  name: "LoadingSpinnerComponent",
  props: {
    message: { type: String, default: "Loading..." }
  },
  template: `
    <div style="text-align:center;padding:30px;color:#888;">
      <div style="
        display:inline-block;width:32px;height:32px;
        border:4px solid #333;border-top-color:#66bb6a;
        border-radius:50%;animation:spin 0.8s linear infinite;
      "></div>
      <p style="margin-top:10px;font-size:14px;">{{ message }}</p>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    </div>
  `
};

// ---- UserProfileComponent ----
const UserProfileComponent = {
  name: "UserProfileComponent",
  props: { profileData: Object },
  methods: {
    safeUrl(url) {
      try {
        const u = new URL(url);
        return u.protocol === "https:" ? url : "";
      } catch { return ""; }
    }
  },
  template: `
    <div v-if="profileData">
      <div :style="{
        backgroundImage: 'url(' + safeUrl(profileData.coverImage) + ')',
        backgroundSize: 'cover', backgroundPosition: 'center',
        height: '120px', borderRadius: '8px', background: '#222'
      }"></div>
      <div style="display:flex;align-items:center;margin-top:-36px;padding:10px;justify-content:center;">
        <img
          :src="safeUrl(profileData.profileImage) || 'https://via.placeholder.com/80'"
          style="width:72px;height:72px;border-radius:50%;border:3px solid #444;background:#222;"
        />
        <div style="margin-left:15px;text-align:left;">
          <h2 style="margin:0;color:#eee;">{{ profileData.displayName }}</h2>
          <small style="color:#aaa;">@{{ profileData.username }}</small>
          <p style="margin:5px 0;color:#ccc;">{{ profileData.about }}</p>
        </div>
      </div>
    </div>
  `
};

// ============================================================
// SteemBiota-specific components
// ============================================================

// ---- CreatureCanvasComponent ----
// Full genome-driven renderer with per-stage lifecycle evolution.
//
// Props:
//   :genome  — genome object
//   :age     — current age in days (integer)
//   :fossil  — bool shortcut for age >= LIF
//
// Pipeline: genome seeds → base phenotype → lifecycle modifiers → draw
const CreatureCanvasComponent = {
  name: "CreatureCanvasComponent",
  props: {
    genome:          { type: Object,  default: null  },
    age:             { type: Number,  default: 0     },
    fossil:          { type: Boolean, default: false },
    feedState:       { type: Object,  default: null  },
    activityState:   { type: Object,  default: null  },
    reactionTrigger: { type: Number,  default: 0     },
    canvasW:         { type: Number,  default: 400   },
    canvasH:         { type: Number,  default: 320   },
    // Accessory being worn — { template, genome } or null
    wearing:         { type: Object,  default: null  },
    // Multiple accessories currently worn (new API).
    wearings:        { type: Array,   default: () => [] },
  },
  emits: ["facing-resolved", "pose-resolved", "clicked"],
  data() {
    const poses = ["standing", "sitting", "sleeping", "alert", "playful"];
    return {
      facingRight:     Math.random() < 0.5,
      pose:            poses[Math.floor(Math.random() * poses.length)],
      // Animation state — null means "use normal logic"
      animPose:        null,
      animExpression:  null,
      _animTimers:     [],   // pending setTimeout ids so we can cancel on unmount

      // ── Autonomous behaviour state machine ──────────────────
      // _behavX    : current horizontal offset from canvas centre (pixels)
      // _behavY    : current vertical offset from canvas centre (pixels, +ve = down)
      //              Driven by _behavVY — creature actually travels up/down the canvas.
      // _behavVX   : horizontal velocity in pixels/second (+ve = right, −ve = left)
      // _behavVY   : vertical velocity in pixels/second (+ve = down, −ve = up)
      // _behavT    : accumulated movement time (seconds) — drives body-bob sine wave
      // _walkPhase : leg-cycle phase in radians — advances proportional to speed
      // _behavState: "idle" | "walk" | "run" | "jump" | "sleep" | "walkto"
      // _behavTimer: id from setTimeout for next state transition
      // _rafId     : requestAnimationFrame handle for the movement loop
      // _lastTs    : timestamp of the previous rAF tick (for delta-time)
      // _jumpY     : current vertical offset during a jump arc (pixels)
      // _jumpVY    : vertical velocity for jump physics
      // _walkToX/Y : target canvas-offset coords for the "walkto" state
      // _clickReactionIndex : cycles through poke reactions in order
      _behavX:     0,
      _behavY:     0,
      _behavVX:    0,
      _behavVY:    0,
      _behavT:     0,
      _walkPhase:  0,
      _behavState: "idle",
      _behavTimer: null,
      _rafId:      null,
      _lastTs:     null,
      _jumpY:      0,
      _jumpVY:     0,
      _walkToX:    0,
      _walkToY:    0,
      _clickReactionIndex: 0,
    };
  },
  watch: {
    genome()           { this.$nextTick(() => this.draw()); },
    age()              { this.$nextTick(() => this.draw()); },
    fossil(isFossil)   {
      this.$nextTick(() => this.draw());
      if (isFossil) {
        // Fossils don't move — stop the behaviour loop cleanly.
        if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
        this._behavState = "idle";
        this._behavVX    = 0;
        this._behavVY    = 0;
      }
    },
    feedState()        { this.$nextTick(() => this.draw()); },
    activityState()    { this.$nextTick(() => this.draw()); },
    wearing()          { this.$nextTick(() => this.draw()); },
    wearings()         { this.$nextTick(() => this.draw()); },
    reactionTrigger(v) { if (v > 0) this._startReaction(); }
  },
  mounted() {
    this.$emit("facing-resolved", this.facingRight);
    this.$emit("pose-resolved", this.pose);
    // Restore saved position from sessionStorage so the creature
    // remembers where it was between page navigations.
    if (this.genome) {
      const key = `sb_pos_${this.genome.GEN}_${this.genome.MOR}`;
      const saved = sessionStorage.getItem(key);
      if (saved) {
        try {
          const { x, y } = JSON.parse(saved);
          this._behavX = parseFloat(x) || 0;
          this._behavY = parseFloat(y) || 0;
        } catch {}
      }
    }
    this.draw();
    if (!this.fossil) this._behaviourLoop();
  },
  beforeUnmount() {
    // Cancel any pending animation timers to avoid drawing on a detached canvas.
    this._animTimers.forEach(id => clearTimeout(id));
    this._animTimers = [];
    // Stop the autonomous behaviour loop.
    if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
    // Persist current position so the creature remembers where it was.
    if (this.genome) {
      const key = `sb_pos_${this.genome.GEN}_${this.genome.MOR}`;
      sessionStorage.setItem(key, JSON.stringify({ x: this._behavX, y: this._behavY }));
    }
  },
  methods: {
    _normalizedWearings() {
      if (Array.isArray(this.wearings) && this.wearings.length) {
        return this.wearings.filter(w => w && w.genome && w.template !== "shirt");
      }
      return (this.wearing && this.wearing.genome && this.wearing.template !== "shirt")
        ? [this.wearing]
        : [];
    },

    // ----------------------------------------------------------
    // Reaction animation — triggered when the creature is fed,
    // played with, or walked. Cycles through 4 pose+expression
    // pairs 2–3 times, then restores the resting state.
    // If called while already animating, restarts cleanly.
    // Pauses autonomous behaviour for the duration.
    // ----------------------------------------------------------
    _startReaction() {
      // Cancel any in-progress animation.
      this._animTimers.forEach(id => clearTimeout(id));
      this._animTimers = [];

      // Pause autonomous movement — stop the rAF loop and any pending
      // state transition so the reaction plays without interference.
      // Zero velocities but keep _behavX/_behavY so the creature
      // reacts in place without teleporting back to the canvas centre.
      if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }
      if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
      this._behavVX    = 0;
      this._behavVY    = 0;
      this._behavState = "idle";

      // The 4-step sequence: same order every time, predictable and legible.
      const POSES       = ["standing", "alert",   "playful",  "sitting"];
      const EXPRESSIONS = ["alert",    "excited",  "thriving", "happy"  ];

      // Random repeats (2 or 3) and per-step duration (2000–3000 ms).
      const repeats = 2 + Math.floor(Math.random() * 2);   // 2 or 3
      const totalSteps = POSES.length * repeats;

      let elapsed = 0;
      for (let rep = 0; rep < repeats; rep++) {
        for (let i = 0; i < POSES.length; i++) {
          const stepIndex = rep * POSES.length + i;
          const duration  = 2000 + Math.floor(Math.random() * 1001); // 2000–3000 ms
          const delay     = elapsed;
          const pose       = POSES[i];
          const expression = EXPRESSIONS[i];

          const id = setTimeout(() => {
            this.animPose       = pose;
            this.animExpression = expression;
            this.draw();
          }, delay);
          this._animTimers.push(id);

          elapsed += duration;
        }
      }

      // Restore resting state after the full sequence, then resume behaviour.
      const restId = setTimeout(() => {
        this.animPose       = null;
        this.animExpression = null;
        this.draw();
        if (!this.fossil) this._behaviourLoop();
      }, elapsed);
      this._animTimers.push(restId);
    },

    // ==============================================================
    // AUTONOMOUS BEHAVIOUR SYSTEM
    //
    // A lightweight state machine that makes the creature move and
    // act on its own.  States:
    //
    //   idle   — standing still; waits a random interval then picks
    //            the next behaviour.
    //   walk   — drifts horizontally at ~40 px/s; uses "standing"
    //            pose with a subtle leg-bob.
    //   run    — drifts at ~110 px/s; uses "alert" pose.
    //   jump   — parabolic arc upward then back down; uses "playful"
    //            pose on the way up, "alert" on landing.
    //   sleep  — stays still using "sleeping" pose for a long random
    //            duration.
    //
    // Health/mood bias (strong):
    //   health ≥ 0.80 (thriving)  →  prefer run + jump, rarely sleep
    //   health ≥ 0.55 (happy)     →  balanced mix
    //   health ≥ 0.30 (content)   →  more walk, some sleep
    //   health  > 0   (hungry)    →  mostly sleep/idle
    //   health = 0    (unfed)     →  almost entirely sleep
    //
    // Movement is driven by requestAnimationFrame for smooth 60fps
    // sliding; the state machine uses setTimeout for coarse timing.
    // Position is saved to sessionStorage on unmount and restored on
    // mount so the creature remembers where it was between navigations.
    // ==============================================================

    // ----------------------------------------------------------
    // Compute a weighted behaviour probability table from health.
    // Returns { idle, walk, run, jump, sleep } summing to 1.0.
    // ----------------------------------------------------------
    _behaviourWeights() {
      const h = this.feedState ? this.feedState.healthPct : 0.5;
      if (h >= 0.80) return { idle: 0.05, walk: 0.20, run: 0.35, jump: 0.35, sleep: 0.05 };
      if (h >= 0.55) return { idle: 0.15, walk: 0.35, run: 0.20, jump: 0.20, sleep: 0.10 };
      if (h >= 0.30) return { idle: 0.20, walk: 0.40, run: 0.05, jump: 0.05, sleep: 0.30 };
      if (h >  0.00) return { idle: 0.15, walk: 0.15, run: 0.00, jump: 0.00, sleep: 0.70 };
      return              { idle: 0.05, walk: 0.05, run: 0.00, jump: 0.00, sleep: 0.90 };
    },

    // Pick one behaviour key from the weight table using a uniform draw.
    _pickBehaviour() {
      const w = this._behaviourWeights();
      let r = Math.random();
      for (const [key, prob] of Object.entries(w)) {
        r -= prob;
        if (r <= 0) return key;
      }
      return "idle";
    },

    // ----------------------------------------------------------
    // Enter a new behaviour state.  Stops the rAF loop if the
    // new state is stationary, starts it if moving.
    // ----------------------------------------------------------
    _enterBehaviour(state) {
      // Clear any pending state-transition timer.
      if (this._behavTimer) { clearTimeout(this._behavTimer); this._behavTimer = null; }
      // Stop existing rAF loop — will be restarted below if needed.
      if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }

      this._behavState = state;
      const W = this.canvasW;
      // Half the canvas width minus a margin so the creature stays visible.
      const limit = W * 0.38;

      if (state === "idle") {
        this._behavVX = 0;
        this._behavVY = 0;
        // Do NOT reset _behavX / _behavY — creature stays where it stopped.
        this.pose     = "standing";
        this.draw();
        // Schedule next behaviour after 2–6 seconds.
        const delay = 2000 + Math.random() * 4000;
        this._behavTimer = setTimeout(() => this._enterBehaviour(this._pickBehaviour()), delay);

      } else if (state === "walk") {
        // Pick independent random horizontal and vertical directions.
        // Prefer moving back toward centre if near an edge.
        const dirX = this._behavX > limit * 0.6 ? -1
                   : this._behavX < -limit * 0.6 ?  1
                   : (Math.random() < 0.5 ? 1 : -1);
        const vLimit = this.canvasH * 0.38;
        const dirY = this._behavY > vLimit * 0.6 ? -1
                   : this._behavY < -vLimit * 0.6 ?  1
                   : (Math.random() < 0.5 ? 1 : -1);
        this._behavVX    = dirX * 40;   // 40 px/s horizontal
        this._behavVY    = dirY * 28;   // 28 px/s vertical (~70% of horizontal)
        this._behavT     = 0;
        this._walkPhase  = 0;
        this.facingRight = dirX > 0;
        this.pose        = "standing";
        this._lastTs     = null;
        this._startRaf();
        // Walk for 2–5 seconds then go idle.
        const dur = 2000 + Math.random() * 3000;
        this._behavTimer = setTimeout(() => this._enterBehaviour("idle"), dur);

      } else if (state === "run") {
        const dirX = this._behavX > limit * 0.6 ? -1
                   : this._behavX < -limit * 0.6 ?  1
                   : (Math.random() < 0.5 ? 1 : -1);
        const vLimit = this.canvasH * 0.38;
        const dirY = this._behavY > vLimit * 0.6 ? -1
                   : this._behavY < -vLimit * 0.6 ?  1
                   : (Math.random() < 0.5 ? 1 : -1);
        this._behavVX    = dirX * 110;  // 110 px/s horizontal
        this._behavVY    = dirY * 75;   // 75 px/s vertical (~70% of horizontal)
        this._behavT     = 0;
        this._walkPhase  = 0;
        this.facingRight = dirX > 0;
        this.pose        = "alert";
        this._lastTs     = null;
        this._startRaf();
        // Run for 1–2.5 seconds then idle.
        const dur = 1000 + Math.random() * 1500;
        this._behavTimer = setTimeout(() => this._enterBehaviour("idle"), dur);

      } else if (state === "jump") {
        this._behavVX = 0;
        this._behavVY = 0;
        // Do NOT reset _behavX / _behavY — jump from current position.
        this._jumpY   = 0;
        this._jumpVY  = -260;   // initial upward velocity (px/s, canvas Y is inverted)
        this.pose     = "playful";
        this._lastTs  = null;
        this._startRaf();
        // Jump ends when the rAF loop detects landing (see _rafTick).

      } else if (state === "sleep") {
        this._behavVX = 0;
        this._behavVY = 0;
        // Do NOT reset _behavX / _behavY — sleep in place.
        this.pose     = "sleeping";
        this.draw();
        // Sleep duration: 6–18 seconds (longer when unhealthier).
        const h   = this.feedState ? this.feedState.healthPct : 0.5;
        const dur = (6 + Math.random() * 12 + (1 - h) * 8) * 1000;
        this._behavTimer = setTimeout(() => this._enterBehaviour("idle"), dur);
      }
    },

    // ----------------------------------------------------------
    // Start (or restart) the requestAnimationFrame movement loop.
    // ----------------------------------------------------------
    _startRaf() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = requestAnimationFrame(ts => this._rafTick(ts));
    },

    // ----------------------------------------------------------
    // rAF tick — called every frame while in a moving state.
    // Updates position, advances walk phase & vertical wander,
    // applies edge bounce, handles jump arc and walk-to-point,
    // then redraws.
    // ----------------------------------------------------------
    _rafTick(ts) {
      if (!this._lastTs) this._lastTs = ts;
      const dt = Math.min((ts - this._lastTs) / 1000, 0.1);  // seconds; capped at 0.1s
      this._lastTs = ts;

      const W     = this.canvasW;
      const H     = this.canvasH;
      const state = this._behavState;

      if (state === "walk" || state === "run") {
        this._behavX += this._behavVX * dt;
        this._behavY += this._behavVY * dt;
        this._behavT += dt;

        // Advance leg-cycle phase proportional to speed.
        // Walk cadence ≈ 2.5 Hz, run ≈ 4.5 Hz — tuned to look natural.
        const phaseRate = state === "run" ? 4.5 * Math.PI * 2 : 2.5 * Math.PI * 2;
        this._walkPhase += phaseRate * dt;

        // Horizontal edge bounce — reverse X velocity and flip facing.
        const xLimit = W * 0.38;
        if (this._behavX > xLimit) {
          this._behavX  =  xLimit;
          this._behavVX = -Math.abs(this._behavVX);
          this.facingRight = false;
        } else if (this._behavX < -xLimit) {
          this._behavX  = -xLimit;
          this._behavVX =  Math.abs(this._behavVX);
          this.facingRight = true;
        }

        // Vertical edge bounce — reverse Y velocity.
        const yLimit = H * 0.38;
        if (this._behavY > yLimit) {
          this._behavY  =  yLimit;
          this._behavVY = -Math.abs(this._behavVY);
        } else if (this._behavY < -yLimit) {
          this._behavY  = -yLimit;
          this._behavVY =  Math.abs(this._behavVY);
        }

      } else if (state === "walkto") {
        // Walk toward _walkToX / _walkToY at walk speed.
        const dx   = this._walkToX - this._behavX;
        const dy   = this._walkToY - this._behavY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ARRIVE_THRESHOLD = 6;   // pixels — close enough to stop

        if (dist < ARRIVE_THRESHOLD) {
          // Arrived — snap to target and go idle.
          this._behavX = this._walkToX;
          this._behavY = this._walkToY;
          this._rafId  = null;
          this._enterBehaviour("idle");
          return;
        }

        // Normalise direction and move at walk speed (40 px/s).
        const SPEED = 40;
        const step  = Math.min(SPEED * dt, dist);  // never overshoot
        this._behavX += (dx / dist) * step;
        this._behavY += (dy / dist) * step;
        this._behavT += dt;

        // Advance leg phase at walk cadence.
        this._walkPhase += 2.5 * Math.PI * 2 * dt;

        // Face the direction of travel.
        this.facingRight = dx > 0;

      } else if (state === "jump") {
        // Simple gravity: upward velocity decays, creature arcs up then lands.
        const GRAVITY = 520;    // px/s²
        this._jumpVY += GRAVITY * dt;
        this._jumpY  += this._jumpVY  * dt;

        if (this._jumpY >= 0) {
          // Landed — snap to ground, switch to alert pose briefly then idle.
          this._jumpY  = 0;
          this._jumpVY = 0;
          this.pose    = "alert";
          this.draw();
          this._rafId = null;
          // Brief landing pause then go idle.
          this._behavTimer = setTimeout(() => this._enterBehaviour("idle"), 600);
          return;
        }
      }

      this.draw();
      this._rafId = requestAnimationFrame(ts2 => this._rafTick(ts2));
    },

    // ----------------------------------------------------------
    // Walk-to-point — creature walks directly toward a canvas
    // offset position (targetX, targetY in _behavX/_behavY space).
    // Cancels any current autonomous behaviour cleanly.
    // ----------------------------------------------------------
    _enterWalkTo(targetX, targetY) {
      if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
      if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }

      this._walkToX    = targetX;
      this._walkToY    = targetY;
      this._behavState = "walkto";
      this._behavVX    = 0;
      this._behavVY    = 0;
      this._behavT     = 0;
      this._walkPhase  = 0;
      this.pose        = "standing";
      this._lastTs     = null;
      this._startRaf();
    },

    // ----------------------------------------------------------
    // Poke reaction — short expressive response when the creature
    // is clicked directly.  Cycles through three moods in order
    // so repeated pokes feel varied rather than repetitive:
    //   0: Surprised  — alert pose + alert expression (1.2 s)
    //   1: Happy      — playful pose + thriving expression (1.5 s)
    //   2: Grumpy     — sitting pose + hungry expression (1.2 s)
    // After the flash the creature resumes autonomous behaviour.
    // ----------------------------------------------------------
    _pokeReaction() {
      // Cancel any running autonomous state but preserve position.
      if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }
      if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
      this._behavVX    = 0;
      this._behavVY    = 0;
      this._behavState = "idle";

      const REACTIONS = [
        { pose: "alert",    expression: "alert",   dur: 1200 },
        { pose: "playful",  expression: "happy",   dur: 1500 },
        { pose: "sitting",  expression: "content", dur: 1200 },
      ];
      const r = REACTIONS[this._clickReactionIndex % REACTIONS.length];
      this._clickReactionIndex++;

      this.animPose       = r.pose;
      this.animExpression = r.expression;
      this.draw();

      const id = setTimeout(() => {
        this.animPose       = null;
        this.animExpression = null;
        this.draw();
        if (!this.fossil) this._behaviourLoop();
      }, r.dur);
      this._animTimers.push(id);

      // Emit so parent views can react (e.g. show a tooltip).
      this.$emit("clicked", { reaction: r.pose });
    },

    // ----------------------------------------------------------
    // Canvas click handler — decides whether the click hit the
    // creature's body or empty space, and responds accordingly.
    //
    // Named without underscore prefix so Vue 3's template proxy
    // exposes it — Vue 3 blocks underscore-prefixed names from
    // template scope as a private-method convention.
    //
    // Hit test: the creature body is an ellipse centred at the
    // creature's current canvas position.  We use the standard
    // ellipse equation:  (dx/a)² + (dy/b)² ≤ 1
    // where a = bodyLen*scale, b = bodyH*scale from buildPhenotype.
    // ----------------------------------------------------------
    onCanvasClick(event) {
      if (this.fossil || !this.genome) return;

      const canvas = this.$refs.canvas;
      const rect   = canvas.getBoundingClientRect();

      // Click position in CSS pixels → canvas pixels.
      const scaleX = canvas.width  / rect.width;
      const scaleY = canvas.height / rect.height;
      const clickX = (event.clientX - rect.left) * scaleX;
      const clickY = (event.clientY - rect.top)  * scaleY;

      const W = canvas.width, H = canvas.height;

      // Creature's current centre in canvas coordinates.
      const isMoving = this._behavState === "walk" || this._behavState === "run"
                    || this._behavState === "walkto";
      const bobAmp   = this._behavState === "run" ? 3 : 5;
      const bobFreq  = this._behavState === "run" ? 1.8 : 1.1;
      const bobY     = isMoving
        ? Math.sin(this._behavT * bobFreq * Math.PI * 2) * bobAmp : 0;

      const creatureCanvasX = W * 0.46 + this._behavX;
      const creatureCanvasY = H * 0.52 + this._behavY + bobY - this._jumpY;

      // Hit test against body ellipse.
      const p  = this.buildPhenotype(this.genome, this.age, this.feedState);
      const sc = p.bodyScale;
      const a  = p.bodyLen * sc;   // half-width (generous — includes head side)
      const b  = p.bodyH   * sc * 1.4;  // half-height with a small tap margin

      const dx = clickX - creatureCanvasX;
      const dy = clickY - creatureCanvasY;
      const hitCreature = (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;

      if (hitCreature) {
        this._pokeReaction();
      } else {
        // Convert click to _behavX/_behavY offset space and walk there.
        const targetX = clickX - W * 0.46;
        const targetY = clickY - H * 0.52;
        // Clamp to the movement limits so the creature never walks off-canvas.
        const xLimit  = W * 0.38;
        const yLimit  = H * 0.38;
        const clampedX = Math.max(-xLimit, Math.min(xLimit, targetX));
        const clampedY = Math.max(-yLimit, Math.min(yLimit, targetY));
        this._enterWalkTo(clampedX, clampedY);
      }
    },

    // ----------------------------------------------------------
    // Entry point — called from mounted() to start the loop.
    // Begins with a short random delay so creatures on the same
    // page don't all move in lockstep.
    // ----------------------------------------------------------
    _behaviourLoop() {
      const jitter = Math.random() * 3000;   // 0–3 s stagger
      this._behavTimer = setTimeout(() => this._enterBehaviour("idle"), jitter);
    },

    // ----------------------------------------------------------
    // Draw four legs in a walking/running gait.
    //
    // phase      : _walkPhase in radians — advances each frame
    // isRunning  : true → wider stride, more air time
    //
    // Gait model: each of the 4 legs gets a phase offset so that
    // diagonally opposite pairs move together (trot gait):
    //   Front-left  + Back-right : phase + 0
    //   Front-right + Back-left  : phase + π
    //
    // Each leg is rendered with a forward/back swing angle derived
    // from sin(phase + offset).  The leg root stays fixed at the
    // torso attachment point; only the lower leg + paw pivot.
    // ----------------------------------------------------------
    _drawWalkingLegs(ctx, p, sc, ox, oy, hue, sat, lit, phase, isRunning) {
      const lLen   = p.legLen * sc;
      const lW     = p.legThick * sc;
      const stride = isRunning ? 0.52 : 0.32;   // max swing angle in radians
      // Air-time: at peak stride the paw lifts off the ground slightly.
      const liftAmp = isRunning ? lLen * 0.22 : lLen * 0.10;

      // Leg attachment points on the torso (matching the standing pose).
      // Two back legs (tail side, +x), two front legs (head side, -x).
      // "behind" = drawn at reduced alpha for depth.
      const legs = [
        // back-right (behind)
        { x: ox + p.bodyLen * sc * 0.52, yBase: oy + p.bodyH * sc * 0.55, phOff: 0,          behind: true  },
        // back-left  (front)
        { x: ox - p.bodyLen * sc * 0.18, yBase: oy + p.bodyH * sc * 0.55, phOff: Math.PI,    behind: false },
        // front-right (behind)
        { x: ox + p.bodyLen * sc * 0.42, yBase: oy + p.bodyH * sc * 0.60, phOff: Math.PI,    behind: true  },
        // front-left  (front)
        { x: ox - p.bodyLen * sc * 0.08, yBase: oy + p.bodyH * sc * 0.60, phOff: 0,          behind: false },
      ];

      for (const leg of legs) {
        const swing  = Math.sin(phase + leg.phOff) * stride;  // −stride … +stride
        // Lift paw off ground when swinging forward (positive swing = forward).
        const lift   = Math.max(0, Math.sin(phase + leg.phOff)) * liftAmp;

        const alpha  = leg.behind ? 0.62 : 1.0;
        ctx.globalAlpha = alpha;

        // Upper leg: fixed at attachment point, rotated by swing angle.
        const upperLen = lLen * 0.55;
        const lowerLen = lLen * 0.55;
        const ux  = leg.x + Math.sin(swing) * upperLen;
        const uy  = leg.yBase + Math.cos(swing) * upperLen;

        // Lower leg: continues from knee, with a slight counter-angle
        // so the paw stays closer to the ground during mid-swing.
        const kneeAngle = swing * 0.5;
        const px  = ux + Math.sin(swing - kneeAngle) * lowerLen;
        const py  = uy + Math.cos(swing - kneeAngle) * lowerLen - lift;

        // Draw upper leg (thigh)
        const legGr = this.linGrad(ctx, leg.x, leg.yBase, ux, uy,
          [[0, this.hsl(hue, sat - 5, lit - 5)], [1, this.hsl(hue, sat - 10, lit - 14)]]
        );
        ctx.fillStyle   = legGr;
        ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
        ctx.lineWidth   = 1;
        ctx.beginPath();
        // Thigh as a rounded trapezoid centred on the attachment → knee line
        const tx = ux - leg.x, ty = uy - leg.yBase;
        const tLen = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = -ty / tLen * lW * 0.5, ny = tx / tLen * lW * 0.5;
        ctx.moveTo(leg.x + nx * 1.0, leg.yBase + ny * 1.0);
        ctx.quadraticCurveTo(leg.x + tx * 0.4 + nx * 0.8, leg.yBase + ty * 0.4 + ny * 0.8,
                             ux + nx * 0.6,                uy + ny * 0.6);
        ctx.lineTo(ux - nx * 0.6, uy - ny * 0.6);
        ctx.quadraticCurveTo(leg.x + tx * 0.4 - nx * 0.8, leg.yBase + ty * 0.4 - ny * 0.8,
                             leg.x - nx * 1.0,             leg.yBase - ny * 1.0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();

        // Draw lower leg (shin)
        const lx = px - ux, ly = py - uy;
        const lLenV = Math.sqrt(lx * lx + ly * ly) || 1;
        const lnx = -ly / lLenV * lW * 0.4, lny = lx / lLenV * lW * 0.4;
        ctx.beginPath();
        ctx.moveTo(ux + lnx, uy + lny);
        ctx.quadraticCurveTo(ux + lx * 0.5 + lnx * 0.7, uy + ly * 0.5 + lny * 0.7,
                             px + lnx * 0.5,             py + lny * 0.5);
        ctx.lineTo(px - lnx * 0.5, py - lny * 0.5);
        ctx.quadraticCurveTo(ux + lx * 0.5 - lnx * 0.7, uy + ly * 0.5 - lny * 0.7,
                             ux - lnx,                   uy - lny);
        ctx.closePath();
        ctx.fill(); ctx.stroke();

        // Paw
        ctx.fillStyle   = this.hsl(hue, sat - 15, lit + 10);
        ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
        ctx.lineWidth   = 0.8;
        ctx.beginPath();
        ctx.ellipse(px, py, lW * 0.72, lW * 0.42, swing * 0.6, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    // ----------------------------------------------------------
    // Direct "worn hat" renderer for creature heads.
    // We intentionally draw this in creature-local coordinates so
    // the hat reads as an actual wearable silhouette (visible brim
    // + crown) instead of relying on downscaled accessory thumbnails.
    // ----------------------------------------------------------
    _drawWornHat(ctx, headX, headY, hR, ag) {
      const hue = ag.CLR ?? 30;
      const sat = ag.SAT ?? 65;
      const lit = ag.LIT ?? 45;
      const sz  = (ag.SZ ?? 70) / 100;

      // Deterministic shape variation from accessory genes (no Math.random).
      const crownLean = (((ag.VAR ?? 0) % 21) - 10) / 100;       // -0.10..0.10
      const taper     = 0.70 + (((ag.STR ?? 0) % 18) / 100);     // 0.70..0.87
      const bandHue   = (hue + 25 + ((ag.ACC ?? 0) % 60)) % 360;

      const brimRx = hR * (0.98 + sz * 0.34);
      const brimRy = hR * (0.22 + sz * 0.07);
      const brimY  = headY - hR * (0.86 + sz * 0.03);

      const crownH   = hR * (0.95 + sz * 0.36);
      const crownBot = brimY - brimRy * 0.18;
      const crownTop = crownBot - crownH;
      const crownRxB = brimRx * 0.62;
      const crownRxT = crownRxB * taper;

      // Brim
      const brimGr = this.linGrad(ctx, headX, brimY - brimRy, headX, brimY + brimRy, [
        [0,   this.hsl(hue, sat, lit + 10)],
        [0.5, this.hsl(hue, sat, lit + 1)],
        [1,   this.hsl(hue, sat, lit - 14)],
      ]);
      ctx.fillStyle = brimGr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 20);
      ctx.lineWidth = Math.max(1, hR * 0.05);
      ctx.beginPath();
      ctx.ellipse(headX, brimY, brimRx, brimRy, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Crown
      const crownGr = this.linGrad(ctx, headX - crownRxB, crownTop, headX + crownRxB, crownBot, [
        [0, this.hsl(hue, sat, lit + 6)],
        [1, this.hsl(hue, sat, lit - 16)],
      ]);
      ctx.fillStyle = crownGr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 24);
      ctx.lineWidth = Math.max(1, hR * 0.045);
      ctx.beginPath();
      ctx.moveTo(headX - crownRxT + crownLean * hR, crownTop);
      ctx.bezierCurveTo(
        headX - crownRxB * 0.95 + crownLean * hR, crownTop + crownH * 0.28,
        headX - crownRxB, crownBot - brimRy * 0.25,
        headX - crownRxB, crownBot
      );
      ctx.lineTo(headX + crownRxB, crownBot);
      ctx.bezierCurveTo(
        headX + crownRxB, crownBot - brimRy * 0.25,
        headX + crownRxB * 0.95 + crownLean * hR, crownTop + crownH * 0.28,
        headX + crownRxT + crownLean * hR, crownTop
      );
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // Top cap
      ctx.fillStyle = this.hsl(hue, sat - 6, lit + 8);
      ctx.beginPath();
      ctx.ellipse(headX + crownLean * hR, crownTop, crownRxT, brimRy * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();

      // Band
      const bandH = Math.max(2, hR * 0.16);
      const bandY = crownBot - bandH;
      ctx.fillStyle = this.hsl(bandHue, Math.min(100, sat + 12), lit - 4);
      ctx.strokeStyle = this.hsl(bandHue, sat, lit - 24);
      ctx.lineWidth = Math.max(0.8, hR * 0.03);
      ctx.beginPath();
      ctx.moveTo(headX - crownRxB, crownBot);
      ctx.lineTo(headX - crownRxB, bandY);
      ctx.quadraticCurveTo(headX, bandY - hR * 0.06, headX + crownRxB, bandY);
      ctx.lineTo(headX + crownRxB, crownBot);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    },

    _redrawNeckForeground(ctx, p, sc, ox, oy, pt) {
      const hue = p.finalHue;
      const sat = p.colorSat;
      const lit = p.colorLight;
      const H1 = this.hsl;

      const headX = ox - p.bodyLen * sc * 0.68 + pt.headDX;
      const headY = oy - p.bodyH  * sc * 0.35  + pt.headDY;
      const neckCtrlY = oy - p.bodyH * sc * (0.2 - pt.neckAngle * 0.35);
      const neckGr = this.linGrad(ctx,
        ox - p.bodyLen * sc * 0.5, oy - p.bodyH * sc * 0.1,
        headX, headY + p.headSize * sc * 0.4,
        [[0, H1(hue, sat - 5, lit - 5)], [1, H1(hue, sat, lit)]]
      );
      ctx.fillStyle   = neckGr;
      ctx.strokeStyle = H1(hue, sat, lit - 18);
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox - p.bodyLen * sc * 0.42, oy - p.bodyH * sc * 0.5);
      ctx.quadraticCurveTo(
        ox - p.bodyLen * sc * 0.58, neckCtrlY,
        headX + p.headSize * sc * 0.55, headY + p.headSize * sc * 0.5
      );
      ctx.quadraticCurveTo(
        ox - p.bodyLen * sc * 0.52, oy,
        ox - p.bodyLen * sc * 0.32, oy + p.bodyH * sc * 0.1
      );
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    },

    // ----------------------------------------------------------
    // Draw an equipped accessory on top of the creature.
    //
    // Called at the end of draw(), inside the creature's ctx.save()
    // block so it automatically inherits the facing-flip transform.
    //
    // Attachment points (in creature-local coordinates):
    //   hat / crown  — above the head (headX, headY - headR * 1.1)
    //   necklace     — at the neck base (between head and torso)
    //   shirt        — at the torso centre (ox, oy)
    //   wings        — behind the torso mid-back (ox + bodyLen * 0.3, oy)
    //
    // The accessory is rendered into a temporary off-screen canvas
    // then composited onto the creature canvas at reduced scale,
    // so the full drawXxx() renderers are reused without change.
    // ----------------------------------------------------------
    _drawAccessoryOnCreature(ctx, p, sc, ox, oy, pt, W, H, accessory, opts = {}) {
      if (!accessory || !accessory.genome) return;
      const { template, genome: ag } = accessory;
      if (template === 'shirt') return;
      const underlayNecklace = !!opts.underlayNecklace;

      // Compute attachment point in creature-local canvas coords
      const headX = ox - p.bodyLen * sc * 0.68 + pt.headDX;
      const headY = oy - p.bodyH  * sc * 0.35  + pt.headDY;
      const hR    = p.headSize * sc;

      // Hats are rendered directly on the head so the creature visibly
      // wears a full hat silhouette (brim + crown) at any lifecycle scale.
      if (template === 'hat') {
        this._drawWornHat(ctx, headX, headY, hR, ag);
        return;
      }

      // Scale the accessory relative to the creature's current body scale.
      // Base scale is tuned per template so head accessories remain visible
      // on smaller lifecycle stages (baby/toddler) while torso items stay
      // proportionate.
      const templateScale = (
        // Hats need extra scale on-creature because the renderer includes
        // full brim + crown proportions intended for a larger standalone canvas.
        template === 'hat'   ? 1.34 :
        // Crown accessories were rendering too large on-creature relative
        // to head radius (especially high-SZ genomes), so use a smaller
        // baseline scalar than hats to keep the crown proportional.
        template === 'crown' ? 0.40 :
        // Wings should read clearly behind the torso. Keep them a bit larger
        // than torso width so the outer tips remain visible even when the
        // torso is painted on top in the underlay pass.
        template === 'wings' ? 1.05 :
        template === 'shirt' ? 0.78 :
        0.72 // necklace + fallback
      );
      const accScale = p.bodyScale * templateScale;
      // Headwear needs a slightly larger source canvas to preserve brim details
      // when downscaled into baby/toddler body sizes.
      const baseCanvasScale = (
        template === 'hat'   ? 0.66 :
        template === 'crown' ? 0.54 :
        // Wing renderers can extend far beyond centre; a small source canvas
        // clips them, making equipped wings disappear or look truncated.
        template === 'wings' ? 0.74 :
        0.40
      );
      const accW = Math.round(W * baseCanvasScale);
      const accH = Math.round(H * baseCanvasScale);

      // Per-template anchor (where the accessory's canvas centre lands on the creature)
      let anchorX, anchorY;
      switch (template) {
        case 'hat':
          // Sits on top of the head, centred horizontally
          anchorX = headX;
          anchorY = headY - hR * 0.42;
          break;
        case 'crown':
          // Slightly higher than hat, more centred on the skull
          anchorX = headX;
          anchorY = headY - hR * 0.58;
          break;
        case 'necklace':
          // Neck base: keep high enough to intersect the neck silhouette,
          // so foreground neck repaint can occlude the back arc.
          anchorX = headX + p.headSize * sc * 0.25;
          // Lower significantly so the necklace reads as chest-worn
          // rather than tight to the throat/jaw.
          anchorY = headY + hR * 1.00;
          break;
        case 'shirt':
          // Move farther toward the tail and slightly lower on the torso so
          // shirts don't read as neckwear.
          anchorX = ox + p.bodyLen * sc * 0.24;
          anchorY = oy + p.bodyH * sc * 0.14;
          break;
        case 'wings':
          // Behind the upper back, shifted tail-side and slightly higher so
          // the torso occludes the root while the wing span remains visible.
          anchorX = ox + p.bodyLen * sc * 0.40;
          anchorY = oy - p.bodyH * sc * 0.62;
          break;
        default:
          anchorX = headX;
          anchorY = headY - hR * 1.05;
      }

      // Render the accessory into an off-screen canvas
      const offscreen = document.createElement('canvas');
      offscreen.width  = accW;
      offscreen.height = accH;
      const offCtx = offscreen.getContext('2d');
      // drawAccessory is defined in accessories.js (loaded before components.js)
      if (typeof drawAccessory === 'function') {
        drawAccessory(offCtx, template, ag, accW, accH, { transparentBackground: true, isWorn: true });
      }

      // Composite onto the creature canvas.
      // For hats/crowns the visual "contact point" is not the canvas centre:
      // the brim/base sits lower than centre in the standalone accessory renderer.
      // Map anchor to that contact zone so the creature wears the full shape
      // (brim + crown) instead of only a tiny top sliver.
      const dw = Math.round(accW  * accScale);
      const dh = Math.round(accH  * accScale);
      const focalY = (
        template === 'hat'   ? 0.68 :
        template === 'crown' ? 0.64 :
        template === 'wings' ? 0.62 :
        0.50
      );
      ctx.globalAlpha = 0.95;
      ctx.drawImage(
        offscreen,
        anchorX - dw * 0.5,
        anchorY - dh * focalY,
        dw, dh
      );
      ctx.globalAlpha = 1;

      // Necklace should wrap around the neck: repaint neck foreground so
      // the back/top portion of the necklace is naturally occluded.
      if (template === 'necklace' && !underlayNecklace) {
        this._redrawNeckForeground(ctx, p, sc, ox, oy, pt);
      }
    },

    // ----------------------------------------------------------
    // Tiny seeded PRNG (mulberry32) — pure, no side-effects.
    // Returns a function that yields floats in [0, 1).
    // ----------------------------------------------------------
    makePrng(seed) {
      let s = seed >>> 0;
      return () => {
        s += 0x6D2B79F5;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },

    // ----------------------------------------------------------
    // Derive phenotype from genome + age.
    // ----------------------------------------------------------
    buildPhenotype(genome, age, feedState) {
      const lifespanBonus = feedState ? feedState.lifespanBonus : 0;
      const effectiveLIF  = genome.LIF + lifespanBonus;
      const pct    = Math.min(age / effectiveLIF, 1.0);
      const fossil = pct >= 1.0;

      // Lifecycle scalars
      let bodyScale, ornamentScale, patternOpacity;
      if      (pct < 0.05) { bodyScale = 0.45; ornamentScale = 0.00; patternOpacity = 0.10; }
      else if (pct < 0.12) { bodyScale = 0.60; ornamentScale = 0.15; patternOpacity = 0.30; }
      else if (pct < 0.25) { bodyScale = 0.78; ornamentScale = 0.40; patternOpacity = 0.60; }
      else if (pct < 0.40) { bodyScale = 0.90; ornamentScale = 0.75; patternOpacity = 0.90; }
      else if (pct < 0.60) { bodyScale = 1.00; ornamentScale = 1.00; patternOpacity = 1.00; }
      else if (pct < 0.80) { bodyScale = 0.98; ornamentScale = 0.88; patternOpacity = 0.90; }
      else if (pct < 1.00) { bodyScale = 0.92; ornamentScale = 0.70; patternOpacity = 0.75; }
      else                 { bodyScale = 0.75; ornamentScale = 0.00; patternOpacity = 0.00; }

      const fertile = age >= genome.FRT_START && age < genome.FRT_END && !fossil;
      const male    = genome.SX === 0;

      // Colour
      const palettes = [
        { base: 160 }, { base: 200 }, { base: 280 }, { base:  30 },
        { base: 340 }, { base: 100 }, { base: 240 }, { base:  55 },
      ];
      const paletteBase = palettes[genome.GEN % 8].base;
      const finalHue    = (paletteBase + genome.CLR) % 360;
      const healthPct   = feedState ? feedState.healthPct : 0.5;
      const satBoost    = fossil ? 0 : Math.round((healthPct - 0.5) * 30);
      const litBoost    = fossil ? 0 : Math.round((healthPct - 0.5) * 16);
      const colorSat    = fossil ? 8  : Math.max(10, Math.min(100, 55 + ornamentScale * 20 + (fertile ? 10 : 0) + satBoost));
      const colorLight  = fossil ? 28 : Math.max(15, Math.min(70,  40 + (pct < 0.6 ? 10 : 0) + litBoost));

      // MOR → body proportions
      const morRng      = this.makePrng(genome.MOR);
      const bodyLen     = 80 + morRng() * 30;   // torso half-width
      const bodyH       = 42 + morRng() * 18;   // torso half-height
      const headSize    = 26 + morRng() * 12;   // head radius
      const tailCurve   = 0.4 + morRng() * 0.5; // tail curl amount

      // APP → appendage style
      const appRng      = this.makePrng(genome.APP);
      const legLen      = 44 + appRng() * 20;
      const legThick    = 7  + appRng() * 5;
      const earH        = 22 + appRng() * 14;
      const earW        = 10 + appRng() * 6;
      const hasWings    = appRng() > 0.72;      // rare dorsal wing/fin
      const wingSpan    = 24 + appRng() * 20;

      // ORN → ornament style
      const ornRng      = this.makePrng(genome.ORN);
      const glowOrbs    = 2 + Math.floor(ornRng() * 4);  // 2–5 orbs on tail
      const ribbons     = 1 + Math.floor(ornRng() * 3);  // 1–3 energy ribbons
      const patternType = Math.floor(ornRng() * 3);      // 0=plain 1=spots 2=dapple
      const orbHue      = (finalHue + 40 + ornRng() * 60) % 360;
      const hasChestMark = ornRng() > 0.4;
      const hasMane      = ornRng() > 0.45;

      return {
        fossil, pct, fertile, male,
        bodyScale, ornamentScale, patternOpacity,
        finalHue, colorSat, colorLight, orbHue,
        bodyLen, bodyH, headSize, tailCurve,
        legLen, legThick, earH, earW,
        hasWings, wingSpan,
        glowOrbs, ribbons, patternType, hasChestMark, hasMane,
        eyeRadius: pct < 0.08 ? 9 : 7,
      };
    },

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------
    hsl(h, s, l, a = 1) {
      return a < 1
        ? `hsla(${h},${s}%,${l}%,${a})`
        : `hsl(${h},${s}%,${l}%)`;
    },
    radGrad(ctx, x, y, r0, r1, stops) {
      const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
      stops.forEach(([t, c]) => g.addColorStop(t, c));
      return g;
    },
    linGrad(ctx, x0, y0, x1, y1, stops) {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      stops.forEach(([t, c]) => g.addColorStop(t, c));
      return g;
    },

    // ----------------------------------------------------------
    // Build pose-specific transform data.
    // Each pose returns overrides applied on top of standard anchors.
    // ----------------------------------------------------------
    buildPoseTransform(pose, p, sc, W, H) {
      const base = {
        oyDelta: 0, headDX: 0, headDY: 0,
        neckAngle: 0, tailUp: 0, tailCurlMul: 1, tailWrap: false,
        legOverride: null, eyeClosed: false, shadowScale: 1,
        torsoAngle: -0.08,  // default slight tilt (matches original hardcoded value)
      };

      if (pose === "standing") return base;

      if (pose === "alert") {
        return {
          ...base,
          oyDelta:    -4 * sc,
          headDX:     2  * sc,
          headDY:    -10 * sc,
          neckAngle:  0.4,
          tailUp:     0.85,
          tailCurlMul: 0.3,
          shadowScale: 0.9,
        };
      }

      if (pose === "playful") {
        return {
          ...base,
          oyDelta:    6 * sc,
          headDX:    -8 * sc,
          headDY:    12 * sc,
          neckAngle: -0.5,
          tailUp:    1.0,
          tailCurlMul: 0.5,
          shadowScale: 1.1,
          legOverride: (ctx, pp, s, ox, oy, hue, sat, lit) => {
            // Back legs behind — standard
            this._drawLeg(ctx, pp, s,
              ox + pp.bodyLen * s * 0.52, oy + pp.bodyH * s * 0.55,
              hue, sat - 8, lit - 10, true);
            this._drawLeg(ctx, pp, s,
              ox - pp.bodyLen * s * 0.18, oy + pp.bodyH * s * 0.55,
              hue, sat - 8, lit - 10, true);
            // Front legs stretched forward and down (play-bow)
            this._drawLegPose(ctx, pp, s,
              ox - pp.bodyLen * s * 0.12, oy + pp.bodyH * s * 0.65,
              hue, sat, lit, false, "stretched");
            this._drawLegPose(ctx, pp, s,
              ox - pp.bodyLen * s * 0.46, oy + pp.bodyH * s * 0.65,
              hue, sat, lit, false, "stretched");
          }
        };
      }

      if (pose === "sitting") {
        // The torso tilts rear-down ~22 degrees.
        // oy is shifted up so the front (chest/neck) stays at the same visual height
        // while the rear drops naturally onto the haunches.
        const tiltAngle = 0.38;   // radians — rear angles downward
        return {
          ...base,
          oyDelta:    -6 * sc,    // shift pivot up so chest height is stable
          headDX:     4  * sc,
          headDY:    -8  * sc,
          neckAngle:  0.3,
          tailUp:     0.0,
          tailCurlMul: 1.6,
          tailWrap:   true,
          shadowScale: 1.2,
          torsoAngle: -0.08 + tiltAngle,  // combined with base lean
          legOverride: (ctx, pp, s, ox, oy, hue, sat, lit) => {
            // Rear of tilted torso drops to approximately:
            //   rearX = ox + bodyLen*s (tail side, positive x)
            //   rearY = oy + bodyLen*s * sin(tiltAngle)
            // Haunches sit at the bottom of that rear drop.
            const rearDropY = pp.bodyLen * s * Math.sin(tiltAngle);
            const haunchY   = oy + pp.bodyH * s * 0.5 + rearDropY;

            // Back haunches — behind body, at dropped rear height
            this._drawHaunch(ctx, pp, s,
              ox + pp.bodyLen * s * 0.44, haunchY,
              hue, sat - 8, lit - 10, true);
            this._drawHaunch(ctx, pp, s,
              ox + pp.bodyLen * s * 0.06, haunchY,
              hue, sat - 8, lit - 10, false);
            // Front legs straight down from front of torso
            this._drawLeg(ctx, pp, s,
              ox - pp.bodyLen * s * 0.30, oy + pp.bodyH * s * 0.65,
              hue, sat, lit, false);
            this._drawLeg(ctx, pp, s,
              ox - pp.bodyLen * s * 0.56, oy + pp.bodyH * s * 0.65,
              hue, sat, lit, false);
          }
        };
      }

      if (pose === "sleeping") {
        return {
          ...base,
          oyDelta:    28 * sc,
          headDX:     0,
          headDY:     18 * sc,
          neckAngle: -0.8,
          tailUp:    -0.3,
          tailCurlMul: 2.0,
          tailWrap:   true,
          eyeClosed:  true,
          shadowScale: 1.3,
          legOverride: (ctx, pp, s, ox, oy, hue, sat, lit) => {
            const tuckY = oy + pp.bodyH * s * 0.55;
            this._drawTuckedLegs(ctx, pp, s, ox, tuckY, hue, sat, lit);
          }
        };
      }

      return base;
    },

    // ----------------------------------------------------------
    // Derive the creature's current expression from game state.
    // Returns an expression key used by _drawFace().
    //
    // Priority order (highest wins):
    //   pose override → thriving → happy → content → hungry → sad
    //   with activity (play/walk) boosting mood one step up.
    // ----------------------------------------------------------
    _buildExpression(pose, feedState, activityState) {
      // Pose always wins for sleeping/alert/playful
      if (pose === "sleeping") return "sleepy";
      if (pose === "alert")    return "alert";
      if (pose === "playful")  return "excited";

      const health   = feedState     ? feedState.healthPct     : null;
      const moodPct  = activityState ? activityState.moodPct   : 0;

      // Mood boost: play activity bumps happiness by up to 0.25
      const boost = moodPct * 0.25;

      if (health === null)              return "content";   // no data yet
      const boosted = Math.min(health + boost, 1.0);
      if (boosted >= 0.80)              return "thriving";
      if (boosted >= 0.55)              return "happy";
      if (boosted >= 0.30)              return "content";
      if (health  >  0.00)              return "hungry";
      return "sad";
    },

    // ----------------------------------------------------------
    // Draw face expression: eye shape, brow, mouth, extras.
    // Called after the base eye iris is already drawn so we can
    // layer expression details on top / beside it.
    // ----------------------------------------------------------
    _drawFace(ctx, expression, eyeX, eyeY, eyeR, snoutX, snoutY, hR, hue, sat, lit, sc) {
      const H1 = this.hsl;
      ctx.lineCap = "round";

      // ── MOUTH ──────────────────────────────────────────────
      // Base position: below nose on snout face, centred
      const mouthX = snoutX - hR * 0.08;
      const mouthY = snoutY + hR * 0.16;
      const mW     = hR * 0.28;   // half-width of mouth arc

      ctx.lineWidth   = Math.max(0.8, eyeR * 0.28);
      ctx.strokeStyle = H1(hue, sat + 5, lit - 35);

      if (expression === "thriving" || expression === "excited") {
        // Big open smile — wide arc curving strongly upward at ends
        ctx.beginPath();
        ctx.moveTo(mouthX - mW, mouthY);
        ctx.quadraticCurveTo(mouthX, mouthY - hR * 0.22, mouthX + mW, mouthY);
        ctx.stroke();
        // Small tongue dot for extra joy
        ctx.fillStyle = H1((hue + 340) % 360, 60, 72, 0.85);
        ctx.beginPath();
        ctx.ellipse(mouthX, mouthY + hR * 0.04, hR * 0.09, hR * 0.07, 0, 0, Math.PI * 2);
        ctx.fill();

      } else if (expression === "happy") {
        // Gentle smile
        ctx.beginPath();
        ctx.moveTo(mouthX - mW * 0.8, mouthY);
        ctx.quadraticCurveTo(mouthX, mouthY - hR * 0.14, mouthX + mW * 0.8, mouthY);
        ctx.stroke();

      } else if (expression === "content" || expression === "alert") {
        // Neutral straight line — slight upward tilt at right end
        ctx.beginPath();
        ctx.moveTo(mouthX - mW * 0.65, mouthY + hR * 0.03);
        ctx.lineTo(mouthX + mW * 0.65, mouthY - hR * 0.03);
        ctx.stroke();

      } else if (expression === "hungry") {
        // Slight frown — corners pulled gently down
        ctx.beginPath();
        ctx.moveTo(mouthX - mW * 0.75, mouthY - hR * 0.02);
        ctx.quadraticCurveTo(mouthX, mouthY + hR * 0.11, mouthX + mW * 0.75, mouthY - hR * 0.02);
        ctx.stroke();

      } else if (expression === "sad") {
        // Pronounced frown
        ctx.beginPath();
        ctx.moveTo(mouthX - mW * 0.8, mouthY - hR * 0.04);
        ctx.quadraticCurveTo(mouthX, mouthY + hR * 0.20, mouthX + mW * 0.8, mouthY - hR * 0.04);
        ctx.stroke();

      } else if (expression === "sleepy") {
        // Tiny neutral mouth, barely visible
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(mouthX - mW * 0.45, mouthY);
        ctx.lineTo(mouthX + mW * 0.45, mouthY);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── EYEBROW / BROW LINE ─────────────────────────────────
      const browY  = eyeY - eyeR * 1.55;
      const browW  = eyeR * 1.1;
      ctx.lineWidth   = Math.max(0.7, eyeR * 0.22);
      ctx.strokeStyle = H1(hue, sat + 5, lit - 28, 0.75);

      if (expression === "thriving" || expression === "excited") {
        // Both brows raised and arched — ^ shape
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.55, browY + eyeR * 0.18);
        ctx.quadraticCurveTo(eyeX, browY - eyeR * 0.22, eyeX + browW * 0.55, browY + eyeR * 0.18);
        ctx.stroke();

      } else if (expression === "happy") {
        // Relaxed raised brow — gentle upward curve
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.5, browY + eyeR * 0.08);
        ctx.quadraticCurveTo(eyeX, browY - eyeR * 0.12, eyeX + browW * 0.5, browY + eyeR * 0.08);
        ctx.stroke();

      } else if (expression === "content") {
        // Flat neutral brow
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.5, browY);
        ctx.lineTo(eyeX + browW * 0.5, browY);
        ctx.stroke();

      } else if (expression === "alert") {
        // Both brows raised high and straight — wide-eyed look
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.55, browY - eyeR * 0.15);
        ctx.lineTo(eyeX + browW * 0.55, browY - eyeR * 0.15);
        ctx.stroke();

      } else if (expression === "hungry") {
        // Inner brow raised on one side — worried/uncertain
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.5, browY + eyeR * 0.08);
        ctx.quadraticCurveTo(eyeX + browW * 0.1, browY - eyeR * 0.18, eyeX + browW * 0.5, browY + eyeR * 0.04);
        ctx.stroke();

      } else if (expression === "sad") {
        // Both brows angled inward-up — classic sad V shape
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.55, browY + eyeR * 0.15);
        ctx.quadraticCurveTo(eyeX - browW * 0.1, browY - eyeR * 0.22, eyeX + browW * 0.55, browY + eyeR * 0.05);
        ctx.stroke();

      } else if (expression === "sleepy") {
        // Drooped brow covering top quarter of eye
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = eyeR * 0.55;
        ctx.beginPath();
        ctx.moveTo(eyeX - browW * 0.5, browY + eyeR * 0.55);
        ctx.quadraticCurveTo(eyeX, browY + eyeR * 0.35, eyeX + browW * 0.5, browY + eyeR * 0.55);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── EXTRA SPARKLES for thriving ────────────────────────
      if (expression === "thriving" || expression === "excited") {
        const sparkHue = (hue + 60) % 360;
        ctx.fillStyle   = H1(sparkHue, 100, 90, 0.9);
        ctx.strokeStyle = H1(sparkHue, 80,  70, 0.6);
        ctx.lineWidth   = 0.6;
        // Two small star glints beside the eye
        for (const [sx, sy, sr] of [
          [eyeX + eyeR * 1.5, eyeY - eyeR * 1.1, eyeR * 0.22],
          [eyeX + eyeR * 0.9, eyeY - eyeR * 1.6, eyeR * 0.14],
        ]) {
          ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        }
      }

      // ── TEARDROP for sad ───────────────────────────────────
      if (expression === "sad") {
        ctx.fillStyle = H1(200, 80, 72, 0.7);
        ctx.beginPath();
        ctx.ellipse(eyeX + eyeR * 0.55, eyeY + eyeR * 1.05,
                    eyeR * 0.14, eyeR * 0.22, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── ROSY CHEEKS for thriving ───────────────────────────
      if (expression === "thriving") {
        ctx.fillStyle = H1((hue + 330) % 360, 70, 68, 0.22);
        ctx.beginPath();
        ctx.ellipse(snoutX + hR * 0.08, snoutY - hR * 0.05,
                    hR * 0.28, hR * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.lineCap = "butt";
    },

    // ----------------------------------------------------------
    // Draw a single leg + paw (standard upright)
    // ----------------------------------------------------------
    _drawLeg(ctx, p, sc, x, y, hue, sat, lit, behind) {
      const lLen = p.legLen * sc;
      const lW   = p.legThick * sc;
      const alpha = behind ? 0.62 : 1.0;
      ctx.globalAlpha = alpha;

      const legGr = this.linGrad(ctx, x, y, x + lW * 0.3, y + lLen * 0.6,
        [
          [0, this.hsl(hue, sat - 5, lit - 5)],
          [1, this.hsl(hue, sat - 10, lit - 14)],
        ]
      );
      ctx.fillStyle   = legGr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x - lW * 0.5, y);
      ctx.quadraticCurveTo(x - lW * 0.7, y + lLen * 0.5, x - lW * 0.3, y + lLen * 0.7);
      ctx.lineTo(x + lW * 0.3, y + lLen * 0.7);
      ctx.quadraticCurveTo(x + lW * 0.7, y + lLen * 0.5, x + lW * 0.5, y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // Paw
      ctx.fillStyle   = this.hsl(hue, sat - 15, lit + 10);
      ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
      ctx.lineWidth   = 0.8;
      ctx.beginPath();
      ctx.ellipse(x, y + lLen * 0.72, lW * 0.72, lW * 0.42, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      ctx.globalAlpha = 1;
    },

    // ----------------------------------------------------------
    // Draw a stretched/angled leg (play-bow front legs)
    // ----------------------------------------------------------
    _drawLegPose(ctx, p, sc, x, y, hue, sat, lit, behind, style) {
      const lLen = p.legLen * sc * (style === "stretched" ? 1.25 : 1.0);
      const lW   = p.legThick * sc;
      const alpha = behind ? 0.62 : 1.0;
      ctx.globalAlpha = alpha;

      const angle = style === "stretched" ? 0.55 : 0;
      const dx = Math.sin(angle) * lLen;
      const dy = Math.cos(angle) * lLen;

      const legGr = this.linGrad(ctx, x, y, x - dx + lW * 0.3, y + dy,
        [[0, this.hsl(hue, sat - 5, lit - 5)], [1, this.hsl(hue, sat - 10, lit - 14)]]
      );
      ctx.fillStyle   = legGr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x - lW * 0.5, y);
      ctx.quadraticCurveTo(x - lW * 0.7 - dx * 0.5, y + dy * 0.5, x - lW * 0.3 - dx, y + dy * 0.72);
      ctx.lineTo(x + lW * 0.3 - dx, y + dy * 0.72);
      ctx.quadraticCurveTo(x + lW * 0.7 - dx * 0.5, y + dy * 0.5, x + lW * 0.5, y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      ctx.fillStyle   = this.hsl(hue, sat - 15, lit + 10);
      ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
      ctx.lineWidth   = 0.8;
      ctx.beginPath();
      ctx.ellipse(x - dx, y + dy * 0.74, lW * 0.85, lW * 0.48, angle, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
    },

    // ----------------------------------------------------------
    // Draw a folded haunch (sitting rear leg)
    // ----------------------------------------------------------
    _drawHaunch(ctx, p, sc, x, y, hue, sat, lit, behind) {
      const alpha = behind ? 0.62 : 1.0;
      const rX = p.legLen * sc * 0.48;
      const rY = p.legThick * sc * 1.1;
      ctx.globalAlpha = alpha;

      const gr = this.linGrad(ctx, x - rX, y, x + rX, y + rY * 2,
        [[0, this.hsl(hue, sat - 5, lit - 8)], [1, this.hsl(hue, sat - 10, lit - 16)]]
      );
      ctx.fillStyle   = gr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 20);
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.ellipse(x, y + rY, rX, rY, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Paw poking out front
      ctx.fillStyle   = this.hsl(hue, sat - 15, lit + 10);
      ctx.strokeStyle = this.hsl(hue, sat, lit - 22);
      ctx.lineWidth   = 0.8;
      ctx.beginPath();
      ctx.ellipse(x - rX * 0.7, y + rY * 1.6, rX * 0.55, rY * 0.55, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
    },

    // ----------------------------------------------------------
    // Draw all four legs tucked flat (sleeping)
    // ----------------------------------------------------------
    _drawTuckedLegs(ctx, p, sc, ox, y, hue, sat, lit) {
      const positions = [
        { x: ox + p.bodyLen * sc * 0.45, behind: true  },
        { x: ox - p.bodyLen * sc * 0.10, behind: true  },
        { x: ox - p.bodyLen * sc * 0.30, behind: false },
        { x: ox - p.bodyLen * sc * 0.55, behind: false },
      ];
      for (const pos of positions) {
        ctx.globalAlpha = pos.behind ? 0.55 : 0.85;
        ctx.fillStyle   = this.hsl(hue, sat - 8, lit - 10);
        ctx.strokeStyle = this.hsl(hue, sat, lit - 20);
        ctx.lineWidth   = 0.8;
        ctx.beginPath();
        ctx.ellipse(pos.x, y, p.legThick * sc * 1.0, p.legThick * sc * 0.55, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    // ----------------------------------------------------------
    // Main draw
    // ----------------------------------------------------------
    draw() {
      const canvas = this.$refs.canvas;
      if (!canvas || !this.genome) return;
      const ctx = canvas.getContext("2d");
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const g = this.genome;
      const p = this.buildPhenotype(g, this.age, this.feedState);
      const sc = p.bodyScale;

      // Pose priority: reaction anim > behaviour state > resting random pose.
      const pose = (!p.fossil && (this.animPose || this.pose)) ? (this.animPose || this.pose) : "standing";
      const pt   = this.buildPoseTransform(pose, p, sc, W, H);

      // Expression: animation override takes priority over game-state-derived expression.
      const expression = this.animExpression || this._buildExpression(pose, this.feedState, this.activityState);

      // Horizontal drift + vertical wander + jump arc all applied as a
      // single translate so every subsequent draw call is shifted together.
      // _behavY  : slow sinusoidal wander during walk/run
      // _jumpY   : physics-driven upward arc (negative = above ground)
      const centreX = W * 0.46;
      const centreY = H * 0.52;

      ctx.save();

      // _behavY = directional vertical travel (bounces off edges like _behavX).
      // _bobY   = tiny sinusoidal body-bob layered on top — 5px walk, 3px run.
      //           Gives a natural rhythm without competing with the real movement.
      const isMoving = this._behavState === "walk" || this._behavState === "run"
                    || this._behavState === "walkto";
      const bobAmp   = this._behavState === "run" ? 3 : 5;
      const bobFreq  = this._behavState === "run" ? 1.8 : 1.1;
      const _bobY    = isMoving
        ? Math.sin(this._behavT * bobFreq * Math.PI * 2) * bobAmp
        : 0;

      ctx.translate(this._behavX, this._behavY + _bobY - this._jumpY);

      if (this.facingRight) {
        // Mirror: translate to right edge of canvas, flip, then draw normally.
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
      }

      const ox = centreX;
      const oy = centreY + pt.oyDelta;

      const H1  = this.hsl;
      const hue = p.finalHue;
      const sat = p.colorSat;
      const lit = p.colorLight;
      const wearings = this._normalizedWearings();

      // ---- FOSSIL ----
      if (p.fossil) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle   = "#666";
        ctx.strokeStyle = "#444";
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.ellipse(ox, oy, p.bodyLen * 0.55, p.bodyH * 0.9, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        const crRng = this.makePrng(g.MOR + 11);
        ctx.strokeStyle = "#333"; ctx.lineWidth = 1.2;
        for (let i = 0; i < 6; i++) {
          ctx.beginPath();
          const sx = ox + (crRng() - 0.5) * p.bodyLen;
          const sy = oy + (crRng() - 0.5) * p.bodyH * 1.5;
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + (crRng() - 0.5) * 28, sy + (crRng() - 0.5) * 28);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.restore();   // always restore — we always ctx.save() now
        return;
      }

      // ---- SHADOW ----
      const shadowY  = oy + p.bodyH * sc + p.legLen * sc * 0.85;
      const shadowGr = this.radGrad(ctx, ox, shadowY, 0, p.bodyLen * sc * 0.9, [
        [0, `hsla(0,0%,0%,0.18)`], [1, `hsla(0,0%,0%,0)`],
      ]);
      ctx.fillStyle = shadowGr;
      ctx.beginPath();
      ctx.ellipse(ox, shadowY,
        p.bodyLen * sc * 0.85 * pt.shadowScale,
        7 * sc * pt.shadowScale, 0, 0, Math.PI * 2);
      ctx.fill();

      // ---- ENERGY RIBBONS (behind body) ----
      if (p.ornamentScale > 0.3) {
        const ribRng = this.makePrng(g.ORN + 200);
        for (let r = 0; r < p.ribbons; r++) {
          const yOff   = (ribRng() - 0.5) * p.bodyH * sc * 0.9;
          const ctrl1x = ox + p.bodyLen * sc * 0.8 + 20 + ribRng() * 30;
          const ctrl1y = oy + yOff - 20 - ribRng() * 25;
          const ctrl2x = ctrl1x + 30 + ribRng() * 50;
          const ctrl2y = oy + yOff + (ribRng() - 0.5) * 40;
          const endX   = ctrl2x + 20 + ribRng() * 40;
          const endY   = ctrl2y + (ribRng() - 0.5) * 30;
          ctx.globalAlpha = (0.55 + ribRng() * 0.35) * p.ornamentScale;
          ctx.strokeStyle = H1((p.orbHue + r * 20) % 360, sat + 30, lit + 30);
          ctx.lineWidth   = (2 + ribRng() * 3) * p.ornamentScale * sc;
          ctx.lineCap     = "round";
          ctx.beginPath();
          ctx.moveTo(ox + p.bodyLen * sc * 0.6, oy + yOff);
          ctx.bezierCurveTo(ctrl1x, ctrl1y, ctrl2x, ctrl2y, endX, endY);
          ctx.stroke();
        }
        ctx.globalAlpha = 1; ctx.lineCap = "butt";
      }

      // ---- LEGS ----
      // During walk/run the autonomous behaviour system supplies a
      // gait-animated leg override using the live _walkPhase value.
      // All other states (idle, jump, reaction anim) use the pose's
      // own legOverride (or the standard standing legs if null).
      const isWalking = !p.fossil &&
        (this._behavState === "walk" || this._behavState === "run" ||
         this._behavState === "walkto") &&
        !this.animPose;  // reaction animation takes priority

      if (isWalking) {
        this._drawWalkingLegs(
          ctx, p, sc, ox, oy, hue, sat, lit,
          this._walkPhase,
          this._behavState === "run"
        );
      } else if (pt.legOverride) {
        pt.legOverride(ctx, p, sc, ox, oy, hue, sat, lit);
      } else {
        // Standard standing legs
        this._drawLeg(ctx, p, sc, ox + p.bodyLen * sc * 0.52, oy + p.bodyH * sc * 0.55,
                      hue, sat - 8, lit - 10, true);
        this._drawLeg(ctx, p, sc, ox - p.bodyLen * sc * 0.18, oy + p.bodyH * sc * 0.55,
                      hue, sat - 8, lit - 10, true);
        this._drawLeg(ctx, p, sc, ox + p.bodyLen * sc * 0.42, oy + p.bodyH * sc * 0.6,
                      hue, sat, lit, false);
        this._drawLeg(ctx, p, sc, ox - p.bodyLen * sc * 0.08, oy + p.bodyH * sc * 0.6,
                      hue, sat, lit, false);
      }

      // ---- TAIL ----
      if (pt.tailWrap) {
        this._drawTailWrap(ctx, p, sc, ox, oy, hue, sat, lit, pt);
      } else {
        this._drawTailPosed(ctx, p, sc, ox, oy, hue, sat, lit, pt);
      }

      // ---- TORSO ----
      const torsoGr = this.linGrad(ctx,
        ox, oy - p.bodyH * sc, ox, oy + p.bodyH * sc,
        [
          [0,   H1(hue, sat - 5,  lit - 8)],
          [0.4, H1(hue, sat,      lit)],
          [1,   H1(hue, sat - 12, lit + 14)],
        ]
      );
      ctx.fillStyle   = torsoGr;
      ctx.strokeStyle = H1(hue, sat, lit - 18);
      ctx.lineWidth   = 1.8;
      ctx.beginPath();
      ctx.ellipse(ox, oy, p.bodyLen * sc, p.bodyH * sc, pt.torsoAngle, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // ---- CHEST MARKING ----
      if (p.hasChestMark && p.ornamentScale > 0.2) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(ox, oy, p.bodyLen * sc, p.bodyH * sc, pt.torsoAngle, 0, Math.PI * 2);
        ctx.clip();
        const chestGr = this.radGrad(ctx,
          ox - p.bodyLen * sc * 0.35, oy, 0, p.bodyLen * sc * 0.45,
          [
            [0,   H1(hue, sat - 20, lit + 28, 0.65)],
            [0.6, H1(hue, sat - 10, lit + 14, 0.25)],
            [1,   H1(hue, sat,      lit,       0)],
          ]
        );
        ctx.fillStyle = chestGr;
        ctx.fillRect(ox - p.bodyLen * sc, oy - p.bodyH * sc, p.bodyLen * sc * 2, p.bodyH * sc * 2);
        ctx.restore();
      }

      // ---- PATTERN (spots / dapple) ----
      if (p.patternOpacity > 0.1 && p.patternType > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(ox, oy, p.bodyLen * sc - 2, p.bodyH * sc - 2, pt.torsoAngle, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = p.patternOpacity * 0.22;
        ctx.fillStyle   = H1((hue + 35) % 360, sat + 10, lit + 20);
        const patRng = this.makePrng(g.ORN + 77);
        if (p.patternType === 1) {
          for (let i = 0; i < 10; i++) {
            const sx = ox + (patRng() - 0.5) * p.bodyLen * sc * 1.6;
            const sy = oy + (patRng() - 0.5) * p.bodyH * sc * 1.6;
            ctx.beginPath(); ctx.arc(sx, sy, (3 + patRng() * 6) * sc, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          for (let i = 0; i < 5; i++) {
            const sx = ox + (patRng() - 0.5) * p.bodyLen * sc * 1.2;
            const sy = oy + (patRng() - 0.5) * p.bodyH * sc;
            ctx.beginPath();
            ctx.ellipse(sx, sy, (8 + patRng() * 14) * sc, (5 + patRng() * 10) * sc,
                        patRng() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore(); ctx.globalAlpha = 1;
      }

      // ---- WINGS LAYER ----
      // Draw wings after torso so they remain visible.
      if (!p.fossil) {
        wearings
          .filter(w => w.template === "wings")
          .forEach(w => this._drawAccessoryOnCreature(ctx, p, sc, ox, oy, pt, W, H, w));
      }

      // ---- NECKLACE UNDERLAY ----
      // Draw worn necklaces before neck/head so natural occlusion comes
      // from creature geometry instead of clipping the accessory image.
      if (!p.fossil) {
        wearings
          .filter(w => w.template === "necklace")
          .forEach(w => this._drawAccessoryOnCreature(ctx, p, sc, ox, oy, pt, W, H, w, { underlayNecklace: true }));
      }

      // ---- NECK ----
      const headX = ox - p.bodyLen * sc * 0.68 + pt.headDX;
      const headY = oy - p.bodyH  * sc * 0.35  + pt.headDY;
      const neckCtrlY = oy - p.bodyH * sc * (0.2 - pt.neckAngle * 0.35);
      const neckGr = this.linGrad(ctx,
        ox - p.bodyLen * sc * 0.5, oy - p.bodyH * sc * 0.1,
        headX, headY + p.headSize * sc * 0.4,
        [[0, H1(hue, sat - 5, lit - 5)], [1, H1(hue, sat, lit)]]
      );
      ctx.fillStyle   = neckGr;
      ctx.strokeStyle = H1(hue, sat, lit - 18);
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox - p.bodyLen * sc * 0.42, oy - p.bodyH * sc * 0.5);
      ctx.quadraticCurveTo(
        ox - p.bodyLen * sc * 0.58, neckCtrlY,
        headX + p.headSize * sc * 0.55, headY + p.headSize * sc * 0.5
      );
      ctx.quadraticCurveTo(
        ox - p.bodyLen * sc * 0.52, oy,
        ox - p.bodyLen * sc * 0.32, oy + p.bodyH * sc * 0.1
      );
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // ---- MANE ----
      if (p.hasMane && p.ornamentScale > 0.2) {
        const maneRng = this.makePrng(g.ORN + 555);
        ctx.strokeStyle = H1(hue, sat - 10, lit + 22);
        ctx.lineCap = "round";
        for (let i = 0; i < 7; i++) {
          const t     = i / 6;
          const mx    = ox - p.bodyLen * sc * (0.45 + t * 0.28) + pt.headDX * t;
          const my    = oy - p.bodyH  * sc * (0.55 + t * 0.15)  + pt.headDY * t;
          const len   = (8 + maneRng() * 12) * sc * p.ornamentScale;
          const angle = -0.4 - maneRng() * 0.5 + pt.neckAngle * 0.2;
          ctx.globalAlpha = 0.55 + maneRng() * 0.3;
          ctx.lineWidth   = (1.5 + maneRng() * 2) * sc;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(mx + Math.cos(angle) * len, my + Math.sin(angle) * len);
          ctx.stroke();
        }
        ctx.globalAlpha = 1; ctx.lineCap = "butt";
      }

      // ---- HEAD ----
      const hR = p.headSize * sc;
      const headGr = this.radGrad(ctx,
        headX - hR * 0.15, headY + hR * 0.2, hR * 0.1, hR * 1.1,
        [
          [0,   H1(hue, sat - 18, lit + 22)],
          [0.5, H1(hue, sat,      lit)],
          [1,   H1(hue, sat + 5,  lit - 12)],
        ]
      );
      ctx.fillStyle   = headGr;
      ctx.strokeStyle = H1(hue, sat, lit - 18);
      ctx.lineWidth   = 1.8;
      ctx.beginPath();
      ctx.arc(headX, headY, hR, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Snout
      const snoutX = headX - hR * 0.72;
      const snoutY = headY + hR * 0.18;
      ctx.fillStyle   = H1(hue, sat - 5, lit + 12);
      ctx.strokeStyle = H1(hue, sat, lit - 18);
      ctx.lineWidth   = 1.2;
      ctx.beginPath();
      ctx.ellipse(snoutX, snoutY, hR * 0.44, hR * 0.28, -0.15, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      // Nose
      ctx.fillStyle = H1(hue, sat + 10, lit - 30);
      ctx.beginPath();
      ctx.ellipse(snoutX - hR * 0.22, snoutY - hR * 0.06, hR * 0.12, hR * 0.08, -0.2, 0, Math.PI * 2);
      ctx.fill();

      // ---- EARS ----
      this._drawEar(ctx, p, sc, headX, headY, hue, sat, lit, -1, false);
      this._drawEar(ctx, p, sc, headX, headY, hue, sat, lit,  1, true);

      // ---- EYE ----
      const eyeX = headX - hR * 0.28;
      const eyeY = headY - hR * 0.14;
      const eyeR = p.eyeRadius * sc;

      if (pt.eyeClosed) {
        // Sleeping — simple curved closed-eye line
        ctx.strokeStyle = H1(hue, sat, lit - 25);
        ctx.lineWidth   = eyeR * 0.55;
        ctx.lineCap     = "round";
        ctx.beginPath();
        ctx.arc(eyeX, eyeY, eyeR * 0.72, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        ctx.lineCap = "butt";
      } else {
        // Alert: slightly wider eye for the alert expression
        const alertScale = (expression === "alert") ? 1.15 : 1.0;
        const irisGr = this.radGrad(ctx,
          eyeX - eyeR * 0.2, eyeY - eyeR * 0.2, 0, eyeR * alertScale,
          [
            [0,   H1((hue + 120) % 360, 70, 75)],
            [0.6, H1((hue + 90)  % 360, 80, 50)],
            [1,   H1((hue + 60)  % 360, 60, 25)],
          ]
        );
        ctx.fillStyle = irisGr;
        ctx.beginPath(); ctx.arc(eyeX, eyeY, eyeR * alertScale, 0, Math.PI * 2); ctx.fill();
        // Pupil — shifted down slightly when sad/hungry, normal otherwise
        const pupilDY = (expression === "sad" || expression === "hungry") ? eyeR * 0.14 : 0;
        ctx.fillStyle = "#0a0a14";
        ctx.beginPath(); ctx.ellipse(eyeX + eyeR * 0.05, eyeY + pupilDY,
                                     eyeR * 0.42, eyeR * 0.62, 0, 0, Math.PI * 2); ctx.fill();
        // Highlights
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        ctx.beginPath(); ctx.arc(eyeX - eyeR * 0.28, eyeY - eyeR * 0.28, eyeR * 0.22, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath(); ctx.arc(eyeX + eyeR * 0.2, eyeY + eyeR * 0.15, eyeR * 0.12, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = H1(hue, sat, lit - 25); ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.arc(eyeX, eyeY, eyeR * alertScale, 0, Math.PI * 2); ctx.stroke();
      }

      // ---- FACE EXPRESSION (brow + mouth + extras) ----
      // Only show on creatures old enough to have a visible face (toddler+)
      if (p.pct >= 0.05) {
        this._drawFace(ctx, expression, eyeX, eyeY, eyeR, snoutX, snoutY, hR, hue, sat, lit, sc);
      }

      // ---- DORSAL WING / FIN ----
      if (p.hasWings && p.ornamentScale > 0.35) {
        const wS = p.wingSpan * sc * p.ornamentScale;
        const wx = ox - p.bodyLen * sc * 0.1;
        const wy = oy - p.bodyH * sc * 0.88;
        ctx.fillStyle   = H1(hue, sat + 10, lit + 16, 0.7);
        ctx.strokeStyle = H1(hue, sat, lit - 10, 0.8);
        ctx.lineWidth   = 1.2;
        ctx.globalAlpha = 0.78;
        ctx.beginPath();
        ctx.moveTo(wx - wS * 0.5, wy + wS * 0.35);
        ctx.quadraticCurveTo(wx - wS * 0.3, wy - wS * 0.4, wx, wy - wS);
        ctx.quadraticCurveTo(wx + wS * 0.3, wy - wS * 0.4, wx + wS * 0.5, wy + wS * 0.35);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ---- GLOWING ORB NODES ----
      if (p.ornamentScale > 0.4) {
        this._drawOrbNodes(ctx, p, sc, ox, oy, g);
      }

      // ---- FERTILITY AURA ----
      if (p.fertile) {
        ctx.globalAlpha = 0.14;
        const aura = this.radGrad(ctx, ox, oy, p.bodyLen * sc * 0.3, p.bodyLen * sc * 1.6,
          [[0, H1((hue + 60) % 360, 100, 85)], [1, H1(hue, 60, 50, 0)]]
        );
        ctx.fillStyle = aura;
        ctx.beginPath(); ctx.arc(ox, oy, p.bodyLen * sc * 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }

      // ---- WEARING ACCESSORY ----
      // Drawn last so it appears on top of the creature.
      // Only shown for non-fossil creatures with an equipped accessory.
      if (!p.fossil) {
        wearings
          .filter(w => w.template !== "necklace" && w.template !== "wings")
          .forEach(w => this._drawAccessoryOnCreature(ctx, p, sc, ox, oy, pt, W, H, w));
      }

      ctx.restore();   // always restore — we always ctx.save() now
    },

    // ----------------------------------------------------------
    // Tail variants
    // ----------------------------------------------------------
    _drawTailPosed(ctx, p, sc, ox, oy, hue, sat, lit, pt) {
      const tX0 = ox + p.bodyLen * sc * 0.82;
      const tY0 = oy - p.bodyH * sc * 0.08;
      const curl = p.tailCurve * pt.tailCurlMul;
      const upShift = pt.tailUp * p.bodyH * sc * 1.5;

      const cp1x = tX0 + 32 * sc;
      const cp1y = tY0 - 30 * sc * curl - upShift * 0.4;
      const cp2x = tX0 + 65 * sc;
      const cp2y = tY0 - 55 * sc * curl - upShift * 0.8;
      const endX = tX0 + 55 * sc;
      const endY = tY0 - 78 * sc * curl - upShift;

      const tailGr = this.linGrad(ctx, tX0, tY0, endX, endY,
        [
          [0,   this.hsl(hue, sat - 5, lit - 8)],
          [0.5, this.hsl(hue, sat, lit + 4)],
          [1,   this.hsl((hue + 30) % 360, sat + 15, lit + 18)],
        ]
      );
      ctx.fillStyle   = tailGr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 14);
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(tX0, tY0 + 10 * sc);
      ctx.bezierCurveTo(cp1x, cp1y + 12 * sc, cp2x + 4 * sc, cp2y + 10 * sc, endX + 8 * sc, endY);
      ctx.bezierCurveTo(cp2x - 6 * sc, cp2y - 14 * sc, cp1x - 10 * sc, cp1y - 12 * sc, tX0, tY0 - 10 * sc);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      const tipGr = this.radGrad(ctx, endX, endY, 0, 20 * sc,
        [
          [0,   this.hsl((hue + 40) % 360, sat + 20, lit + 32, 0.9)],
          [0.6, this.hsl((hue + 20) % 360, sat + 10, lit + 18, 0.5)],
          [1,   this.hsl(hue, sat, lit, 0)],
        ]
      );
      ctx.fillStyle = tipGr;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(endX, endY, 20 * sc, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    },

    _drawTailWrap(ctx, p, sc, ox, oy, hue, sat, lit, pt) {
      // Tail curls around and wraps under/beside the body (sitting/sleeping)
      const tX0 = ox + p.bodyLen * sc * 0.78;
      const tY0 = oy + p.bodyH * sc * 0.1;

      const cp1x = tX0 + 18 * sc;
      const cp1y = tY0 + 20 * sc;
      const cp2x = ox + p.bodyLen * sc * 0.2;
      const cp2y = oy + p.bodyH * sc * 1.1;
      const endX = ox - p.bodyLen * sc * 0.1;
      const endY = oy + p.bodyH * sc * 0.85;

      const tailGr = this.linGrad(ctx, tX0, tY0, endX, endY,
        [
          [0,   this.hsl(hue, sat - 5, lit - 8)],
          [0.5, this.hsl(hue, sat, lit + 4)],
          [1,   this.hsl((hue + 30) % 360, sat + 15, lit + 18)],
        ]
      );
      ctx.fillStyle   = tailGr;
      ctx.strokeStyle = this.hsl(hue, sat, lit - 14);
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(tX0, tY0 - 8 * sc);
      ctx.bezierCurveTo(cp1x, cp1y - 10 * sc, cp2x + 8 * sc, cp2y - 12 * sc, endX + 6 * sc, endY - 8 * sc);
      ctx.bezierCurveTo(cp2x - 4 * sc, cp2y + 4 * sc, cp1x - 10 * sc, cp1y + 8 * sc, tX0, tY0 + 8 * sc);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      const tipGr = this.radGrad(ctx, endX, endY, 0, 16 * sc,
        [
          [0,   this.hsl((hue + 40) % 360, sat + 20, lit + 32, 0.9)],
          [0.6, this.hsl((hue + 20) % 360, sat + 10, lit + 18, 0.5)],
          [1,   this.hsl(hue, sat, lit, 0)],
        ]
      );
      ctx.fillStyle = tipGr;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(endX, endY, 16 * sc, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    },



    // ----------------------------------------------------------
    // Draw a pointed ear
    // ----------------------------------------------------------
    _drawEar(ctx, p, sc, headX, headY, hue, sat, lit, side, front) {
      const hR   = p.headSize * sc;
      const eH   = p.earH * sc;
      const eW   = p.earW * sc;
      const baseX = headX - hR * 0.12 + (side < 0 ? -hR * 0.28 : hR * 0.28);
      const baseY = headY - hR * 0.62;
      const tipX  = baseX + (side < 0 ? -eW * 0.3 : eW * 0.3);
      const tipY  = baseY - eH;
      ctx.globalAlpha = front ? 1.0 : 0.7;

      // Outer ear
      ctx.fillStyle   = this.hsl(hue, sat + 5, lit - 5);
      ctx.strokeStyle = this.hsl(hue, sat, lit - 20);
      ctx.lineWidth   = 1.2;
      ctx.beginPath();
      ctx.moveTo(baseX - eW * 0.55, baseY);
      ctx.quadraticCurveTo(baseX - eW * 0.7, baseY - eH * 0.5, tipX, tipY);
      ctx.quadraticCurveTo(baseX + eW * 0.7, baseY - eH * 0.5, baseX + eW * 0.55, baseY);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // Inner ear — pinkish/contrasting
      if (front && p.ornamentScale > 0.1) {
        ctx.fillStyle = this.hsl((hue + 15) % 360, sat + 20, lit + 20, 0.65);
        ctx.beginPath();
        ctx.moveTo(baseX - eW * 0.3, baseY - eH * 0.12);
        ctx.quadraticCurveTo(baseX - eW * 0.35, baseY - eH * 0.55, tipX, tipY + eH * 0.22);
        ctx.quadraticCurveTo(baseX + eW * 0.35, baseY - eH * 0.55, baseX + eW * 0.3, baseY - eH * 0.12);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },

    // ----------------------------------------------------------
    // Draw glowing orb nodes along the tail
    // ----------------------------------------------------------
    _drawOrbNodes(ctx, p, sc, ox, oy, g) {
      const orbRng = this.makePrng(g.ORN + 888);
      const tX0    = ox + p.bodyLen * sc * 0.82;
      const tY0    = oy - p.bodyH * sc * 0.08;

      for (let i = 0; i < p.glowOrbs; i++) {
        const t  = (i + 1) / (p.glowOrbs + 1);
        // Place orbs along the tail bezier (linear approximation)
        const curl = p.tailCurve;
        const bx = tX0 + (32 + t * 33) * sc;
        const by = tY0 - (t * 55 * curl + (orbRng() - 0.5) * 10) * sc;

        const orbR    = (5 + orbRng() * 5) * sc * p.ornamentScale;
        const orbHue  = (p.orbHue + i * 25) % 360;
        const isPrimary = i % 2 === 0;

        // Outer glow
        const glowGr = this.radGrad(ctx, bx, by, 0, orbR * 2.8,
          [
            [0,   this.hsl(orbHue, 100, 88, 0.7)],
            [0.4, this.hsl(orbHue,  90, 70, 0.35)],
            [1,   this.hsl(orbHue,  80, 55, 0)],
          ]
        );
        ctx.fillStyle = glowGr;
        ctx.globalAlpha = 0.8 * p.ornamentScale;
        ctx.beginPath(); ctx.arc(bx, by, orbR * 2.8, 0, Math.PI * 2); ctx.fill();

        // Orb body
        const orbGr = this.radGrad(ctx, bx - orbR * 0.3, by - orbR * 0.3, 0, orbR,
          [
            [0,   this.hsl(orbHue, 60, 95)],
            [0.5, this.hsl(orbHue, 90, 72)],
            [1,   this.hsl(orbHue, 100, 45)],
          ]
        );
        ctx.globalAlpha = p.ornamentScale;
        ctx.fillStyle   = orbGr;
        ctx.strokeStyle = this.hsl(orbHue, 80, 60, 0.6);
        ctx.lineWidth   = 0.7;
        ctx.beginPath(); ctx.arc(bx, by, orbR, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();

        // Specular
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.globalAlpha = p.ornamentScale * 0.8;
        ctx.beginPath(); ctx.arc(bx - orbR * 0.32, by - orbR * 0.32, orbR * 0.28, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  },
  template: `<canvas ref="canvas" :width="canvasW" :height="canvasH" style="max-width:100%;cursor:pointer;-webkit-tap-highlight-color:transparent;outline:none;user-select:none;" @click="onCanvasClick"></canvas>`
};

// ---- CreatureCardComponent ----
// Compact card used in paginated creature lists (Home and Profile pages).
// prop: post     — { author, permlink, name, genome, age, lifecycleStage, created }
// prop: username — currently logged-in username (empty string if logged out)
const CreatureCardComponent = {
  name: "CreatureCardComponent",
  components: { CreatureCanvasComponent },
  props: {
    post:     { type: Object, required: true },
    username: { type: String, default: "" }
  },
  data() {
    return {
      copied:            false,
      votes:             [],     // fetched on mount
      rebloggers:        [],     // fetched on mount
      resolvedWearing:   null,   // fetched on mount for mini-card canvas
      socialLoading:     true,
      votingInProgress:  false,
      resteemInProgress: false,
      votePickerOpen:    false,
      votePct:           100     // chosen upvote percentage
    };
  },
  mounted() {
    // Fetch vote + reblog counts in the background — non-blocking
    Promise.all([
      fetchVotes(this.post.author, this.post.permlink),
      fetchRebloggers(this.post.author, this.post.permlink)
    ]).then(([v, r]) => {
      this.votes      = v;
      this.rebloggers = r;
    }).catch(() => {}).finally(() => { this.socialLoading = false; });
    this.loadWearing();
  },
  computed: {
    fossil()     { return this.post.age >= this.post.genome.LIF; },
    sexSymbol()  { return this.post.genome.SX === 0 ? "♂" : "♀"; },
    stageColor() { return this.post.lifecycleStage ? this.post.lifecycleStage.color : "#888"; },
    stageLabel() {
      const s = this.post.lifecycleStage;
      return s ? s.icon + " " + s.name : "";
    },
    routePath()  { return "/@" + this.post.author + "/" + this.post.permlink; },
    steemitUrl() { return "https://steemit.com/@" + this.post.author + "/" + this.post.permlink; },
    cardWearing() {
      // Prefer pre-resolved data when available, then async card-local lookup.
      return this.post.wearing || this.resolvedWearing || null;
    },
    hasVoted() {
      if (!this.username) return false;
      return this.votes.some(v => v.voter === this.username && v.percent > 0);
    },
    hasResteemed() {
      if (!this.username) return false;
      return this.rebloggers.includes(this.username);
    },
    provenanceBadge() {
      if (this.post.isPhantom)
        return { icon: "👻", label: "Phantom", color: "#9e9e9e" };
      if (this.post.isDuplicate)
        return { icon: "⚠", label: "Duplicate", color: "#ff8a80" };
      const type       = this.post.type || "founder";
      const hasParents = !!(this.post.parentA || this.post.parentB);
      if (type === "offspring" && hasParents)
        return { icon: this.post.speciated ? "⚡" : "🧬", label: this.post.speciated ? "Speciation" : "Bred", color: "#80deea" };
      if (type === "offspring" && !hasParents)
        return { icon: "⚠", label: "No parents", color: "#ff8a80" };
      // founder — check suspicious genome
      const g = this.post.genome;
      const suspicion = (g.MOR >= 9900 ? 1 : 0) + (g.APP >= 9900 ? 1 : 0) +
                        (g.MUT === 5 ? 1 : 0) + (g.LIF > 159 || g.LIF < 80 ? 1 : 0) +
                        (g.ORN >= 9900 ? 1 : 0);
      if (suspicion >= 3)
        return { icon: "⚠", label: "Unverified", color: "#ffb74d" };
      return { icon: "🌱", label: "Origin", color: "#a5d6a7" };
    }
  },
  methods: {
    async loadWearing() {
      try {
        if (typeof fetchAllReplies !== "function" || typeof fetchCreatureWearing !== "function") return;
        const replies = await fetchAllReplies(this.post.author, this.post.permlink);
        const wearing = await fetchCreatureWearing(this.post.author, this.post.permlink, replies || []);
        // Shirt accessory has been removed from creature rendering.
        this.resolvedWearing = (wearing && wearing.template !== "shirt") ? wearing : null;
      } catch {
        this.resolvedWearing = null;
      }
    },
    toggleVotePicker(e) {
      e.preventDefault(); e.stopPropagation();
      if (!this.username || !window.steem_keychain || this.hasVoted) return;
      this.votePickerOpen = !this.votePickerOpen;
    },
    submitVote(e) {
      e.preventDefault(); e.stopPropagation();
      if (!this.username || !window.steem_keychain) return;
      if (this.hasVoted || this.votingInProgress) return;
      this.votePickerOpen  = false;
      this.votingInProgress = true;
      const weight = Math.round(Math.max(1, Math.min(100, this.votePct))) * 100;
      publishVote(this.username, this.post.author, this.post.permlink, weight, (res) => {
        this.votingInProgress = false;
        if (res.success) {
          this.votes = [...this.votes, {
            voter: this.username, percent: weight, weight: 1,
            rshares: 0, reputation: 0, time: new Date().toISOString()
          }];
        }
      });
    },
    submitResteem(e) {
      e.preventDefault(); e.stopPropagation();
      if (!this.username || !window.steem_keychain) return;
      if (this.hasResteemed || this.resteemInProgress) return;
      this.resteemInProgress = true;
      publishResteem(this.username, this.post.author, this.post.permlink, (res) => {
        this.resteemInProgress = false;
        if (res.success) this.rebloggers = [...this.rebloggers, this.username];
      });
    },
    copyUrl(e) {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.steemitUrl).then(() => {
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 1800);
      }).catch(() => {
        // Fallback for browsers without clipboard API
        const ta = document.createElement("textarea");
        ta.value = this.steemitUrl;
        ta.style.position = "fixed";
        ta.style.opacity  = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 1800);
      });
    }
  },
  template: `
    <router-link :to="routePath" style="text-decoration:none;color:inherit;display:block;">
      <div
        style="background:#111;border:1px solid #222;border-radius:10px;padding:10px;
               text-align:center;cursor:pointer;transition:border-color 0.18s;position:relative;"
        @mouseenter="$event.currentTarget.style.borderColor='#2e7d32'"
        @mouseleave="$event.currentTarget.style.borderColor='#222'"
      >
        <creature-canvas-component
          :genome="post.genome"
          :age="post.age"
          :fossil="fossil"
          :wearing="cardWearing"
          :canvas-w="180"
          :canvas-h="144"
          style="display:block;margin:0 auto;"
        ></creature-canvas-component>

        <!-- Creature name -->
        <div style="font-size:0.82rem;font-weight:bold;color:#a5d6a7;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px;">
          🧬 {{ post.name }}
        </div>

        <!-- Row 1: sex · age · lifecycle  ·  ❤️ count  [↑] -->
        <div style="font-size:0.70rem;margin-top:5px;display:flex;gap:5px;
                    justify-content:center;align-items:center;flex-wrap:wrap;
                    position:relative;" @click.prevent.stop>
          <span style="color:#888;">{{ sexSymbol }}</span>
          <span style="color:#444;">·</span>
          <span style="color:#888;">{{ post.age }}d</span>
          <span style="color:#444;">·</span>
          <span :style="{ color: stageColor }">{{ stageLabel }}</span>
          <span style="color:#444;">·</span>
          <!-- Upvote count -->
          <span v-if="!socialLoading" style="color:#ef9a9a;" title="Upvotes">❤️ {{ votes.length }}</span>
          <span v-else style="color:#333;">❤️ …</span>
          <!-- Upvote button or tick -->
          <template v-if="username">
            <button
              v-if="!hasVoted"
              @click="toggleVotePicker"
              :disabled="votingInProgress"
              title="Upvote this creature"
              style="padding:0 5px;font-size:0.66rem;line-height:1.5;
                     background:#1a0a0a;border:1px solid #4a1a1a;color:#ef9a9a;
                     border-radius:4px;cursor:pointer;"
            >{{ votingInProgress ? "…" : "↑" }}</button>
            <span v-else style="color:#ef5350;font-size:0.66rem;" title="You upvoted this">✓</span>
          </template>
          <!-- % picker popover — anchored to this row -->
          <div
            v-if="votePickerOpen"
            style="position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);
                   background:#111;border:1px solid #3a1a1a;border-radius:8px;
                   padding:10px 12px;min-width:155px;z-index:300;
                   box-shadow:0 4px 18px rgba(0,0,0,0.8);"
          >
            <div @click.stop="votePickerOpen = false"
                 style="position:fixed;inset:0;z-index:-1;"></div>
            <div style="font-size:0.7rem;color:#ef9a9a;font-weight:bold;
                        text-align:center;margin-bottom:7px;">❤️ Vote strength</div>
            <div style="text-align:center;font-size:1rem;font-weight:bold;
                        color:#ef9a9a;margin-bottom:5px;">{{ votePct }}%</div>
            <input type="range" v-model.number="votePct" min="1" max="100" step="1"
                   style="width:100%;accent-color:#ef5350;cursor:pointer;" />
            <div style="display:flex;justify-content:space-between;
                        font-size:0.6rem;color:#444;margin-top:2px;">
              <span>1%</span><span>100%</span>
            </div>
            <button
              @click.stop="submitVote"
              style="margin-top:7px;width:100%;background:#3a0a0a;
                     border:1px solid #6a2020;color:#ef9a9a;font-size:0.75rem;
                     border-radius:5px;padding:4px 0;cursor:pointer;"
            >Confirm {{ votePct }}%</button>
          </div>
        </div>

        <!-- Row 2: @author · provenance badge  ·  🔁 count  [↺] -->
        <div style="font-size:0.65rem;margin-top:3px;display:flex;gap:4px;
                    justify-content:center;align-items:center;flex-wrap:wrap;"
             @click.prevent.stop>
          <span style="color:#3a3a3a;">@{{ post.author }}</span>
          <span :style="{ color: provenanceBadge.color, fontSize:'0.63rem' }">
            {{ provenanceBadge.icon }} {{ provenanceBadge.label }}
          </span>
          <span style="color:#333;">·</span>
          <!-- Resteem count -->
          <span v-if="!socialLoading" style="color:#80cbc4;" title="Resteems">🔁 {{ rebloggers.length }}</span>
          <span v-else style="color:#333;">🔁 …</span>
          <!-- Resteem button or tick -->
          <template v-if="username">
            <button
              v-if="!hasResteemed"
              @click="submitResteem"
              :disabled="resteemInProgress"
              title="Resteem this creature"
              style="padding:0 5px;font-size:0.63rem;line-height:1.5;
                     background:#0a1a1a;border:1px solid #1a3a3a;color:#80cbc4;
                     border-radius:4px;cursor:pointer;"
            >{{ resteemInProgress ? "…" : "↺" }}</button>
            <span v-else style="color:#26c6da;font-size:0.63rem;" title="You resteemed this">✓</span>
          </template>
        </div>
        <button
          @click="copyUrl"
          :style="{
            marginTop: '7px',
            padding: '3px 10px',
            fontSize: '0.68rem',
            background: copied ? '#1b3a1b' : '#1a1a1a',
            color: copied ? '#66bb6a' : '#555',
            border: '1px solid ' + (copied ? '#2e7d32' : '#2a2a2a'),
            borderRadius: '5px',
            cursor: 'pointer',
            transition: 'all 0.2s',
            width: '100%'
          }"
          title="Copy Steemit URL"
        >{{ copied ? "✓ Copied!" : "📋 Copy URL" }}</button>
      </div>
    </router-link>
  `
};

// ---- GenomeTableComponent ----
// Renders the genome key/value pairs in a styled table.
const GenomeTableComponent = {
  name: "GenomeTableComponent",
  props: {
    genome: { type: Object, required: true }
  },
  computed: {
    sexLabel() {
      return this.genome.SX === 0 ? "♂ Male" : "♀ Female";
    },
    rows() {
      const g = this.genome;
      return [
        { key: "Genus",             value: generateGenusName(g.GEN) + " (GEN " + g.GEN + ")" },
        { key: "Sex",               value: this.sexLabel },
        { key: "Morphology",        value: g.MOR },
        { key: "Appendage Seed",    value: g.APP },
        { key: "Ornamentation",     value: g.ORN },
        { key: "Colour (hue°)",     value: g.CLR },
        { key: "Lifespan",          value: g.LIF },
        { key: "Fertility start",   value: g.FRT_START },
        { key: "Fertility end",     value: g.FRT_END },
        { key: "Mutation tendency", value: g.MUT !== undefined ? g.MUT : "—" },
      ];
    }
  },
  template: `
    <table style="margin:12px auto;border-collapse:collapse;font-size:13px;color:#ccc;">
      <tbody>
        <tr v-for="row in rows" :key="row.key">
          <td style="padding:3px 12px;text-align:right;color:#888;">{{ row.key }}</td>
          <td style="padding:3px 12px;text-align:left;color:#eee;font-weight:bold;">{{ row.value }}</td>
        </tr>
      </tbody>
    </table>
  `
};

// ---- GlobalProfileBannerComponent ----
// Compact banner shown on every page.
// Logged in: shows user's own profile + level badge + XP progress.
// Logged out: shows @steembiota's profile as site identity (no level).
const GlobalProfileBannerComponent = {
  name: "GlobalProfileBannerComponent",
  props: {
    profileData: { type: Object, default: null },
    userLevel:   { type: Object, default: null },  // from computeUserLevel()
    isLoggedIn:  { type: Boolean, default: false }
  },
  methods: {
    safeUrl(url) {
      try {
        const u = new URL(url);
        return u.protocol === "https:" ? url : "";
      } catch { return ""; }
    }
  },
  template: `
    <div v-if="profileData" style="position:relative;margin:8px auto 0;max-width:700px;border-radius:10px;overflow:hidden;border:1px solid #2a2a2a;">
      <!-- Cover image -->
      <div :style="{
        height: '72px',
        background: safeUrl(profileData.coverImage)
          ? 'url(' + safeUrl(profileData.coverImage) + ') center/cover no-repeat'
          : 'linear-gradient(135deg, #1a2e1a 0%, #0d1a0d 100%)',
        borderBottom: '1px solid #222'
      }"></div>

      <!-- Avatar + info row -->
      <div style="display:flex;align-items:center;gap:12px;padding:0 16px 10px;background:#161616;">
        <!-- Avatar overlapping cover -->
        <img
          :src="safeUrl(profileData.profileImage) || ''"
          @error="$event.target.style.display='none'"
          style="width:52px;height:52px;border-radius:50%;border:2px solid #2e7d32;background:#222;margin-top:-26px;flex-shrink:0;object-fit:cover;"
        />
        <div style="text-align:left;margin-top:4px;min-width:0;flex:1;">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
            <div style="font-size:0.95rem;font-weight:bold;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              {{ profileData.displayName }}
            </div>
            <!-- Level badge (logged-in only) -->
            <div v-if="isLoggedIn && userLevel" :title="'XP: ' + userLevel.totalXp" style="display:inline-flex;align-items:center;gap:4px;background:#1a2e1a;border:1px solid #2e7d32;border-radius:12px;padding:1px 8px;font-size:0.72rem;white-space:nowrap;cursor:default;">
              <span>{{ userLevel.icon }}</span>
              <span style="color:#a5d6a7;font-weight:bold;">{{ userLevel.rank }}</span>
              <span style="color:#555;">·</span>
              <span style="color:#66bb6a;">{{ userLevel.totalXp }} XP</span>
            </div>
          </div>
          <div style="font-size:0.78rem;color:#66bb6a;">@{{ profileData.username }}</div>
          <div v-if="profileData.about" style="font-size:0.75rem;color:#666;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:400px;">
            {{ profileData.about }}
          </div>
          <!-- XP progress bar toward next rank (logged-in only) -->
          <div v-if="isLoggedIn && userLevel && userLevel.nextRank" style="margin-top:6px;max-width:340px;">
            <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:#555;margin-bottom:3px;">
              <span>→ {{ userLevel.nextRankIcon }} {{ userLevel.nextRank }}</span>
              <span>{{ userLevel.totalXp }} / {{ userLevel.nextRankXp }} XP</span>
            </div>
            <div style="background:#111;border:1px solid #2a2a2a;border-radius:4px;height:5px;overflow:hidden;">
              <div :style="{
                width: Math.round(userLevel.progressToNext * 100) + '%',
                height: '100%',
                background: 'linear-gradient(90deg, #2e7d32, #66bb6a)',
                borderRadius: '4px',
                transition: 'width 0.6s ease'
              }"></div>
            </div>
          </div>
          <!-- Max rank message -->
          <div v-if="isLoggedIn && userLevel && !userLevel.nextRank" style="font-size:0.7rem;color:#66bb6a;margin-top:4px;">
            ✦ Maximum rank achieved
          </div>
          <!-- Activity breakdown tooltip row -->
          <div v-if="isLoggedIn && userLevel" style="font-size:0.68rem;color:#444;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            🌱 {{ userLevel.breakdown.founders }} founders
            &nbsp;·&nbsp; 🐣 {{ userLevel.breakdown.offspring }} offspring
            &nbsp;·&nbsp; 🍃 {{ userLevel.breakdown.feedsGiven }} feeds
            &nbsp;·&nbsp; 🔬 {{ userLevel.breakdown.genera }} genera
            <template v-if="userLevel.breakdown.speciated > 0">&nbsp;·&nbsp; ⚡ {{ userLevel.breakdown.speciated }} speciation{{ userLevel.breakdown.speciated > 1 ? 's' : '' }}</template>
          </div>
        </div>
      </div>
    </div>
  `
};

// ============================================================
// ActivityPanelComponent
// Unified panel for all three creature interactions:
//   Feed  🍃 → Health boost → lifespan + fertility bonuses
//   Play  🎮 → Mood boost   → wider effective fertility window
//   Walk  🦮 → Vitality     → extended effective lifespan
//
// Feed anti-spam: 1 feed per (feeder, UTC-day), 20 total lifetime.
// Play/Walk anti-spam: 1 each per (user, UTC-day), 15 total each.
// ============================================================
const ActivityPanelComponent = {
  name: "ActivityPanelComponent",
  props: {
    username:              String,
    creatureAuthor:        { type: String, default: null },
    creaturePermlink:      { type: String, default: null },
    creatureName:          { type: String, default: null },
    unicodeArt:            { type: String, default: "" },
    // Feed state (passed from CreatureView)
    ctxFeedState:          { type: Object,  default: null },
    ctxFeedEvents:         { type: Object,  default: null },
    ctxAlreadyFed:         { type: Boolean, default: false },
    initialActivityState:  { type: Object,  default: null }
  },
  emits: ["notify", "feed-state-updated", "activity-state-updated"],
  data() {
    return {
      // Feed state
      feedEvents:         this.ctxFeedEvents || null,
      feedState:          this.ctxFeedState  || null,
      alreadyFedToday:    this.ctxAlreadyFed || false,
      foodType:           "nectar",
      publishingFeed:     false,
      // Play / Walk state
      activityState:      this.initialActivityState || null,
      publishingPlay:     false,
      publishingWalk:     false,
      alreadyPlayedToday: this.initialActivityState?.alreadyPlayedToday || false,
      alreadyWalkedToday: this.initialActivityState?.alreadyWalkedToday || false,
    };
  },
  watch: {
    ctxFeedState(val)  { if (val) this.feedState  = val; },
    ctxFeedEvents(val) { if (val) this.feedEvents = val; },
    ctxAlreadyFed(val) { this.alreadyFedToday = val; },
    initialActivityState(val) {
      if (val) {
        this.activityState      = val;
        this.alreadyPlayedToday = val.alreadyPlayedToday || false;
        this.alreadyWalkedToday = val.alreadyWalkedToday || false;
      }
    }
  },
  computed: {
    // ── Feed computed ──
    foodOptions() {
      return [
        { value: "nectar",  label: "🍯 Nectar  — +1 day lifespan" },
        { value: "fruit",   label: "🍎 Fruit   — +10% fertility" },
        { value: "crystal", label: "💎 Crystal — +5% fertility" },
      ];
    },
    healthBarWidth() {
      if (!this.feedState) return "0%";
      return Math.round(this.feedState.healthPct * 100) + "%";
    },
    healthBarColor() {
      if (!this.feedState) return "#444";
      const h = this.feedState.healthPct;
      return h >= 0.80 ? "#66bb6a" : h >= 0.55 ? "#a5d6a7" : h >= 0.30 ? "#ffb74d" : "#888";
    },
    canFeed() {
      return !this.alreadyFedToday &&
             !!this.creatureAuthor &&
             !!this.username &&
             !this.publishingFeed &&
             this.feedEvents &&
             this.feedEvents.total < 20;
    },
    feedButtonLabel() {
      if (this.publishingFeed)   return "Feeding…";
      if (!this.username)        return "Log in to feed";
      if (!this.creatureAuthor)  return "No creature loaded";
      if (this.alreadyFedToday)  return "Already fed today ✓";
      if (this.feedEvents && this.feedEvents.total >= 20) return "Feed cap reached (20/20)";
      return "🍃 Feed this creature";
    },
    // ── Play / Walk computed ──
    canPlay() {
      return !!this.username && !!this.creatureAuthor && !this.publishingPlay &&
             !this.alreadyPlayedToday &&
             (!this.activityState || this.activityState.playTotal < 15);
    },
    canWalk() {
      return !!this.username && !!this.creatureAuthor && !this.publishingWalk &&
             !this.alreadyWalkedToday &&
             (!this.activityState || this.activityState.walkTotal < 15);
    },
    playButtonLabel() {
      if (this.publishingPlay)     return "Playing…";
      if (!this.username)          return "Log in to play";
      if (this.alreadyPlayedToday) return "Played today ✓";
      if (this.activityState && this.activityState.playTotal >= 15) return "Play cap reached (15/15)";
      return "🎮 Play with creature";
    },
    walkButtonLabel() {
      if (this.publishingWalk)     return "Walking…";
      if (!this.username)          return "Log in to walk";
      if (this.alreadyWalkedToday) return "Walked today ✓";
      if (this.activityState && this.activityState.walkTotal >= 15) return "Walk cap reached (15/15)";
      return "🦮 Take for a walk";
    },
    moodBarWidth() {
      if (!this.activityState) return "0%";
      return Math.round(this.activityState.moodPct * 100) + "%";
    },
    vitalityBarWidth() {
      if (!this.activityState) return "0%";
      return Math.round(this.activityState.vitalityPct * 100) + "%";
    }
  },
  methods: {
    // ── Feed ──
    feedCreature() {
      if (!this.canFeed) return;
      if (!window.steem_keychain) { this.$emit("notify", "Steem Keychain is not installed.", "error"); return; }
      this.publishingFeed = true;
      publishFeed(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        this.foodType,
        this.unicodeArt,
        (response) => {
          this.publishingFeed = false;
          if (response.success) {
            const feeder  = this.username;
            const isOwner = feeder === this.creatureAuthor;
            this.feedEvents = {
              ...this.feedEvents,
              total:          this.feedEvents.total + 1,
              ownerFeeds:     isOwner ? this.feedEvents.ownerFeeds + 1 : this.feedEvents.ownerFeeds,
              communityFeeds: isOwner ? this.feedEvents.communityFeeds : this.feedEvents.communityFeeds + 1,
              byFeeder: { ...this.feedEvents.byFeeder, [feeder]: (this.feedEvents.byFeeder[feeder] || 0) + 1 }
            };
            const genomeLIF = this.feedState
              ? Math.round(this.feedState.lifespanBonus / 0.20 + (this.feedState.lifespanBonus > 0 ? 1 : 100))
              : 100;
            this.feedState = computeFeedState(this.feedEvents, { LIF: genomeLIF });
            this.alreadyFedToday = true;
            this.$emit("feed-state-updated", this.feedState);
            const foodLabel = { nectar: "Nectar", fruit: "Fruit", crystal: "Crystal" }[this.foodType] || this.foodType;
            this.$emit("notify", "🍃 Fed " + this.creatureName + " with " + foodLabel + "!", "success");
          } else {
            this.$emit("notify", "Feed failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    // ── Play / Walk optimistic update ──
    _optimisticUpdate(type) {
      const s = this.activityState || {
        playTotal: 0, playOwner: 0, playCommunity: 0,
        walkTotal: 0, walkOwner: 0, walkCommunity: 0,
        moodPct: 0, vitalityPct: 0, moodLabel: null, vitalityLabel: null,
        fertilityExtension: 0, vitalityLifespanBonus: 0
      };
      const OWNER_W = 2, COM_W = 1;
      const isOwner = this.username === this.creatureAuthor;

      let updated;
      if (type === "play") {
        const playTotal = s.playTotal + 1;
        const playOwner = isOwner ? s.playOwner + 1 : s.playOwner;
        const playCommunity = isOwner ? s.playCommunity : s.playCommunity + 1;
        const playScore = playOwner * OWNER_W + playCommunity * COM_W;
        const moodPct = Math.min(playScore / (15 * OWNER_W), 1.0);
        const fertilityExtension = Math.round(moodPct * 10);
        let moodLabel = null;
        if      (moodPct >= 0.80) moodLabel = "Ecstatic";
        else if (moodPct >= 0.55) moodLabel = "Playful";
        else if (moodPct >= 0.30) moodLabel = "Cheerful";
        else if (moodPct >  0.00) moodLabel = "Content";
        updated = { ...s, playTotal, playOwner, playCommunity, moodPct, moodLabel, fertilityExtension,
                    alreadyPlayedToday: true,
                    alreadyWalkedToday: s.alreadyWalkedToday || false };
      } else {
        const walkTotal = s.walkTotal + 1;
        const walkOwner = isOwner ? s.walkOwner + 1 : s.walkOwner;
        const walkCommunity = isOwner ? s.walkCommunity : s.walkCommunity + 1;
        const walkScore = walkOwner * OWNER_W + walkCommunity * COM_W;
        const vitalityPct = Math.min(walkScore / (15 * OWNER_W), 1.0);
        const vitalityLifespanBonus = Math.round(vitalityPct * 10);
        let vitalityLabel = null;
        if      (vitalityPct >= 0.80) vitalityLabel = "Vigorous";
        else if (vitalityPct >= 0.55) vitalityLabel = "Active";
        else if (vitalityPct >= 0.30) vitalityLabel = "Lively";
        else if (vitalityPct >  0.00) vitalityLabel = "Stirring";
        updated = { ...s, walkTotal, walkOwner, walkCommunity, vitalityPct, vitalityLabel, vitalityLifespanBonus,
                    alreadyWalkedToday: true,
                    alreadyPlayedToday: s.alreadyPlayedToday || false };
      }
      this.activityState = updated;
      this.$emit("activity-state-updated", updated);
    },

    playWithCreature() {
      if (!this.canPlay) return;
      if (!window.steem_keychain) { this.$emit("notify", "Steem Keychain is not installed.", "error"); return; }
      this.publishingPlay = true;
      publishPlay(
        this.username, this.creatureAuthor, this.creaturePermlink,
        this.creatureName, this.unicodeArt,
        (response) => {
          this.publishingPlay = false;
          if (response.success) {
            this.alreadyPlayedToday = true;
            this._optimisticUpdate("play");
            this.$emit("notify", "🎮 Played with " + this.creatureName + "! Mood improved.", "success");
          } else {
            this.$emit("notify", "Play failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    walkCreature() {
      if (!this.canWalk) return;
      if (!window.steem_keychain) { this.$emit("notify", "Steem Keychain is not installed.", "error"); return; }
      this.publishingWalk = true;
      publishWalk(
        this.username, this.creatureAuthor, this.creaturePermlink,
        this.creatureName, this.unicodeArt,
        (response) => {
          this.publishingWalk = false;
          if (response.success) {
            this.alreadyWalkedToday = true;
            this._optimisticUpdate("walk");
            this.$emit("notify", "🦮 Took " + this.creatureName + " for a walk! Vitality improved.", "success");
          } else {
            this.$emit("notify", "Walk failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    }
  },

  template: `
    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #333;">
      <h3 style="color:#b39ddb;margin:0 0 12px;">🌿 Activities</h3>

      <!-- Login gate -->
      <div v-if="!username" style="text-align:center;padding:18px 0;color:#555;font-size:13px;">
        🔒 Log in to do activities with this creature.
      </div>

      <template v-else>

        <!-- ── Health bar (feed stats) ── -->
        <div v-if="feedState" style="max-width:320px;margin:0 auto 16px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#888;margin-bottom:4px;">
            <span>🍃 Health <span v-if="feedState.label" style="color:#a5d6a7;">({{ feedState.symbol }} {{ feedState.label }})</span></span>
            <span>{{ feedEvents ? feedEvents.total : 0 }}/20 feeds
              <template v-if="feedState.lifespanBonus > 0">
                · Lifespan +<strong style="color:#66bb6a;">{{ feedState.lifespanBonus }}d</strong>
              </template>
              <template v-if="feedState.fertilityBoost > 0">
                · Fertility +<strong style="color:#f48fb1;">{{ Math.round(feedState.fertilityBoost * 100) }}%</strong>
              </template>
            </span>
          </div>
          <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;height:8px;overflow:hidden;">
            <div :style="{ width: healthBarWidth, height:'100%', background: healthBarColor, borderRadius:'6px', transition:'width 0.4s ease' }"></div>
          </div>
        </div>

        <!-- ── Mood + Vitality bars (activity stats) ── -->
        <div v-if="activityState && (activityState.playTotal > 0 || activityState.walkTotal > 0)"
          style="max-width:320px;margin:0 auto 16px;display:flex;flex-direction:column;gap:10px;">

          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;color:#888;margin-bottom:4px;">
              <span>🎮 Mood <span v-if="activityState.moodLabel" style="color:#ce93d8;">({{ activityState.moodLabel }})</span></span>
              <span>{{ activityState.playTotal }}/15 plays
                <template v-if="activityState.fertilityExtension > 0">
                  · Fertility +<strong style="color:#ce93d8;">{{ activityState.fertilityExtension }}d</strong>
                </template>
              </span>
            </div>
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;height:8px;overflow:hidden;">
              <div :style="{ width: moodBarWidth, height:'100%', background:'#9c27b0', borderRadius:'6px', transition:'width 0.4s ease' }"></div>
            </div>
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;color:#888;margin-bottom:4px;">
              <span>🦮 Vitality <span v-if="activityState.vitalityLabel" style="color:#80cbc4;">({{ activityState.vitalityLabel }})</span></span>
              <span>{{ activityState.walkTotal }}/15 walks
                <template v-if="activityState.vitalityLifespanBonus > 0">
                  · Lifespan +<strong style="color:#80cbc4;">{{ activityState.vitalityLifespanBonus }}d</strong>
                </template>
              </span>
            </div>
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;height:8px;overflow:hidden;">
              <div :style="{ width: vitalityBarWidth, height:'100%', background:'#00897b', borderRadius:'6px', transition:'width 0.4s ease' }"></div>
            </div>
          </div>
        </div>

        <!-- ── Three action cards: Feed · Play · Walk ── -->
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;max-width:640px;margin:0 auto;">

          <!-- Feed card -->
          <div style="flex:1;min-width:180px;background:#0d1f0d;border:1px solid #1b5e20;border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:1.2rem;margin-bottom:4px;">🍃</div>
            <div style="font-size:13px;font-weight:bold;color:#a5d6a7;margin-bottom:4px;">Feed</div>
            <div style="font-size:11px;color:#555;margin-bottom:10px;">Boosts health · lifespan &amp; fertility</div>
            <!-- Food selector -->
            <div style="display:flex;flex-direction:column;gap:5px;text-align:left;margin-bottom:10px;">
              <div v-for="opt in foodOptions" :key="opt.value"
                   style="display:flex;align-items:center;gap:6px;cursor:pointer;"
                   @click="foodType = opt.value">
                <div :style="{
                  width:'12px', height:'12px', borderRadius:'50%', flexShrink:0,
                  border: '2px solid ' + (foodType === opt.value ? '#66bb6a' : '#333'),
                  background: foodType === opt.value ? '#2e7d32' : 'transparent'
                }"></div>
                <span :style="{ fontSize:'11px', color: foodType === opt.value ? '#ccc' : '#666' }">{{ opt.label }}</span>
              </div>
            </div>
            <button
              @click="feedCreature"
              :disabled="!canFeed"
              :style="{
                width:'100%', padding:'7px 0', fontSize:'12px',
                background: canFeed ? '#1b5e20' : '#1a1a1a',
                color: canFeed ? '#c8e6c9' : '#444',
                border: '1px solid ' + (canFeed ? '#2e7d32' : '#2a2a2a'),
                borderRadius:'6px', cursor: canFeed ? 'pointer' : 'default'
              }"
            >{{ feedButtonLabel }}</button>
            <p v-if="alreadyFedToday" style="color:#555;font-size:11px;margin:6px 0 0;">Come back tomorrow!</p>
          </div>

          <!-- Play card -->
          <div style="flex:1;min-width:180px;background:#120a1e;border:1px solid #4a148c;border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:1.2rem;margin-bottom:4px;">🎮</div>
            <div style="font-size:13px;font-weight:bold;color:#ce93d8;margin-bottom:4px;">Play</div>
            <div style="font-size:11px;color:#555;margin-bottom:10px;">Boosts mood · widens fertility window</div>
            <button
              @click="playWithCreature"
              :disabled="!canPlay"
              :style="{
                width:'100%', padding:'7px 0', fontSize:'12px',
                background: canPlay ? '#4a148c' : '#1a1a1a',
                color: canPlay ? '#e1bee7' : '#444',
                border: '1px solid ' + (canPlay ? '#7b1fa2' : '#2a2a2a'),
                borderRadius:'6px', cursor: canPlay ? 'pointer' : 'default'
              }"
            >{{ playButtonLabel }}</button>
            <p v-if="alreadyPlayedToday" style="color:#555;font-size:11px;margin:6px 0 0;">Come back tomorrow!</p>
          </div>

          <!-- Walk card -->
          <div style="flex:1;min-width:180px;background:#071a17;border:1px solid #004d40;border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:1.2rem;margin-bottom:4px;">🦮</div>
            <div style="font-size:13px;font-weight:bold;color:#80cbc4;margin-bottom:4px;">Walk</div>
            <div style="font-size:11px;color:#555;margin-bottom:10px;">Boosts vitality · extends lifespan</div>
            <button
              @click="walkCreature"
              :disabled="!canWalk"
              :style="{
                width:'100%', padding:'7px 0', fontSize:'12px',
                background: canWalk ? '#004d40' : '#1a1a1a',
                color: canWalk ? '#b2dfdb' : '#444',
                border: '1px solid ' + (canWalk ? '#00695c' : '#2a2a2a'),
                borderRadius:'6px', cursor: canWalk ? 'pointer' : 'default'
              }"
            >{{ walkButtonLabel }}</button>
            <p v-if="alreadyWalkedToday" style="color:#555;font-size:11px;margin:6px 0 0;">Come back tomorrow!</p>
          </div>

        </div>
      </template>
    </div>
  `
};

// ============================================================
// BreedingPanelComponent
// Lets users paste two SteemBiota post URLs, loads genomes,
// breeds them client-side (deterministic seeded PRNG + MUT),
// previews the child, then publishes via Steem Keychain.
// ============================================================
const BreedingPanelComponent = {
  name: "BreedingPanelComponent",
  props: {
    username:    String,
    initialUrlA: { type: String, default: "" },
    // When set from CreatureView, locks Parent A to the page's creature.
    // Shape: { url, name, sex }  (sex is "♂ Male" or "♀ Female")
    lockedA:     { type: Object,  default: null }
  },
  emits: ["notify"],
  data() {
    const seedUrl = (this.lockedA?.url) || this.initialUrlA || "";
    return {
      urlA:        seedUrl,
      urlB:        "",
      loading:     false,
      loadError:   "",
      loadStatus:  "",
      genomeA:     null,
      genomeB:     null,
      childGenome: null,
      childName:   null,
      childArt:    null,
      breedInfo:   null,
      publishing:  false,
      customTitle: "",
      _facingRight: false
    };
  },
  watch: {
    // Keep urlA in sync if the locked creature changes (e.g. navigation)
    lockedA(val) { if (val?.url) this.urlA = val.url; }
  },
  computed: {
    sexLabel() {
      if (!this.childGenome) return "";
      return this.childGenome.SX === 0 ? "♂ Male" : "♀ Female";
    },
    parentASex() {
      if (!this.genomeA) return "";
      return this.genomeA.SX === 0 ? "♂ Male" : "♀ Female";
    },
    parentBSex() {
      if (!this.genomeB) return "";
      return this.genomeB.SX === 0 ? "♂ Male" : "♀ Female";
    },
    mutationLabel() {
      if (!this.breedInfo) return "";
      if (this.breedInfo.speciated) return "⚡ Speciation — new genus emerged!";
      if (this.breedInfo.mutated)   return "🧬 Mutation occurred";
      return "✔ Clean inheritance";
    },
    mutationColor() {
      if (!this.breedInfo) return "#888";
      if (this.breedInfo.speciated) return "#ffb74d";
      if (this.breedInfo.mutated)   return "#80deea";
      return "#666";
    }
  },
  methods: {
    async breedCreatures() {
      this.loadError   = "";
      this.loadStatus  = "";
      this.genomeA     = null;
      this.genomeB     = null;
      this.childGenome = null;
      this.childArt    = null;
      this.breedInfo   = null;

      const ua = this.urlA.trim();
      const ub = this.urlB.trim();
      if (!ua || !ub) {
        this.loadError = "Please enter both parent URLs.";
        return;
      }
      if (ua === ub) {
        this.loadError = "Parent A and Parent B must be different posts.";
        return;
      }

      this.loading = true;
      try {
        this.loadStatus = "Loading parent genomes…";
        const [resA, resB] = await Promise.all([
          loadGenomeFromPost(ua),
          loadGenomeFromPost(ub)
        ]);
        // Store parent genomes for sex display before attempting breed
        this.genomeA = resA.genome;
        this.genomeB = resB.genome;

        // ---- Fertility check ----
        const checkFertility = (res, label) => {
          // loadGenomeFromPost already throws for phantoms, but guard here too
          const g   = res.genome;
          const age = res.age;
          if (age >= g.LIF) throw new Error(
            `${label} (${res.author}) is a fossil (age ${age} ≥ lifespan ${g.LIF}). Fossils cannot breed.`
          );
          if (age < g.FRT_START) throw new Error(
            `${label} (${res.author}) is too young to breed (age ${age}, fertile from day ${g.FRT_START}).`
          );
          if (age >= g.FRT_END) throw new Error(
            `${label} (${res.author}) is past breeding age (age ${age}, fertile until day ${g.FRT_END}).`
          );
        };
        checkFertility(resA, "Parent A");
        checkFertility(resB, "Parent B");

        // ---- Breed permit check ----
        // Opt-in model: effective owner always allowed; others need a named active permit.
        // res.effectiveOwner comes from loadGenomeFromPost (transfer-aware).
        const checkPermit = (res, label) => {
          const owner = res.effectiveOwner || res.author;
          if (!isBreedingPermitted(owner, this.username, res.permits)) {
            throw new Error(
              `${label} (@${owner}) requires a breed permit. ` +
              `Only @${owner} or users with an active permit can use this creature. ` +
              `Contact @${owner} to request one.`
            );
          }
        };
        checkPermit(resA, "Parent A");
        checkPermit(resB, "Parent B");

        // ---- Kinship check ----
        this.loadStatus = "Checking ancestry and family relationships…";
        await checkBreedingCompatibility(resA, resB);

        // ---- Breed ----
        this.loadStatus = "";
        const { child, mutated, speciated } = breedGenomes(resA.genome, resB.genome);
        this._facingRight = Math.random() < 0.5;
        this.childGenome = child;
        this.childName   = generateFullName(child);
        this.childArt    = buildUnicodeArt(child, 0, null, this._facingRight, "standing");
        this.customTitle = buildDefaultTitle(this.childName, new Date());
        this.breedInfo   = { mutated, speciated,
          parentA: { author: resA.author, permlink: resA.permlink },
          parentB: { author: resB.author, permlink: resB.permlink }
        };
      } catch (e) {
        this.loadStatus = "";
        this.loadError = e.message || String(e);
      }
      this.loading = false;
    },

    async publishChild() {
      if (!this.username) {
        this.$emit("notify", "Please log in first.", "error");
        return;
      }
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      this.publishing = true;
      publishOffspring(
        this.username,
        this.childGenome,
        this.childArt,
        this.childName,
        this.breedInfo,
        this.customTitle,
        generateGenusName(this.childGenome.GEN),
        (response) => {
          this.publishing = false;
          if (response.success) {
            const childPermlink = response.permlink;

            // Fire birth-announcement replies to both parents (best-effort, non-blocking)
            const art = this.childArt || "";
            const breedMeta = this.breedInfo;
            const cName  = this.childName;
            const cGenome = this.childGenome;
            const poster  = this.username;

            const notifyBirthError = (who) => {
              // Silently swallow — birth reply failure should not alarm the user
              console.warn("Birth reply to " + who + " failed (non-fatal).");
            };

            if (breedMeta.parentA && breedMeta.parentA.author) {
              publishBirthReply(
                breedMeta.parentA.author, breedMeta.parentA.permlink,
                poster, childPermlink, cName, cGenome, art, breedMeta,
                (r) => { if (!r.success) notifyBirthError(breedMeta.parentA.author); }
              );
            }
            if (breedMeta.parentB && breedMeta.parentB.author) {
              publishBirthReply(
                breedMeta.parentB.author, breedMeta.parentB.permlink,
                poster, childPermlink, cName, cGenome, art, breedMeta,
                (r) => { if (!r.success) notifyBirthError(breedMeta.parentB.author); }
              );
            }

            this.$emit("notify", "🧬 " + this.childName + " published to the blockchain!", "success");
            this.$router.push("/@" + this.username + "/" + childPermlink);
          } else {
            this.$emit("notify", "Publish failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    }
  },
  template: `
    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #333;">
      <h3 style="color:#80deea;margin:0 0 4px;">🧬 Breed Creatures</h3>
      <p style="font-size:12px;color:#555;margin:0 0 12px;">Requires one ♂ Male and one ♀ Female of the same genus.</p>

      <!-- Login gate -->
      <div v-if="!username" style="text-align:center;padding:18px 0;color:#555;font-size:13px;">
        🔒 Log in to breed creatures.
      </div>

      <template v-else>
      <div style="display:flex;flex-direction:column;gap:8px;max-width:520px;margin:0 auto;">
        <!-- Parent A — locked to page creature, or free input -->
        <div style="position:relative;">
          <!-- Locked display -->
          <div v-if="lockedA" :style="{
            fontSize:'13px', padding:'8px 10px', borderRadius:'6px',
            background:'#0d1a0d', border:'1px solid #2e7d32',
            color:'#a5d6a7', display:'flex', justifyContent:'space-between', alignItems:'center'
          }">
            <span>🔒 Parent A: <strong>{{ lockedA.name }}</strong></span>
            <span :style="{ fontSize:'12px', fontWeight:'bold', color: lockedA.sex.startsWith('♂') ? '#90caf9' : '#f48fb1' }">
              {{ lockedA.sex }}
            </span>
          </div>
          <!-- Free input -->
          <template v-else>
            <input
              v-model="urlA"
              type="text"
              placeholder="Parent A — Steem post URL"
              style="font-size:13px;width:100%;padding-right:70px;"
            />
            <span
              v-if="genomeA"
              :style="{
                position:'absolute', right:'10px', top:'50%', transform:'translateY(-50%)',
                fontSize:'12px', fontWeight:'bold',
                color: genomeA.SX === 0 ? '#90caf9' : '#f48fb1',
                pointerEvents:'none'
              }"
            >{{ parentASex }}</span>
          </template>
        </div>
        <!-- Parent B -->
        <div style="position:relative;">
          <input
            v-model="urlB"
            type="text"
            placeholder="Parent B — Steem post URL"
            style="font-size:13px;width:100%;padding-right:70px;"
          />
          <span
            v-if="genomeB"
            :style="{
              position:'absolute', right:'10px', top:'50%', transform:'translateY(-50%)',
              fontSize:'12px', fontWeight:'bold',
              color: genomeB.SX === 0 ? '#90caf9' : '#f48fb1',
              pointerEvents:'none'
            }"
          >{{ parentBSex }}</span>
        </div>
        <button
          @click="breedCreatures"
          :disabled="loading"
          style="background:#1a3a2a;"
        >
          {{ loading ? "Checking…" : "🔬 Breed" }}
        </button>
      </div>

      <!-- Status message during kinship check -->
      <div v-if="loadStatus" style="color:#80deea;font-size:12px;margin-top:8px;font-style:italic;">
        ⏳ {{ loadStatus }}
      </div>

      <!-- Error -->
      <div v-if="loadError" style="color:#ff8a80;font-size:13px;margin-top:8px;">
        ⚠ {{ loadError }}
      </div>

      <!-- Child preview -->
      <div v-if="childGenome" style="margin-top:20px;">
        <div style="font-size:1.1rem;font-weight:bold;color:#80deea;">
          🧬 {{ childName }}
        </div>
        <div style="font-size:0.85rem;color:#888;margin:2px 0 6px;">
          {{ sexLabel }}
          &nbsp;·&nbsp;
          <span :style="{ color: mutationColor }">{{ mutationLabel }}</span>
        </div>

        <!-- Unicode art preview -->
        <pre style="font-size:11px;line-height:1.3;display:inline-block;text-align:left;">{{ childArt }}</pre>

        <!-- Genome summary -->
        <div style="font-size:12px;color:#666;margin:4px 0 10px;">
          GEN {{ childGenome.GEN }}
          &nbsp;·&nbsp; MOR {{ childGenome.MOR }}
          &nbsp;·&nbsp; APP {{ childGenome.APP }}
          &nbsp;·&nbsp; ORN {{ childGenome.ORN }}
          &nbsp;·&nbsp; MUT {{ childGenome.MUT }}
          &nbsp;·&nbsp; LIF {{ childGenome.LIF }} days
        </div>

        <!-- Post title — pre-filled, user-editable -->
        <div style="margin-top:12px;max-width:520px;margin-left:auto;margin-right:auto;">
          <label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">Post title</label>
          <input
            v-model="customTitle"
            type="text"
            maxlength="255"
            style="width:100%;font-size:13px;"
          />
        </div>

        <button
          @click="publishChild"
          :disabled="publishing || !username"
          style="background:#1565c0;margin-top:10px;"
        >
          {{ publishing ? "Publishing…" : "📡 Publish Offspring to Steem" }}
        </button>
      </div>
      </template>
    </div>
  `
};

// ============================================================
// BreedPermitPanelComponent
// Shown on the creature page to the creature's owner only.
// Lets the owner grant named breed permits and revoke them.
//
// Props:
//   username         — logged-in user (= owner, gate enforced by parent)
//   creatureAuthor   — owner of the creature
//   creaturePermlink — permlink of the creature post
//   creatureName     — display name
//   currentGrantees  — string[] — current active permit holders
//
// Emits:
//   notify(msg, type)
//   permits-updated(newPermitState)
// ============================================================
const BreedPermitPanelComponent = {
  name: "BreedPermitPanelComponent",
  props: {
    username:         String,
    creatureAuthor:   String,
    creaturePermlink: String,
    creatureName:     String,
    currentGrantees:  { type: Array, default: () => [] }
  },
  emits: ["notify", "permits-updated"],
  data() {
    return {
      expanded:     false,
      granteeInput: "",
      expiresDays:  0,
      publishing:   false
    };
  },
  computed: {
    hasGrantees() { return this.currentGrantees.length > 0; }
  },
  methods: {
    async grantPermit() {
      const grantee = this.granteeInput.trim().toLowerCase();
      if (!grantee) {
        this.$emit("notify", "Please enter a username to grant a permit to.", "error");
        return;
      }
      if (grantee === this.username) {
        this.$emit("notify", "You already have implicit permission as the owner.", "error");
        return;
      }
      if (this.currentGrantees.includes(grantee)) {
        this.$emit("notify", `@${grantee} already has an active permit.`, "error");
        return;
      }
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      this.publishing = true;
      publishBreedPermit(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        grantee,
        Number(this.expiresDays) || 0,
        (response) => {
          this.publishing = false;
          if (response.success) {
            this.$emit("notify", `🔑 Breed permit granted to @${grantee}.`, "success");
            this.granteeInput = "";
            this.expiresDays  = 0;
            // Optimistically update the permit state so the UI refreshes immediately
            const updated = {
              grantees: new Set([...this.currentGrantees, grantee])
            };
            this.$emit("permits-updated", updated);
          } else {
            this.$emit("notify", "Permit failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    async revokePermit(grantee) {
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      this.publishing = true;
      publishBreedRevoke(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        grantee,
        (response) => {
          this.publishing = false;
          if (response.success) {
            this.$emit("notify", `🚫 Permit revoked for @${grantee}.`, "success");
            // Optimistically remove from permit state
            const newSet = new Set(this.currentGrantees);
            newSet.delete(grantee);
            this.$emit("permits-updated", { grantees: newSet });
          } else {
            this.$emit("notify", "Revoke failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    }
  },

  template: `
    <div style="margin-top:24px;max-width:520px;margin-left:auto;margin-right:auto;">

      <!-- Collapsed header --
           Shows a summary line; clicking expands the manager. -->
      <div
        @click="expanded = !expanded"
        style="display:flex;align-items:center;justify-content:space-between;
               cursor:pointer;padding:10px 14px;border-radius:8px;
               background:#0a0f0a;border:1px solid #1a2e1a;user-select:none;"
      >
        <span style="font-size:0.88rem;color:#66bb6a;font-weight:bold;">
          🔑 Breed Permits
          <span style="font-weight:normal;color:#555;font-size:0.80rem;margin-left:8px;">
            {{ hasGrantees ? currentGrantees.length + ' active' : 'none granted' }}
          </span>
        </span>
        <span style="color:#444;font-size:0.78rem;">{{ expanded ? '▲ collapse' : '▼ manage' }}</span>
      </div>

      <div v-if="expanded" style="
        border:1px solid #1a2e1a;border-top:none;border-radius:0 0 8px 8px;
        background:#080d08;padding:14px;
      ">
        <p style="font-size:0.78rem;color:#555;margin:0 0 12px;line-height:1.5;">
          This creature is <strong style="color:#888;">closed to external breeding by default.</strong>
          Grant a named permit to let another user use it as a parent.
          Permits are recorded permanently on-chain; revocations are also on-chain.
        </p>

        <!-- Active grantees list -->
        <div v-if="hasGrantees" style="margin-bottom:14px;">
          <div style="font-size:0.75rem;color:#66bb6a;text-transform:uppercase;
                      letter-spacing:0.07em;margin-bottom:6px;">Active Permits</div>
          <div
            v-for="g in currentGrantees"
            :key="g"
            style="display:flex;align-items:center;justify-content:space-between;
                   padding:6px 10px;border-radius:6px;background:#0d1a0d;
                   border:1px solid #1a2e1a;margin-bottom:5px;"
          >
            <span style="font-size:0.83rem;color:#a5d6a7;">@{{ g }}</span>
            <button
              @click="revokePermit(g)"
              :disabled="publishing"
              style="background:#1a0000;color:#ff8a80;border:1px solid #3b0000;
                     font-size:0.72rem;padding:3px 10px;border-radius:4px;"
            >
              Revoke
            </button>
          </div>
        </div>
        <div v-else style="font-size:0.78rem;color:#333;margin-bottom:14px;">
          No permits granted yet.
        </div>

        <!-- Grant new permit -->
        <div style="font-size:0.75rem;color:#66bb6a;text-transform:uppercase;
                    letter-spacing:0.07em;margin-bottom:8px;">Grant New Permit</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <input
            v-model="granteeInput"
            type="text"
            placeholder="Steem username (without @)"
            style="font-size:13px;width:100%;"
            @keydown.enter="grantPermit"
          />
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <label style="font-size:0.78rem;color:#666;white-space:nowrap;">
              Expires in
            </label>
            <input
              v-model.number="expiresDays"
              type="number"
              min="0"
              step="1"
              placeholder="days"
              style="font-size:13px;width:80px;text-align:center;"
            />
            <span style="font-size:0.78rem;color:#444;">
              days &nbsp;(0 = no expiry)
            </span>
          </div>
          <button
            @click="grantPermit"
            :disabled="publishing || !granteeInput.trim()"
            style="background:#1a3a1a;"
          >
            {{ publishing ? "Publishing…" : "🔑 Grant Permit" }}
          </button>
        </div>

      </div>
    </div>
  `
};

// ============================================================
// TransferPanelComponent
// Shown on the creature page for TWO audiences:
//   A) The effective owner — can send an offer or cancel a pending one.
//   B) The pending recipient — can accept or ignore (ignore = do nothing).
//
// Props:
//   username           — logged-in user
//   creatureAuthor     — original post.author (needed for reply targeting)
//   creaturePermlink   — creature post permlink
//   creatureName       — display name
//   transferState      — result of parseOwnershipChain()
//   isOwner            — boolean (current effective owner)
//   isPendingRecipient — boolean (named in the pending offer)
//
// Emits:
//   notify(msg, type)
//   transfer-updated(newTransferState)  — optimistic state update
// ============================================================
const TransferPanelComponent = {
  name: "TransferPanelComponent",
  props: {
    username:           String,
    creatureAuthor:     String,
    creaturePermlink:   String,
    creatureName:       String,
    transferState:      { type: Object, default: null },
    isOwner:            { type: Boolean, default: false },
    isPendingRecipient: { type: Boolean, default: false }
  },
  emits: ["notify", "transfer-updated"],
  data() {
    return {
      expanded:    false,
      recipientInput: "",
      publishing:  false
    };
  },
  computed: {
    pendingOffer()    { return this.transferState?.pendingOffer || null; },
    transferHistory() { return this.transferState?.transferHistory || []; },
    hasHistory()      { return this.transferHistory.length > 0; }
  },
  methods: {
    async sendOffer() {
      const to = this.recipientInput.trim().toLowerCase();
      if (!to) {
        this.$emit("notify", "Please enter a recipient username.", "error");
        return;
      }
      if (to === this.username) {
        this.$emit("notify", "You cannot transfer to yourself.", "error");
        return;
      }
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      this.publishing = true;
      publishTransferOffer(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        to,
        (response) => {
          this.publishing = false;
          if (response.success) {
            this.$emit("notify", `🤝 Transfer offer sent to @${to}. Waiting for acceptance.`, "success");
            this.recipientInput = "";
            // Optimistic update — build a synthetic pending offer
            const syntheticState = {
              ...(this.transferState || {}),
              effectiveOwner:  this.username,
              pendingOffer:    { to, offerPermlink: response.permlink || "pending", ts: new Date() },
              permitsValidFrom: this.transferState?.permitsValidFrom || null,
              transferHistory: this.transferHistory
            };
            this.$emit("transfer-updated", syntheticState);
          } else {
            this.$emit("notify", "Offer failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    async cancelOffer() {
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      this.publishing = true;
      publishTransferCancel(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        (response) => {
          this.publishing = false;
          if (response.success) {
            this.$emit("notify", "❌ Transfer offer cancelled.", "success");
            const syntheticState = {
              ...(this.transferState || {}),
              effectiveOwner:  this.username,
              pendingOffer:    null,
              permitsValidFrom: this.transferState?.permitsValidFrom || null,
              transferHistory: this.transferHistory
            };
            this.$emit("transfer-updated", syntheticState);
          } else {
            this.$emit("notify", "Cancel failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    async acceptOffer() {
      if (!this.pendingOffer) return;
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      this.publishing = true;
      publishTransferAccept(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        this.pendingOffer.offerPermlink,
        (response) => {
          this.publishing = false;
          if (response.success) {
            this.$emit("notify", `✅ You are now the owner of ${this.creatureName}!`, "success");
            const now = new Date();
            const syntheticState = {
              effectiveOwner:  this.username,
              pendingOffer:    null,
              permitsValidFrom: now,
              transferHistory: [
                ...this.transferHistory,
                { from: this.pendingOffer.offeredBy || "previous owner", to: this.username, ts: now }
              ]
            };
            this.$emit("transfer-updated", syntheticState);
          } else {
            this.$emit("notify", "Accept failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    formatDate(ts) {
      if (!ts) return "?";
      return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
  },

  template: `
    <div style="margin-top:24px;max-width:520px;margin-left:auto;margin-right:auto;">

      <!-- ===== RECIPIENT VIEW: pending offer awaiting acceptance ===== -->
      <div v-if="isPendingRecipient && pendingOffer" style="
        padding:16px 18px;border-radius:10px;
        background:#0d1a0d;border:1px solid #2e7d32;
      ">
        <div style="font-size:1rem;font-weight:bold;color:#a5d6a7;margin-bottom:8px;">
          🤝 Ownership Transfer Offer
        </div>
        <p style="font-size:0.83rem;color:#888;margin:0 0 14px;line-height:1.5;">
          @{{ pendingOffer.offeredBy || "The current owner" }} is offering to transfer
          <strong style="color:#eee;">{{ creatureName }}</strong> to you.
          Accepting is permanent and recorded on-chain.
          All previous breed permits will be voided — you start fresh.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
          <button
            @click="acceptOffer"
            :disabled="publishing"
            style="background:#1a3a1a;"
          >
            {{ publishing ? "Publishing…" : "✅ Accept Ownership" }}
          </button>
          <button
            @click="$emit('notify', 'To decline, simply ignore the offer. The sender can cancel it at any time.', 'info')"
            style="background:#1a1a1a;color:#888;border:1px solid #333;"
          >
            ℹ️ How to decline
          </button>
        </div>
      </div>

      <!-- ===== OWNER VIEW ===== -->
      <template v-if="isOwner">

        <!-- Collapsed header -->
        <div
          @click="expanded = !expanded"
          style="display:flex;align-items:center;justify-content:space-between;
                 cursor:pointer;padding:10px 14px;border-radius:8px;
                 background:#0a0a12;border:1px solid #1a1a2e;user-select:none;"
        >
          <span style="font-size:0.88rem;color:#80cbc4;font-weight:bold;">
            🤝 Transfer Ownership
            <span v-if="pendingOffer" style="font-weight:normal;color:#ffb74d;font-size:0.80rem;margin-left:8px;">
              ⏳ offer pending → @{{ pendingOffer.to }}
            </span>
            <span v-else-if="hasHistory" style="font-weight:normal;color:#555;font-size:0.80rem;margin-left:8px;">
              {{ transferHistory.length }} transfer{{ transferHistory.length === 1 ? "" : "s" }} on record
            </span>
            <span v-else style="font-weight:normal;color:#555;font-size:0.80rem;margin-left:8px;">
              original owner
            </span>
          </span>
          <span style="color:#444;font-size:0.78rem;">{{ expanded ? "▲ collapse" : "▼ manage" }}</span>
        </div>

        <div v-if="expanded" style="
          border:1px solid #1a1a2e;border-top:none;border-radius:0 0 8px 8px;
          background:#08080f;padding:14px;
        ">
          <p style="font-size:0.78rem;color:#555;margin:0 0 12px;line-height:1.5;">
            Transfers are two-sided: you send an offer, the recipient must accept on-chain.
            All breed permits are voided on transfer — the new owner starts fresh.
            The original <code style="color:#444;">post.author</code> never changes on-chain;
            SteemBiota derives the effective owner from the signed reply history.
    <br/>
  <strong style="color:#ff8a80;">⚠ Note: Worn accessories do not travel with the creature.</strong> 
  They will be automatically unequipped and remain in your inventory.          
          </p>

          <!-- Pending offer status -->
          <div v-if="pendingOffer" style="
            padding:12px;border-radius:8px;background:#1a1200;
            border:1px solid #3a2800;margin-bottom:14px;
          ">
            <div style="font-size:0.80rem;color:#ffb74d;font-weight:bold;margin-bottom:6px;">
              ⏳ Pending offer → @{{ pendingOffer.to }}
            </div>
            <p style="font-size:0.75rem;color:#888;margin:0 0 10px;">
              Waiting for @{{ pendingOffer.to }} to accept on-chain.
              You can cancel this offer at any time.
            </p>
            <button
              @click="cancelOffer"
              :disabled="publishing"
              style="background:#1a0000;color:#ff8a80;border:1px solid #3b0000;font-size:0.78rem;"
            >
              {{ publishing ? "Publishing…" : "❌ Cancel Offer" }}
            </button>
          </div>

          <!-- New offer form — only shown when no offer is pending -->
          <template v-else>
            <div style="font-size:0.75rem;color:#80cbc4;text-transform:uppercase;
                        letter-spacing:0.07em;margin-bottom:8px;">Send Transfer Offer</div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              <input
                v-model="recipientInput"
                type="text"
                placeholder="Recipient username (without @)"
                style="font-size:13px;width:100%;"
                @keydown.enter="sendOffer"
              />
              <p style="font-size:0.72rem;color:#444;margin:0;">
                ⚠ This cannot be undone unless the recipient declines (never accepts).
                The offer stays open until they accept or you cancel it.
              </p>
              <button
                @click="sendOffer"
                :disabled="publishing || !recipientInput.trim()"
                style="background:#0d1a2e;"
              >
                {{ publishing ? "Publishing…" : "🤝 Send Offer" }}
              </button>
            </div>
          </template>

          <!-- Transfer history -->
          <template v-if="hasHistory">
            <div style="font-size:0.75rem;color:#80cbc4;text-transform:uppercase;
                        letter-spacing:0.07em;margin:14px 0 8px;">Transfer History</div>
            <div
              v-for="(t, i) in transferHistory"
              :key="i"
              style="font-size:0.75rem;color:#555;padding:5px 0;
                     border-bottom:1px solid #111;display:flex;gap:8px;align-items:center;"
            >
              <span style="color:#3a3a3a;">{{ formatDate(t.ts) }}</span>
              <span style="color:#444;">@{{ t.from }}</span>
              <span style="color:#2a2a2a;">→</span>
              <span style="color:#80cbc4;">@{{ t.to }}</span>
            </div>
          </template>

        </div>
      </template>

    </div>
  `
};

// ============================================================
// SocialPanelComponent
// Displays standard Steem social interactions on a creature page:
//   ❤️  Upvotes  — vote count + top voter avatars/names
//   🔁  Resteems — resteem count + resteeming users
//   💬  Comments — non-SteemBiota reply thread, read + write
//
// Sits below the Activities panel, above the Unicode render section.
//
// Props:
//   username        — logged-in user (or "" if not logged in)
//   creatureAuthor  — post author
//   creaturePermlink — post permlink
//   votes           — Array<{ voter, percent, weight }> from fetchVotes()
//   rebloggers      — Array<string> usernames from fetchRebloggers()
//   socialComments  — Array<reply> non-game top-level replies
//   socialLoading   — boolean
//
// Emits:
//   notify(msg, type)
//   comment-posted(replyObject)  — optimistic add
// ============================================================
const SocialPanelComponent = {
  name: "SocialPanelComponent",
  props: {
    username:         { type: String,  default: "" },
    creatureAuthor:   { type: String,  required: true },
    creaturePermlink: { type: String,  required: true },
    votes:            { type: Array,   default: () => [] },
    rebloggers:       { type: Array,   default: () => [] },
    socialComments:   { type: Array,   default: () => [] },
    socialLoading:    { type: Boolean, default: false }
  },
  emits: ["notify", "comment-posted"],
  data() {
    return {
      commentsExpanded: true,   // comments open by default
      commentText:      "",
      submitting:       false
    };
  },
  computed: {
    commentCount() { return this.socialComments.length; }
  },
  methods: {
    timeAgo(ts) {
      const diff = (Date.now() - new Date(ts)) / 1000;
      if (diff < 60)    return Math.round(diff) + "s";
      if (diff < 3600)  return Math.round(diff / 60) + "m";
      if (diff < 86400) return Math.round(diff / 3600) + "h";
      return Math.round(diff / 86400) + "d";
    },
    formatBody(body) {
      // Strip markdown image syntax and truncate for display
      return (body || "")
        .replace(/!\[.*?\]\(.*?\)/g, "[image]")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[#*_`>]/g, "")
        .trim()
        .slice(0, 500) + (body && body.length > 500 ? "…" : "");
    },
    profileUrl(user) {
      return `/#/@${user}`;
    },
    async submitComment() {
      const body = this.commentText.trim();
      if (!body) return;
      if (!this.username) {
        this.$emit("notify", "Please log in to comment.", "error");
        return;
      }
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }
      if (body.length < 2) {
        this.$emit("notify", "Comment is too short.", "error");
        return;
      }
      this.submitting = true;
      publishComment(
        this.username,
        body,
        this.creatureAuthor,
        this.creaturePermlink,
        (res) => {
          this.submitting = false;
          if (res.success) {
            // Build an optimistic reply object matching Steem reply shape
            const optimistic = {
              author:           this.username,
              permlink:         res.permlink || "pending",
              body:             body,
              created:          new Date().toISOString().replace("T", " ").slice(0, 19),
              parent_author:    this.creatureAuthor,
              parent_permlink:  this.creaturePermlink,
              json_metadata:    "{}"
            };
            this.commentText = "";
            this.$emit("comment-posted", optimistic);
            this.$emit("notify", "💬 Comment published!", "success");
          } else {
            this.$emit("notify", "Comment failed: " + (res.message || "Unknown error"), "error");
          }
        }
      );
    }
  },

  template: `
    <div style="margin-top:24px;max-width:580px;margin-left:auto;margin-right:auto;">

      <!-- ===== LOADING ===== -->
      <div v-if="socialLoading" style="text-align:center;padding:12px 0;">
        <span style="font-size:0.78rem;color:#444;">Loading social data…</span>
      </div>

      <template v-else>

        <!-- ===== COMMENTS ===== -->
        <div>
          <div
            @click="commentsExpanded = !commentsExpanded"
            style="display:flex;align-items:center;justify-content:space-between;
                   cursor:pointer;padding:9px 14px;border-radius:8px;
                   background:#0a0a0a;border:1px solid #1e1e1e;user-select:none;"
          >
            <span style="font-size:0.85rem;color:#a5d6a7;">
              💬 <strong>{{ commentCount }}</strong>
              Comment{{ commentCount === 1 ? "" : "s" }}
            </span>
            <span style="font-size:0.72rem;color:#333;">{{ commentsExpanded ? "▲" : "▼" }}</span>
          </div>

          <div v-if="commentsExpanded" style="
            border:1px solid #1e1e1e;border-top:none;border-radius:0 0 8px 8px;
            background:#080808;padding:14px;
          ">

            <!-- Comment compose box -->
            <div v-if="username" style="margin-bottom:14px;">
              <textarea
                v-model="commentText"
                placeholder="Write a comment…"
                rows="3"
                style="width:100%;font-size:13px;background:#0f0f0f;color:#ccc;
                       border:1px solid #2a2a2a;border-radius:6px;padding:8px;
                       resize:vertical;font-family:inherit;box-sizing:border-box;"
                @keydown.ctrl.enter="submitComment"
              ></textarea>
              <div style="display:flex;justify-content:flex-end;align-items:center;
                           gap:10px;margin-top:6px;">
                <span style="font-size:0.68rem;color:#333;">Ctrl+Enter to post</span>
                <button
                  @click="submitComment"
                  :disabled="submitting || !commentText.trim()"
                  style="background:#1a2a1a;font-size:0.8rem;padding:5px 14px;"
                >{{ submitting ? "Publishing…" : "Post" }}</button>
              </div>
            </div>
            <div v-else style="font-size:0.78rem;color:#444;margin-bottom:12px;">
              Log in to leave a comment.
            </div>

            <!-- Comments list -->
            <div v-if="commentCount === 0 && !username" style="font-size:0.78rem;color:#333;">
              No comments yet. Be the first!
            </div>
            <div v-else-if="commentCount === 0" style="font-size:0.78rem;color:#333;">
              No comments yet.
            </div>

            <div
              v-for="(c, i) in socialComments"
              :key="c.permlink || i"
              style="padding:10px 0;border-bottom:1px solid #111;"
            >
              <!-- Author row -->
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
                <a
                  :href="profileUrl(c.author)"
                  style="font-size:0.82rem;font-weight:bold;color:#80cbc4;text-decoration:none;"
                >@{{ c.author }}</a>
                <span style="font-size:0.68rem;color:#333;">{{ timeAgo(c.created) }} ago</span>
              </div>
              <!-- Body -->
              <div style="font-size:0.82rem;color:#aaa;line-height:1.5;white-space:pre-wrap;word-break:break-word;">
                {{ formatBody(c.body) }}
              </div>
            </div>

          </div>
        </div>

      </template>
    </div>
  `
};

// ============================================================
// EquipPanelComponent
//
// Shown on the CreatureView. Lets the creature owner equip and
// remove accessories that they have permission to wear.
//
// Lists currently worn accessories with a "Remove" button on each.
// Provides an "Equip Accessory" form where the owner pastes an
// accessory URL — the system fetches the accessory, verifies the
// owner has permission (public domain or per-user grant), checks
// it isn't already worn by another creature, then posts wear_on.
//
// Props:
//   username        — logged-in user (or "")
//   creatureAuthor  — creature post author
//   creaturePermlink— creature post permlink
//   creatureName    — display name
//   wearings        — Array from fetchCreatureWearings()
//                     [{ template, genome, accAuthor, accPermlink, accName, permissionLapsed }]
//   isOwner         — true when username is the creature's effective owner
//
// Emits:
//   notify(msg, type)
//   wearings-updated(newWearings)
// ============================================================
const EquipPanelComponent = {
  name: "EquipPanelComponent",
  props: {
    username:         { type: String, default: "" },
    creatureAuthor:   { type: String, required: true },
    creaturePermlink: { type: String, required: true },
    creatureName:     { type: String, default: "" },
    wearings:         { type: Array,  default: () => [] },
    isOwner:          { type: Boolean, default: false },
  },
  emits: ["notify", "wearings-updated"],

  data() {
    return {
      expanded: false,

      // URL equip
      accUrlInput:   "",
      checkingUrl:   false,
      previewAcc:    null,
      previewError:  "",

      // Wardrobe
      loadingWardrobe: false,
      wardrobe: [],

      // Shared
      publishing: false,
    };
  },

  computed: {
    hasWearings() { return this.wearings.length > 0; },
    lapsingWearings() { return this.wearings.filter(w => w.permissionLapsed); },
  },

  watch: {
    accUrlInput() {
      this.previewAcc   = null;
      this.previewError = "";
    }
  },

  methods: {
    /* ─────────────────────────────
       Wardrobe Logic
    ───────────────────────────── */
    async openPicker() {
      this.expanded = !this.expanded;
      if (this.expanded && this.wardrobe.length === 0) {
        await this.refreshWardrobe();
      }
    },

    async refreshWardrobe() {
      this.loadingWardrobe = true;
      try {
        const owned = await fetchAccessoriesOwnedBy(this.username);

        const wardrobeWithStatus = await Promise.all(
          owned.map(async (acc) => {
            const busyWith = await findCreatureWearingAccessory(
              this.username, acc.author, acc.permlink
            );

            const isWornHere = this.wearings.some(
              w => w.accPermlink === acc.permlink
            );

            return { ...acc, busyWith: isWornHere ? null : busyWith };
          })
        );

        this.wardrobe = wardrobeWithStatus;
      } catch (e) {
        this.$emit("notify", "Failed to load wardrobe.", "error");
      }
      this.loadingWardrobe = false;
    },

    async equipItem(acc) {
      if (acc.busyWith) return;

      this.publishing = true;

      publishWearOn(
        this.username,
        this.creatureAuthor, this.creaturePermlink, this.creatureName,
        acc.author, acc.permlink, acc.name,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", `✨ Equipped ${acc.name}!`, "success");

            const newWearing = {
              ...acc,
              accAuthor: acc.author,
              accPermlink: acc.permlink,
              accName: acc.name,
              permissionLapsed: false
            };

            this.$emit("wearings-updated", [
              newWearing,
              ...this.wearings
            ]);

            this.refreshWardrobe();
          } else {
            this.$emit("notify", "Equip failed.", "error");
          }
        }
      );
    },

    /* ─────────────────────────────
       URL Equip Logic
    ───────────────────────────── */
    parseAccUrl(raw) {
      const m = raw.trim().match(/@([a-z0-9.-]+)\/([a-z0-9-]+)\s*$/i);
      if (!m) throw new Error("Cannot parse accessory URL");
      return {
        author: m[1].toLowerCase(),
        permlink: m[2].toLowerCase()
      };
    },

    async checkAccessory() {
      if (!this.accUrlInput.trim()) return;

      this.previewAcc   = null;
      this.previewError = "";
      this.checkingUrl  = true;

      try {
        const { author, permlink } = this.parseAccUrl(this.accUrlInput);

        const post = await fetchPost(author, permlink);
        if (!post || !post.author) throw new Error("Accessory post not found.");

        let meta = {};
        try { meta = JSON.parse(post.json_metadata || "{}"); } catch {}

        if (meta.steembiota?.type !== "accessory")
          throw new Error("This post is not a SteemBiota accessory.");

        const accData = meta.steembiota.accessory;

        const accReplies = await fetchAllReplies(author, permlink);
        const perms = parseAccessoryPermissions(accReplies, author);

        if (!isWearPermitted(perms, this.username)) {
          throw new Error("You don't have permission to wear this.");
        }

        const busyCreature = await findCreatureWearingAccessory(
          this.username, author, permlink
        );

        if (busyCreature) {
          throw new Error(
            `Already worn by ${busyCreature}. Remove it there first.`
          );
        }

        this.previewAcc = {
          template:    accData.template || "hat",
          genome:      accData.genome,
          accName:     accData.name || author,
          accAuthor:   author,
          accPermlink: permlink,
        };

      } catch (e) {
        this.previewError = e.message || "Failed to load accessory.";
      }

      this.checkingUrl = false;
    },

    async equipAccessory() {
      if (!this.previewAcc || !window.steem_keychain) return;

      this.publishing = true;

      const { accAuthor, accPermlink, accName } = this.previewAcc;

      publishWearOn(
        this.username,
        this.creatureAuthor, this.creaturePermlink, this.creatureName,
        accAuthor, accPermlink, accName,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", `🧢 ${accName} equipped!`, "success");

            const newWearing = {
              ...this.previewAcc,
              permissionLapsed: false
            };

            this.$emit("wearings-updated", [
              newWearing,
              ...this.wearings
            ]);

            this.accUrlInput  = "";
            this.previewAcc   = null;
            this.previewError = "";
          } else {
            this.$emit("notify",
              "Equip failed: " + (res.message || "Unknown error"),
              "error"
            );
          }
        }
      );
    },

    /* ─────────────────────────────
       Remove
    ───────────────────────────── */
    async removeAccessory(w) {
      if (!window.steem_keychain) return;

      this.publishing = true;

      publishWearOff(
        this.username,
        this.creatureAuthor, this.creaturePermlink, this.creatureName,
        w.accAuthor, w.accPermlink, w.accName,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", `👚 ${w.accName} removed.`, "success");

            this.$emit("wearings-updated",
              this.wearings.filter(x =>
                x.accPermlink !== w.accPermlink ||
                x.accAuthor !== w.accAuthor
              )
            );
          } else {
            this.$emit("notify",
              "Remove failed: " + (res.message || "Unknown error"),
              "error"
            );
          }
        }
      );
    },
  },

  template: `
  <div style="max-width:520px;margin:16px auto;">

    <!-- Worn list (unchanged) -->
    <div v-if="hasWearings" style="margin-bottom:12px;">
      <!-- (same as your existing worn UI) -->
    </div>

    <!-- Equip Panel -->
    <template v-if="isOwner && username">

      <!-- Toggle -->
      <div @click="expanded=!expanded"
        style="display:flex;justify-content:space-between;cursor:pointer;
               padding:9px 14px;border-radius:8px;
               background:#0a0a12;border:1px solid #1a1a2e;">
        <span style="color:#ce93d8;font-weight:bold;">
          🧢 Equip an Accessory
        </span>
        <span>{{ expanded ? "▲" : "▼" }}</span>
      </div>

      <div v-if="expanded"
        style="border:1px solid #1a1a2e;border-top:none;padding:14px;background:#08080f;">

        <!-- URL input -->
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <input v-model="accUrlInput" @keydown.enter="checkAccessory"
            placeholder="Paste accessory URL..." style="flex:1;" />
          <button @click="checkAccessory">
            {{ checkingUrl ? "Checking…" : "Check" }}
          </button>
        </div>

        <!-- Preview -->
        <div v-if="previewAcc">
          <div>{{ previewAcc.accName }}</div>
          <button @click="equipAccessory">
            {{ publishing ? "Publishing…" : "🧢 Equip" }}
          </button>
        </div>

        <!-- Wardrobe -->
        <div style="margin-top:14px;">
          <div @click="openPicker"
            style="cursor:pointer;color:#ce93d8;">
            🎩 Open Wardrobe {{ expanded ? "▲" : "▼" }}
          </div>

          <div v-if="loadingWardrobe">Loading...</div>

          <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,100px);gap:8px;">
            <div v-for="acc in wardrobe" :key="acc.permlink"
              @click="equipItem(acc)"
              :style="{opacity: acc.busyWith ? 0.4 : 1}">
              <div>{{ acc.name }}</div>
              <div v-if="acc.busyWith">Busy</div>
            </div>
          </div>
        </div>

      </div>
    </template>

  </div>
  `
};
