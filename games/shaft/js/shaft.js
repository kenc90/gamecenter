/* ===== Shaft — game logic =====
   Single-file, dependency-free canvas game; all art is drawn with 2D
   primitives (no image assets). A homage to NAGI-P Soft's 1996 freeware.
   - Only two verbs: left and right. Gravity and a descending hazard
     ceiling do the rest — stay below the ceiling, stay off the spikes.
     Touching the ceiling is instant death, on the ground or mid-air.
   - The shaft is endless: rows of short floating shelves — normal, spike,
     conveyor and bounce, like the original's floor types — are generated
     deterministically from a run seed, so a run can be saved and resumed.
   - Best depth + sound preference persisted in localStorage
     (gc-shaft-stats); an in-progress dig lives in gc-shaft-run. */
(function () {
  "use strict";

  // ---------- Canvas / world constants ----------
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var W = 380, H = 620;                 // logical units, DPR-scaled below
  var WALL = 14;                         // side wall thickness
  var PW = 16, PH = 20;                  // player size
  var GRAV = 1500, MAXVY = 720;
  var ACC = 1500, FRIC = 1000, VMAX = 290, BOUNCE = 0.4;
  var FH = 64, FLOOR0 = 120, SLAB_H = 14; // floor spacing / first slab top
  var LEAD = 90;                         // screen y of the ceiling: the bar is
                                         // pinned near the top and the world
                                         // scrolls beneath it
  var CSPIKE = 9;                        // pillards hanging from the bar; the
                                         // kill line is at their tips
  var HP_MAX = 50, SPIKE_DPS = 22, CONV_SPEED = 110, BOUNCE_VY = 600;

  // Sharp rendering on hi-dpi screens: back store in device pixels.
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // ---------- Persistence ----------
  var STATS_KEY = "gc-shaft-stats";
  var RUN_KEY = "gc-shaft-run";
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveStats(s) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function loadRun() {
    try {
      var r = JSON.parse(localStorage.getItem(RUN_KEY));
      return r && typeof r.seed === "number" && typeof r.y === "number" ? r : null;
    } catch (e) { return null; }
  }
  function saveRun() {
    try {
      // a paused dig is still a live dig — it must survive the tab closing
      if (state !== "play" && state !== "pause") return;
      localStorage.setItem(RUN_KEY, JSON.stringify({
        seed: seed, x: pl.x, y: pl.y, vy: pl.vy, hp: hp, camY: camY, depth: depth
      }));
    } catch (e) {}
  }
  function clearRun() { try { localStorage.removeItem(RUN_KEY); } catch (e) {} }
  var stats = loadStats();
  var best = stats.best | 0;
  var muted = !!stats.muted;

  // ---------- DOM refs ----------
  var stage = document.getElementById("stage");
  var depthEl = document.getElementById("depth");
  var bestEl = document.getElementById("best");
  var soundBtn = document.getElementById("soundBtn");
  var rulesBtn = document.getElementById("rulesBtn");
  var newBtn = document.getElementById("newBtn");
  var rulesModal = document.getElementById("rulesModal");
  var readyOverlay = document.getElementById("readyOverlay");
  var pauseOverlay = document.getElementById("pauseOverlay");
  var overOverlay = document.getElementById("overOverlay");
  var overStats = document.getElementById("overStats");
  var overTitle = document.getElementById("overTitle");
  var overMedal = document.getElementById("overMedal");
  var startBtn = document.getElementById("startBtn");
  var continueBtn = document.getElementById("continueBtn");
  var resumeBtn = document.getElementById("resumeBtn");
  var againBtn = document.getElementById("againBtn");

  // ---------- Game state ----------
  var state = "ready";                   // ready | play | pause | died | over
  var seed = 1;
  var floors = [];                       // generated platform rows, by index
  var pl = { x: W / 2 - PW / 2, y: 30, vx: 0, vy: 0, face: 1, squash: 0 };
  var camY = -70;                        // crushing ceiling's world y
  var hp = HP_MAX;
  var depth = 0;                         // deepest floor reached this run
  var t = 0, diedAt = 0, deathCause = "";
  var flash = 0, hurt = 0, shake = 0;
  var particles = [];
  var saveT = 0, hurtSndT = 0;

  // ---------- Deterministic noise ----------
  function h(a, b) {
    var t2 = (a * 374761393 + b * 668265263 + seed * 1013904223) >>> 0;
    t2 = (t2 ^ (t2 >>> 13)) >>> 0;
    t2 = Math.imul(t2, 1274126177) >>> 0;
    t2 = (t2 ^ (t2 >>> 16)) >>> 0;
    return t2 / 4294967296;
  }

  // ---------- Floor generation (pure function of index + seed) ----------
  // Short floating shelves, 1-3 per row, separated by open drop-gaps of at
  // least 54px.  Kinds: "norm" (heals a little on impact, like the 1996
  // original), "spike" (drains HP), "conv" (a belt that shoves sideways),
  // "bounce" (a trampoline that slings you back up the shaft).
  function ensureFloors(upto) {
    while (floors.length <= upto) {
      var j = floors.length;
      var inner = W - 2 * WALL;
      var k = j < 6 ? 2 : 1 + ((h(j, 1) * 2.99) | 0);
      var i, ws = [], sum = 0;
      for (i = 0; i < k; i++) { ws[i] = 46 + h(j, 10 + i) * 60; sum += ws[i]; }
      var between = (k - 1) * 54;
      if (sum + between > inner) {                 // trim shelves until the drop-gaps fit
        var sc = (inner - between) / sum;
        for (i = 0; i < k; i++) ws[i] *= sc;
        sum = inner - between;
      }
      // scatter the leftover slack over the lead-in and between-gaps
      var slack = inner - sum - between, cuts = [];
      for (i = 0; i < k; i++) { var e = h(j, 20 + i) * slack; cuts.push(e); slack -= e; }
      var plats = [], x = WALL + cuts[0];
      for (i = 0; i < k; i++) {
        if (i > 0) x += 54 + cuts[i];
        plats.push({ a: x, b: x + ws[i] });
        x += ws[i];
      }
      // kinds — no hazards down to floor 6, bounce pads from 8, belts from 12
      var spikeP = j >= 6 ? Math.min(0.5, 0.1 + (j - 6) * 0.005) : 0;
      var convP = j >= 12 ? 0.15 : 0;
      var bounceP = j >= 8 ? 0.14 : 0;
      for (i = 0; i < k; i++) {
        var r = h(j, 40 + i);
        plats[i].kind = r < spikeP ? "spike" : r < spikeP + convP ? "conv" : r < spikeP + convP + bounceP ? "bounce" : "norm";
        plats[i].dir = h(j, 55 + i) < 0.5 ? -1 : 1;
      }
      floors.push({ y: FLOOR0 + j * FH, plats: plats });
    }
  }

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
  function sndLand(power) { beep(90 + power * 40, 0.06, "triangle", 0.03 + power * 0.02); }
  function sndBounce() { beep(160, 0.05, "square", 0.02, 110); }
  function sndBoing() { beep(170, 0.16, "square", 0.045, 520); }
  function sndHurt() { beep(55, 0.08, "sawtooth", 0.05, 45); }
  function sndDie() { beep(220, 0.4, "sawtooth", 0.07, 50); }
  function sndMilestone() { beep(700, 0.09, "triangle", 0.05); setTimeout(function () { beep(1050, 0.13, "triangle", 0.05); }, 80); }
  function sndStart() { beep(320, 0.08, "triangle", 0.04); setTimeout(function () { beep(480, 0.1, "triangle", 0.04); }, 70); }

  // ---------- Helpers ----------
  function camSpeed() { return Math.min(248, 64 + depth * 1.5); }
  function floorIndexOf(worldY) { return Math.floor((worldY - FLOOR0) / FH); }

  function spawnDust(x, y, n, col, speed) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI, v = (0.3 + Math.random() * 0.7) * speed;
      particles.push({ x: x, y: y, vx: Math.cos(a) * v, vy: -Math.sin(a) * v * 0.6, life: 0.4 + Math.random() * 0.25, max: 0.65, col: col, r: 1.5 + Math.random() * 2 });
    }
  }

  // ---------- Run flow ----------
  function newRun() {
    seed = (Math.random() * 0x7fffffff) | 0;
    floors = [];
    ensureFloors(4);
    pl.x = W / 2 - PW / 2; pl.y = 30; pl.vx = 0; pl.vy = 0; pl.face = 1; pl.squash = 0;
    camY = -70; hp = HP_MAX; depth = 0;
    particles = []; flash = 0; hurt = 0; shake = 0;
    state = "play";
    readyOverlay.hidden = true; overOverlay.hidden = true; pauseOverlay.hidden = true;
    depthEl.textContent = "0";
    sndStart();
  }
  function resumeRun(r) {
    seed = r.seed; floors = [];
    ensureFloors(Math.max(4, floorIndexOf(r.y + H) + 2));
    pl.x = r.x; pl.y = r.y; pl.vx = 0; pl.vy = r.vy || 0; pl.face = 1; pl.squash = 0;
    camY = r.camY; hp = r.hp; depth = r.depth | 0;
    particles = []; flash = 0; hurt = 0; shake = 0;
    state = "play";
    readyOverlay.hidden = true; overOverlay.hidden = true; pauseOverlay.hidden = true;
    depthEl.textContent = String(depth);
    sndStart();
  }
  function die(cause) {
    if (state !== "play") return;
    state = "died";
    diedAt = t; deathCause = cause;
    flash = 0.4; shake = 0.35;
    hp = 0;
    sndDie();
    spawnDust(pl.x + PW / 2, pl.y + PH / 2, 26, "#ff5a4e", 170);
    clearRun();
  }
  function gameOver() {
    state = "over";
    var isBest = depth > best;
    if (isBest) best = depth;
    saveStats({ best: best, muted: muted });
    bestEl.textContent = String(best);
    overTitle.textContent =
      deathCause === "crushed" ? "Crushed!" :
      deathCause === "spikes" ? "Spiked!" :
      deathCause === "depths" ? "Swallowed by the depths" : "Game over";
    if (isBest && depth > 0) overTitle.textContent += " — new best!";
    overMedal.textContent = depth >= 150 ? "\uD83C\uDFC6" : depth >= 80 ? "\uD83E\uDD47" : depth >= 40 ? "\uD83E\uDD48" : depth >= 15 ? "\uD83E\uDD49" : "\uD83D\uDC80";
    overStats.textContent = "Depth " + depth + " \u00b7 Best " + best;
    overOverlay.hidden = false;
  }

  // ---------- Update ----------
  function update(dt) {
    t += dt;
    if (flash > 0) flash = Math.max(0, flash - dt);
    if (hurt > 0) hurt = Math.max(0, hurt - dt * 3);
    if (shake > 0) shake = Math.max(0, shake - dt);
    pl.squash = Math.max(0, pl.squash - dt * 6);
    if (state !== "pause") {
      for (var p = particles.length - 1; p >= 0; p--) {
        var pt = particles[p];
        pt.life -= dt;
        if (pt.life <= 0) { particles.splice(p, 1); continue; }
        pt.vy += 500 * dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      }
    }
    // a beat of flash-and-shake, then the verdict card
    if (state === "died" && t - diedAt > 0.55) gameOver();
    if (state !== "play") return;

    // --- input: momentum-based slide, walls bounce ---
    var dir = (keyR || touchR ? 1 : 0) - (keyL || touchL ? 1 : 0);
    if (dir) { pl.vx += dir * ACC * dt; pl.face = dir; }
    else if (pl.vx > 0) pl.vx = Math.max(0, pl.vx - FRIC * dt);
    else pl.vx = Math.min(0, pl.vx + FRIC * dt);
    if (pl.vx > VMAX) pl.vx = VMAX; if (pl.vx < -VMAX) pl.vx = -VMAX;
    pl.x += pl.vx * dt;
    if (pl.x < WALL) { pl.x = WALL; if (pl.vx < -60) { sndBounce(); spawnDust(WALL, pl.y + PH / 2, 4, "#c3ccd9", 90); } pl.vx = -pl.vx * BOUNCE; }
    if (pl.x + PW > W - WALL) { pl.x = W - WALL - PW; if (pl.vx > 60) { sndBounce(); spawnDust(W - WALL, pl.y + PH / 2, 4, "#c3ccd9", 90); } pl.vx = -pl.vx * BOUNCE; }

    // --- the ceiling: an advancing wall of rock ---
    // Moves and is checked BEFORE the player falls: touching it at all is
    // instant death, ground or mid-air.  Both sides only travel downward,
    // so sampling at the top of the ceiling's step catches every contact —
    // a player can never dive away from a bar that is already on them.
    camY += camSpeed() * dt;
    if (camY + CSPIKE >= pl.y) { die("crushed"); return; }

    // --- gravity + one-way landing on shelf tops ---
    var prevBottom = pl.y + PH;
    pl.vy = Math.min(MAXVY, pl.vy + GRAV * dt);
    pl.y += pl.vy * dt;
    var bottom = pl.y + PH;
    var fi = floorIndexOf(bottom);
    if (fi >= 0) {
      ensureFloors(fi + 2);
      var f = floors[fi];
      var stand = null;
      for (var s = 0; s < f.plats.length; s++) {
        var p = f.plats[s];
        if (prevBottom <= f.y + 0.01 && bottom >= f.y && p.a < pl.x + PW - 1 && p.b > pl.x + 1) { stand = p; break; }
      }
      if (stand) {
        var impact = prevBottom < f.y - 1;          // a real landing, not just resting
        if (pl.vy > 240) { sndLand(Math.min(1, pl.vy / MAXVY)); spawnDust(pl.x + PW / 2, f.y, 5, "#8a6c52", 70); }
        if (pl.vy > 80) pl.squash = 1;
        pl.y = f.y - PH; pl.vy = 0;
        if (stand.kind === "spike") {
          hp -= SPIKE_DPS * dt;
          hurt = 1;
          spawnDust(pl.x + PW / 2, f.y, 2, "#ff5a4e", 110);
          hurtSndT -= dt;
          if (hurtSndT <= 0) { sndHurt(); hurtSndT = 0.18; }
          if (hp <= 0) { die("spikes"); return; }
        } else if (stand.kind === "bounce") {
          // fires on ANY contact, not just a hard impact — dropping in
          // slowly or strolling onto the pad from a ledge must fling too.
          // The launch carries the player off the pad, so this can't loop.
          pl.vy = -BOUNCE_VY;             // slings you back up — straight into the ceiling's path
          pl.squash = 1;
          sndBoing();
          spawnDust(pl.x + PW / 2, f.y, 6, "#35b39e", 120);
        } else if (impact && hp < HP_MAX) {
          // normal shelves patch you up a little, straight out of the original
          hp = Math.min(HP_MAX, hp + 3);
          spawnDust(pl.x + PW / 2, f.y - PH, 3, "#5ad06b", 60);
        }
        if (stand.kind === "conv") {
          // the belt drags you along while you ride it
          pl.x = Math.max(WALL, Math.min(W - WALL - PW, pl.x + stand.dir * CONV_SPEED * dt));
        }
      }
    }

    // --- fell out of the world? the shaft ate you ---
    if (pl.y - camY > H - LEAD + 8) { die("depths"); return; }

    // --- depth score + milestones ---
    var d = Math.max(0, floorIndexOf(pl.y + PH));
    if (d > depth) {
      depth = d;
      depthEl.textContent = String(depth);
      if (depth % 10 === 0) sndMilestone();
      if (depth > best) bestEl.textContent = String(depth);
    }

    // keep the visible slice of the shaft built
    ensureFloors(floorIndexOf(camY + H + FH) + 2);

    // --- autosave the dig every moment ---
    saveT -= dt;
    if (saveT <= 0) { saveRun(); saveT = 0.6; }
  }

  // ---------- Draw ----------
  function draw() {
    // cave air
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#171320");
    bg.addColorStop(0.6, "#1d1512");
    bg.addColorStop(1, "#120c0a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 16, (Math.random() - 0.5) * shake * 16);

    // rock strata lines drifting with the shaft
    ctx.strokeStyle = "rgba(255,255,255,.045)";
    ctx.lineWidth = 1;
    var strata = 46, off = ((camY % strata) + strata) % strata;
    for (var sy = -off; sy < H; sy += strata) {
      ctx.beginPath(); ctx.moveTo(WALL, sy + 0.5); ctx.lineTo(W - WALL, sy + 0.5); ctx.stroke();
    }

    drawWalls();
    drawFloors();
    drawCeiling();
    drawParticles();
    if (state !== "died" && state !== "over") drawPlayer();

    ctx.restore();

    // depth readout, big and centre-top like an old arcade
    if (state !== "ready") {
      ctx.font = "800 40px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(10,8,16,.85)";
      ctx.fillStyle = "#fff";
      ctx.strokeText(String(depth), W / 2, 58);
      ctx.fillText(String(depth), W / 2, 58);
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.fillText("FLOORS DOWN", W / 2, 72);
    }
    drawHpBar();

    // hurt / hit flashes
    if (hurt > 0) {
      ctx.fillStyle = "rgba(255,60,60," + (hurt * 0.18).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
    if (flash > 0) {
      ctx.fillStyle = "rgba(255,255,255," + (flash / 0.4 * 0.75).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  function rr(x, y, w, hh, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r);
    ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawWalls() {
    for (var side = 0; side < 2; side++) {
      var wx = side ? W - WALL : 0;
      ctx.fillStyle = "#33261a";
      ctx.fillRect(wx, 0, WALL, H);
      // brick seams scrolling with the shaft
      ctx.fillStyle = "rgba(0,0,0,.4)";
      var seam = 26, off = ((camY % seam) + seam) % seam;
      for (var by = -off; by < H; by += seam) ctx.fillRect(wx, by, WALL, 2);
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fillRect(side ? wx : wx + WALL - 2, 0, 2, H);
    }
  }

  function drawFloors() {
    ensureFloors(floorIndexOf(camY + H) + 1);
    for (var i = Math.max(0, floorIndexOf(camY - FH)); i < floors.length; i++) {
      var f = floors[i], fy = f.y - camY + LEAD;
      if (fy > H + 20) break;
      if (fy < -SLAB_H - 12) continue;
      for (var s = 0; s < f.plats.length; s++) {
        var p = f.plats[s], sx = p.a, sw = p.b - p.a;
        // shelf body — a floating slab with rounded ends
        ctx.fillStyle = p.kind === "conv" ? "#3c424c" : p.kind === "bounce" ? "#1f5a52" : "#5d4838";
        rr(sx, fy, sw, SLAB_H, 3); ctx.fill();
        ctx.fillStyle = p.kind === "conv" ? "#59616e" : p.kind === "bounce" ? "#35b39e" : "#8a6c52";
        ctx.fillRect(sx + 2, fy, sw - 4, 4);
        ctx.fillStyle = "rgba(0,0,0,.4)";
        ctx.fillRect(sx + 2, fy + SLAB_H - 3, sw - 4, 3);
        if (p.kind === "conv") {
          // animated amber chevrons showing the belt's direction
          ctx.save();
          ctx.beginPath(); ctx.rect(sx + 1, fy, sw - 2, 7); ctx.clip();
          ctx.fillStyle = "#f0a90a";
          var span = 14, off = ((t * 70 * p.dir) % span + span) % span;
          for (var cx2 = sx - span + off; cx2 < sx + sw; cx2 += span) {
            ctx.beginPath();
            if (p.dir > 0) {
              ctx.moveTo(cx2, fy + 1); ctx.lineTo(cx2 + 6, fy + 3.5); ctx.lineTo(cx2, fy + 6);
            } else {
              ctx.moveTo(cx2 + 6, fy + 1); ctx.lineTo(cx2, fy + 3.5); ctx.lineTo(cx2 + 6, fy + 6);
            }
            ctx.closePath(); ctx.fill();
          }
          ctx.restore();
        } else if (p.kind === "bounce") {
          // stacked spring coils: up-arrows along the pad
          ctx.strokeStyle = "#9ef0cf";
          ctx.lineWidth = 1.6;
          ctx.lineCap = "round";
          for (var ax = sx + 9; ax + 8 <= sx + sw - 4; ax += 16) {
            ctx.beginPath();
            ctx.moveTo(ax, fy + 10);
            ctx.lineTo(ax + 4, fy + 6);
            ctx.lineTo(ax + 8, fy + 10);
            ctx.stroke();
          }
        } else if (p.kind !== "spike") {
          // grit pebbles, deterministic per shelf
          ctx.fillStyle = "rgba(0,0,0,.25)";
          for (var k2 = 0; k2 < 3; k2++) {
            var px = sx + 6 + h(i, 20 + k2 + s * 9) * (sw - 12);
            ctx.fillRect(px, fy + 6 + (k2 % 2) * 3, 3, 2);
          }
        }
        // pillards: spike beds covering the whole shelf top
        if (p.kind === "spike") {
          ctx.fillStyle = "#c3ccd9";
          ctx.strokeStyle = "#4c535e";
          ctx.lineWidth = 1;
          for (var bx = sx + 2; bx + 10 <= sx + sw - 2 + 0.5; bx += 11) {
            ctx.beginPath();
            ctx.moveTo(bx, fy + 1);
            ctx.lineTo(bx + 5, fy - 9);
            ctx.lineTo(bx + 10, fy + 1);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          }
        }
      }
    }
  }

  function drawCeiling() {
    // The bar sits at a fixed screen line (LEAD).  The kill check is
    // camY >= pl.y and the player draws at pl.y - camY + LEAD, so contact
    // on screen and contact in the physics are the exact same pixel.
    var cy = LEAD;                       // screen-space ceiling line
    // solid rock above the line
    var grd = ctx.createLinearGradient(0, Math.max(0, cy - 90), 0, cy);
    grd.addColorStop(0, "#05040a");
    grd.addColorStop(1, "#1a0d10");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, cy);
    // hazard stripe band riding the edge
    var bandH = Math.min(13, cy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, cy - bandH, W, bandH); ctx.clip();
    ctx.fillStyle = "#f0a90a";
    ctx.fillRect(0, cy - bandH, W, bandH);
    ctx.fillStyle = "#191623";
    var shift = (t * 26) % 32;
    for (var x = -40; x < W + 40; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + shift, cy);
      ctx.lineTo(x + shift + 16, cy);
      ctx.lineTo(x + shift + 16 + bandH, cy - bandH);
      ctx.lineTo(x + shift + bandH, cy - bandH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // the hot edge itself
    ctx.fillStyle = "#ff5a4e";
    ctx.fillRect(0, cy - 1.5, W, 2.5);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.shadowColor = "#ff3b2e";
    ctx.shadowBlur = 14;
    ctx.fillRect(0, cy - 1.5, W, 2.5);
    ctx.restore();
    // row of pillards hanging off the bar — the kill line is their tips
    ctx.fillStyle = "#c3ccd9";
    ctx.strokeStyle = "#4c535e";
    ctx.lineWidth = 1;
    for (var cx = WALL + 1; cx + 10 <= W - WALL + 0.5; cx += 11) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + 5, cy + CSPIKE);
      ctx.lineTo(cx + 10, cy);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
  }

  function drawPlayer() {
    var x = pl.x, y = pl.y - camY + LEAD;
    var sq = pl.squash * 0.18;            // land squash: wider + flatter
    ctx.save();
    ctx.translate(x + PW / 2, y + PH);
    ctx.scale(1 + sq, 1 - sq);
    ctx.translate(-(PW / 2), -PH);
    // body — cinnabar coveralls
    ctx.fillStyle = "#e8654f";
    ctx.strokeStyle = "#1c2233";
    ctx.lineWidth = 2;
    rr(0, 8, PW, PH - 8, 4); ctx.fill(); ctx.stroke();
    // headlamp glow
    var lamp = ctx.createRadialGradient(PW / 2 + pl.face * 6, 5, 1, PW / 2 + pl.face * 6, 5, 16);
    lamp.addColorStop(0, "rgba(255,240,170,.55)");
    lamp.addColorStop(1, "rgba(255,240,170,0)");
    ctx.fillStyle = lamp;
    ctx.fillRect(-10, -11, PW + 20, PH + 12);
    // head + hard hat
    ctx.fillStyle = "#ffd83a";
    ctx.beginPath(); ctx.arc(PW / 2, 6, 6.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#ffdf6b";
    ctx.beginPath(); ctx.arc(PW / 2, 4.4, 6.4, Math.PI, 0); ctx.fill();
    ctx.fillStyle = "#fff8d8";
    ctx.beginPath(); ctx.arc(PW / 2 + pl.face * 3.4, 5.4, 1.9, 0, Math.PI * 2); ctx.fill();
    // eyes
    ctx.fillStyle = "#1c2233";
    ctx.fillRect(PW / 2 + pl.face * 1 - 1.2, 6.6, 2.2, 2.6);
    ctx.fillRect(PW / 2 + pl.face * 4 - 1.2, 6.6, 2.2, 2.6);
    ctx.restore();
  }

  function drawHpBar() {
    if (state === "ready") return;
    var bx = 22, by = 18, bw = 116, bh = 12;
    ctx.fillStyle = "rgba(10,8,16,.55)";
    rr(bx - 4, by - 4, bw + 8, bh + 8, 8); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1.5;
    rr(bx, by, bw, bh, 6); ctx.stroke();
    var v = Math.max(0, hp) / HP_MAX;
    if (v > 0) {
      ctx.fillStyle = v > 0.5 ? "#5ad06b" : v > 0.25 ? "#f0a90a" : "#ff5a4e";
      rr(bx + 2, by + 2, (bw - 4) * v, bh - 4, 4); ctx.fill();
    }
    ctx.font = "700 10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,.65)";
    ctx.fillText("HP", bx + bw + 8, by + 10);
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.col;
      ctx.fillRect(p.x - p.r / 2, p.y - camY + LEAD - p.r / 2, p.r, p.r);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Input ----------
  var keyL = false, keyR = false, touchL = false, touchR = false;
  var pointers = {};                       // pointerId -> "L" | "R"

  function primaryAction() {
    if (state === "ready") newRun();
    else if (state === "over" && t - diedAt > 0.45) newRun();
    else if (state === "pause") togglePause();
  }
  function togglePause() {
    if (state === "play") {
      state = "pause"; saveRun();
      pauseOverlay.hidden = false;
    } else if (state === "pause") {
      state = "play";
      pauseOverlay.hidden = true;
    }
  }
  stage.addEventListener("pointerdown", function (e) {
    if (e.target.closest && e.target.closest("button, a")) return;
    if (state !== "play") { primaryAction(); return; }
    var r = stage.getBoundingClientRect();
    var side = (e.clientX - r.left) < r.width / 2 ? "L" : "R";
    pointers[e.pointerId] = side;
    syncTouch();
  });
  function endPointer(e) {
    if (pointers[e.pointerId]) { delete pointers[e.pointerId]; syncTouch(); }
  }
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("pointerleave", endPointer);
  function syncTouch() {
    touchL = touchR = false;
    for (var id in pointers) { if (pointers[id] === "L") touchL = true; else touchR = true; }
  }
  document.addEventListener("keydown", function (e) {
    if (rulesModal && !rulesModal.hidden) {
      if (e.key === "Escape") closeRules();
      return;
    }
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keyL = true; e.preventDefault(); }
    else if (e.code === "ArrowRight" || e.code === "KeyD") { keyR = true; e.preventDefault(); }
    else if (e.code === "Space") { e.preventDefault(); primaryAction(); }
    else {
      var k = (e.key || "").toLowerCase();
      if (k === "n") newRun();
      else if (k === "p") { if (state === "play" || state === "pause") togglePause(); }
      else if (k === "r") openRules();
      else if (k === "m") toggleSound();
    }
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") keyL = false;
    if (e.code === "ArrowRight" || e.code === "KeyD") keyR = false;
  });
  window.addEventListener("blur", function () { if (state === "play") togglePause(); });
  window.addEventListener("pagehide", saveRun);

  startBtn.addEventListener("click", function () { if (state === "ready") newRun(); });
  continueBtn.addEventListener("click", function () {
    var r = loadRun();
    if (r) resumeRun(r); else newRun();
  });
  resumeBtn.addEventListener("click", togglePause);
  againBtn.addEventListener("click", function () { newRun(); });
  newBtn.addEventListener("click", function () { newRun(); });

  // ---------- Sound toggle / rules modal ----------
  function toggleSound() {
    muted = !muted;
    soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
    soundBtn.setAttribute("aria-pressed", String(!muted));
    saveStats({ best: best, muted: muted });
    if (!muted) sndStart();
  }
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  soundBtn.addEventListener("click", toggleSound);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });

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

  // ---------- Boot ----------
  bestEl.textContent = String(best);
  soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
  soundBtn.setAttribute("aria-pressed", String(!muted));
  ensureFloors(4);
  var savedRun = loadRun();
  if (savedRun) {
    continueBtn.hidden = false;
    continueBtn.textContent = "Continue \u2014 floor " + (savedRun.depth | 0);
  }
  requestAnimationFrame(frame);
})();
