/* ===== Tunnel Flyer — game logic =====
   A real-time pseudo-3D tunnel drawn with plain canvas 2D: the world is
   stored in 3D coordinates and projected by hand (sx = cx + x * f / z).
   No libraries, no image assets.
   - Steer with keys or pointer; the octagonal tunnel bends on its own and
     the ship crashes into walls or the floating orange hazard blocks that
     partially fill it. Gold rings = bonus points.
   - The tunnel is PROCEDURAL: axis wander is a pure function of z, blocks
     and rings are hashed from their index, so the whole world rebuilds
     identically from the distance alone. That is what makes the run
     save/resume trivial.
   - gc-flyer-stats: {best, muted}. gc-flyer-run: {dist, ax, ay, rings}. */
(function () {
  "use strict";

  // ---------- Canvas / world constants ----------
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var W = 640, H = 400;                 // logical units, DPR-scaled below
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  var SIDES = 8;                        // octagonal cross-section
  var SEG = 24;                         // tunnel ring spacing (world units)
  var VIEW = 48;                        // rings drawn into the distance
  var R = 140;                          // tunnel radius
  var FOCAL = 360;                      // perspective strength
  var BLOCK_START = 520, BLOCK_EVERY = 430;   // floating hazard blocks
  var RING_EVERY = 360, RING_START = 300;
  var SHIP_R = 12;
  var NOSE = 24;                        // the ship's nose leads the camera —
  var TAU = Math.PI * 2;                // collisions register there, in view

  // Tunnel axis: pure functions of z — the whole world is deterministic.
  function axisX(z) { return Math.sin(z * 0.0013) * 95 + Math.sin(z * 0.00061 + 2) * 70; }
  function axisY(z) { return Math.cos(z * 0.00105 + 1) * 70 + Math.sin(z * 0.00047) * 55; }
  function hash(n) { var s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  function blockZ(k) { return BLOCK_START + k * BLOCK_EVERY; }
  function ringZ(k) { return RING_START + k * RING_EVERY; }
  function blockAngle(k) { return hash(k * 7.13) * TAU; }
  function blockOff(k) { return 42 + hash(k * 9.77 + 0.31) * 36; }   // center dist from axis
  function blockHalf(k) { return 26 + hash(k * 5.31 + 0.77) * 14; }  // half-size
  function ringAngle(k) { return hash(k * 3.71 + 0.19) * TAU; }

  // ---------- Persistence ----------
  var STATS_KEY = "gc-flyer-stats";
  var RUN_KEY = "gc-flyer-run";
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveStats(s) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  var stats = loadStats();
  var best = stats.best | 0;
  var muted = !!stats.muted;

  function saveRun() {
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify({
        dist: dist, ax: ax, ay: ay, rings: ringsGot
      }));
    } catch (e) {}
  }
  function clearRun() {
    try { localStorage.removeItem(RUN_KEY); } catch (e) {}
  }

  // ---------- DOM refs ----------
  var stage = document.getElementById("stage");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var soundBtn = document.getElementById("soundBtn");
  var pauseBtn = document.getElementById("pauseBtn");
  var rulesBtn = document.getElementById("rulesBtn");
  var newBtn = document.getElementById("newBtn");
  var rulesModal = document.getElementById("rulesModal");
  var readyOverlay = document.getElementById("readyOverlay");
  var overOverlay = document.getElementById("overOverlay");
  var overStats = document.getElementById("overStats");
  var overTitle = document.getElementById("overTitle");
  var overMedal = document.getElementById("overMedal");
  var startBtn = document.getElementById("startBtn");
  var againBtn = document.getElementById("againBtn");

  // ---------- Game state ----------
  var state = "ready";                  // ready | play | died | over
  var paused = false;
  var dist = 0;                         // camera z — the whole save state
  var ax = 0, ay = 0;                   // ship absolute x/y in the cross-section
  var vx = 0, vy = 0;                   // steering velocity
  var ringsGot = 0;
  var score = 0;
  var nextBlockK = 0, nextRingK = 0;    // obstacle cursors (crossed-checks)
  var diedAt = 0, t = 0, milestone = 0;
  var crashWhy = "wall";                 // what killed the ship: wall | block
  var parts = [];                       // crash/pickup particles (screen space)
  var fx = [];                          // pickup shockwaves + floating text
  var pickupAt = -9;                    // last ring grabbed (HUD score pulse)
  var keys = { up: false, down: false, left: false, right: false };
  var tgtX = null, tgtY = null;         // pointer target (absolute coords)

  function speed() { return Math.min(620, 300 + dist * 0.02); }
  function shipScore() { return Math.floor(dist / 10) + ringsGot * 50; }

  // ---------- Sound (tiny WebAudio blips, no assets) ----------
  var audioCtx = null;
  function beep(freq, dur, type, vol, slideTo) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, audioCtx.currentTime);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, audioCtx.currentTime + dur);
      g.gain.setValueAtTime(vol || 0.04, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }
  function sndRing() { beep(988, 0.07, "triangle", 0.05); setTimeout(function () { beep(1319, 0.1, "triangle", 0.05); }, 60); }
  function sndBlock() { beep(660, 0.09, "square", 0.035, 880); }
  function sndMile() { beep(523, 0.09, "triangle", 0.05); setTimeout(function () { beep(784, 0.14, "triangle", 0.05); }, 90); }
  function sndCrash() { beep(320, 0.4, "sawtooth", 0.07, 40); }

  // gold burst where a ring was grabbed: shockwave + sparks + floating +50.
  // Anchored to the ring as it actually appears on screen: if the ring fills
  // or surrounds the view, the burst sits at its hole (screen center); if the
  // ring sits off to one side, it anchors to the nearest visible point of its
  // golden rim — never flung to a random edge of the canvas.
  function spawnPickup(wx, wy, wz) {
    var s = FOCAL / Math.max(6, wz - dist);
    var ox = (wx - ax) * s, oy = (wy - ay) * s;      // ring center on screen, from middle
    var ol = Math.hypot(ox, oy), rad = 26 * s;       // ring's on-screen radius
    var ex, ey;
    if (ol <= rad) { ex = W / 2; ey = H / 2; }       // we're flying through it
    else {                                            // nearest visible arc of the rim
      var q = (ol - rad) / ol;
      ex = W / 2 + ox * q;
      ey = H / 2 + oy * q;
    }
    ex = Math.max(16, Math.min(W - 16, ex));
    ey = Math.max(16, Math.min(H - 16, ey));
    fx.push({ x: ex, y: ey, born: t, life: 0.55 });
    for (var i = 0; i < 14; i++) {
      var a = Math.random() * TAU, sp = 40 + Math.random() * 170;
      parts.push({
        x: ex, y: ey,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.3 + Math.random() * 0.4,
        c: i % 2 ? "#ffd83a" : "#fff3c4"
      });
    }
  }

  // ---------- Flow ----------
  function setScore() {
    score = shipScore();
    scoreEl.textContent = String(score);
    if (score > best) { best = score; bestEl.textContent = String(best); }
  }

  function newGame() {
    state = "play";
    paused = false;
    dist = 0; ringsGot = 0;
    ax = axisX(0); ay = axisY(0);
    vx = 0; vy = 0;
    nextBlockK = 0; nextRingK = 0;
    parts = [];
    fx = [];
    milestone = 0;
    tgtX = null; tgtY = null;
    readyOverlay.hidden = true;
    overOverlay.hidden = true;
    syncPauseBtn();
    setScore();
    saveRun();
  }

  function resumeRun(saved) {
    state = "play";
    paused = false;
    dist = saved.dist;
    ax = saved.ax; ay = saved.ay;
    ringsGot = saved.rings | 0;
    vx = 0; vy = 0;
    // skip everything already behind the camera; the world is deterministic
    nextBlockK = Math.max(0, Math.floor((dist + NOSE - BLOCK_START) / BLOCK_EVERY) + 1);
    nextRingK = Math.max(0, Math.floor((dist + NOSE - RING_START) / RING_EVERY) + 1);
    parts = [];
    readyOverlay.hidden = true;
    overOverlay.hidden = true;
    syncPauseBtn();
    setScore();
  }

  function crash(why, wx, wy, wz) {
    state = "died";
    crashWhy = why || "wall";
    diedAt = t;
    sndCrash();
    clearRun();
    // explode at the contact point, projected to screen — not dead center
    var ex = W / 2, ey = H / 2;
    if (wx !== undefined) {
      var cdz = (wz || dist) - dist;
      if (cdz > 4) {
        var cs = FOCAL / cdz;
        ex = W / 2 + (wx - ax) * cs;
        ey = H / 2 + (wy - ay) * cs;
      }
    }
    for (var i = 0; i < 46; i++) {
      var a = Math.random() * TAU, sp = 60 + Math.random() * 340;
      parts.push({
        x: ex, y: ey,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.8,
        c: i % 3 === 0 ? "#ffd83a" : i % 3 === 1 ? "#4de1ff" : "#ff8c1a"
      });
    }
  }

  function gameOver() {
    state = "over";
    saveStats({ best: best, muted: muted });
    bestEl.textContent = String(best);
    var isBest = score >= best && score > 0;
    overTitle.textContent = (crashWhy === "block" ? "You smacked a block" : "You hit the wall") + (isBest ? " \u2014 new best!" : "!");
    overMedal.textContent = score >= 4000 ? "\uD83C\uDFC6" : score >= 2000 ? "\uD83E\uDD47" : score >= 800 ? "\uD83E\uDD48" : score >= 250 ? "\uD83E\uDD49" : "\uD83D\uDCA5";
    overStats.textContent = "Score " + score + " \u00b7 Best " + best + " \u00b7 " + Math.floor(dist) + "m \u00b7 " + ringsGot + " rings";
    overOverlay.hidden = false;
  }

  function togglePause(force) {
    if (state !== "play") return;
    paused = (typeof force === "boolean") ? force : !paused;
    syncPauseBtn();
  }
  function syncPauseBtn() {
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(paused));
    pauseBtn.hidden = state !== "play";
  }

  // ---------- Update ----------
  function update(dt) {
    t += dt;

    // crash particles animate in every state
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 1.6 * dt; p.vy *= 1 - 1.6 * dt;
      p.life -= dt;
      if (p.life <= 0) parts.splice(i, 1);
    }

    if (state === "died") {
      if (t - diedAt > 1.2) gameOver();
      return;
    }
    if (state !== "play" || paused) return;

    // --- steering: keys accelerate, pointer pulls toward its target ---
    var ACC = 1500, CAP = 430;
    if (keys.left) { vx -= ACC * dt; tgtX = null; }
    if (keys.right) { vx += ACC * dt; tgtX = null; }
    if (keys.up) { vy -= ACC * dt; tgtY = null; }
    if (keys.down) { vy += ACC * dt; tgtY = null; }
    if (tgtX !== null) vx += (tgtX - ax) * 26 * dt;
    if (tgtY !== null) vy += (tgtY - ay) * 26 * dt;
    vx *= 1 - 3.4 * dt;                 // damping: the ship has inertia
    vy *= 1 - 3.4 * dt;
    vx = Math.max(-CAP, Math.min(CAP, vx));
    vy = Math.max(-CAP, Math.min(CAP, vy));
    ax += vx * dt;
    ay += vy * dt;

    // --- fly forward ---
    var prev = dist;
    dist += speed() * dt;
    setScore();

    // walls: the NOSE plane, so contact registers while still in view
    var wz = dist + NOSE;
    var ox = ax - axisX(wz), oy = ay - axisY(wz);
    var ol = Math.hypot(ox, oy);
    if (ol > R - SHIP_R) {
      crash("wall", axisX(wz) + ox / ol * R, axisY(wz) + oy / ol * R, wz);
      return;
    }

    // hazard blocks the nose crossed this frame (fast forward can pass one)
    while (wz >= blockZ(nextBlockK)) {
      var k = nextBlockK++;
      var bz = blockZ(k);
      var ba = blockAngle(k), bo = blockOff(k), bh = blockHalf(k) + SHIP_R * 0.7;
      var bxp = axisX(bz) + Math.cos(ba) * bo, byp = axisY(bz) + Math.sin(ba) * bo;
      if (Math.abs(ax - bxp) < bh && Math.abs(ay - byp) < bh) { crash("block", ax, ay, bz); return; }
      if (prev + NOSE < bz) sndBlock();
    }

    // rings crossed this frame
    while (wz >= ringZ(nextRingK)) {
      var rk = nextRingK++;
      var rz = ringZ(rk);
      var ph = ringAngle(rk);
      var rx = ax - axisX(rz), ry = ay - axisY(rz);
      var cx = Math.cos(ph) * 60, cy = Math.sin(ph) * 60;
      if (Math.hypot(rx - cx, ry - cy) < 34) {
        ringsGot++; sndRing(); setScore();
        pickupAt = t;
        spawnPickup(axisX(rz) + cx, axisY(rz) + cy, rz);
      }
    }

    // autosave every 250 m
    var ms = Math.floor(dist / 250);
    if (ms > milestone) { milestone = ms; saveRun(); }
    // milestone jingle on each 1000 m crossing
    if (Math.floor(dist / 1000) > Math.floor(prev / 1000)) sndMile();
  }

  // ---------- Projection ----------
  // camera sits at the ship: (ax, ay, dist). Anything closer than NEAR pops.
  var NEAR = 10;
  function proj(x, y, z, out) {
    var dz = z - dist;
    if (dz < NEAR) return null;
    var s = FOCAL / dz;
    out.x = W / 2 + (x - ax) * s;
    out.y = H / 2 + (y - ay) * s;
    out.s = s;
    out.dz = dz;
    return out;
  }

  // ---------- Draw ----------
  var ringVerts = [];                    // projected rings, index 0..VIEW
  for (var i0 = 0; i0 <= VIEW; i0++) {
    ringVerts.push({ pts: [], ok: false, z: 0 });
    for (var j0 = 0; j0 < SIDES; j0++) ringVerts[i0].pts.push({ x: 0, y: 0 });
  }
  var tmp = { x: 0, y: 0, s: 0, dz: 0 };

  function draw() {
    ctx.fillStyle = "#05070f";
    ctx.fillRect(0, 0, W, H);

    // project every tunnel ring once
    var first = Math.floor(dist / SEG) + 1;
    for (var i = 0; i <= VIEW; i++) {
      var z = (first + i) * SEG;
      var rv = ringVerts[i];
      rv.z = z;
      rv.ok = true;
      var mx = axisX(z), my = axisY(z);
      for (var j = 0; j < SIDES; j++) {
        var a = j * TAU / SIDES + Math.PI / SIDES;
        var p = proj(mx + Math.cos(a) * R, my + Math.sin(a) * R, z, tmp);
        if (!p) { rv.ok = false; break; }
        rv.pts[j].x = p.x; rv.pts[j].y = p.y;
      }
    }

    // fill quads far -> near (painter's algorithm)
    for (var s2 = VIEW - 1; s2 >= 0; s2--) {
      var A = ringVerts[s2], B = ringVerts[s2 + 1];
      if (!A.ok || !B.ok) continue;
      var fog = Math.pow((B.z - dist) / (VIEW * SEG), 1.7);
      if (fog > 0.98) continue;
      for (var j2 = 0; j2 < SIDES; j2++) {
        var j3 = (j2 + 1) % SIDES;
        var am = (j2 + 0.5) * TAU / SIDES + Math.PI / SIDES;
        var b = 0.30 + 0.70 * (1 - Math.sin(am)) / 2;      // top faces lit
        var r = (8 + 60 * b) * (1 - fog) + 5 * fog;
        var g = (40 + 150 * b) * (1 - fog) + 7 * fog;
        var bl = (70 + 170 * b) * (1 - fog) + 15 * fog;
        ctx.fillStyle = "rgb(" + (r | 0) + "," + (g | 0) + "," + (bl | 0) + ")";
        ctx.beginPath();
        ctx.moveTo(A.pts[j2].x, A.pts[j2].y);
        ctx.lineTo(A.pts[j3].x, A.pts[j3].y);
        ctx.lineTo(B.pts[j3].x, B.pts[j3].y);
        ctx.lineTo(B.pts[j2].x, B.pts[j2].y);
        ctx.closePath();
        ctx.fill();
      }
      // wireframe rib on this ring for the tron look
      var f2 = Math.pow((A.z - dist) / (VIEW * SEG), 1.7);
      ctx.strokeStyle = "rgba(120,230,255," + (0.35 * (1 - f2)).toFixed(3) + ")";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(A.pts[0].x, A.pts[0].y);
      for (var j4 = 1; j4 < SIDES; j4++) ctx.lineTo(A.pts[j4].x, A.pts[j4].y);
      ctx.closePath();
      ctx.stroke();
    }

    drawBlocks();
    drawRings();
    if (state === "play" || state === "ready") drawShip();
    drawParticles();
    drawFx();
    // crash flash — sells the moment of impact
    if (state === "died") {
      var dd = t - diedAt;
      if (dd < 0.18) {
        ctx.fillStyle = "rgba(255,255,255," + (0.55 * (1 - dd / 0.18)).toFixed(3) + ")";
        ctx.fillRect(0, 0, W, H);
      }
    }
    drawHud();
  }

  function drawBlocks() {
    var farZ = dist + VIEW * SEG;
    // start one behind the cursor: the block you just smacked stays on screen
    for (var k = Math.max(0, nextBlockK - 1); blockZ(k) < farZ; k++) {
      var bz = blockZ(k);
      if (bz < dist + 10) continue;   // draw until the face is almost on the lens
      var h = blockHalf(k);
      var a = blockAngle(k), o = blockOff(k);
      var bx = axisX(bz) + Math.cos(a) * o, by = axisY(bz) + Math.sin(a) * o;
      var D = 46;                                   // box depth (world units)
      var f = [], r2 = [], ok = true, q;
      for (q = 0; q < 4; q++) {
        var cxx = bx + (q === 0 || q === 3 ? -h : h);
        var cyy = by + (q < 2 ? -h : h);
        if (!proj(cxx, cyy, bz, f[q] = {}) || !proj(cxx, cyy, bz + D, r2[q] = {})) ok = false;
      }
      if (!ok) continue;
      var fog = Math.pow((bz - dist) / (VIEW * SEG), 1.7);
      var al = 1 - fog;
      // side faces (the far face is always hidden behind the near one)
      ctx.fillStyle = "rgba(160,64,8," + (0.72 * al).toFixed(3) + ")";
      for (q = 0; q < 4; q++) {
        var q2 = (q + 1) % 4;
        ctx.beginPath();
        ctx.moveTo(f[q].x, f[q].y); ctx.lineTo(f[q2].x, f[q2].y);
        ctx.lineTo(r2[q2].x, r2[q2].y); ctx.lineTo(r2[q].x, r2[q].y);
        ctx.closePath(); ctx.fill();
      }
      // hazard front with a warning cross
      ctx.beginPath();
      ctx.moveTo(f[0].x, f[0].y);
      ctx.lineTo(f[1].x, f[1].y); ctx.lineTo(f[2].x, f[2].y); ctx.lineTo(f[3].x, f[3].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,140,26," + (0.42 * al).toFixed(3) + ")";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,180,60," + (0.95 * al).toFixed(3) + ")";
      ctx.lineWidth = Math.max(1, 2.6 * f[0].s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(f[0].x, f[0].y); ctx.lineTo(f[2].x, f[2].y);
      ctx.moveTo(f[1].x, f[1].y); ctx.lineTo(f[3].x, f[3].y);
      ctx.globalAlpha = 0.5 * al;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawRings() {
    var farZ = dist + VIEW * SEG;
    // start one behind the cursor: a grabbed ring stays visible as you pass it
    for (var k = Math.max(0, nextRingK - 1); ringZ(k) < farZ; k++) {
      var rz = ringZ(k);
      if (rz < dist + 10) continue;
      var ph = ringAngle(k);
      var p = proj(axisX(rz) + Math.cos(ph) * 60, axisY(rz) + Math.sin(ph) * 60, rz, tmp);
      if (!p) continue;
      var fog = Math.pow((rz - dist) / (VIEW * SEG), 1.7);
      var rad = 26 * p.s;
      var pulse = 0.75 + Math.sin(t * 5 + k) * 0.25;
      ctx.strokeStyle = "rgba(255,216,58," + (0.9 * (1 - fog) * pulse).toFixed(3) + ")";
      ctx.lineWidth = Math.max(1.5, rad * 0.22);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, TAU);
      ctx.stroke();
    }
  }

  function drawShip() {
    var cx = W / 2, cy = H / 2;
    var roll = Math.max(-0.6, Math.min(0.6, -vx * 0.0016));
    ctx.save();
    ctx.translate(cx, cy + 4);
    ctx.rotate(roll);
    // REAR view of the ship: the camera looks straight at its back, so the
    // nozzle and its engine glow face the player — reads as flying away.
    ctx.fillStyle = "#cfe3f2";
    ctx.strokeStyle = "#19b9d8";
    ctx.lineWidth = 1.8;
    // wings: a shallow V seen from behind
    ctx.beginPath();
    ctx.moveTo(-26, 9); ctx.lineTo(-7, -3); ctx.lineTo(7, -3); ctx.lineTo(26, 9);
    ctx.lineTo(26, 13); ctx.lineTo(7, 2); ctx.lineTo(-7, 2); ctx.lineTo(-26, 13);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // vertical stabiliser fin
    ctx.beginPath();
    ctx.moveTo(0, -13); ctx.lineTo(3.5, -4); ctx.lineTo(-3.5, -4);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // hull back
    ctx.fillStyle = "#e8f6ff";
    ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, TAU); ctx.fill(); ctx.stroke();
    // nozzle rim + engine glow aimed at the camera
    ctx.fillStyle = "#20353f";
    ctx.beginPath(); ctx.arc(0, 0, 5.6, 0, TAU); ctx.fill();
    var pulse = (state === "play" ? speed() * 0.006 : 3) + Math.sin(t * 30) * 1.5;
    var gl = ctx.createRadialGradient(0, 0, 1, 0, 0, 6 + pulse);
    gl.addColorStop(0, "rgba(255,220,120,.95)");
    gl.addColorStop(0.45, "rgba(255,140,26,.6)");
    gl.addColorStop(1, "rgba(255,110,26,0)");
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(0, 0, 6 + pulse, 0, TAU); ctx.fill();
    ctx.restore();

    // danger vignette when close to the wall
    if (state === "play") {
      var rr = Math.hypot(ax - axisX(dist), ay - axisY(dist));
      var near = Math.max(0, (rr - (R - 46)) / 34);
      if (near > 0) {
        ctx.fillStyle = "rgba(255,40,60," + Math.min(0.35, near * 0.22).toFixed(3) + ")";
        ctx.fillRect(0, 0, W, H);
      }
    }
  }

  function drawParticles() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.6));
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
    }
    ctx.globalAlpha = 1;
  }

  function drawFx() {
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i], age = (t - f.born) / f.life;
      if (age >= 1) { fx.splice(i, 1); continue; }
      var e = 1 - age;
      // expanding shockwave
      ctx.strokeStyle = "rgba(255,216,58," + (0.9 * e).toFixed(3) + ")";
      ctx.lineWidth = 1 + 3 * e;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 8 + 54 * (1 - e * e), 0, TAU);
      ctx.stroke();
      // floating +50 rising and fading
      ctx.font = "800 " + (15 + 5 * e).toFixed(0) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,243,196," + e.toFixed(3) + ")";
      ctx.fillText("+50", f.x, f.y - 14 - 26 * (1 - e));
      ctx.textAlign = "left";
    }
  }

  function drawHud() {
    if (state !== "ready") {
      var pop = Math.max(0, 1 - (t - pickupAt) / 0.28);   // score pulses on pickup
      ctx.font = "800 " + (34 + 9 * pop).toFixed(0) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(5,7,15,.8)";
      ctx.fillStyle = "#fff";
      ctx.strokeText(String(score), W / 2, 44);
      ctx.fillText(String(score), W / 2, 44);
    }
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(120,230,255,.85)";
    ctx.fillText(Math.floor(dist) + " m", 14, H - 16);
    ctx.fillStyle = "rgba(255,216,58,.85)";
    ctx.fillText("\u25CE \u00d7 " + ringsGot, 14, H - 36);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.fillText(Math.round(speed() * 0.6) + " km/h", W - 14, H - 16);
    ctx.textAlign = "left";

    if (state === "play" && paused) {
      ctx.fillStyle = "rgba(3,5,14,.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.font = "800 30px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.fillText("Paused", W / 2, H / 2);
      ctx.textAlign = "left";
    }
  }

  // ---------- Input ----------
  stage.addEventListener("pointermove", function (e) {
    if (state !== "play" || paused) return;
    var rect = canvas.getBoundingClientRect();
    var nx = (e.clientX - rect.left) / rect.width * W - W / 2;
    var ny = (e.clientY - rect.top) / rect.height * H - H / 2;
    // screen pixels -> world offset at the ship's plane (0.5 keeps it brisk)
    tgtX = ax + nx * 0.5;
    tgtY = ay + ny * 0.5;
  });
  function primaryAction() {
    if (state === "ready") newGame();
    else if (state === "over") newGame();
  }
  stage.addEventListener("pointerdown", function (e) {
    if (e.target.closest("button, a")) return;
    primaryAction();
  });
  document.addEventListener("keydown", function (e) {
    if (rulesModal && !rulesModal.hidden) {
      if (e.key === "Escape") closeRules();
      return;
    }
    if (e.code === "Space") { e.preventDefault(); primaryAction(); return; }
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keys.left = true; e.preventDefault(); }
    else if (e.code === "ArrowRight" || e.code === "KeyD") { keys.right = true; e.preventDefault(); }
    else if (e.code === "ArrowUp" || e.code === "KeyW") { keys.up = true; e.preventDefault(); }
    else if (e.code === "ArrowDown" || e.code === "KeyS") { keys.down = true; e.preventDefault(); }
    var k = (e.key || "").toLowerCase();
    if (k === "n") newGame();
    else if (k === "p") togglePause();
    else if (k === "r") openRules();
    else if (k === "m") toggleSound();
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") keys.left = false;
    else if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = false;
    else if (e.code === "ArrowUp" || e.code === "KeyW") keys.up = false;
    else if (e.code === "ArrowDown" || e.code === "KeyS") keys.down = false;
  });
  startBtn.addEventListener("click", function () { newGame(); });
  againBtn.addEventListener("click", function () { newGame(); });
  newBtn.addEventListener("click", function () { newGame(); });
  pauseBtn.addEventListener("click", function () { togglePause(); });

  // ---------- Sound toggle / rules modal ----------
  function toggleSound() {
    muted = !muted;
    soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
    soundBtn.setAttribute("aria-pressed", String(!muted));
    saveStats({ best: best, muted: muted });
  }
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  soundBtn.addEventListener("click", toggleSound);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });

  // ---------- Save on the way out ----------
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (state === "play") { togglePause(true); saveRun(); }
    }
  });
  window.addEventListener("pagehide", function () { if (state === "play") saveRun(); });

  // ---------- Boot ----------
  bestEl.textContent = String(best);
  soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
  soundBtn.setAttribute("aria-pressed", String(!muted));
  syncPauseBtn();
  try {
    var s0 = JSON.parse(localStorage.getItem(RUN_KEY));
    if (s0 && typeof s0.dist === "number" && s0.dist > 0) resumeRun(s0);
  } catch (e) {}

  // ---------- Main loop ----------
  var lastTs = null;
  function frame(ts) {
    if (lastTs == null) lastTs = ts;
    var dt = Math.min(0.033, (ts - lastTs) / 1000);
    lastTs = ts;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
