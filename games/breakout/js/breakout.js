/* ===== Breakout — game logic =====
   Single-file, dependency-free canvas game; all art is drawn with 2D
   primitives (no image assets).
   - Slide the paddle with mouse / touch / arrows, launch with Space.
   - Seven brick rows, worth 10..70 points bottom-up; clear the wall to
     advance a level (faster ball, narrower paddle).
   - Best score + sound persisted in gc-breakout-stats; the live run
     (score, lives, level, surviving bricks) persists in gc-breakout-run
     so a refresh resumes where you left off. */
(function () {
  "use strict";

  // ---------- Canvas / world constants ----------
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var W = 480, H = 600;                 // logical units, DPR-scaled below

  // Sharp rendering on hi-dpi screens: back store in device pixels.
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  var ROWS = 7, COLS = 8;
  var WALL_X = 14, WALL_TOP = 78, BRICK_GAP = 4;
  var BRICK_W = (W - WALL_X * 2 - BRICK_GAP * (COLS - 1)) / COLS;
  var BRICK_H = 20;
  var PADDLE_Y = H - 38, PADDLE_H = 12;
  var BALL_R = 7;
  var HUD_H = WALL_TOP - 8;             // dark strip on top for level / lives

  // Row colours, top -> bottom (classic rainbow wall).
  var ROW_COLORS = ["#e23b2e", "#ff8c1a", "#ffd83a", "#2fb068", "#2a9dd6", "#7b3bf0", "#f04a9b"];
  function rowPts(r) { return (r + 1) * 10; }    // bottom row pays most

  function paddleW() { return Math.max(48, 78 - (level - 1) * 6); }
  function ballSpeed() { return Math.min(470, 300 + (level - 1) * 28); }

  // ---------- Persistence ----------
  var STATS_KEY = "gc-breakout-stats";
  var RUN_KEY = "gc-breakout-run";
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
        score: score, lives: lives, level: level, bricks: bricks
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
  var livesEl = document.getElementById("lives");
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
  var state = "ready";                  // ready | play | over
  var paused = false;
  var score = 0, lives = 3, level = 1;
  var bricks = [];                      // 1 = alive, 0 = smashed (row-major)
  var paddleX = W / 2;                  // paddle centre
  var ball = { x: W / 2, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0, stuck: true };
  var debris = [];                      // {x,y,vx,vy,life,color} brick shards
  var banner = null;                    // {text, until} centred canvas message
  var t = 0;
  var keys = { left: false, right: false };

  // Deterministic starfield so the backdrop never shimmers.
  var stars = [];
  (function () {
    var seed = 20260919;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var i = 0; i < 46; i++) stars.push({ x: rnd() * W, y: rnd() * H, r: .6 + rnd() * 1.1, a: .18 + rnd() * .4 });
  })();

  function buildWall() {
    bricks = [];
    for (var i = 0; i < ROWS * COLS; i++) bricks.push(1);
  }
  function bricksLeft() {
    var n = 0;
    for (var i = 0; i < bricks.length; i++) n += bricks[i];
    return n;
  }
  function stickBall() {
    ball.stuck = true;
    ball.vx = 0; ball.vy = 0;
    ball.x = paddleX;
    ball.y = PADDLE_Y - BALL_R - 1;
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
  function sndBounce() { beep(240, 0.05, "square", 0.03); }
  function sndBrick(r) { beep(420 + r * 60, 0.06, "square", 0.045, 620 + r * 60); }
  function sndLaunch() { beep(300, 0.1, "triangle", 0.05, 640); }
  function sndDie() { beep(300, 0.28, "sawtooth", 0.06, 60); }
  function sndLevel() {
    beep(523, 0.09, "triangle", 0.05);
    setTimeout(function () { beep(659, 0.09, "triangle", 0.05); }, 90);
    setTimeout(function () { beep(784, 0.16, "triangle", 0.05); }, 180);
  }

  // ---------- Flow ----------
  function setScore(v) { score = v; scoreEl.textContent = String(score); }
  function setLives(v) { lives = v; livesEl.textContent = String(Math.max(0, lives)); }

  function newGame() {
    state = "play";
    paused = false;
    setScore(0); setLives(3); level = 1;
    buildWall();
    paddleX = W / 2;
    stickBall();
    debris = [];
    banner = { text: "Level 1", until: t + 1.4 };
    readyOverlay.hidden = true;
    overOverlay.hidden = true;
    syncPauseBtn();
    saveRun();
  }

  function loseLife() {
    sndDie();
    setLives(lives - 1);
    if (lives <= 0) { gameOver(); return; }
    stickBall();
    banner = { text: lives + " " + (lives === 1 ? "life" : "lives") + " left", until: t + 1.2 };
    saveRun();
  }

  function levelUp() {
    level++;
    sndLevel();
    stickBall();
    buildWall();
    banner = { text: "Level " + level, until: t + 1.6 };
    saveRun();
  }

  function gameOver() {
    state = "over";
    clearRun();
    var isBest = score > best;
    if (isBest) best = score;
    saveStats({ best: best, muted: muted });
    bestEl.textContent = String(best);
    overTitle.textContent = isBest && score > 0 ? "New best!" : "Game over";
    overMedal.textContent = score >= 7000 ? "\uD83C\uDFC6" : score >= 3500 ? "\uD83E\uDD47" : score >= 1500 ? "\uD83E\uDD48" : score >= 500 ? "\uD83E\uDD49" : "\uD83D\uDC80";
    overStats.textContent = "Score " + score + " \u00b7 Best " + best + " \u00b7 Level " + level;
    overOverlay.hidden = false;
  }

  function launch() {
    if (!ball.stuck) return;
    ball.stuck = false;
    var a = (Math.random() * 0.7 - 0.35);       // -20°..+20° off vertical
    var s = ballSpeed();
    ball.vx = Math.sin(a) * s;
    ball.vy = -Math.cos(a) * s;
    sndLaunch();
  }

  function togglePause(force) {
    if (state !== "play") return;
    paused = (typeof force === "boolean") ? force : !paused;
    syncPauseBtn();
  }
  function syncPauseBtn() {
    var on = paused;
    pauseBtn.textContent = on ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(on));
    pauseBtn.hidden = state !== "play";
  }

  // ---------- Update ----------
  function update(dt) {
    t += dt;
    // debris always animates, even between lives
    for (var d = debris.length - 1; d >= 0; d--) {
      var p = debris[d];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; p.life -= dt;
      if (p.life <= 0) debris.splice(d, 1);
    }
    if (state !== "play" || paused) return;

    // Keyboard paddle drive
    var kv = 460 * dt;
    if (keys.left) paddleX -= kv;
    if (keys.right) paddleX += kv;
    var half = paddleW() / 2;
    paddleX = Math.max(WALL_X + half, Math.min(W - WALL_X - half, paddleX));

    if (ball.stuck) { ball.x = paddleX; ball.y = PADDLE_Y - BALL_R - 1; return; }

    // Sub-stepped motion keeps fast balls from tunnelling through bricks.
    var steps = Math.max(1, Math.ceil(Math.max(Math.abs(ball.vx), Math.abs(ball.vy)) * dt / 6));
    var sdt = dt / steps;
    for (var s = 0; s < steps && !ball.stuck; s++) stepBall(sdt);
  }

  function stepBall(dt) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Walls
    if (ball.x - BALL_R < WALL_X) { ball.x = WALL_X + BALL_R; ball.vx = Math.abs(ball.vx); sndBounce(); }
    else if (ball.x + BALL_R > W - WALL_X) { ball.x = W - WALL_X - BALL_R; ball.vx = -Math.abs(ball.vx); sndBounce(); }
    if (ball.y - BALL_R < HUD_H) { ball.y = HUD_H + BALL_R; ball.vy = Math.abs(ball.vy); sndBounce(); }

    // Bottom out
    if (ball.y - BALL_R > H + 10) { loseLife(); return; }

    // Paddle — angle off the hit offset like the arcade original
    var half = paddleW() / 2;
    if (ball.vy > 0 &&
        ball.y + BALL_R >= PADDLE_Y && ball.y - BALL_R <= PADDLE_Y + PADDLE_H &&
        ball.x >= paddleX - half - BALL_R && ball.x <= paddleX + half + BALL_R) {
      var off = Math.max(-1, Math.min(1, (ball.x - paddleX) / half));
      var ang = off * 1.05;                       // up to ~60 degrees off vertical
      var sp = Math.hypot(ball.vx, ball.vy);
      ball.vx = Math.sin(ang) * sp;
      ball.vy = -Math.cos(ang) * sp;
      ball.y = PADDLE_Y - BALL_R - 0.5;
      sndBounce();
    }

    // Bricks: check the cell the leading edge entered this step
    var row = Math.floor((ball.y - BALL_R - WALL_TOP) / (BRICK_H + BRICK_GAP));
    var col = Math.floor((ball.x - WALL_X) / (BRICK_W + BRICK_GAP));
    if (row >= 0 && row < ROWS && col >= 0 && col < COLS && bricks[row * COLS + col]) {
      bricks[row * COLS + col] = 0;
      setScore(score + rowPts(row));
      if (score > best) { best = score; bestEl.textContent = String(best); }
      sndBrick(ROWS - 1 - row);
      spawnDebris(row, col);
      // Reflect on the axis with the shallower overlap into the brick cell.
      var bx = WALL_X + col * (BRICK_W + BRICK_GAP);
      var by = WALL_TOP + row * (BRICK_H + BRICK_GAP);
      var overX = Math.min(ball.x + BALL_R - bx, bx + BRICK_W - (ball.x - BALL_R));
      var overY = Math.min(ball.y + BALL_R - by, by + BRICK_H - (ball.y - BALL_R));
      if (overX < overY) ball.vx = -ball.vx; else ball.vy = -ball.vy;
      saveRun();
      if (bricksLeft() === 0) levelUp();
    }
  }

  function spawnDebris(row, col) {
    var cx = WALL_X + col * (BRICK_W + BRICK_GAP) + BRICK_W / 2;
    var cy = WALL_TOP + row * (BRICK_H + BRICK_GAP) + BRICK_H / 2;
    var color = ROW_COLORS[row % ROW_COLORS.length];
    for (var i = 0; i < 5; i++) {
      debris.push({
        x: cx + (Math.random() - .5) * BRICK_W * .7,
        y: cy + (Math.random() - .5) * BRICK_H * .6,
        vx: (Math.random() - .5) * 190,
        vy: -40 - Math.random() * 120,
        life: .35 + Math.random() * .3,
        color: color
      });
    }
  }

  // ---------- Draw ----------
  function draw() {
    // Deep-space backdrop
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b1030");
    bg.addColorStop(1, "#1a1040");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      ctx.fillStyle = "rgba(255,255,255," + st.a.toFixed(2) + ")";
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
    }

    // HUD strip
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.fillRect(0, 0, W, HUD_H);
    ctx.font = "800 17px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffd83a";
    ctx.fillText("LEVEL " + level, 16, 34);
    // Lives as little balls, bottom-right of the strip
    for (var l = 0; l < Math.max(0, lives); l++) {
      ctx.fillStyle = "#e8ecff";
      ctx.beginPath();
      ctx.arc(W - 20 - l * 20, 28, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.textAlign = "right";
    ctx.font = "700 12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.fillText(bricksLeft() + " bricks left", W - 16, 56);
    ctx.textAlign = "left";

    // Bricks
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        if (!bricks[r * COLS + c]) continue;
        var x = WALL_X + c * (BRICK_W + BRICK_GAP);
        var y = WALL_TOP + r * (BRICK_H + BRICK_GAP);
        ctx.fillStyle = ROW_COLORS[r % ROW_COLORS.length];
        roundRect(x, y, BRICK_W, BRICK_H, 4); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,.25)";
        roundRect(x + 2, y + 2, BRICK_W - 4, 5, 2.5); ctx.fill();
      }
    }

    // Debris shards
    for (var d = 0; d < debris.length; d++) {
      var p = debris[d];
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 3));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 3, p.y - 2, 6, 4);
    }
    ctx.globalAlpha = 1;

    // Paddle
    var half = paddleW() / 2;
    var pg = ctx.createLinearGradient(0, PADDLE_Y, 0, PADDLE_Y + PADDLE_H);
    pg.addColorStop(0, "#8fb4ff");
    pg.addColorStop(.4, "#2a5ad6");
    pg.addColorStop(1, "#16307e");
    ctx.fillStyle = pg;
    roundRect(paddleX - half, PADDLE_Y, paddleW(), PADDLE_H, 6); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.35)";
    roundRect(paddleX - half + 4, PADDLE_Y + 2, paddleW() - 8, 3, 1.5); ctx.fill();

    // Ball with a soft glow
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,.8)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Launch hint while parked
    if (state === "play" && ball.stuck && !paused) {
      ctx.font = "700 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255," + (0.5 + Math.sin(t * 4) * 0.3).toFixed(2) + ")";
      ctx.fillText("Space or click to launch", W / 2, PADDLE_Y - 34);
      ctx.textAlign = "left";
    }

    // Paused veil
    if (state === "play" && paused) {
      ctx.fillStyle = "rgba(5,8,20,.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.font = "800 30px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.fillText("Paused", W / 2, H / 2);
      ctx.textAlign = "left";
    }

    // Level / life banner
    if (banner && t < banner.until) {
      var a2 = Math.min(1, (banner.until - t) / 0.4);
      ctx.font = "800 34px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(11,16,48," + (0.8 * a2).toFixed(2) + ")";
      ctx.fillStyle = "rgba(255,216,58," + a2.toFixed(2) + ")";
      ctx.strokeText(banner.text, W / 2, H * 0.45);
      ctx.fillText(banner.text, W / 2, H * 0.45);
      ctx.textAlign = "left";
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- Input ----------
  function pointerX(e) {
    var rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left) / rect.width * W;
  }
  stage.addEventListener("pointermove", function (e) {
    if (state !== "play" || paused) return;
    var half = paddleW() / 2;
    paddleX = Math.max(WALL_X + half, Math.min(W - WALL_X - half, pointerX(e)));
  });
  function primaryAction() {
    if (state === "ready") { resumeSavedOrNew(); }
    else if (state === "play" && !paused) launch();
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
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
      e.preventDefault();
      primaryAction();
      return;
    }
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keys.left = true; e.preventDefault(); }
    else if (e.code === "ArrowRight" || e.code === "KeyD") { keys.right = true; e.preventDefault(); }
    var k = (e.key || "").toLowerCase();
    if (k === "n") newGame();
    else if (k === "p") togglePause();
    else if (k === "r") openRules();
    else if (k === "m") toggleSound();
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") keys.left = false;
    else if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = false;
  });
  startBtn.addEventListener("click", function () { if (state === "ready") resumeSavedOrNew(); });
  againBtn.addEventListener("click", function () { newGame(); });
  newBtn.addEventListener("click", function () { newGame(); });
  pauseBtn.addEventListener("click", function () { togglePause(); });

  // ---------- Sound toggle / rules modal ----------
  function toggleSound() {
    muted = !muted;
    soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
    soundBtn.setAttribute("aria-pressed", String(!muted));
    saveStats({ best: best, muted: muted });
    if (!muted) sndBounce();
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
      if (state === "play") togglePause(true);
      if (state === "play") saveRun();
    }
  });
  window.addEventListener("pagehide", function () { if (state === "play") saveRun(); });

  // ---------- Boot ----------
  function resumeSavedOrNew() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(RUN_KEY)); } catch (e) {}
    if (saved && Array.isArray(saved.bricks) && saved.bricks.length === ROWS * COLS &&
        saved.lives > 0 && state !== "play") {
      state = "play";
      setScore(saved.score | 0);
      setLives(saved.lives | 0);
      level = Math.max(1, saved.level | 1);
      bricks = saved.bricks.map(function (b) { return b ? 1 : 0; });
      paddleX = W / 2;
      stickBall();
      readyOverlay.hidden = true;
      syncPauseBtn();
      return;
    }
    newGame();
  }

  bestEl.textContent = String(best);
  soundBtn.textContent = muted ? "Sound: Off" : "Sound: On";
  soundBtn.setAttribute("aria-pressed", String(!muted));
  buildWall();
  syncPauseBtn();
  // A saved run skips the ready card entirely — straight back to the wall.
  try {
    var s0 = JSON.parse(localStorage.getItem(RUN_KEY));
    if (s0 && Array.isArray(s0.bricks) && s0.bricks.length === ROWS * COLS && s0.lives > 0) {
      resumeSavedOrNew();
    }
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
