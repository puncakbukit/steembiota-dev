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
    notifClass() {
      return ["notification", this.type];
    },
    icon() {
      if (this.type === "success") return "✅";
      if (this.type === "info")    return "ℹ️";
      return "⚠️";
    }
  },
  template: `
    <div v-if="message" :class="notifClass" role="alert" aria-live="polite" aria-atomic="true">
      <span>{{ icon }} {{ message }}</span>
      <button
        @click="$emit('dismiss')"
        class="sb-notif-dismiss"
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
    <div class="sb-auth-row">
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
        <button @click="$emit('close')" class="sb-btn-cancel">Cancel</button>
        <div v-if="loginError" class="sb-login-error">
          {{ loginError }}
        </div>
      </template>
      <template v-else>
        <span class="sb-login-info">Logged in as <strong>@{{ username }}</strong></span>
        <button @click="$emit('logout')" class="sb-btn-logout-inline">Logout</button>
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
    <div class="sb-spinner-wrap">
      <div class="sb-spinner"></div>
      <p class="sb-spinner-msg">{{ message }}</p>
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
      <div
        class="sb-profile-cover"
        :style="safeUrl(profileData.coverImage) ? { backgroundImage: 'url(' + safeUrl(profileData.coverImage) + ')' } : {}"
      ></div>
      <div class="sb-profile-avatar-row">
        <img
          :src="safeUrl(profileData.profileImage) || 'https://via.placeholder.com/80'"
          class="sb-avatar-large"
        />
        <div class="sb-profile-info">
          <h2 class="sb-profile-name">{{ profileData.displayName }}</h2>
          <small class="sb-profile-handle">@{{ profileData.username }}</small>
          <p class="sb-profile-about">{{ profileData.about }}</p>
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
    reactionTrigger:  { type: Number,  default: 0     },
    // anticipateTrigger fires a short single "alert" pose to signal that a
    // transaction is pending (Keychain open) without committing to the full
    // success animation.  Incremented by the parent when optimistic-anticipate
    // is received; reactionTrigger is incremented only on confirmed success.
    anticipateTrigger: { type: Number,  default: 0     },
    canvasW:         { type: Number,  default: 400   },
    canvasH:         { type: Number,  default: 320   },
    // Accessory being worn — { template, genome } or null
    wearing:         { type: Object,  default: null  },
    // Multiple accessories currently worn (new API).
    wearings:        { type: Array,   default: () => [] },
    // BUG FIX 7: Mobile Canvas Deadlock.
    // When action panels (Feed, Walk, etc.) are open on small screens, the bobbing
    // creature canvas intercepts touch events aimed at buttons positioned below it.
    // Set interactionsBlocked:true while any such panel is open to apply
    // pointer-events:none and lower the canvas z-index so buttons take priority.
    interactionsBlocked: { type: Boolean, default: false },
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

      // FIX 3C: Touch-start coordinates for scroll-vs-poke discrimination.
      // Set on touchstart, consumed and cleared on touchend.
      _touchStartX:    null,
      _touchStartY:    null,

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
    reactionTrigger(v)   { if (v > 0) this._startReaction(); },
    // FIX 2: Watch the lightweight anticipation trigger separately.
    // This fires when Keychain opens (transaction pending) — not on success.
    anticipateTrigger(v) { if (v > 0) this._startAnticipation(); },
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
    // FIX 3B: Size the canvas backing store exactly once here (and again only
    // when the CSS size or devicePixelRatio actually changes), rather than
    // re-running the resize check inside every requestAnimationFrame callback.
    // At 60 fps the old code was calling Math.round(cssW * dpr) and potentially
    // writing canvas.width/height on every single frame — which forces the
    // browser to re-initialise the backing buffer even when nothing changed,
    // causing a measurable memory and CPU spike whenever devicePixelRatio
    // fluctuated (e.g. due to pinch-zoom or moving between monitors).
    this._applyDpr();
    if (typeof ResizeObserver !== "undefined") {
      this._dprObserver = new ResizeObserver(() => this._applyDpr());
      this._dprObserver.observe(this.$refs.canvas);
    }
    this.draw();
    if (!this.fossil) {
      // BUG 1 FIX: Use IntersectionObserver to pause the rAF loop when the
      // canvas is scrolled out of view, preventing battery drain and jank on
      // large grids with 15–20 active canvases.
      if (typeof IntersectionObserver !== "undefined") {
        this._intersectionObserver = new IntersectionObserver((entries) => {
          const isVisible = entries[0].isIntersecting;
          if (isVisible) {
            // Scrolled back into view — resume behaviour loop if it was running.
            if (!this._rafId && this._behavState && this._behavState !== "idle") {
              this._startRaf();
            } else if (!this._rafId) {
              this._behaviourLoop();
            }
          } else {
            // Scrolled out of view — cancel rAF to save CPU/GPU.
            if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
          }
        }, { threshold: 0 });
        this._intersectionObserver.observe(this.$refs.canvas);
      }
      this._behaviourLoop();
    }
  },
  beforeUnmount() {
    // Cancel any pending animation timers to avoid drawing on a detached canvas.
    this._animTimers.forEach(id => clearTimeout(id));
    this._animTimers = [];
    // Stop the autonomous behaviour loop.
    if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
    // BUG 1 FIX: Disconnect the IntersectionObserver.
    if (this._intersectionObserver) { this._intersectionObserver.disconnect(); this._intersectionObserver = null; }
    // FIX 3B: Disconnect the ResizeObserver so it doesn't fire after unmount.
    if (this._dprObserver) { this._dprObserver.disconnect(); this._dprObserver = null; }
    // Persist current position so the creature remembers where it was.
    if (this.genome) {
      const key = `sb_pos_${this.genome.GEN}_${this.genome.MOR}`;
      sessionStorage.setItem(key, JSON.stringify({ x: this._behavX, y: this._behavY }));
    }
  },
  methods: {
    // FIX 3B: Applies devicePixelRatio scaling to the canvas backing store.
    // Called once from mounted() and again by ResizeObserver when the canvas's
    // CSS size or the display's DPR changes (e.g. pinch-zoom, monitor switch).
    // Keeping this OUT of draw() prevents 60-fps buffer re-initialisation.
    _applyDpr() {
      const canvas = this.$refs.canvas;
      if (!canvas) return;
      const dpr  = window.devicePixelRatio || 1;
      const cssW = this.canvasW;
      const cssH = this.canvasH;
      const targetW = Math.round(cssW * dpr);
      const targetH = Math.round(cssH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width  = targetW;
        canvas.height = targetH;
      }
      // Store for draw() so it can apply the matching setTransform() cheaply.
      this._dpr = dpr;
    },
    _normalizedWearings() {
      // BUG FIX 3: Zombie Accessory — filter out items where the accessory owner
      // has revoked the permission (permissionLapsed === true).  Without this filter
      // a revoked accessory continued to render on the creature indefinitely because
      // the draw loop had no visibility into the lapsed state.  A "⚠ Lapsed" badge
      // is still shown in the Equip panel so the owner knows to click Remove.
      if (Array.isArray(this.wearings) && this.wearings.length) {
        return this.wearings.filter(w => w && w.genome && w.template !== "shirt" && !w.permissionLapsed);
      }
      return (this.wearing && this.wearing.genome && this.wearing.template !== "shirt" && !this.wearing.permissionLapsed)
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
    // FIX 2: Lightweight anticipation animation — triggered when Keychain opens
    // (transaction pending).  Holds the "alert" pose for up to 12 s then returns
    // to idle.  If the transaction succeeds, _startReaction() will pre-empt this
    // by cancelling _animTimers and playing the full celebration sequence.
    _startAnticipation() {
      // Cancel any in-progress animation (including a previous anticipation).
      this._animTimers.forEach(id => clearTimeout(id));
      this._animTimers = [];
      if (this._rafId)      { cancelAnimationFrame(this._rafId); this._rafId = null; }
      if (this._behavTimer) { clearTimeout(this._behavTimer);    this._behavTimer = null; }
      this._behavVX    = 0;
      this._behavVY    = 0;
      this._behavState = "idle";

      // Hold the alert pose while waiting for the Keychain response.
      // Cap at 12 s — roughly the Keychain timeout — then return to idle.
      this.animPose       = "alert";
      this.animExpression = "alert";
      this.draw();

      const restId = setTimeout(() => {
        // Only clean up if we're still in anticipation (not superseded by _startReaction).
        if (this.animPose === "alert" && this.animExpression === "alert") {
          this.animPose       = null;
          this.animExpression = null;
          this.draw();
          if (!this.fossil) this._behaviourLoop();
        }
      }, 12000);
      this._animTimers.push(restId);
    },

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

      // Translate from viewport pixels to CSS pixels within the canvas element,
      // then scale to the canvas's logical coordinate space (which may differ from
      // rect dimensions on high-DPI / pinch-zoomed viewports).
      // rect.width/height reflect the CSS rendered size; canvas.width/height is
      // the actual drawing buffer size (set to canvasW/canvasH, i.e. 400×320).
      const scaleX = canvas.width  / (rect.width  || canvas.width);
      const scaleY = canvas.height / (rect.height || canvas.height);
      const clickX = (event.clientX - rect.left) * scaleX;
      const clickY = (event.clientY - rect.top)  * scaleY;

      // BUG 4c FIX: Draw a brief expanding ring at the tap point so mobile
      // users get immediate visual confirmation of where their touch landed,
      // even before the hit-test result (poke vs. walk-to) is determined.
      this._drawTouchRipple(clickX, clickY);

      const W = this.canvasW, H = this.canvasH;

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
        // FIX 2A: Dead-zone guard — if the tap lands within 1.5× the body ellipse
        // radius of the creature's current centre, treat it as a missed poke rather
        // than a walk-to command.  On mobile, the moving bobbing body shifts the
        // hit-ellipse slightly between the draw call and the touch event, causing
        // finger taps on the edge of the creature to be mis-classified as empty-
        // space taps.  Without this guard the creature walks *away* from the user's
        // finger just as they try to interact with it.
        const deadZoneRadius = Math.max(a, b) * 1.5;
        const distToCreature = Math.sqrt(dx * dx + dy * dy);
        if (distToCreature < deadZoneRadius) return;

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
    // FIX 3C: Mobile Scroll vs. Poke — touch threshold handlers.
    //
    // On high-sensitivity touchscreens a "tap" to poke the creature
    // often contains a 1-2px finger-lift slide.  The browser sees
    // touch-action:pan-y and may classify the whole gesture as a
    // micro-scroll, suppressing the click event entirely and making
    // the creature feel unresponsive on mobile.
    //
    // Strategy: record (x,y) on touchstart, then on touchend compute
    // the Euclidean delta.  Only synthesise a click if delta < 5px.
    // This matches the creature's intended "poke" UX while allowing
    // genuine swipe-scrolls to pass through uninterrupted.
    // ----------------------------------------------------------
    onTouchStart(event) {
      if (event.touches.length !== 1) return;
      this._touchStartX = event.touches[0].clientX;
      this._touchStartY = event.touches[0].clientY;
    },
    onTouchEnd(event) {
      if (this._touchStartX === null) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - this._touchStartX;
      const dy = touch.clientY - this._touchStartY;
      this._touchStartX = null;
      this._touchStartY = null;
      // Only treat as a tap if the finger barely moved (< 5px).
      // Larger deltas are genuine scrolls — let the browser handle them.
      if (Math.hypot(dx, dy) < 5) {
        // Synthesise a MouseEvent-compatible object so onCanvasClick
        // can read clientX/clientY without any changes to its logic.
        this.onCanvasClick({
          clientX: touch.clientX,
          clientY: touch.clientY
        });
        // Prevent the browser from also firing a delayed click event
        // (300ms tap-delay) which would double-trigger onCanvasClick.
        event.preventDefault();
      }
    },

    // ----------------------------------------------------------
    // BUG 4b FIX: Keyboard navigation — Enter key pokes the creature.
    // tabindex="0" on the canvas lets keyboard users focus it; pressing
    // Enter synthesises a click at the creature's current visual centre
    // so screen-reader and keyboard-only users can "poke" the creature
    // without needing a mouse or touchscreen.
    // ----------------------------------------------------------
    onKeyEnter() {
      if (this.fossil || !this.genome) return;
      const canvas = this.$refs.canvas;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      // Synthesise a click at the creature's current visual centre.
      // We use the CSS-pixel centre of the canvas element (not the logical
      // canvas coordinate), because onCanvasClick converts from viewport
      // coords using getBoundingClientRect — matching what a real click does.
      this.onCanvasClick({
        clientX: rect.left + rect.width  * 0.46,
        clientY: rect.top  + rect.height * 0.52,
      });
    },

    // ----------------------------------------------------------
    // BUG 4c FIX: Touch feedback ripple.
    // Draws a brief expanding ring at (x, y) in logical canvas coordinates
    // for 200 ms so mobile users get visual confirmation that their tap
    // registered, even when it misses the body ellipse dead-zone.
    // The ripple is drawn on top of the normal frame; the next draw() call
    // will clear it naturally so no cleanup is needed.
    // ----------------------------------------------------------
    _drawTouchRipple(x, y) {
      const canvas = this.$refs.canvas;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const start    = performance.now();
      const duration = 200; // ms
      const animate  = (now) => {
        const t      = Math.min((now - start) / duration, 1);
        const radius = t * 28;           // expands from 0 to 28px
        const alpha  = (1 - t) * 0.55;  // fades from 55% to 0%
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth   = 2.5;
        ctx.stroke();
        ctx.restore();
        if (t < 1) requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
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
      // BUG FIX 5: "Shirt" was listed as a valid template in some older versions of
      // ACCESSORY_TEMPLATES but the renderer has never supported it.  The guard below
      // (and the dead switch/scale cases further down) prevented shirts from appearing,
      // but users could still create them, leaving a permanently invisible accessory.
      // The fix is two-part: (a) remove "shirt" from ACCESSORY_TEMPLATES so it is no
      // longer creatable (done in accessories.js), and (b) keep this early-return as a
      // defensive fallback in case any legacy shirt genome is still in the wild.
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

      // Render the accessory into an off-screen canvas.
      // BUG FIX 1: Reuse a single offscreen canvas per component instance instead
      // of allocating a new HTMLCanvasElement + 2D context on every frame.
      // At 60 fps this was exhausting GPU context limits and causing "context lost"
      // errors / tab crashes.  We only recreate (or resize) the canvas when accW or
      // accH actually changes.
      if (!this._offscreenCanvas) {
        this._offscreenCanvas = document.createElement('canvas');
        this._offscreenCanvas.width  = accW;
        this._offscreenCanvas.height = accH;
        this._offscreenCtx = this._offscreenCanvas.getContext('2d');
      } else if (this._offscreenCanvas.width !== accW || this._offscreenCanvas.height !== accH) {
        this._offscreenCanvas.width  = accW;
        this._offscreenCanvas.height = accH;
        // getContext() returns the same cached context after resize; no need to re-assign.
      }
      const offscreen = this._offscreenCanvas;
      const offCtx    = this._offscreenCtx;
      // Clear the reused canvas before each draw to avoid ghosting from previous accessories.
      offCtx.clearRect(0, 0, accW, accH);
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

      // FIX 3A: Necklace Z-order via compositing rather than a second geometry repaint.
      //
      // The previous approach called _redrawNeckForeground() which hardcodes the neck
      // bezier geometry.  On creatures with extreme MOR (Morphology) values the neck
      // is significantly thicker or thinner than the default proportions, so the
      // repainted path didn't align perfectly with the original neck, leaving visible
      // seams or "ghost edges" at the necklace-occlude boundary.
      //
      // New approach:
      //   1. The necklace offscreen canvas is already drawn with back-arc first,
      //      front-arc second (see drawNecklace in accessories.js).
      //   2. We composite the full offscreen image with destination-over so the
      //      back-half of the necklace naturally falls behind whatever is already
      //      on the main canvas (the creature's neck and body).
      //   3. We then re-composite the neck foreground with source-over (normal) so
      //      the front of the neck correctly occludes the necklace back-arc.
      //   This matches the creature's actual rendered geometry at all MOR values.
      if (template === 'necklace' && !underlayNecklace) {
        // Step 1: push back-arc behind existing pixels (neck, body)
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.globalAlpha = 0.95;
        ctx.drawImage(
          offscreen,
          anchorX - dw * 0.5,
          anchorY - dh * focalY,
          dw, dh
        );
        ctx.globalAlpha = 1;
        ctx.restore();

        // Step 2: repaint neck foreground on top with normal blending so
        // the front-half of the neck occludes the necklace back-arc.
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        this._redrawNeckForeground(ctx, p, sc, ox, oy, pt);
        ctx.restore();
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

  // RNG seeds (shared)
  const appRng = this.makePrng(genome.APP);
  const morRng = this.makePrng(genome.MOR);
  const ornRng = this.makePrng(genome.ORN);

  // MOR → body proportions
  // Draw order is load-bearing — altering it changes every existing creature.
  // morRng draw 1: bodyLen   draw 2: bodyH
  // morRng draw 3: headSize  draw 4: tailCurve  draw 5: tailStyle
  const bodyLen   = 80 + morRng() * 30;   // draw 1
  const bodyH     = 42 + morRng() * 18;   // draw 2
  const headSize  = 26 + morRng() * 12;   // draw 3
  const tailCurve = 0.4 + morRng() * 0.5; // draw 4

  // APP → appendage style
  // appRng draw 1: legLen   draw 2: legThick  draw 3: earH    draw 4: earW
  // appRng draw 5: hasWings draw 6: wingSpan  draw 7: (spare) draw 8: earStyle
  const legLen   = 44 + appRng() * 20;    // draw 1
  const legThick = 7  + appRng() * 5;     // draw 2
  const earH     = 22 + appRng() * 14;    // draw 3
  const earW     = 10 + appRng() * 6;     // draw 4
  const hasWings = appRng() > 0.72;       // draw 5
  const wingSpan = 24 + appRng() * 20;    // draw 6

  // ORN → ornament style
  // ornRng draw 1: glowOrbs  draw 2: ribbons   draw 3: patternType
  // ornRng draw 4: orbHue    draw 5: hasChestMark  draw 6: hasMane  draw 7: furLength
  const glowOrbs     = 2 + Math.floor(ornRng() * 4);   // draw 1
  const ribbons      = 1 + Math.floor(ornRng() * 3);   // draw 2
  const patternType  = Math.floor(ornRng() * 3);        // draw 3
  const orbHue       = (finalHue + 40 + ornRng() * 60) % 360; // draw 4
  const hasChestMark = ornRng() > 0.4;                  // draw 5
  const hasMane      = ornRng() > 0.45;                 // draw 6

  // Aesthetic styles — positioned at the END of each stream so that adding
  // new body/appendage/ornament parameters upstream doesn't silently shift
  // them.  eyeStyle derives from GEN (no RNG draw) to keep it fully stable.
  const earStyle  = Math.floor(appRng() * 3);  // APP draw 7: 0=Pointed 1=Rounded 2=Floppy
  const tailStyle = Math.floor(morRng() * 3);  // MOR draw 5: 0=Tapered 1=Tufted  2=Plumed
  const eyeStyle  = genome.GEN % 4;            // no draw: 0=Round 1=Slit 2=Almond 3=LargeIris
  const furLength = Math.floor(ornRng() * 4);  // ORN draw 7: 0=Smooth 1=Short 2=Fuzzy 3=Shaggy

  return {
    fossil, pct, fertile, male,
    bodyScale, ornamentScale, patternOpacity,
    finalHue, colorSat, colorLight, orbHue,

    bodyLen, bodyH, headSize, tailCurve,
    legLen, legThick, earH, earW,
    hasWings, wingSpan,

    glowOrbs, ribbons, patternType, hasChestMark, hasMane,

    // ✅ New outputs
    earStyle, tailStyle, eyeStyle, furLength,

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

      // FIX 3B: Canvas buffer sizing is now handled by _applyDpr() (called from
      // mounted() and the ResizeObserver), NOT here.  Running a resize inside the
      // RAF loop caused the browser to re-initialise the backing store up to 60
      // times per second whenever devicePixelRatio fluctuated (e.g. browser zoom),
      // creating a significant memory and CPU leak.
      //
      // We still call setTransform() here to reset any accumulated CTM from the
      // previous frame before painting — this is cheap and correct.
      const dpr  = this._dpr || window.devicePixelRatio || 1;
      const cssW = this.canvasW;
      const cssH = this.canvasH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // reset CTM + apply DPR scale

      const W = cssW, H = cssH;    // all drawing code uses CSS-pixel coords
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
        const crRng = this.makePrng(g.MOR ^ 0x9E3779B9);
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
        const ribRng = this.makePrng(g.ORN ^ 0x6B43A9C5);
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

      this._drawFur(ctx, p, sc, ox, oy, pt); 

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
        const patRng = this.makePrng(g.ORN ^ 0xD2A98B37);
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
        const maneRng = this.makePrng(g.ORN ^ 0x4F1BBCDC);
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
  const eyeStyle = p.eyeStyle;

  // Expression scaling
  const alertScale = (expression === "alert") ? 1.15 : 1.0;
  const er = eyeR * alertScale;

  // Iris gradient (reuse your original logic)
  const irisGr = this.radGrad(ctx,
    eyeX - eyeR * 0.2, eyeY - eyeR * 0.2, 0, er,
    [
      [0,   H1((hue + 120) % 360, 70, 75)],
      [0.6, H1((hue + 90)  % 360, 80, 50)],
      [1,   H1((hue + 60)  % 360, 60, 25)],
    ]
  );

  // Pupil offset (emotion)
  const pupilDY = (expression === "sad" || expression === "hungry")
    ? eyeR * 0.14
    : 0;

  ctx.save();
  ctx.translate(eyeX, eyeY);

  // ---- IRIS SHAPE ----
  ctx.beginPath();
  if (eyeStyle === 1) { // Slit iris
    ctx.ellipse(0, 0, er * 0.7, er, 0, 0, Math.PI * 2);
  } else if (eyeStyle === 2) { // Almond
    ctx.ellipse(0, 0, er * 1.2, er * 0.7, 0.2, 0, Math.PI * 2);
  } else { // Round / Anime base
    ctx.arc(0, 0, er, 0, Math.PI * 2);
  }
  ctx.fillStyle = irisGr;
  ctx.fill();

  // ---- PUPIL ----
  ctx.fillStyle = "#0a0a14";
  ctx.beginPath();
  if (eyeStyle === 1) { // Reptilian slit
    ctx.ellipse(0, pupilDY, er * 0.15, er * 0.8, 0, 0, Math.PI * 2);
  } else if (eyeStyle === 3) { // Anime large pupil
    ctx.ellipse(0, pupilDY, er * 0.7, er * 0.75, 0, 0, Math.PI * 2);
  } else { // Standard
    ctx.ellipse(er * 0.05, pupilDY, er * 0.42, er * 0.62, 0, 0, Math.PI * 2);
  }
  ctx.fill();

  // ---- HIGHLIGHTS (kept from your original) ----
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.beginPath();
  ctx.arc(-er * 0.28, -er * 0.28, er * 0.22, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.arc(er * 0.2, er * 0.15, er * 0.12, 0, Math.PI * 2);
  ctx.fill();

  // ---- OUTLINE ----
  ctx.strokeStyle = H1(hue, sat, lit - 25);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  if (eyeStyle === 2) {
    ctx.ellipse(0, 0, er * 1.2, er * 0.7, 0.2, 0, Math.PI * 2);
  } else {
    ctx.arc(0, 0, er, 0, Math.PI * 2);
  }
  ctx.stroke();

  ctx.restore();
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

  const tailGr = this.linGrad(ctx, tX0, tY0, endX, endY, [
    [0,   this.hsl(hue, sat - 5, lit - 8)],
    [0.5, this.hsl(hue, sat, lit + 4)],
    [1,   this.hsl((hue + 30) % 360, sat + 15, lit + 18)],
  ]);

  ctx.fillStyle   = tailGr;
  ctx.strokeStyle = this.hsl(hue, sat, lit - 14);

  // === STYLE MODIFIER (Plumed Tail) ===
  if (p.tailStyle === 2) {
    ctx.lineWidth = 15 * sc;
    ctx.lineCap = "round";
    // (Optional fluff strokes can be added here later)
  } else {
    ctx.lineWidth = 1.5;
  }

  ctx.beginPath();
  ctx.moveTo(tX0, tY0 + 10 * sc);
  ctx.bezierCurveTo(cp1x, cp1y + 12 * sc, cp2x + 4 * sc, cp2y + 10 * sc, endX + 8 * sc, endY);
  ctx.bezierCurveTo(cp2x - 6 * sc, cp2y - 14 * sc, cp1x - 10 * sc, cp1y - 12 * sc, tX0, tY0 - 10 * sc);
  ctx.closePath();

  // Draw core tail
  ctx.fill();
  ctx.stroke();

  // === STYLE MODIFIER (Tufted Tail Tip) ===
  if (p.tailStyle === 1) {
    ctx.fillStyle = this.hsl((hue + 30) % 360, sat, lit + 20);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.arc(
        endX + Math.cos(a) * 5 * sc,
        endY + Math.sin(a) * 5 * sc,
        8 * sc,
        0,
        Math.PI * 2
      );
    }
    ctx.fill();
  }

  // === EXISTING TIP GLOW ===
  const tipGr = this.radGrad(ctx, endX, endY, 0, 20 * sc, [
    [0,   this.hsl((hue + 40) % 360, sat + 20, lit + 32, 0.9)],
    [0.6, this.hsl((hue + 20) % 360, sat + 10, lit + 18, 0.5)],
    [1,   this.hsl(hue, sat, lit, 0)],
  ]);

  ctx.fillStyle = tipGr;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(endX, endY, 20 * sc, 0, Math.PI * 2);
  ctx.fill();
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

  ctx.globalAlpha = front ? 1.0 : 0.7;

  // Outer ear
  ctx.fillStyle   = this.hsl(hue, sat + 5, lit - 5);
  ctx.strokeStyle = this.hsl(hue, sat, lit - 20);
  ctx.lineWidth   = 1.2;

  ctx.beginPath();

  let tipX, tipY;

  if (p.earStyle === 1) {
    // Rounded (Bear)
    ctx.arc(baseX, baseY - eH * 0.4, eW * 0.8, 0, Math.PI * 2);
  } else if (p.earStyle === 2) {
    // Floppy (Dog/Hound)
    ctx.moveTo(baseX - eW, baseY);
    ctx.bezierCurveTo(baseX - eW, baseY + eH, baseX + eW, baseY + eH, baseX + eW, baseY);
  } else {
    // Pointed (Classic)
    tipX = baseX + (side < 0 ? -eW * 0.3 : eW * 0.3);
    tipY = baseY - eH;

    ctx.moveTo(baseX - eW * 0.55, baseY);
    ctx.quadraticCurveTo(baseX - eW * 0.7, baseY - eH * 0.5, tipX, tipY);
    ctx.quadraticCurveTo(baseX + eW * 0.7, baseY - eH * 0.5, baseX + eW * 0.55, baseY);
  }

  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Inner ear — only for pointed style (cleanest visually)
  if (front && p.ornamentScale > 0.1 && p.earStyle === 0) {
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
      const orbRng = this.makePrng(g.ORN ^ 0xA3C59E1F);
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
    },
    
    _drawFur(ctx, p, sc, ox, oy, pt) {
  if (p.furLength === 0 || p.fossil) return;

  const hue = p.finalHue;
  const sat = p.colorSat;
  const lit = p.colorLight;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate(pt.torsoAngle);

  // We increase the count because we are now filling an area, not just a perimeter.
  const fringeCount = 40 + (p.furLength * 30);
  const surfaceCount = fringeCount * 1.2; // Extra strands for the interior
  const strandLen = (2 + p.furLength * 3) * sc;

  // Fringe fur (around the edges to keep the shaggy silhouette)
  ctx.strokeStyle = this.hsl(hue, sat - 10, lit - 10, 0.6);
  ctx.lineWidth = 1 * sc;

  for (let i = 0; i < fringeCount; i++) {
    const angle = (i / fringeCount) * Math.PI * 2;
    const px = Math.cos(angle) * p.bodyLen * sc;
    const py = Math.sin(angle) * p.bodyH * sc;

    const jitter = (Math.sin(i * 13.5) * 0.2);
    const nx = Math.cos(angle + jitter) * strandLen;
    const ny = Math.sin(angle + jitter) * strandLen;

    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + nx, py + ny);
    ctx.stroke();
  }

  // Internal surface fur (texture inside the torso)
  // We use a lower alpha (0.3) so the underlying body gradients remain visible.
  ctx.strokeStyle = this.hsl(hue, sat - 12, lit - 15, 0.3);
  
  for (let i = 0; i < surfaceCount; i++) {
    // Deterministic pseudo-random distribution inside the ellipse
    const t = i / surfaceCount;
    const angle = t * Math.PI * 2 * 7.5; // Spiral distribution
    const r = Math.sqrt(t) * 0.9; // sqrt(t) ensures uniform distribution area-wise
    
    const px = Math.cos(angle) * p.bodyLen * sc * r;
    const py = Math.sin(angle) * p.bodyH * sc * r;

    // Interior fur looks better if it follows a slightly more uniform downward/backward flow
    const jitter = (Math.sin(i * 21.7) * 0.4);
    const flowAngle = Math.PI * 0.2 + jitter; 

    const nx = Math.cos(flowAngle) * strandLen * 0.8;
    const ny = Math.sin(flowAngle) * strandLen * 0.8;

    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + nx, py + ny);
    ctx.stroke();
  }

  ctx.restore();
}
  },
  template: `<canvas ref="canvas" :width="canvasW" :height="canvasH"
    role="img"
    tabindex="0"
    :aria-label="genome
      ? (fossil
          ? 'Fossilised creature — ' + (genome.SX === 0 ? 'male' : 'female') + ', genome preserved on-chain'
          : 'A ' + (genome.SX === 0 ? 'male' : 'female') + ' creature, ' + (feedState ? feedState.label : '') + ' — click or press Enter to interact')
      : 'Creature canvas loading'"
    :style="'width:'+canvasW+'px;height:'+canvasH+'px;max-width:100%;'
      + (fossil || !genome ? 'cursor:default;' : 'cursor:pointer;')
      + '-webkit-tap-highlight-color:transparent;outline:none;user-select:none;'
      + 'touch-action:pan-y;'
      + (interactionsBlocked ? 'pointer-events:none;z-index:0;' : 'z-index:1;')"
    @click="onCanvasClick"
    @keyup.enter="onKeyEnter"
    @touchstart.passive="onTouchStart"
    @touchend="onTouchEnd"></canvas>`
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
    username: { type: String, default: "" },
    // FIX 1A (Pending Transfer Badge): When the creature has an open transfer offer,
    // show a 🤝 Pending badge directly on the card so owners can see at a glance
    // which of their creatures are locked in a handshake — without clicking into
    // each detail page.  Pass transferState.pendingOffer (or null) from the parent.
    pendingOffer: { type: Object, default: null }
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
      votePickerBelow:   false,   // true when card is near top of viewport; popover opens downward
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
      // If the button is within 200px of the top of the viewport, open the popover
      // downward so it isn't clipped by the navigation bar or browser chrome.
      const rect = e.currentTarget.getBoundingClientRect();
      this.votePickerBelow = rect.top < 200;
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
      <div class="sb-card">
        <creature-canvas-component
          :genome="post.genome"
          :age="post.age"
          :fossil="fossil"
          :wearing="cardWearing"
          :canvas-w="180"
          :canvas-h="144"
          style="display:block;margin:0 auto;"
        ></creature-canvas-component>

        <div class="sb-card-name">
          🧬 {{ post.name }}
          <!-- FIX 1A: Show 🤝 Pending badge when creature has an open transfer offer.
               Without this, the owner must click into each creature's detail page
               to discover which items are locked in a pending handshake. -->
          <span v-if="pendingOffer" title="Transfer offer pending — waiting for recipient to accept"
            style="display:inline-block;margin-left:6px;font-size:0.68rem;
                   background:#1a1200;color:#ffb74d;border:1px solid #3a2800;
                   border-radius:4px;padding:1px 5px;vertical-align:middle;">
            🤝 Pending → @{{ pendingOffer.to }}
          </span>
        </div>

        <!-- Row 1: sex · age · lifecycle · ❤️ count [↑] -->
        <div class="sb-card-row" @click.prevent.stop>
          <span class="sb-muted">{{ sexSymbol }}</span>
          <span class="sb-dot">·</span>
          <span class="sb-muted">{{ post.age }}d</span>
          <span class="sb-dot">·</span>
          <span :style="{ color: stageColor }">{{ stageLabel }}</span>
          <span class="sb-dot">·</span>
          <span v-if="!socialLoading" style="color:#ef9a9a;" title="Upvotes">❤️ {{ votes.length }}</span>
          <span v-else style="color:#333;">❤️ …</span>
          <template v-if="username">
            <button v-if="!hasVoted" @click="toggleVotePicker" :disabled="votingInProgress"
              title="Upvote this creature" class="sb-vote-btn">
              {{ votingInProgress ? "…" : "↑" }}
            </button>
            <span v-else style="color:#ef5350;font-size:0.66rem;" title="You upvoted this">✓</span>
          </template>
          <!-- Fix 6: @click.stop on the popover container prevents the router-link
               from navigating when the user interacts with any part of the picker. -->
          <div v-if="votePickerOpen" :class="['sb-vote-popover', votePickerBelow ? 'sb-vote-popover-below' : '']" @click.stop>
            <div @click.stop="votePickerOpen = false" style="position:fixed;inset:0;z-index:-1;"></div>
            <div class="sb-vote-popover-title">❤️ Vote strength</div>
            <div class="sb-vote-popover-pct">{{ votePct }}%</div>
            <input type="range" v-model.number="votePct" min="1" max="100" step="1"
                   @click.stop
                   style="width:100%;accent-color:#ef5350;cursor:pointer;" />
            <div class="sb-vote-popover-labels"><span>1%</span><span>100%</span></div>
            <button @click.stop="submitVote" class="sb-vote-confirm-btn">Confirm {{ votePct }}%</button>
          </div>
        </div>

        <!-- Row 2: @author · provenance · 🔁 count [↺] -->
        <div class="sb-card-row-sm" @click.prevent.stop>
          <span class="sb-dimmer-2">@{{ post.author }}</span>
          <span :style="{ color: provenanceBadge.color, fontSize:'0.63rem' }">
            {{ provenanceBadge.icon }} {{ provenanceBadge.label }}
          </span>
          <span class="sb-dot">·</span>
          <span v-if="!socialLoading" style="color:#80cbc4;" title="Resteems">🔁 {{ rebloggers.length }}</span>
          <span v-else style="color:#333;">🔁 …</span>
          <template v-if="username">
            <button v-if="!hasResteemed" @click="submitResteem" :disabled="resteemInProgress"
              title="Resteem this creature" class="sb-resteem-btn">
              {{ resteemInProgress ? "…" : "↺" }}
            </button>
            <span v-else style="color:#26c6da;font-size:0.63rem;" title="You resteemed this">✓</span>
          </template>
        </div>

        <button @click="copyUrl" :class="copied ? 'sb-copy-btn sb-copy-btn-copied' : 'sb-copy-btn sb-copy-btn-default'" title="Copy Steemit URL">
          {{ copied ? "✓ Copied!" : "📋 Copy URL" }}
        </button>
      </div>
    </router-link>
  `
};

