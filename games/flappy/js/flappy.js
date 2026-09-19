/* ===== Flappy Bird — game logic =====
   Single-file, dependency-free canvas game; all art is drawn with 2D
   primitives (no image assets).
   - Tap / click / Space to flap; pass pipes to score.
   - Speed ramps and gaps tighten with the score.
   - Best score + sound preference persisted in localStorage (gc-flappy-stats).
   Runs are momentary, so there is no in-progress save to resume. */
(function () {
  "use strict";

  // ---------- Canvas / world constants ----------
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var W = 400, H = 600;                 // logical units, DPR-scaled below
  var GROUND_H = 84;
  var GROUND_Y = H - GROUND_H;
  var PIPE_W = 62, CAP_H = 26;
  var BIRD_X = 110, BIRD_R = 14;        // collision circle
  var GRAV = 1400, FLAP_V = -430, MAX_FALL = 620;

  // Sharp rendering on hi-dpi screens: back store in device pixels.
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // ---------- Persistence ----------
  var STATS_KEY = "gc-flappy-stats";
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

  // ---------- DOM refs ----------
  var stage = document.getElementById("stage");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var soundBtn = document.getElementById("soundBtn");
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
  var bird = { y: H * 0.42, vy: 0, rot: 0, wing: 0 };
  var pipes = [];                       // { x, gapY, gap, scored }
  var score = 0;
  var speed = 140;
  var t = 0;                            // global clock for idle bob
  var diedAt = 0;                       // timestamp of death (input guard)
  var flash = 0;                        // white hit-flash alpha timer
  var groundX = 0;                      // ground stripe scroll offset
  var cloudX = 0, bushX = 0;            // parallax offsets

  // Fixed decor sets (positions cycle modulo a period)
  var clouds = [ { x: 40, y: 80, s: 1 }, { x: 180, y: 150, s: .7 }, { x: 300, y: 60, s: 1.2 }, { x: 480, y: 120, s: .85 } ];
  var CLOUD_PERIOD = 560;
  var bushPeriod = 120;

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
  function sndFlap() { beep(520, 0.08, "square", 0.035, 760); }
  function sndScore() { beep(880, 0.09, "triangle", 0.05); setTimeout(function () { beep(1175, 0.12, "triangle", 0.05); }, 70); }
  function sndHit() { beep(220, 0.18, "sawtooth", 0.06, 70); }

  // ---------- Helpers ----------
  function currentGap() { return Math.max(118, 168 - score * 2.5); }
  function currentSpeed() { return Math.min(235, 140 + score * 4); }
  function spacing() { return 230; }

  function resetRun() {
    state = "ready";
    bird.y = H * 0.42; bird.vy = 0; bird.rot = 0; bird.wing = 0;
    pipes = [];
    score = 0;
    flash = 0;
    scoreEl.textContent = "0";
    overOverlay.hidden = true;
    readyOverlay.hidden = false;
  }
  function startRun() {
    state = "play";
    readyOverlay.hidden = true;
    flap();
  }
  function flap() {
    bird.vy = FLAP_V;
    bird.wing = 1;                       // triggers one wingbeat animation
    sndFlap();
  }

  function spawnPipe() {
    var gap = currentGap();
    var margin = 56;
    var minC = margin + gap / 2;
    var maxC = GROUND_Y - margin - gap / 2;
    pipes.push({ x: W + 20, gapY: minC + Math.random() * (maxC - minC), gap: gap, scored: false });
  }

  function hitPipe() {
    // Circle vs the four pipe rectangles (generous corners shaved a bit).
    var r = BIRD_R - 2;
    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];
      if (p.x > BIRD_X + r || p.x + PIPE_W < BIRD_X - r) continue;
      var topH = p.gapY - p.gap / 2;
      var botY = p.gapY + p.gap / 2;
      if (circleInRect(BIRD_X, bird.y, r, p.x, -50, PIPE_W, topH + 50)) return true;
      if (circleInRect(BIRD_X, bird.y, r, p.x, botY, PIPE_W, GROUND_Y - botY)) return true;
    }
    return false;
  }
  function circleInRect(cx, cy, r, rx, ry, rw, rh) {
    var nx = Math.max(rx, Math.min(cx, rx + rw));
    var ny = Math.max(ry, Math.min(cy, ry + rh));
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function die() {
    state = "died";
    diedAt = t;
    flash = 0.35;
    sndHit();
  }
  function gameOver() {
    state = "over";
    var isBest = score > best;
    if (isBest) { best = score; }
    saveStats({ best: best, muted: muted });
    bestEl.textContent = String(best);
    overTitle.textContent = isBest && score > 0 ? "New best!" : "Game over";
    overMedal.textContent = score >= 40 ? "\uD83C\uDFC6" : score >= 20 ? "\uD83E\uDD47" : score >= 10 ? "\uD83E\uDD48" : score >= 5 ? "\uD83E\uDD49" : "\uD83D\uDC80";
    overStats.textContent = "Score " + score + " \u00b7 Best " + best;
    overOverlay.hidden = false;
  }

  // ---------- Update ----------
  function update(dt) {
    t += dt;
    if (flash > 0) flash = Math.max(0, flash - dt);
    bird.wing = Math.max(0, bird.wing - dt * 6);

    var worldSpeed = (state === "play") ? speed : (state === "ready" ? 90 : 0);
    groundX = (groundX + worldSpeed * dt) % 24;
    cloudX = (cloudX + worldSpeed * 0.25 * dt) % CLOUD_PERIOD;
    bushX = (bushX + worldSpeed * 0.55 * dt) % bushPeriod;

    if (state === "ready") {
      bird.y = H * 0.42 + Math.sin(t * 3.2) * 9;   // idle hover bob
      bird.rot = 0;
      return;
    }

    if (state === "play") {
      speed = currentSpeed();
      // Physics
      bird.vy = Math.min(MAX_FALL, bird.vy + GRAV * dt);
      bird.y += bird.vy * dt;
      if (bird.y < BIRD_R) { bird.y = BIRD_R; bird.vy = Math.max(bird.vy, 0); }
      bird.rot = Math.max(-0.42, Math.min(1.3, bird.vy * 0.0022));

      // Scroll + spawn pipes
      for (var i = pipes.length - 1; i >= 0; i--) {
        pipes[i].x -= speed * dt;
        if (pipes[i].x + PIPE_W < -30) pipes.splice(i, 1);
      }
      if (!pipes.length || pipes[pipes.length - 1].x < W - spacing()) spawnPipe();

      // Score
      for (var j = 0; j < pipes.length; j++) {
        var p = pipes[j];
        if (!p.scored && p.x + PIPE_W < BIRD_X - BIRD_R) {
          p.scored = true;
          score++;
          scoreEl.textContent = String(score);
          sndScore();
        }
      }

      // Collisions
      if (bird.y + BIRD_R >= GROUND_Y) { bird.y = GROUND_Y - BIRD_R; die(); }
      else if (hitPipe()) die();
      return;
    }

    if (state === "died") {
      // Bird tumbles to the ground, then the over card shows.
      bird.vy = Math.min(MAX_FALL, bird.vy + GRAV * dt);
      bird.y += bird.vy * dt;
      bird.rot = Math.min(1.5, bird.rot + dt * 6);
      if (bird.y + BIRD_R >= GROUND_Y) {
        bird.y = GROUND_Y - BIRD_R;
        gameOver();
      }
    }
  }

  // ---------- Draw ----------
  function draw() {
    // Sky
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#3ec3cc");
    sky.addColorStop(0.75, "#8fdde0");
    sky.addColorStop(1, "#c9f0e8");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Clouds (parallax, wrapping)
    ctx.fillStyle = "rgba(255,255,255,.85)";
    for (var i = 0; i < clouds.length; i++) {
      var c = clouds[i];
      for (var k = -1; k <= 1; k++) {
        var cx = ((c.x - cloudX) % CLOUD_PERIOD + CLOUD_PERIOD) % CLOUD_PERIOD + k * CLOUD_PERIOD - 60;
        if (cx < -90 || cx > W + 90) continue;
        drawCloud(cx, c.y, c.s);
      }
    }

    // Far bushes above the ground line
    ctx.fillStyle = "#5cd45c";
    for (var b = -1; b < W / bushPeriod + 2; b++) {
      var bx = b * bushPeriod - bushX;
      ctx.beginPath();
      ctx.arc(bx + 30, GROUND_Y + 4, 26, Math.PI, 0);
      ctx.arc(bx + 82, GROUND_Y + 4, 34, Math.PI, 0);
      ctx.fill();
    }

    // Pipes
    for (var p2 = 0; p2 < pipes.length; p2++) drawPipe(pipes[p2]);

    // Ground
    ctx.fillStyle = "#ded895";
    ctx.fillRect(0, GROUND_Y, W, GROUND_H);
    ctx.fillStyle = "#c9ad54";
    ctx.fillRect(0, GROUND_Y, W, 5);
    ctx.fillStyle = "#d5b95f";
    for (var gx = -24; gx < W + 24; gx += 24) {
      var sx = gx - groundX;
      ctx.beginPath();
      ctx.moveTo(sx, GROUND_Y + 5);
      ctx.lineTo(sx + 12, GROUND_Y + 5);
      ctx.lineTo(sx + 2, GROUND_Y + 17);
      ctx.lineTo(sx - 10, GROUND_Y + 17);
      ctx.closePath();
      ctx.fill();
    }

    // Bird
    drawBird();

    // Live score on canvas
    if (state !== "ready") {
      ctx.font = "800 44px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(28,34,51,.85)";
      ctx.fillStyle = "#fff";
      ctx.strokeText(String(score), W / 2, 68);
      ctx.fillText(String(score), W / 2, 68);
    }

    // Hit flash
    if (flash > 0) {
      ctx.fillStyle = "rgba(255,255,255," + (flash / 0.35 * 0.8).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawCloud(x, y, s) {
    ctx.beginPath();
    ctx.arc(x, y, 14 * s, 0, Math.PI * 2);
    ctx.arc(x + 16 * s, y - 6 * s, 17 * s, 0, Math.PI * 2);
    ctx.arc(x + 34 * s, y, 13 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPipe(p) {
    var topH = p.gapY - p.gap / 2;
    var botY = p.gapY + p.gap / 2;
    var capX = p.x - 4, capW = PIPE_W + 8;
    // bodies
    ctx.fillStyle = "#2fb068";
    ctx.fillRect(p.x, -10, PIPE_W, topH + 10);
    ctx.fillRect(p.x, botY, PIPE_W, GROUND_Y - botY);
    // highlight + shade stripes
    ctx.fillStyle = "rgba(255,255,255,.28)";
    ctx.fillRect(p.x + 7, -10, 9, topH + 10);
    ctx.fillRect(p.x + 7, botY, 9, GROUND_Y - botY);
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.fillRect(p.x + PIPE_W - 12, -10, 12, topH + 10);
    ctx.fillRect(p.x + PIPE_W - 12, botY, 12, GROUND_Y - botY);
    // caps
    ctx.fillStyle = "#27a15c";
    ctx.fillRect(capX, topH - CAP_H, capW, CAP_H);
    ctx.fillRect(capX, botY, capW, CAP_H);
    ctx.strokeStyle = "#127a24";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(capX + 1.25, topH - CAP_H + 1.25, capW - 2.5, CAP_H - 2.5);
    ctx.strokeRect(capX + 1.25, botY + 1.25, capW - 2.5, CAP_H - 2.5);
  }

  function drawBird() {
    ctx.save();
    ctx.translate(BIRD_X, bird.y);
    ctx.rotate(bird.rot);
    // body
    ctx.fillStyle = "#ffd83a";
    ctx.strokeStyle = "#1c2233";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // belly
    ctx.fillStyle = "#fff6d8";
    ctx.beginPath();
    ctx.arc(-2, 6, 8, 0, Math.PI * 2);
    ctx.fill();
    // wing (flaps forward right after a beat, else idles)
    var wingAng = bird.wing > 0 ? -1.1 + (1 - bird.wing) * 1.7 : Math.sin(t * 8) * 0.25 + 0.15;
    ctx.save();
    ctx.translate(-3, 1);
    ctx.rotate(wingAng);
    ctx.fillStyle = "#f0a90a";
    ctx.beginPath();
    ctx.ellipse(0, 5, 6.5, 9.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // beak
    ctx.fillStyle = "#ff8c1a";
    ctx.beginPath();
    ctx.moveTo(9, -1);
    ctx.lineTo(22, 2.5);
    ctx.lineTo(9, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6, -5.5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1c2233";
    ctx.beginPath();
    ctx.arc(7.6, -5.5, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Input ----------
  function primaryAction() {
    if (state === "ready") startRun();
    else if (state === "play") flap();
    else if (state === "over" && t - diedAt > 0.45) resetRun(), startRun();
  }
  stage.addEventListener("pointerdown", function (e) {
    // Buttons/links inside the overlays handle themselves.
    if (e.target.closest("button, a")) return;
    primaryAction();
  });
  document.addEventListener("keydown", function (e) {
    if (rulesModal && !rulesModal.hidden) {
      if (e.key === "Escape") closeRules();
      return;
    }
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
      e.preventDefault();
      primaryAction();
      return;
    }
    var k = (e.key || "").toLowerCase();
    if (k === "n") { resetRun(); startRun(); }
    else if (k === "r") openRules();
    else if (k === "m") toggleSound();
  });
  startBtn.addEventListener("click", function () { if (state === "ready") startRun(); });
  againBtn.addEventListener("click", function () { resetRun(); startRun(); });
  newBtn.addEventListener("click", function () { resetRun(); startRun(); });

  // ---------- Sound toggle / rules modal ----------
  function toggleSound() {
    muted = !muted;
    soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
    soundBtn.setAttribute("aria-pressed", String(!muted));
    saveStats({ best: best, muted: muted });
    if (!muted) sndFlap();
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
  resetRun();
  requestAnimationFrame(frame);
})();