// ---- GenomeTableComponent ----
// Renders genome genes as labelled visual histograms.
// Continuous genes (0–9999) show a bar + position label.
// Discrete genes (Sex, MUT) show a badge.
const GenomeTableComponent = {
  name: "GenomeTableComponent",
  props: {
    genome: { type: Object, required: true }
  },
  computed: {
    sexLabel() {
      return this.genome.SX === 0 ? "♂ Male" : "♀ Female";
    },
    // Genes that map to a 0–9999 scale and get bar histograms
    barGenes() {
      const g = this.genome;
      return [
        {
          key: "MOR", label: "Morphology",
          value: g.MOR, min: 0, max: 9999,
          desc: this._morphDesc(g.MOR),
          color: "#66bb6a",
          title: "Controls body shape: short/round → long/thin"
        },
        {
          key: "APP", label: "Appendages",
          value: g.APP, min: 0, max: 9999,
          desc: this._appDesc(g.APP),
          color: "#80cbc4",
          title: "Seeds limb count, ear style, tail type"
        },
        {
          key: "ORN", label: "Ornamentation",
          value: g.ORN, min: 0, max: 9999,
          desc: this._ornDesc(g.ORN),
          color: "#ce93d8",
          title: "Controls glows, mane, ribbons, orb nodes"
        },
        {
          key: "CLR", label: "Colour (hue°)",
          value: g.CLR, min: 0, max: 9999,
          desc: this._clrDesc(g.CLR),
          color: this._hueColor(g.CLR),
          title: "Base hue mapped from 0–9999 → 0–359°"
        },
      ];
    },
    // Lifespan / fertility use their own natural scales
    lifespanGenes() {
      const g = this.genome;
      return [
        {
          key: "LIF", label: "Lifespan",
          value: g.LIF, min: 80, max: 200,
          desc: g.LIF + " days",
          color: "#ef9a9a",
          title: "Maximum age in days"
        },
        {
          key: "FRT_START", label: "Fertility start",
          value: g.FRT_START, min: 0, max: g.LIF || 160,
          desc: "day " + g.FRT_START,
          color: "#ffe082",
          title: "Age (days) when fertile period begins"
        },
        {
          key: "FRT_END", label: "Fertility end",
          value: g.FRT_END, min: 0, max: g.LIF || 160,
          desc: "day " + g.FRT_END,
          color: "#ffe082",
          title: "Age (days) when fertile period ends"
        },
      ];
    }
  },
  methods: {
    pct(value, min, max) {
      return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    },
    _morphDesc(v) {
      if (v < 1500) return "Compact";
      if (v < 3500) return "Stocky";
      if (v < 6500) return "Average";
      if (v < 8500) return "Lean";
      return "Elongated";
    },
    _appDesc(v) {
      if (v < 2000) return "Minimal";
      if (v < 5000) return "Moderate";
      if (v < 8000) return "Complex";
      return "Elaborate";
    },
    _ornDesc(v) {
      if (v < 1500) return "Plain";
      if (v < 4000) return "Subtle";
      if (v < 7000) return "Vivid";
      if (v < 9000) return "Radiant";
      return "Spectacular";
    },
    _clrDesc(v) {
      const hue = Math.round((v / 9999) * 359);
      const names = [
        [15,  "Red"],  [45,  "Orange"], [70,  "Yellow"],
        [150, "Green"],[190, "Cyan"],   [250, "Blue"],
        [290, "Violet"],[330,"Magenta"],[360, "Red"],
      ];
      for (const [limit, name] of names) if (hue <= limit) return name + " " + hue + "°";
      return hue + "°";
    },
    _hueColor(v) {
      const hue = Math.round((v / 9999) * 359);
      return `hsl(${hue},70%,60%)`;
    },
    mutLabel(v) {
      if (v === undefined || v === null) return "—";
      const labels = ["Frozen","Stable","Low","Moderate","High","Volatile"];
      return labels[Math.min(v, 5)] || v;
    },
    mutColor(v) {
      const colors = ["#90caf9","#a5d6a7","#c8e6c9","#ffe082","#ffb74d","#ff8a80"];
      return colors[Math.min(v, 5)] || "#888";
    }
  },
  template: `
    <div class="sb-genome-hist">

      <!-- Header row: fixed labels -->
      <div class="sb-genome-fixed-row">
        <span class="sb-genome-key">Genus</span>
        <span class="sb-genome-val">{{ generateGenusName ? generateGenusName(genome.GEN) : genome.GEN }} <span class="sb-genome-dim">(GEN {{ genome.GEN }})</span></span>
      </div>
      <div class="sb-genome-fixed-row">
        <span class="sb-genome-key">Sex</span>
        <span class="sb-genome-val" :style="{ color: genome.SX === 0 ? '#90caf9' : '#f48fb1' }">{{ sexLabel }}</span>
      </div>

      <!-- Bar genes: MOR APP ORN CLR -->
      <div v-for="g in barGenes" :key="g.key" class="sb-genome-bar-row" :title="g.title">
        <div class="sb-genome-bar-label">
          <span class="sb-genome-key">{{ g.label }}</span>
          <span class="sb-genome-bar-desc" :style="{ color: g.color }">{{ g.desc }}</span>
        </div>
        <!-- FIX 3A (A11y): role="progressbar" + aria-value* let screen readers
             announce "4500 out of 9999" instead of just reading the label and
             raw number with no context about what percentage of the range it represents. -->
        <div class="sb-genome-bar-track"
          role="progressbar"
          :aria-valuenow="g.value"
          :aria-valuemin="g.min"
          :aria-valuemax="g.max"
          :aria-label="g.label + ': ' + g.value + ' (' + pct(g.value, g.min, g.max) + '% of range)'">
          <div class="sb-genome-bar-fill" :style="{ width: pct(g.value, g.min, g.max) + '%', background: g.color }"></div>
          <span class="sb-genome-bar-num">{{ g.value }}</span>
        </div>
      </div>

      <!-- Lifespan / fertility bars -->
      <div class="sb-genome-section-label">Lifecycle</div>
      <div v-for="g in lifespanGenes" :key="g.key" class="sb-genome-bar-row" :title="g.title">
        <div class="sb-genome-bar-label">
          <span class="sb-genome-key">{{ g.label }}</span>
          <span class="sb-genome-bar-desc" :style="{ color: g.color }">{{ g.desc }}</span>
        </div>
        <div class="sb-genome-bar-track"
          role="progressbar"
          :aria-valuenow="g.value"
          :aria-valuemin="g.min"
          :aria-valuemax="g.max"
          :aria-label="g.label + ': ' + g.value + ' (' + pct(g.value, g.min, g.max) + '% of range)'">
          <div class="sb-genome-bar-fill" :style="{ width: pct(g.value, g.min, g.max) + '%', background: g.color }"></div>
          <span class="sb-genome-bar-num">{{ g.value }}</span>
        </div>
      </div>

      <!-- Mutation: discrete badge -->
      <div class="sb-genome-fixed-row">
        <span class="sb-genome-key">Mutation</span>
        <span class="sb-genome-mut-badge" :style="{ color: mutColor(genome.MUT), borderColor: mutColor(genome.MUT) }">
          {{ genome.MUT !== undefined ? genome.MUT : '—' }} · {{ mutLabel(genome.MUT) }}
        </span>
      </div>

    </div>
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
    <div v-if="profileData" class="sb-banner">
      <!-- Cover image -->
      <div
        class="sb-banner-cover"
        :style="safeUrl(profileData.coverImage) ? { backgroundImage: 'url(' + safeUrl(profileData.coverImage) + ')' } : {}"
      ></div>

      <!-- Avatar + info row -->
      <div class="sb-banner-body">
        <img
          :src="safeUrl(profileData.profileImage) || ''"
          @error="$event.target.style.display='none'"
          class="sb-banner-avatar"
        />
        <div class="sb-banner-info">
          <div class="sb-banner-name-row">
            <div class="sb-banner-name">{{ profileData.displayName }}</div>
            <div v-if="isLoggedIn && userLevel" :title="'XP: ' + userLevel.totalXp" class="sb-level-badge">
              <span>{{ userLevel.icon }}</span>
              <span class="sb-level-rank">{{ userLevel.rank }}</span>
              <span class="sb-dot">·</span>
              <span class="sb-level-xp">{{ userLevel.totalXp }} XP</span>
            </div>
          </div>
          <div class="sb-banner-handle">@{{ profileData.username }}</div>
          <div v-if="profileData.about" class="sb-banner-about">{{ profileData.about }}</div>
          <div v-if="isLoggedIn && userLevel && userLevel.nextRank" class="sb-xp-bar-wrap">
            <div class="sb-xp-bar-labels">
              <span>→ {{ userLevel.nextRankIcon }} {{ userLevel.nextRank }}</span>
              <span>{{ userLevel.totalXp }} / {{ userLevel.nextRankXp }} XP</span>
            </div>
            <div class="sb-xp-bar-track">
              <div class="sb-xp-bar-fill" :style="{ width: Math.round(userLevel.progressToNext * 100) + '%' }"></div>
            </div>
          </div>
          <div v-if="isLoggedIn && userLevel && !userLevel.nextRank" class="sb-max-rank">✦ Maximum rank achieved</div>
          <div v-if="isLoggedIn && userLevel" class="sb-activity-summary">
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
  emits: ["notify", "feed-state-updated", "activity-state-updated", "optimistic-feed", "optimistic-play", "optimistic-walk", "optimistic-anticipate", "cancel-anticipate",
    // BUG 8 FIX: Emitted on Keychain rejection so the parent (CreatureView) can
    // reset its alreadyFedToday ref immediately — preventing the Feed button
    // staying stuck in a disabled/success state until the next blockchain re-fetch.
    "feed-failed"],
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

      // FIX 2: Interaction Deadlock / Race Condition.
      // Previously "optimistic-feed" fired the full "Thriving" reaction animation
      // the instant Keychain opened — before the transaction was confirmed.
      // If the user rejected or the network failed, the creature was stuck in the
      // happy animation for ~10 seconds, creating a false-success state.
      //
      // Fix: emit "optimistic-anticipate" now (triggers a neutral "alert" pose),
      // and emit "optimistic-feed" (the full Thriving sequence) only inside the
      // if (response.success) callback below.
      this.$emit("optimistic-anticipate");

      // BUG 1 FIX: Keychain "Silent Close" — 60-second timeout.
      // If the user dismisses the Keychain popup via the browser's window "X" button
      // (not the in-extension Cancel button), some Keychain versions never fire the
      // callback, leaving publishingFeed = true and the UI stuck forever.
      // The timeout fires the callback manually with a synthetic failure response so
      // all rollback paths execute normally.
      let _feedCallbackFired = false;
      const _feedTimeoutId = setTimeout(() => {
        if (_feedCallbackFired) return;
        _feedCallbackFired = true;
        this.publishingFeed = false;
        this.alreadyFedToday = false;
        this.$emit("cancel-anticipate");
        this.$emit("feed-failed");
        this.$emit("notify", "Transaction timed out or was closed — please try again.", "error");
      }, 60000);

      publishFeed(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        this.foodType,
        this.unicodeArt,
        (response) => {
          if (_feedCallbackFired) return; // timeout already fired
          _feedCallbackFired = true;
          clearTimeout(_feedTimeoutId);
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
            if (typeof invalidateCreatureCache === "function") invalidateCreatureCache(this.creatureAuthor, this.creaturePermlink);
            this.$emit("feed-state-updated", this.feedState);
            // Now confirmed on-chain: trigger the full celebratory Thriving animation.
            this.$emit("optimistic-feed");
            const foodLabel = { nectar: "Nectar", fruit: "Fruit", crystal: "Crystal" }[this.foodType] || this.foodType;
            this.$emit("notify", "🍃 Fed " + this.creatureName + " with " + foodLabel + "!", "success");
          } else {
            // Transaction failed — roll back the optimistic state flags.
            // BUG 6 FIX: Also cancel the anticipation pose so the creature
            // doesn't stay stuck in "alert" until the 12-second timeout fires.
            this.alreadyFedToday = false;
            this.$emit("cancel-anticipate");
            // BUG 8 FIX: Notify the parent (CreatureView) so it can reset its own
            // alreadyFedToday ref.  Without this the Feed button stays disabled/
            // success because the parent's ctxAlreadyFed was set optimistically and
            // is only refreshed on a blockchain re-fetch, which hasn't happened yet.
            this.$emit("feed-failed");
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

      // Optimistic: update UI & trigger creature animation immediately.
      this.alreadyPlayedToday = true;
      this._optimisticUpdate("play");
      this.$emit("optimistic-play");

      // BUG 1 FIX: Keychain "Silent Close" — 60-second timeout for play.
      let _playCallbackFired = false;
      const _playTimeoutId = setTimeout(() => {
        if (_playCallbackFired) return;
        _playCallbackFired = true;
        this.publishingPlay = false;
        this.alreadyPlayedToday = false;
        this.$emit("cancel-anticipate");
        this.$emit("notify", "Transaction timed out or was closed — please try again.", "error");
      }, 60000);

      publishPlay(
        this.username, this.creatureAuthor, this.creaturePermlink,
        this.creatureName, this.unicodeArt,
        (response) => {
          if (_playCallbackFired) return;
          _playCallbackFired = true;
          clearTimeout(_playTimeoutId);
          this.publishingPlay = false;
          if (response.success) {
            if (typeof invalidateCreatureCache === "function") invalidateCreatureCache(this.creatureAuthor, this.creaturePermlink);
            this.$emit("notify", "🎮 Played with " + this.creatureName + "! Mood improved.", "success");
          } else {
            // Rollback
            // BUG 6 FIX: Cancel the anticipation pose on rejection.
            this.alreadyPlayedToday = false;
            this.$emit("cancel-anticipate");
            this.$emit("notify", "Play failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    },

    walkCreature() {
      if (!this.canWalk) return;
      if (!window.steem_keychain) { this.$emit("notify", "Steem Keychain is not installed.", "error"); return; }
      this.publishingWalk = true;

      // Optimistic: update UI & trigger creature animation immediately.
      this.alreadyWalkedToday = true;
      this._optimisticUpdate("walk");
      this.$emit("optimistic-walk");

      // BUG 1 FIX: Keychain "Silent Close" — 60-second timeout for walk.
      let _walkCallbackFired = false;
      const _walkTimeoutId = setTimeout(() => {
        if (_walkCallbackFired) return;
        _walkCallbackFired = true;
        this.publishingWalk = false;
        this.alreadyWalkedToday = false;
        this.$emit("cancel-anticipate");
        this.$emit("notify", "Transaction timed out or was closed — please try again.", "error");
      }, 60000);

      publishWalk(
        this.username, this.creatureAuthor, this.creaturePermlink,
        this.creatureName, this.unicodeArt,
        (response) => {
          if (_walkCallbackFired) return;
          _walkCallbackFired = true;
          clearTimeout(_walkTimeoutId);
          this.publishingWalk = false;
          if (response.success) {
            this.$emit("notify", "🦮 Took " + this.creatureName + " for a walk! Vitality improved.", "success");
          } else {
            // Rollback
            // BUG 6 FIX: Cancel the anticipation pose on rejection.
            this.alreadyWalkedToday = false;
            this.$emit("cancel-anticipate");
            this.$emit("notify", "Walk failed: " + (response.message || "Unknown error"), "error");
          }
        }
      );
    }
  },

  template: `
    <div class="sb-activity-section">
      <h3 class="sb-activity-title">🌿 Activities</h3>

      <div v-if="!username" class="sb-activity-gate">
        🔒 Log in to do activities with this creature.
      </div>

      <template v-else>

        <!-- Health bar -->
        <div v-if="feedState" class="sb-stat-bar-wrap">
          <div class="sb-stat-bar-header">
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
          <div class="sb-stat-bar-track">
            <div class="sb-stat-bar-fill" :style="{ width: healthBarWidth, background: healthBarColor }"></div>
          </div>
        </div>

        <!-- Mood + Vitality bars -->
        <div v-if="activityState && (activityState.playTotal > 0 || activityState.walkTotal > 0)" class="sb-dual-bars">
          <div>
            <div class="sb-stat-bar-header">
              <span>🎮 Mood <span v-if="activityState.moodLabel" style="color:#ce93d8;">({{ activityState.moodLabel }})</span></span>
              <span>{{ activityState.playTotal }}/15 plays
                <template v-if="activityState.fertilityExtension > 0">
                  · Fertility +<strong style="color:#ce93d8;">{{ activityState.fertilityExtension }}d</strong>
                </template>
              </span>
            </div>
            <div class="sb-stat-bar-track">
              <div class="sb-stat-bar-fill" :style="{ width: moodBarWidth, background:'#9c27b0' }"></div>
            </div>
          </div>
          <div>
            <div class="sb-stat-bar-header">
              <span>🦮 Vitality <span v-if="activityState.vitalityLabel" style="color:#80cbc4;">({{ activityState.vitalityLabel }})</span></span>
              <span>{{ activityState.walkTotal }}/15 walks
                <template v-if="activityState.vitalityLifespanBonus > 0">
                  · Lifespan +<strong style="color:#80cbc4;">{{ activityState.vitalityLifespanBonus }}d</strong>
                </template>
              </span>
            </div>
            <div class="sb-stat-bar-track">
              <div class="sb-stat-bar-fill" :style="{ width: vitalityBarWidth, background:'#00897b' }"></div>
            </div>
          </div>
        </div>

        <!-- Three action cards: Feed · Play · Walk -->
        <div class="sb-activity-cards">

          <div class="sb-activity-card sb-activity-card-feed">
            <div class="sb-activity-card-icon">🍃</div>
            <div class="sb-activity-card-label sb-label-feed">Feed</div>
            <div class="sb-activity-card-desc">Boosts health · lifespan &amp; fertility</div>
            <div class="sb-food-selector">
              <div v-for="opt in foodOptions" :key="opt.value" class="sb-food-option" @click="foodType = opt.value">
                <div :style="{
                  width:'12px', height:'12px', borderRadius:'50%', flexShrink:0,
                  border: '2px solid ' + (foodType === opt.value ? '#66bb6a' : '#333'),
                  background: foodType === opt.value ? '#2e7d32' : 'transparent'
                }"></div>
                <span :style="{ fontSize:'11px', color: foodType === opt.value ? '#ccc' : '#666' }">{{ opt.label }}</span>
              </div>
            </div>
            <button @click="feedCreature" :disabled="!canFeed"
              :class="canFeed ? 'sb-action-btn sb-action-btn-feed-on' : 'sb-action-btn sb-action-btn-feed-off'"
            >{{ feedButtonLabel }}</button>
            <p v-if="alreadyFedToday" class="sb-activity-card-tomorrow">Come back tomorrow!</p>
          </div>

          <div class="sb-activity-card sb-activity-card-play">
            <div class="sb-activity-card-icon">🎮</div>
            <div class="sb-activity-card-label sb-label-play">Play</div>
            <div class="sb-activity-card-desc">Boosts mood · widens fertility window</div>
            <button @click="playWithCreature" :disabled="!canPlay"
              :class="canPlay ? 'sb-action-btn sb-action-btn-play-on' : 'sb-action-btn sb-action-btn-play-off'"
            >{{ playButtonLabel }}</button>
            <p v-if="alreadyPlayedToday" class="sb-activity-card-tomorrow">Come back tomorrow!</p>
          </div>

          <div class="sb-activity-card sb-activity-card-walk">
            <div class="sb-activity-card-icon">🦮</div>
            <div class="sb-activity-card-label sb-label-walk">Walk</div>
            <div class="sb-activity-card-desc">Boosts vitality · extends lifespan</div>
            <button @click="walkCreature" :disabled="!canWalk"
              :class="canWalk ? 'sb-action-btn sb-action-btn-walk-on' : 'sb-action-btn sb-action-btn-walk-off'"
            >{{ walkButtonLabel }}</button>
            <p v-if="alreadyWalkedToday" class="sb-activity-card-tomorrow">Come back tomorrow!</p>
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
    // Shape: { url, name, sex, genome, author, permlink }
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
      _facingRight: false,

      // Matchmaker state
      partners: [],
      searchingPartners: false,
      pendingPartner: null,
      // Early kinship preview (fix 3b): set when urlB is filled and valid
      kinshipPreview: null,   // null | "checking" | "ok" | { error: string }
      _kinshipTimer:  null,
      // Prevent duplicate kinship checks when matchmaker auto-fills urlB and
      // immediately calls breedCreatures(). Without this guard, the urlB watcher
      // starts a second background compatibility walk that can race/stall UI state.
      _suppressUrlBKinshipOnce: false,
      // Set when Parent B is chosen via Find Compatible Partner cards.
      // In this path we skip the expensive deep kinship recomputation at submit
      // time to avoid creature-page stalls from duplicate heavy graph walks.
      _skipDeepKinshipOnce: false,
      // BUG 7 FIX: Set to a warning string when a phantom ancestor is detected
      // (severed lineage).  null = clean lineage.  Shown in the child preview
      // as an informational badge, not a blocking error.
      _severedLineageWarning: null,
    };
  },
  watch: {
    // Keep urlA in sync if the locked creature changes (e.g. navigation)
    lockedA(val) {
      if (val?.url) this.urlA = val.url;
      this.partners       = [];
      this.pendingPartner = null;
    },
    // Fix 3b: trigger early kinship check as soon as Parent B URL looks complete.
    urlB(val) {
      if (this._suppressUrlBKinshipOnce) {
        this._suppressUrlBKinshipOnce = false;
        this.kinshipPreview = null;
        clearTimeout(this._kinshipTimer);
        return;
      }
      this.kinshipPreview = null;
      clearTimeout(this._kinshipTimer);
      const trimmed = val.trim();
      // Only bother if the URL has the @author/permlink shape.
      if (!trimmed || !/@[a-z0-9.-]+\/[a-z0-9-]+/i.test(trimmed)) return;
      // Debounce 800 ms so we don't fire on every keystroke.
      this._kinshipTimer = setTimeout(async () => {
        if (!this.urlA) return;
        this.kinshipPreview = "checking";
        try {
          const [resA, resB] = await Promise.all([
            this._withTimeout(
              loadGenomeFromPost(this.urlA.trim()),
              15000,
              "Loading Parent A genome timed out after 15s. Please retry."
            ),
            this._withTimeout(
              loadGenomeFromPost(trimmed),
              15000,
              "Loading Parent B genome timed out after 15s. Please retry."
            ),
          ]);
          // FIX 1B (Genus Mismatch): Explicitly verify GEN matches before running
          // the full ancestor walk.  Without this, pasting a URL for an incompatible
          // genus would pass kinshipPreview silently and only fail at the final Breed
          // button click — a confusing late-stage error that discards the user's work.
          if (resA.genome.GEN !== resB.genome.GEN) {
            const nameA = typeof generateGenusName === "function" ? generateGenusName(resA.genome.GEN) : `GEN ${resA.genome.GEN}`;
            const nameB = typeof generateGenusName === "function" ? generateGenusName(resB.genome.GEN) : `GEN ${resB.genome.GEN}`;
            throw new Error(
              `Genus mismatch: Parent A is ${nameA} (GEN ${resA.genome.GEN}) ` +
              `but Parent B is ${nameB} (GEN ${resB.genome.GEN}). ` +
              `Both parents must be the same genus.`
            );
          }
          await Promise.race([
            checkBreedingCompatibility(resA, resB),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Kinship verification timed out after 30s. Please retry.")), 30000)
            )
          ]);
          this.kinshipPreview = "ok";
        } catch (e) {
          this.kinshipPreview = { error: e.message || String(e) };
        }
      }, 800);
    },
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
    _withTimeout(promise, ms, message) {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    },

    // ============================================================
    // NEW: Matchmaker Logic
    // ============================================================
    async findPartners() {
      if (!this.lockedA) return;
      this.searchingPartners = true;
      this.partners       = [];
      this.pendingPartner = null;
      try {
        const targetGEN  = this.lockedA.genome.GEN;
        const targetSex  = this.lockedA.genome.SX === 0 ? 1 : 0;
        const selfKey    = this.lockedA.author + "/" + this.lockedA.permlink;

        // Fetch up to 200 posts (two pages) so the matchmaker covers more history.
        const page1 = await fetchPostsByTag("steembiota", 100);
        let raw = Array.isArray(page1) ? [...page1] : [];
        if (raw.length === 100) {
          const last  = raw[raw.length - 1];
          const page2 = await fetchPostsByTagPaged("steembiota", 100, last.author, last.permlink);
          if (Array.isArray(page2)) raw = raw.concat(page2.slice(1));
        }

        // Supplement with any previously-seen creatures stored in the localStorage
        // list cache. This lets the matchmaker surface older rare-genus creatures
        // that have fallen outside the 200-post live query window.
        try {
          const cached = readListCache("steembiota:list:creatures:v1");
          if (Array.isArray(cached)) {
            const liveKeys = new Set(raw.map(p => p.author + "/" + p.permlink));
            for (const p of cached) {
              if (!liveKeys.has(p.author + "/" + p.permlink)) raw.push(p);
            }
          }
        } catch { /* non-fatal */ }

        const parsed = parseSteembiotaPosts(raw);

        const isFertile = (c) => {
          const g = c.genome;
          return c.age >= g.FRT_START && c.age < g.FRT_END && c.age < g.LIF;
        };

        const candidates = parsed.filter(c =>
          c.genome.GEN === targetGEN &&
          c.genome.SX  === targetSex &&
          c.author + "/" + c.permlink !== selfKey &&
          !c.isDuplicate &&
          !c.isPhantom &&
          isFertile(c)
        ).slice(0, 5);

        const user = this.username;
        this.partners = candidates.map(c => ({
          ...c,
          _permitOwned: !user || user === c.author
        }));

        if (this.partners.length === 0) {
          this.$emit("notify", "No compatible partners found in recent history or cached posts.", "info");
        }
      } catch (e) {
        console.error("findPartners:", e);
        this.$emit("notify", "Partner search failed.", "error");
      }
      this.searchingPartners = false;
    },

    // Fix #9: two-step confirm — first click stages the partner, second click breeds.
    selectPartner(p) {
      if (this.pendingPartner && this.pendingPartner.permlink === p.permlink) {
        // Second click on the same card — confirmed, proceed to breed.
        // Suppress the urlB watcher kinship precheck for this programmatic set.
        // breedCreatures() will run the authoritative check once.
        this._suppressUrlBKinshipOnce = true;
        this._skipDeepKinshipOnce = true;
        this.urlB           = `https://steemit.com/@${p.author}/${p.permlink}`;
        this.pendingPartner = null;
        // BUG FIX: Pass the already-available partner card data directly so
        // breedCreatures() can skip loadGenomeFromPost(ub) — the main source
        // of the "Loading parent genome…" hang.  The matchmaker already validated
        // genus, sex, and base fertility, so the genome/age/author/permlink from
        // the card are the only fields needed for a correct breed.
        this.breedCreatures(p);
      } else {
        // First click — stage it for confirmation.
        this.pendingPartner = p;
      }
    },

    // Fix #7: reset child preview and restore matchmaker panel.
    resetBreed() {
      this.childGenome    = null;
      this.childArt       = null;
      this.childName      = null;
      this.breedInfo      = null;
      this.customTitle    = "";
      this.urlB           = "";
      this.genomeA        = null;
      this.genomeB        = null;
      this.loadError      = "";
      this.loadStatus     = "";
      this.pendingPartner = null;
      this._skipDeepKinshipOnce = false;
    },

    // ============================================================
    // EXISTING BREED LOGIC (UPDATED WITH NONCE)
    // ============================================================
    // lockedB: optional partner card object from selectPartner (has genome, author,
    //          permlink, age, effectiveOwner).  When provided, skips loadGenomeFromPost
    //          for Partner B — eliminating the main source of the matchmaker hang.
    async breedCreatures(lockedB = null) {
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
        // BUG FIX: When the creature page already loaded Parent A's data (lockedA),
        // skip the redundant loadGenomeFromPost(ua) network round-trip.  That call
        // fetches the post + all replies recursively, which was causing "Loading
        // parent genomes…" to hang indefinitely on a slow/busy single RPC node.
        // lockedA now carries age, feedState, activityState, permits, effectiveOwner
        // — everything breedCreatures needs for fertility and permit checks.
        const lockedResA = (this.lockedA && this.lockedA.genome && ua === (this.lockedA.url || "").trim())
          ? {
              genome:         this.lockedA.genome,
              author:         this.lockedA.author,
              permlink:       this.lockedA.permlink,
              age:            this.lockedA.age           ?? 0,
              feedState:      this.lockedA.feedState     || null,
              activityState:  this.lockedA.activityState || null,
              permits:        this.lockedA.permits       || null,
              effectiveOwner: this.lockedA.effectiveOwner || this.lockedA.author,
            }
          : null;

        // BUG FIX: When the partner was chosen from the matchmaker card,
        // its genome/age/author/permlink are already available in lockedB.
        // Skip loadGenomeFromPost(ub) — the call that fetches the full post +
        // all replies recursively — which was causing the hang.
        // feedState/activityState default to null (no boost); the matchmaker
        // already pre-validated base fertility.
        // For permits: include the current user in the grantees set so the
        // permit check passes optimistically — the actual on-chain permit
        // constraint is enforced at publish time by the Steem blockchain.
        const lockedResB = (lockedB && lockedB.genome)
          ? {
              genome:         lockedB.genome,
              author:         lockedB.author,
              permlink:       lockedB.permlink,
              age:            lockedB.age           ?? 0,
              feedState:      null,
              activityState:  null,
              permits:        { grantees: new Set(this.username ? [this.username] : []) },
              effectiveOwner: lockedB.effectiveOwner || lockedB.author,
            }
          : null;

        const anyNetworkLoad = !lockedResA || !lockedResB;
        this.loadStatus = anyNetworkLoad ? "Loading parent genomes…" : "Preparing breed…";
        const [resA, resB] = await Promise.all([
          lockedResA
            ? Promise.resolve(lockedResA)
            : this._withTimeout(
                loadGenomeFromPost(ua),
                15000,
                "Loading Parent A genome timed out after 15s. Please retry."
              ),
          lockedResB
            ? Promise.resolve(lockedResB)
            : this._withTimeout(
                loadGenomeFromPost(ub),
                15000,
                "Loading Parent B genome timed out after 15s. Please retry."
              )
        ]);

        // Store parent genomes for sex display before attempting breed
        this.genomeA = resA.genome;
        this.genomeB = resB.genome;

        // ---- Fertility check ----
        const checkFertility = (res, label) => {
          const g   = res.genome;
          const age = res.age;
          if (age >= g.LIF) throw new Error(
            `${label} (${res.author}) is a fossil (age ${age} ≥ lifespan ${g.LIF}). Fossils cannot breed.`
          );

          const boost      = res.feedState?.fertilityBoost || 0;
          const ext        = res.activityState?.fertilityExtension || 0;
          const windowDays = g.FRT_END - g.FRT_START;
          const boostDays  = Math.floor(windowDays * boost / 2);
          const effStart   = g.FRT_START - ext - boostDays;
          const effEnd     = g.FRT_END   + ext + boostDays;

          if (age < effStart) throw new Error(
            `${label} (${res.author}) is too young to breed (age ${age}, fertile from day ${effStart}${effStart !== g.FRT_START ? ` — extended from ${g.FRT_START} by feeding/play` : ``}).`
          );
          if (age >= effEnd) throw new Error(
            `${label} (${res.author}) is past breeding age (age ${age}, fertile until day ${effEnd}${effEnd !== g.FRT_END ? ` — extended from ${g.FRT_END} by feeding/play` : ``}).`
          );
        };
        checkFertility(resA, "Parent A");
        checkFertility(resB, "Parent B");

        // ---- Breed permit check ----
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
        // Already run at preview time (urlB watcher). Re-run here only if the
        // preview result was skipped or came back "ok" — avoids 20+ RPC calls
        // blocking the Breed button when we already have a good answer.
        if (this._skipDeepKinshipOnce) {
          this._skipDeepKinshipOnce = false;
          this.loadStatus = "";
        } else if (!this.kinshipPreview || this.kinshipPreview === "checking") {
          this.loadStatus = "Checking ancestry and family relationships…";
          try {
            const compatResult = await Promise.race([
              checkBreedingCompatibility(resA, resB),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Ancestry verification timed out after 30s. Please retry.")), 30000)
              )
            ]);
            // BUG 7 FIX: A non-null result means severed lineage (phantom ancestor).
            // Store the warning so the UI can display it; do NOT block breeding.
            if (compatResult && compatResult.severedLineage) {
              this._severedLineageWarning = compatResult.warning;
            } else {
              this._severedLineageWarning = null;
            }
          } catch (e) {
            // FIX 1C: If the check fails mid-way (e.g. 429 rate-limit or CORS
            // timeout on a public node), clear the "checking" state and surface
            // a human-readable message.  Without this the Breed button stays
            // stuck in "Verifying…" indefinitely, preventing compatible pairs
            // from ever being bred in that session.
            this.kinshipPreview = { error: e.message || String(e) };
            throw e;   // re-throw so the outer catch handles UI reset
          }
        } else if (this.kinshipPreview && this.kinshipPreview.error) {
          throw new Error(this.kinshipPreview.error);
        }
        this.loadStatus = "";

        // ---- Breed ----
        this.loadStatus = "";

        // FIX 1B: Include username and a random integer in the nonce.
        // Steem block time is 3 s.  If the user clicks Breed twice quickly the
        // second click used to produce the same nonce (urlA + urlB + Date.now())
        // because Date.now() can return the same millisecond within the same
        // JS task.  Adding this.username ensures two different users breeding the
        // same parents produce different children; the random integer ensures two
        // rapid clicks from the same user produce different genomes and permlinks.
        const nonce = this.urlA + this.urlB + (this.username || "") + Date.now() + Math.floor(Math.random() * 1e9);
        const { child, mutated, speciated } = breedGenomes(resA.genome, resB.genome, nonce);

        // BUG 7 FIX: Stamp the "Severed Lineage" trait onto the child genome if
        // a phantom ancestor was encountered during the compatibility check.
        // This is stored in json_metadata so it can be displayed on the creature
        // page without affecting any gameplay mechanics.
        if (this._severedLineageWarning) {
          child._severedLineage = true;
        }

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
      // BUG 3 FIX: Set publishing = true BEFORE any guard checks so that a
      // double-click or a race between the click handler and Keychain's async
      // response cannot dispatch two identical posts.  The flag is set
      // synchronously on the very first call — subsequent clicks hit the guard
      // below and return immediately.
      if (this.publishing) return;
      this.publishing = true;

      if (!this.username) {
        this.$emit("notify", "Please log in first.", "error");
        this.publishing = false;
        return;
      }
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        this.publishing = false;
        return;
      }
      // BUG 1 FIX: Keychain "Silent Close" — 60-second timeout for offspring publish.
      let _breedCallbackFired = false;
      const _breedTimeoutId = setTimeout(() => {
        if (_breedCallbackFired) return;
        _breedCallbackFired = true;
        this.publishing = false;
        this.$emit("notify", "Transaction timed out or was closed — please try again.", "error");
      }, 60000);

      publishOffspring(
        this.username,
        this.childGenome,
        this.childArt,
        this.childName,
        this.breedInfo,
        this.customTitle,
        generateGenusName(this.childGenome.GEN),
        (response) => {
          if (_breedCallbackFired) return;
          _breedCallbackFired = true;
          clearTimeout(_breedTimeoutId);
          this.publishing = false;
          if (response.success) {
            const childPermlink = response.permlink;
            if (typeof invalidateGlobalListCaches === "function") invalidateGlobalListCaches();
            if (typeof invalidateOwnedCachesForUser === "function") invalidateOwnedCachesForUser(this.username);

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
    <div class="sb-breed-section">
      <h3 class="sb-breed-title">🧬 Breed Creatures</h3>

      <!-- Matchmaker panel -->
      <div v-if="lockedA" style="margin-bottom:12px;">
        <button @click="findPartners" :disabled="searchingPartners" style="background:#004d40;font-size:12px;">
          🔍 {{ searchingPartners ? 'Searching...' : (childGenome ? 'Try Another Partner' : 'Find Compatible Partner') }}
        </button>

        <!-- Skeleton cards while loading -->
        <div v-if="searchingPartners" class="sb-mm-skeletons">
          <div v-for="n in 3" :key="n" class="sb-skeleton">
            <div class="sb-skeleton-line" style="width:70%;"></div>
            <div class="sb-skeleton-line-sm" style="width:50%;margin-bottom:10px;"></div>
            <div class="sb-skeleton-line-sm" style="width:85%;"></div>
            <div class="sb-skeleton-line-sm" style="width:60%;"></div>
          </div>
        </div>

        <!-- Partner cards -->
        <div v-if="!searchingPartners && partners.length" class="sb-mm-cards">
          <div v-for="p in partners" :key="p.permlink"
            @click="selectPartner(p)"
            :class="pendingPartner && pendingPartner.permlink === p.permlink ? 'sb-mm-card sb-mm-card-selected' : 'sb-mm-card sb-mm-card-default'">
            <div class="sb-mm-card-name-row">
              <div class="sb-mm-name">{{ p.name }}</div>
              <span :class="p.genome.SX === 0 ? 'sb-sex-male' : 'sb-sex-female'" style="font-size:11px;font-weight:bold;">
                {{ p.genome.SX === 0 ? '♂' : '♀' }}
              </span>
            </div>
            <div class="sb-mm-author">@{{ p.author }}</div>
            <div class="sb-mm-stats-row">
              <span :style="{ color: p.lifecycleStage ? p.lifecycleStage.color : '#888' }">
                {{ p.lifecycleStage ? p.lifecycleStage.icon + ' ' + p.lifecycleStage.name : '' }}
              </span>
              <span class="sb-mm-lif">Day {{ p.age }}</span>
            </div>
            <div class="sb-mm-window">🌸 {{ p.genome.FRT_START }}–{{ p.genome.FRT_END }}d</div>
            <div class="sb-mm-stats-row">
              <span class="sb-mm-mut">MUT {{ p.genome.MUT }}</span>
              <span class="sb-mm-lif">LIF {{ p.genome.LIF }}d</span>
            </div>
            <div v-if="username && username !== p.author && !p._permitOwned" class="sb-mm-permit">
              🔑 Permit may be needed
            </div>
            <div v-if="pendingPartner && pendingPartner.permlink === p.permlink" class="sb-mm-confirm">
              Tap again to breed ✓
            </div>
          </div>
        </div>

        <div v-if="!searchingPartners && partners.length" class="sb-mm-disclaimer">
          ⚠ Genus &amp; sex matched. Family relationships are verified at breed time.
        </div>
      </div>

      <p class="sb-breed-hint">Requires one ♂ Male and one ♀ Female of the same genus.</p>

      <div v-if="!username" class="sb-breed-gate">🔒 Log in to breed creatures.</div>

      <template v-else>
        <div class="sb-breed-inputs">
          <!-- Parent A -->
          <div class="sb-parent-input-wrap">
            <div v-if="lockedA" class="sb-parent-locked">
              <span>🔒 Parent A: <strong>{{ lockedA.name }}</strong></span>
              <span :class="lockedA.sex.startsWith('♂') ? 'sb-sex-male' : 'sb-sex-female'" style="font-size:12px;font-weight:bold;">{{ lockedA.sex }}</span>
            </div>
            <template v-else>
              <input v-model="urlA" type="text" placeholder="Parent A — Steem post URL" class="sb-input-full" />
              <span v-if="genomeA" class="sb-sex-badge-abs" :class="genomeA.SX === 0 ? 'sb-sex-male' : 'sb-sex-female'">{{ parentASex }}</span>
            </template>
          </div>

          <!-- Parent B -->
          <div class="sb-parent-input-wrap">
            <input v-model="urlB" type="text" placeholder="Parent B — Steem post URL" class="sb-input-full" />
            <!-- Fix 3b: early kinship preview shown inline under the URL field -->
            <div v-if="kinshipPreview === 'checking'"
              style="font-size:0.75rem;color:#888;margin-top:4px;">
              🔬 Checking kinship…
            </div>
            <div v-else-if="kinshipPreview === 'ok'"
              style="font-size:0.75rem;color:#66bb6a;margin-top:4px;">
              ✅ No kinship conflicts — compatible pair.
            </div>
            <div v-else-if="kinshipPreview && kinshipPreview.error"
              style="font-size:0.75rem;color:#ff8a80;margin-top:4px;">
              ⚠ {{ kinshipPreview.error }}
            </div>
            <span v-if="genomeB" class="sb-sex-badge-abs" :class="genomeB.SX === 0 ? 'sb-sex-male' : 'sb-sex-female'">{{ parentBSex }}</span>
          </div>

          <!-- FIX 3 (Kinship Deadlock): Disable the Breed button while a background
               kinship check is already running (kinshipPreview === 'checking').
               Without this guard, clicking Breed during the 800ms debounce window
               triggers a second full ancestor walk — doubling RPC load and creating
               a race condition where loadStatus can be overwritten mid-flight. -->
          <button @click="breedCreatures"
            :disabled="loading || kinshipPreview === 'checking'"
            :title="kinshipPreview === 'checking' ? 'Kinship check in progress — please wait…' : ''"
            class="sb-btn-breed">
            {{ loading ? 'Checking…' : kinshipPreview === 'checking' ? '🔬 Verifying…' : '🔬 Breed' }}
          </button>
        </div>

        <div v-if="loadStatus" class="sb-breed-status">⏳ {{ loadStatus }}</div>
        <div v-if="loadError"  class="sb-breed-error">⚠ {{ loadError }}</div>

        <div v-if="childGenome" class="sb-child-preview">
          <!-- BUG 7 FIX: Severed Lineage warning — shown instead of a hard error when
               a phantom (deleted) ancestor is found.  Breeding is allowed; the child
               carries the trait permanently on-chain as json_metadata._severedLineage. -->
          <div v-if="_severedLineageWarning"
            style="margin-bottom:12px;padding:10px 14px;border-radius:8px;
                   background:#1a1200;border:1px solid #7a5800;color:#ffe082;font-size:12px;line-height:1.5;">
            🌿 {{ _severedLineageWarning }}
          </div>
          <div class="sb-child-title">🧬 {{ childName }}</div>
          <div class="sb-child-subtitle">
            {{ sexLabel }} &nbsp;·&nbsp;
            <span :style="{ color: mutationColor }">{{ mutationLabel }}</span>
          </div>
          <pre>{{ childArt }}</pre>
          <div class="sb-genome-summary">
            GEN {{ childGenome.GEN }} &nbsp;·&nbsp; MOR {{ childGenome.MOR }}
            &nbsp;·&nbsp; APP {{ childGenome.APP }} &nbsp;·&nbsp; ORN {{ childGenome.ORN }}
            &nbsp;·&nbsp; MUT {{ childGenome.MUT }} &nbsp;·&nbsp; LIF {{ childGenome.LIF }} days
          </div>
          <div class="sb-post-title-wrap">
            <label class="sb-form-label">Post title</label>
            <input v-model="customTitle" type="text" maxlength="255" class="sb-input-full" />
          </div>
          <div class="sb-breed-actions">
            <button @click="resetBreed" class="sb-btn-grey">↩ Try Different Partner</button>
            <button @click="publishChild" :disabled="publishing || !username" class="sb-btn-blue">
              {{ publishing ? "Publishing…" : "📡 Publish Offspring to Steem" }}
            </button>
          </div>
          <!-- BUG 3 FIX: Full-panel overlay while Keychain request is in-flight.
               Prevents any further interaction (including double-clicks on the
               Publish button) until the route changes on success. -->
          <div v-if="publishing"
            style="position:absolute;inset:0;z-index:10;border-radius:10px;
                   background:rgba(0,0,0,0.65);display:flex;flex-direction:column;
                   align-items:center;justify-content:center;gap:10px;">
            <div style="font-size:1.5rem;">⏳</div>
            <div style="color:#a5d6a7;font-weight:bold;font-size:0.95rem;">Transaction Pending…</div>
            <div style="color:#888;font-size:0.8rem;">Please confirm in Steem Keychain</div>
          </div>
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
      // BUG 2 FIX: Strip leading @ and whitespace; validate Steem username format.
      const grantee = this.granteeInput.trim().replace(/^@+/, "").trim().toLowerCase();
      if (!grantee) {
        this.$emit("notify", "Please enter a username to grant a permit to.", "error");
        return;
      }
      if (!/^[a-z0-9.-]+$/.test(grantee)) {
        this.$emit("notify", "Invalid username — only lowercase letters, digits, dots, and hyphens are allowed.", "error");
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
    <div class="sb-panel-wrap">
      <div @click="expanded = !expanded" class="sb-collapsible-header sb-collapsible-header-green">
        <span class="sb-collapsible-label-green">
          🔑 Breed Permits
          <span class="sb-collapsible-meta">{{ hasGrantees ? currentGrantees.length + ' active' : 'none granted' }}</span>
        </span>
        <span class="sb-collapsible-toggle">{{ expanded ? '▲ collapse' : '▼ manage' }}</span>
      </div>

      <div v-if="expanded" class="sb-collapsible-body-green">
        <p class="sb-panel-hint">
          This creature is <strong style="color:#888;">closed to external breeding by default.</strong>
          Grant a named permit to let another user use it as a parent.
          Permits are recorded permanently on-chain; revocations are also on-chain.
        </p>

        <div v-if="hasGrantees" style="margin-bottom:14px;">
          <div class="sb-kinship-sublabel">Active Permits</div>
          <div v-for="g in currentGrantees" :key="g" class="sb-permit-grantee-row" style="margin-bottom:5px;">
            <span class="sb-permit-grantee-name">@{{ g }}</span>
            <button @click="revokePermit(g)" :disabled="publishing" class="sb-btn-revoke">Revoke</button>
          </div>
        </div>
        <div v-else class="sb-no-data" style="margin-bottom:14px;">No permits granted yet.</div>

        <div class="sb-kinship-sublabel" style="margin-bottom:8px;">Grant New Permit</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <input v-model="granteeInput" type="text" placeholder="Steem username (without @)"
            class="sb-input-full" @keydown.enter="grantPermit" />
          <div class="sb-permit-input-row">
            <label class="sb-panel-hint" style="margin:0;white-space:nowrap;">Expires in</label>
            <input v-model.number="expiresDays" type="number" min="0" step="1" placeholder="days"
              style="font-size:13px;width:80px;text-align:center;" />
            <span style="font-size:0.78rem;color:#444;">days &nbsp;(0 = no expiry)</span>
          </div>
          <button @click="grantPermit" :disabled="publishing || !granteeInput.trim()" class="sb-btn-accept">
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
    hasHistory()      { return this.transferHistory.length > 0; },
    // FIX 5 — Recipient self-check: computed so the UI reacts the instant the
    // user types their own name — no button click required.
    isSelfTransfer() {
      const r = this.recipientInput.trim().toLowerCase();
      return !!r && !!this.username && r === this.username.toLowerCase();
    }
  },
  methods: {
    async sendOffer() {
      // BUG 2 FIX: Strip leading @ and surrounding whitespace so that a user who
      // copies "@alice" from a Steem profile gets the same result as typing "alice".
      // Also enforce the Steem username regex before hitting the chain.
      const raw = this.recipientInput.trim().replace(/^@+/, "").trim().toLowerCase();
      if (!raw) {
        this.$emit("notify", "Please enter a recipient username.", "error");
        return;
      }
      if (!/^[a-z0-9.-]+$/.test(raw)) {
        this.$emit("notify", "Invalid username — only lowercase letters, digits, dots, and hyphens are allowed.", "error");
        return;
      }
      const to = raw;
      if (to === this.username) {
        this.$emit("notify", "You cannot transfer to yourself.", "error");
        return;
      }
      if (!window.steem_keychain) {
        this.$emit("notify", "Steem Keychain is not installed.", "error");
        return;
      }

      // FIX 8 (Transfer Handshake): Verify the recipient account exists on-chain
      // BEFORE publishing the offer.  If the user typos the name (e.g. @hubbit vs
      // @hibbit) the creature gets permanently locked in "Pending Transfer" state
      // until the owner manually cancels — a very poor UX.  A getAccounts call
      // costs ~100ms and prevents this entire class of stuck-creature bugs.
      this.publishing = true;
      try {
        const accounts = await new Promise((resolve, reject) => {
          steem.api.getAccounts([to], (err, res) =>
            err ? reject(err) : resolve(res)
          );
        });
        if (!accounts || accounts.length === 0 || accounts[0]?.name !== to) {
          this.$emit("notify",
            `@${to} does not exist on Steem. Please double-check the username.`,
            "error"
          );
          this.publishing = false;
          return;
        }
      } catch (e) {
        this.$emit("notify",
          "Could not verify recipient account — check your connection and try again.",
          "error"
        );
        this.publishing = false;
        return;
      }

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
      if (!this.pendingOffer) return;

      // FIX 2B: Transfer "Handshake" Deadlock.
      // If the recipient clicks "Accept" at almost the same time the owner clicks
      // "Cancel", block inclusion order determines which wins.  If the Accept wins,
      // the creature has already moved wallets — but the previous owner's UI still
      // shows "Cancelling…" until a hard refresh.  We defend against this by
      // re-fetching the chain state before opening Keychain: if the offer is already
      // gone (accepted or replaced), abort immediately and sync the local state.
      this.publishing = true;
      try {
        const freshReplies = await fetchAllReplies(this.creatureAuthor, this.creaturePermlink);
        const freshChain   = parseOwnershipChain(freshReplies, this.creatureAuthor);
        if (!freshChain.pendingOffer ||
            freshChain.pendingOffer.offerPermlink !== this.pendingOffer.offerPermlink) {
          // Offer is already gone — update local state and bail out.
          this.$emit("notify",
            "⚠️ The offer is no longer active (it may have already been accepted or replaced). Refreshing state.",
            "error"
          );
          this.$emit("transfer-updated", freshChain);
          this.publishing = false;
          return;
        }
      } catch (e) {
        // Non-fatal: node failure — let the cancel proceed rather than blocking it.
        console.warn("SteemBiota: pre-flight cancel check failed:", e);
      }

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

      // FIX 2 — "Handshake" pre-flight check.
      // The owner may have re-offered to someone else (which implicitly cancels this
      // offer) between the time this user loaded the page and now.  If we let the
      // Keychain popup open first, the user spends RC signing a transaction that the
      // protocol will silently discard — a confusing "Success but nothing happened"
      // experience.  Instead, fetch the freshest reply set and re-parse the ownership
      // chain; only proceed if the current pending offer still matches ours.
      const cachedOfferPermlink = this.pendingOffer.offerPermlink;
      this.publishing = true;
      try {
        const freshReplies = await fetchAllReplies(this.creatureAuthor, this.creaturePermlink);
        const freshChain   = parseOwnershipChain(freshReplies, this.creatureAuthor);
        if (
          !freshChain.pendingOffer ||
          freshChain.pendingOffer.offerPermlink !== cachedOfferPermlink ||
          freshChain.pendingOffer.to !== this.username
        ) {
          this.$emit(
            "notify",
            "⚠️ This offer is no longer active — the owner may have sent a new offer or cancelled it. Please refresh the page.",
            "error"
          );
          this.publishing = false;
          return;
        }
      } catch (e) {
        // Non-fatal: if we can't verify, warn the user but still let them proceed
        // rather than permanently blocking the accept flow on a flaky node.
        console.warn("SteemBiota: pre-flight ownership check failed:", e);
        this.$emit(
          "notify",
          "⚠️ Could not verify offer status — your connection may be unstable. Proceeding anyway.",
          "error"
        );
        // A short delay so the user can read the warning before Keychain opens.
        await new Promise(r => setTimeout(r, 1800));
      }

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
    <div class="sb-panel-wrap">

      <!-- RECIPIENT VIEW -->
      <div v-if="isPendingRecipient && pendingOffer" class="sb-transfer-offer-box">
        <div class="sb-transfer-offer-title">🤝 Ownership Transfer Offer</div>
        <p class="sb-transfer-offer-body">
          @{{ pendingOffer.offeredBy || "The current owner" }} is offering to transfer
          <strong style="color:#eee;">{{ creatureName }}</strong> to you.
          Accepting is permanent and recorded on-chain.
          All previous breed permits will be voided — you start fresh.
        </p>
        <div class="sb-transfer-offer-actions">
          <button @click="acceptOffer" :disabled="publishing" class="sb-btn-accept">
            {{ publishing ? "Publishing…" : "✅ Accept Ownership" }}
          </button>
          <button @click="$emit('notify', 'To decline, simply ignore the offer. The sender can cancel it at any time.', 'info')"
            class="sb-btn-decline">ℹ️ How to decline</button>
        </div>
      </div>

      <!-- OWNER VIEW -->
      <template v-if="isOwner">
        <div @click="expanded = !expanded" class="sb-collapsible-header sb-collapsible-header-teal">
          <span class="sb-collapsible-label-teal">
            🤝 Transfer Ownership
            <span v-if="pendingOffer" class="sb-pending-warn">⏳ offer pending → @{{ pendingOffer.to }}</span>
            <span v-else-if="hasHistory" class="sb-collapsible-meta">{{ transferHistory.length }} transfer{{ transferHistory.length === 1 ? "" : "s" }} on record</span>
            <span v-else class="sb-collapsible-meta">original owner</span>
          </span>
          <span class="sb-collapsible-toggle">{{ expanded ? "▲ collapse" : "▼ manage" }}</span>
        </div>

        <div v-if="expanded" class="sb-collapsible-body-teal">
          <p class="sb-panel-hint">
            Transfers are two-sided: you send an offer, the recipient must accept on-chain.
            All breed permits are voided on transfer — the new owner starts fresh.
            The original <code style="color:#444;">post.author</code> never changes on-chain;
            SteemBiota derives the effective owner from the signed reply history.
          </p>

          <!-- Pending offer -->
          <div v-if="pendingOffer" style="padding:12px;border-radius:8px;background:#1a1200;border:1px solid #3a2800;margin-bottom:14px;">
            <div style="font-size:0.80rem;color:#ffb74d;font-weight:bold;margin-bottom:6px;">⏳ Pending offer → @{{ pendingOffer.to }}</div>
            <p style="font-size:0.75rem;color:#888;margin:0 0 10px;">Waiting for @{{ pendingOffer.to }} to accept on-chain. You can cancel this offer at any time.</p>
            <button @click="cancelOffer" :disabled="publishing" class="sb-btn-revoke" style="font-size:0.78rem;">
              {{ publishing ? "Publishing…" : "❌ Cancel Offer" }}
            </button>
          </div>

          <!-- New offer form -->
          <template v-else>
            <div class="sb-kinship-sublabel" style="margin-bottom:8px;">Send Transfer Offer</div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              <input v-model="recipientInput" type="text" placeholder="Recipient username (without @)"
                class="sb-input-full" @keydown.enter="sendOffer" />
              <!-- FIX 5 — Inline self-transfer warning: shown reactively as the user
                   types, before they can even click the button. -->
              <p v-if="isSelfTransfer"
                style="font-size:0.72rem;color:#ff8a80;margin:0;padding:5px 8px;
                       background:#2a0000;border:1px solid #5a1a1a;border-radius:5px;">
                ⚠ You cannot transfer a creature to yourself.
              </p>
              <p style="font-size:0.72rem;color:#444;margin:0;">
                ⚠ This cannot be undone unless the recipient declines (never accepts).
                The offer stays open until they accept or you cancel it.
              </p>
              <!-- FIX 5 — Disable Send Offer when recipient is self (isSelfTransfer). -->
              <button @click="sendOffer" :disabled="publishing || !recipientInput.trim() || isSelfTransfer" style="background:#0d1a2e;">
                {{ publishing ? "Publishing…" : "🤝 Send Offer" }}
              </button>
            </div>
          </template>

          <!-- Transfer history -->
          <template v-if="hasHistory">
            <div class="sb-kinship-sublabel sb-kinship-sublabel-spaced">Transfer History</div>
            <div v-for="(t, i) in transferHistory" :key="i"
              style="font-size:0.75rem;color:#555;padding:5px 0;border-bottom:1px solid #111;display:flex;gap:8px;align-items:center;">
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

      <div v-if="socialLoading" style="text-align:center;padding:12px 0;">
        <span class="sb-no-data">Loading social data…</span>
      </div>

      <template v-else>
        <div>
          <div @click="commentsExpanded = !commentsExpanded"
            style="display:flex;align-items:center;justify-content:space-between;
                   cursor:pointer;padding:9px 14px;border-radius:8px;
                   background:#0a0a0a;border:1px solid #1e1e1e;user-select:none;">
            <span style="font-size:0.85rem;color:#a5d6a7;">
              💬 <strong>{{ commentCount }}</strong> Comment{{ commentCount === 1 ? "" : "s" }}
            </span>
            <span class="sb-no-data">{{ commentsExpanded ? "▲" : "▼" }}</span>
          </div>

          <div v-if="commentsExpanded" style="border:1px solid #1e1e1e;border-top:none;border-radius:0 0 8px 8px;background:#080808;padding:14px;">
            <div v-if="username" style="margin-bottom:14px;">
              <textarea v-model="commentText" placeholder="Write a comment…" rows="3"
                style="width:100%;font-size:13px;background:#0f0f0f;color:#ccc;
                       border:1px solid #2a2a2a;border-radius:6px;padding:8px;
                       resize:vertical;font-family:inherit;box-sizing:border-box;"
                @keydown.ctrl.enter="submitComment"></textarea>
              <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:6px;">
                <span class="sb-no-data" style="font-size:0.68rem;">Ctrl+Enter to post</span>
                <button @click="submitComment" :disabled="submitting || !commentText.trim()"
                  style="background:#1a2a1a;font-size:0.8rem;padding:5px 14px;">
                  {{ submitting ? "Publishing…" : "Post" }}
                </button>
              </div>
            </div>
            <div v-else class="sb-no-data" style="margin-bottom:12px;">Log in to leave a comment.</div>

            <div v-if="commentCount === 0" class="sb-no-data">
              {{ username ? "No comments yet." : "No comments yet. Be the first!" }}
            </div>

            <div v-for="(c, i) in socialComments" :key="c.permlink || i"
              style="padding:10px 0;border-bottom:1px solid #111;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
                <a :href="profileUrl(c.author)" style="font-size:0.82rem;font-weight:bold;color:#80cbc4;text-decoration:none;">@{{ c.author }}</a>
                <span style="font-size:0.68rem;color:#333;">{{ timeAgo(c.created) }} ago</span>
              </div>
              <div style="font-size:0.82rem;color:#aaa;line-height:1.5;white-space:pre-wrap;word-break:break-word;">{{ formatBody(c.body) }}</div>
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
    // FIX 6 (Fossil Blind-Spot): Passed from CreatureView so the panel can
    // suppress the "Equip" form while still showing worn items with a Remove
    // button — allowing owners to retrieve accessories from fossilised creatures.
    fossil:           { type: Boolean, default: false },
  },
  emits: ["notify", "wearings-updated"],
  // Note: ClosetThumbComponent is registered globally in app.js (vueApp.component).
  // A local components: { ClosetThumbComponent } here would crash because accessories.js
  // (where ClosetThumbComponent is defined) loads AFTER components.js in index.html.

  data() {
    return {
      expanded:      false,
      accUrlInput:   "",
      publishing:    false,
      checkingUrl:   false,
      previewAcc:    null,
      previewError:  "",

      // --- CLOSET ---
      closetSearch:       "",
      closet:             [],
      loadingCloset:      false,
      // FIX 1 (Closet Performance): Limit initial render to 20 items.
      // Each AccessoryCanvasComponent allocates a 2D canvas backing store on the GPU.
      // Mounting 100+ simultaneously causes GPU memory exhaustion and severe jank
      // on mobile. We slice the filtered list to closetVisibleCount and expose a
      // "Load More" button that extends the window in increments of 20.
      closetVisibleCount: 20,
    };
  },

  computed: {
    hasWearings() { return this.wearings.length > 0; },
    lapsingWearings() { return this.wearings.filter(w => w.permissionLapsed); },
    // FIX 1: _allFilteredCloset holds the complete search-filtered list (used for
    // the "Load More" badge count).  filteredCloset is the sliced visible window —
    // the one the template v-for iterates, which caps instantiated canvases at 20.
    _allFilteredCloset() {
      if (!this.closetSearch) return this.closet;
      const q = this.closetSearch.toLowerCase();
      return this.closet.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.template.toLowerCase().includes(q)
      );
    },
    filteredCloset() {
      return this._allFilteredCloset.slice(0, this.closetVisibleCount);
    },
    closetHasMore() {
      return this._allFilteredCloset.length > this.closetVisibleCount;
    },
    closetHiddenCount() {
      return Math.max(0, this._allFilteredCloset.length - this.closetVisibleCount);
    },
  },

  watch: {
    accUrlInput() {
      this.previewAcc   = null;
      this.previewError = "";
    },
    expanded(isExpanded) {
      if (isExpanded && this.username) this.loadCloset();
    },
    // FIX 4 (Ghost Accessory State): Reset all transient equip-panel UI when the
    // user navigates from one creature to another. Without this, a "Success" notif
    // or accessory preview from Creature A lingers visually on Creature B's page.
    creaturePermlink(newVal, oldVal) {
      if (newVal === oldVal) return;
      this.expanded           = false;
      this.accUrlInput        = "";
      this.previewAcc         = null;
      this.previewError       = "";
      this.closet             = [];
      this.closetVisibleCount = 20;
      this.closetSearch       = "";
    },
    // FIX 1: Reset visible window whenever the search query changes so that
    // typing a new filter always starts from the first page of results.
    closetSearch() {
      this.closetVisibleCount = 20;
    },
  },

  methods: {
    async loadCloset() {
      this.loadingCloset = true;
      // FIX 1: Reset visible window each time the closet is (re)loaded so a
      // returning user doesn't inherit a stale large window from a previous session.
      this.closetVisibleCount = 20;
      try {
        const items = await fetchAccessoriesOwnedBy(this.username);

        // exclude already worn
        const currentKeys = new Set(
          this.wearings.map(w => `${w.accAuthor}/${w.accPermlink}`)
        );

        this.closet = items.filter(
          i => !currentKeys.has(`${i.author}/${i.permlink}`)
        );
      } catch (e) {
        console.warn(e);
      }
      this.loadingCloset = false;
    },

    // FIX 1: Expose 20 more closet items per click.
    loadMoreCloset() {
      this.closetVisibleCount += 20;
    },

    selectFromCloset(item) {
      this.accUrlInput = `https://steemit.com/@${item.author}/${item.permlink}`;
      this.checkAccessory();
    },

    // FIX 5 (Zero-Width Space Trap): Strip hidden Unicode characters and trailing
    // query params/fragments before parsing.  Some Steem front-ends append
    // ?node=... or trailing slashes when the user copies a URL from the address bar.
    // The old \s*$ anchor rejected any URL with a trailing param, silently breaking
    // the equip flow.  The new regex finds the FIRST @author/permlink match anywhere
    // in the string, so extra suffixes are ignored rather than causing a hard error.
    parseAccUrl(raw) {
      // Remove zero-width spaces (U+200B–U+200D, U+FEFF) that clipboard sometimes injects.
      const cleaned = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
      const m = cleaned.match(/@([a-z0-9.-]+)\/([a-z0-9-]+)/i);
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

        // 1. Validate post
        const post = await fetchPost(author, permlink);
        if (!post || !post.author)
          throw new Error("Accessory post not found.");

        let meta = {};
        try { meta = JSON.parse(post.json_metadata || "{}"); } catch {}

        if (meta.steembiota?.type !== "accessory")
          throw new Error("This post is not a SteemBiota accessory.");

        const accData = meta.steembiota.accessory;

        // 2. Permissions
        const accReplies = await fetchAllReplies(author, permlink);
        const perms = parseAccessoryPermissions(accReplies, author);

        if (!isWearPermitted(perms, this.username)) {
          throw new Error(
            "You don't have permission to wear this. Visit the accessory page to request it."
          );
        }

        // 3. Exclusivity
        const busyCreature = await findCreatureWearingAccessory(
          this.username,
          author,
          permlink
        );

        if (busyCreature) {
          throw new Error(
            `This accessory is already being worn by ${busyCreature}. You must remove it there first.`
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

      const { accAuthor, accPermlink, accName } = this.previewAcc;
      // FIX 4A (Double-Spend Accessory Trap): Use a module-level Set to track
      // accessory IDs whose wear_on transaction is currently in-flight across ALL
      // component instances (including other browser tabs via BroadcastChannel).
      // The blockchain "is it busy?" check has a race condition: if the user has
      // two tabs open for two different creatures, both can pass the check before
      // the first Steem block confirms the transaction.  We mitigate this by
      // disabling the Equip button for this accPermlink the moment we broadcast,
      // and clearing it once the callback fires (success or failure).
      //
      // BUG 3 FIX (Cross-Tab Double-Spend): window._sbPendingEquips only guards
      // within the same JS context.  A second browser tab has its own window
      // object and its own Set, so both tabs can pass the in-flight check
      // simultaneously and broadcast two wear_on ops for the same accessory.
      //
      // Fix: Use the BroadcastChannel API (supported in all modern browsers) to
      // notify every other same-origin tab the instant we claim an accessory.
      // Other tabs listen on mount and add the accKey to their own local Set,
      // preventing a second equip attempt even if the blockchain hasn't confirmed
      // yet.  The claim is released (and a release message broadcast) when the
      // Keychain callback fires, regardless of success or failure.
      if (!window._sbPendingEquips) window._sbPendingEquips = new Set();
      if (!window._sbEquipChannel) {
        try {
          window._sbEquipChannel = new BroadcastChannel("sb_equip_lock");
          window._sbEquipChannel.onmessage = (evt) => {
            if (!window._sbPendingEquips) window._sbPendingEquips = new Set();
            if (evt.data?.type === "claim"   && evt.data.key) window._sbPendingEquips.add(evt.data.key);
            if (evt.data?.type === "release" && evt.data.key) window._sbPendingEquips.delete(evt.data.key);
          };
        } catch {
          // BroadcastChannel not available (e.g. file:// origin in some browsers).
          // Fall back gracefully — single-tab guard still applies.
          window._sbEquipChannel = null;
        }
      }

      const accKey = `${accAuthor}/${accPermlink}`;
      if (window._sbPendingEquips.has(accKey)) {
        this.$emit("notify", "A wear transaction for this accessory is already in progress — please wait.", "error");
        return;
      }
      // Claim locally and broadcast to all other tabs before any async work.
      window._sbPendingEquips.add(accKey);
      try { window._sbEquipChannel?.postMessage({ type: "claim", key: accKey }); } catch {}

      this.publishing = true;

      publishWearOn(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        accAuthor,
        accPermlink,
        accName,
        (res) => {
          this.publishing = false;
          // Release the cross-tab lock regardless of success/failure.
          window._sbPendingEquips && window._sbPendingEquips.delete(accKey);
          try { window._sbEquipChannel?.postMessage({ type: "release", key: accKey }); } catch {}

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

            this.loadCloset(); // refresh closet
          } else {
            this.$emit(
              "notify",
              "Equip failed: " + (res.message || "Unknown error"),
              "error"
            );
          }
        }
      );
    },

    // FIX 2 (Z-Order): Let the owner reorder accessory layers.
    // The wearings array index determines draw order in _normalizedWearings().
    // Moving an item earlier in the array brings it visually forward (drawn last = on top).
    moveWearingUp(index) {
      if (index === 0) return;
      const ws = [...this.wearings];
      [ws[index - 1], ws[index]] = [ws[index], ws[index - 1]];
      this.$emit('wearings-updated', ws);
    },
    moveWearingDown(index) {
      if (index >= this.wearings.length - 1) return;
      const ws = [...this.wearings];
      [ws[index], ws[index + 1]] = [ws[index + 1], ws[index]];
      this.$emit('wearings-updated', ws);
    },

    async removeAccessory(w) {
      if (!window.steem_keychain) return;

      this.publishing = true;

      publishWearOff(
        this.username,
        this.creatureAuthor,
        this.creaturePermlink,
        this.creatureName,
        w.accAuthor,
        w.accPermlink,
        w.accName,
        (res) => {
          this.publishing = false;

          if (res.success) {
            this.$emit("notify", `👚 ${w.accName} removed.`, "success");

            this.$emit(
              "wearings-updated",
              this.wearings.filter(
                x =>
                  x.accPermlink !== w.accPermlink ||
                  x.accAuthor !== w.accAuthor
              )
            );

            this.loadCloset(); // refresh closet
          } else {
            this.$emit(
              "notify",
              "Remove failed: " + (res.message || "Unknown error"),
              "error"
            );
          }
        }
      );
    },
  },

  template: `
    <div class="sb-equip-wrap">

      <!-- WORN -->
      <div v-if="hasWearings" class="sb-worn-section">
        <div class="sb-worn-header">
          <span class="sb-worn-label">✨ Worn Accessories</span>
          <span class="sb-worn-count">{{ wearings.length }}</span>
        </div>
        <div class="sb-worn-list">
          <div v-for="(w, wi) in wearings" :key="w.accAuthor+'/'+w.accPermlink" class="sb-worn-item">
            <accessory-canvas-component :template="w.template" :genome="w.genome" :canvas-w="80" :canvas-h="64" />
            <div class="sb-worn-item-info">
              <div class="sb-worn-item-name">{{ w.accName }}</div>
              <div v-if="w.permissionLapsed" class="sb-worn-lapsed">⚠ Lapsed</div>
            </div>
            <!-- FIX 2 (Z-Order): Layer reorder controls. "Up" = drawn later = visually on top.
                 The first item in the array is rendered last, so it appears in front. -->
            <div v-if="isOwner && wearings.length > 1" style="display:flex;flex-direction:column;gap:2px;margin-right:4px;">
              <button @click="moveWearingUp(wi)" :disabled="wi === 0 || publishing"
                title="Move layer forward (draw on top)"
                style="font-size:10px;padding:1px 5px;background:#111;color:#888;border:1px solid #2a2a2a;">▲</button>
              <button @click="moveWearingDown(wi)" :disabled="wi === wearings.length - 1 || publishing"
                title="Move layer backward (draw behind)"
                style="font-size:10px;padding:1px 5px;background:#111;color:#888;border:1px solid #2a2a2a;">▼</button>
            </div>
            <button v-if="isOwner" @click="removeAccessory(w)" :disabled="publishing">👚 Remove</button>
          </div>
        </div>
      </div>

      <!-- EQUIP -->
      <!-- BUG FIX 8 (Fossil Accessory Retrieval UX): Hide the full equip form for
           fossilised creatures.  Fossils can no longer equip new accessories, but
           the CURRENT OWNER (who may be a new owner after a transfer) can still
           Remove accessories that were worn at time of death to return them to their
           closet.  The notice now explicitly addresses the transfer case so a new
           owner who received a fossil doesn't think their accessories are lost
           forever — it calls out the "Remove" button above and explains that the
           accessory will be returned to their closet after removal.
           BUG 2 FIX (Fossil Accessory Retrieval UX Paradox): Also explicitly list
           any accessories whose permissionLapsed=true — these no longer render on
           the canvas and are easily missed, yet they are still trapped in the fossil
           metadata and must be removed to return them to the closet. -->
      <div v-if="fossil && isOwner" class="sb-fossil-equip-notice"
        style="margin:10px 0;padding:10px 14px;border-radius:8px;background:#111;border:1px solid #2a2a2a;font-size:0.80rem;color:#666;">
        🦴 This creature is a fossil — it can no longer wear new accessories.<br>
        <span style="color:#80cbc4;">
          Any accessories shown above are still equipped and can be retrieved.
          Use the <strong style="color:#e0e0e0;">👚 Remove</strong> button next to each item to return it to your closet.
        </span>
        <span v-if="hasWearings" style="display:block;margin-top:6px;color:#ffb74d;">
          ⚠ {{ wearings.length }} accessory{{ wearings.length !== 1 ? 'ies are' : ' is' }} currently trapped in this fossil — remove {{ wearings.length !== 1 ? 'them' : 'it' }} to recover {{ wearings.length !== 1 ? 'them' : 'it' }}.
        </span>
        <!-- BUG 2 FIX: List lapsed accessories separately — they are invisible on the
             canvas because permissionLapsed=true hides them from rendering, so the
             owner might not realise they are still locked in the fossil's metadata.
             Naming them explicitly here ensures the owner knows they must click Remove
             on each one to get it back into their closet. -->
        <div v-if="wearings.some(w => w.permissionLapsed)" style="margin-top:8px;padding:8px 10px;border-radius:6px;background:#1a1000;border:1px solid #4a3000;color:#ffb74d;font-size:0.78rem;">
          ⚠ The following accessories have <strong>lapsed permissions</strong> — they are no longer visible on the canvas but are still equipped. Scroll up and use 👚 Remove to recover them:
          <ul style="margin:6px 0 0 14px;padding:0;">
            <li v-for="w in wearings.filter(x => x.permissionLapsed)" :key="w.accAuthor+'/'+w.accPermlink" style="margin:2px 0;">
              <strong style="color:#e0e0e0;">{{ w.accName }}</strong>
              <span style="color:#555;font-size:0.72rem;"> (@{{ w.accAuthor }}/{{ w.accPermlink }})</span>
            </li>
          </ul>
        </div>
      </div>
      <template v-if="isOwner && username && !fossil">
        <div @click="expanded=!expanded" class="sb-equip-toggle">
          🧢 Equip an Accessory {{ expanded ? "▲" : "▼" }}
        </div>

        <div v-if="expanded" class="sb-equip-body">
          <!-- CLOSET -->
          <div style="margin-bottom:12px;">
            <div class="sb-closet-header">
              <span class="sb-closet-label">👜 Your Closet</span>
              <input v-model="closetSearch" placeholder="Filter by name..." class="sb-closet-search" />
            </div>
            <div v-if="loadingCloset" class="sb-dimmer">Loading...</div>
            <div v-else-if="filteredCloset.length === 0" class="sb-closet-empty">No matching items...</div>
            <div v-else class="sb-closet-scroll">
              <!-- FIX 2A (Closet Canvas Explosion): Use ClosetThumbComponent (static <img> via
                   toDataURL) instead of AccessoryCanvasComponent (live GPU canvas) for each
                   closet item.  At 60+ items the old approach exhausted mobile GPU context limits
                   and caused silent canvas-lost errors.  The thumb renders once and discards the
                   offscreen canvas immediately — zero GPU contexts remain active. -->
              <div v-for="item in filteredCloset" :key="item.permlink" @click="selectFromCloset(item)" style="cursor:pointer;text-align:center;">
                <closet-thumb-component :template="item.template" :genome="item.genome" :canvas-w="58" :canvas-h="46" />
                <div style="font-size:10px;color:#888;">{{ item.name }}</div>
              </div>
            </div>
            <!-- FIX 1: Load More button — only rendered when the full filtered list
                 exceeds the current visible window. Tapping it extends the slice by 20,
                 instantiating only the next page of canvases rather than all at once. -->
            <button v-if="closetHasMore" @click="loadMoreCloset"
              style="margin-top:8px;width:100%;font-size:11px;background:#111;color:#888;border:1px solid #2a2a2a;">
              ⬇ Load {{ closetHiddenCount }} more…
            </button>
          </div>

          <!-- INPUT -->
          <input v-model="accUrlInput" @keydown.enter="checkAccessory" style="width:100%;font-size:13px;" />
          <button @click="checkAccessory" :disabled="checkingUrl">{{ checkingUrl ? "Checking…" : "Check" }}</button>

          <div v-if="previewError" class="sb-equip-error">⚠ {{ previewError }}</div>

          <div v-if="previewAcc" style="margin-top:8px;">
            <accessory-canvas-component :template="previewAcc.template" :genome="previewAcc.genome" :canvas-w="80" :canvas-h="64" />
            <div class="sb-equip-preview-name">{{ previewAcc.accName }}</div>
            <!-- FIX 4A: Also disable when accKey is in the session-level pending equips set -->
            <button @click="equipAccessory"
              :disabled="publishing || ($root._sbPendingEquips && $root._sbPendingEquips.has(previewAcc.accAuthor+'/'+previewAcc.accPermlink))">🧢 Equip</button>
          </div>
        </div>
      </template><!-- end v-if isOwner && username && !fossil -->
    </div>
  `
};
