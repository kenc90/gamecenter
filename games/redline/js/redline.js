/* =====================================================================
   Redline — a pseudo-3D arcade racer in plain canvas.
   The road is an endless strip of segments projected the Out Run way:
   curve and hill are pure sine functions of the segment index (seeded),
   so the track regenerates bit-identically from the run save. Traffic
   cars are live objects; roadside art is a hash of the segment index.
   No libraries, no assets.
   ===================================================================== */
(function () {
  "use strict";

  var W = 640, H = 400;
  var SEG = 200;                    // world units per road segment
  var ROAD_W = 2000;                // half-width of the road in world units
  var DRAW = 170;                   // segments rendered ahead
  var CAM_H = 1000, PLAYER_Z = 840; // camera height / player distance ahead
  var CAM_D = 1 / Math.tan(50 * Math.PI / 180);   // ~100° field of view
  var MAX_SPD = 12000;              // world units / s  (displayed ~300 km/h)
  var ACC = 7200, BRK = 15000, COAST = 1600, OFF_BRK = 5200, OFF_MAX = 3200;
  var CP_FIRST = 30000, CP_EVERY = 90000;   // checkpoint z positions
  var START_TIME = 20, CP_TIME = 8, CRASH_TIME = 4;

  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var DPR = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  var stage = document.getElementById("stage");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var soundBtn = document.getElementById("soundBtn");
  var pauseBtn = document.getElementById("pauseBtn");
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

  // ---------- Persistence ----------
  var STATS_KEY = "gc-redline-stats", RUN_KEY = "gc-redline-run";
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { best: 0, muted: false }; }
    catch (e) { return { best: 0, muted: false }; }
  }
  function saveStats() { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {} }
  var stats = loadStats();

  // ---------- Deterministic world ----------
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  var seed = 0, ph1 = 0, ph2 = 0, ph3 = 0, ph4 = 0, ph5 = 0;
  function setSeed(s) {
    seed = s;
    ph1 = hash(s) * 6.283; ph2 = hash(s + 7.13) * 6.283; ph3 = hash(s + 19.7) * 6.283;
    ph4 = hash(s + 31.3) * 6.283; ph5 = hash(s + 53.9) * 6.283;
  }
  function segY(i) { return 1300 * Math.sin(i * 0.019 + ph4) + 700 * Math.sin(i * 0.0053 + ph5); }
  function curveAt(i) {
    return 3.2 * Math.sin(i * 0.023 + ph1) + 2.2 * Math.sin(i * 0.0071 + ph2) + 1.4 * Math.sin(i * 0.0013 + ph3);
  }
  function cpAt(k) { return CP_FIRST + k * CP_EVERY; }

  // ---------- Game state ----------
  var state = "ready";              // ready | play | pause | over
  var pos = 0, playerX = 0, speed = 0;
  var timeLeft = START_TIME, cps = 0;
  var startCd = 0, goAt = -9, goToast = "";   // 3-2-1-GO staging lights
  var t = 0, lastFrame = 0;
  var crashAt = -9, cpFlashAt = -9, shake = 0;
  var toast = "", toastUntil = 0;
  var parts = [];                   // dust + sparks
  var keys = { gas: 0, brk: 0, left: 0, right: 0 };
  var touchSteer = 0, touchGas = false;
  var saveTimer = 0;
  var cars = [];

  function score() { return Math.floor(pos / 100) + cps * 500; }
  function setScore() {
    scoreEl.textContent = score();
    if (score() > stats.best) { stats.best = score(); saveStats(); }
    bestEl.textContent = stats.best;
  }
  function say(msg, secs) { toast = msg; toastUntil = t + (secs || 2.2); }

  var CAR_COLORS = ["#d43a2f", "#2a9dd6", "#f0a90a", "#2fb068", "#e8ecf2", "#7d40e0", "#ff6e1a"];
  function spawnCar(ahead) {
    var z = ahead ? pos + 6000 + Math.random() * 30000 : Math.random() * 36000;
    cars.push({
      z: z, offset: (Math.random() * 1.6 - 0.8),
      spd: MAX_SPD * (0.22 + Math.random() * 0.34),
      c: CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0],
      hitCool: 0
    });
  }
  function resetCars() {
    cars = [];
    for (var i = 0; i < 7; i++) spawnCar(false);
    cars.forEach(function (c) { if (c.z < pos + 1500) c.z += 6000 + Math.random() * 26000; });
  }

  // ---------- Sound ----------
  var audioCtx = null, engOsc = null, engGain = null;
  function beep(freq, dur, type, vol, slide) {
    if (stats.muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "square"; o.frequency.value = freq;
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), audioCtx.currentTime + dur);
      g.gain.value = vol || 0.04;
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }
  function engineOn() {
    if (stats.muted || state !== "play") return engineOff();
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!engOsc) {
        engOsc = audioCtx.createOscillator(); engGain = audioCtx.createGain();
        engOsc.type = "sawtooth"; engOsc.frequency.value = 45; engGain.gain.value = 0.0;
        engOsc.connect(engGain); engGain.connect(audioCtx.destination); engOsc.start();
      }
    } catch (e) {}
  }
  function engineTick() {
    if (!engOsc) return;
    var p = speed / MAX_SPD;
    engOsc.frequency.value = 38 + p * 105 + (keys.gas ? 8 : 0);
    engGain.gain.value = 0.012 + p * 0.014;
  }
  function engineOff() {
    try { if (engGain) engGain.gain.value = 0; } catch (e) {}
  }
  function sndCrash() { beep(200, 0.3, "sawtooth", 0.07, 40); beep(90, 0.35, "square", 0.05, 30); }
  function sndCp() { beep(660, 0.09, "triangle", 0.05); setTimeout(function () { beep(880, 0.09, "triangle", 0.05); }, 90); setTimeout(function () { beep(1320, 0.18, "triangle", 0.05); }, 180); }
  function sndCount() { beep(620, 0.12, "square", 0.05); }
  function sndGo() { beep(980, 0.35, "square", 0.06); }
  function sndTick() { beep(1100, 0.05, "square", 0.03); }

  // ---------- Run save ----------
  function saveRun() {
    if (state !== "play" && state !== "pause") return;
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify({ seed: seed, pos: pos, x: playerX, spd: speed, time: timeLeft, cps: cps }));
    } catch (e) {}
  }
  function clearRun() { try { localStorage.removeItem(RUN_KEY); } catch (e) {} }
  function peekRun() { try { return JSON.parse(localStorage.getItem(RUN_KEY)); } catch (e) { return null; } }

  // ---------- Flow ----------
  function newRun() {
    setSeed((Math.random() * 100000) | 0);
    pos = 0; playerX = 0; speed = 0; timeLeft = START_TIME; cps = 0;
    parts = []; shake = 0;
    resetCars();
    state = "play";
    readyOverlay.hidden = true; pauseOverlay.hidden = true; overOverlay.hidden = true;
    setScore(); engineOn();
    startCd = 3.99; goToast = "GO! The clock is running now";
  }
  function resumeRun(r) {
    setSeed(r.seed); pos = r.pos; playerX = r.x; speed = r.spd;
    timeLeft = r.time; cps = r.cps; parts = [];
    resetCars();
    state = "play";
    readyOverlay.hidden = true; pauseOverlay.hidden = true; overOverlay.hidden = true;
    setScore(); engineOn();
    startCd = 3.99; goToast = "Back in the driver's seat — clock running";
  }
  function gameOver() {
    state = "over"; engineOff();
    clearRun();
    var s = score(), isBest = s >= stats.best && s > 0;
    overTitle.textContent = isBest ? "Legend of the coast road" : "The clock beat you";
    overMedal.textContent = isBest ? "🏆" : "⏱️";
    overStats.textContent = "Score " + s + " · " + Math.floor(pos / 100) + " m · " + cps + " checkpoints smashed";
    overOverlay.hidden = false;
    setScore();
  }
  function crash(car) {
    if (t - crashAt < 0.8) return;
    crashAt = t; shake = 1;
    speed *= 0.12;                                        // nearly stopped
    timeLeft = Math.max(0, timeLeft - CRASH_TIME);        // and the clock bleeds
    playerX += (Math.random() - 0.5) * 0.6;               // knocked off your line
    say("-" + CRASH_TIME + "s \u2014 metal costs minutes", 1.8);
    sndCrash();
    for (var i = 0; i < 16; i++) {
      var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 220;
      parts.push({ x: W / 2 + playerX * 120, y: H - 74, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 90,
        life: 0.35 + Math.random() * 0.4, c: i % 2 ? "#ff6e1a" : "#fff3c4" });
    }
    if (car) car.z = pos - 400;    // spin the offender out of the way
    say("That was a rental", 1.4);
  }

  // ---------- Input ----------
  document.addEventListener("keydown", function (e) {
    if (rulesModal && !rulesModal.hidden) { if (e.key === "Escape") closeRules(); return; }
    var k = e.key.toLowerCase();
    if (k === "arrowup" || k === "w") { keys.gas = 1; e.preventDefault(); }
    else if (k === "arrowdown" || k === "s") { keys.brk = 1; e.preventDefault(); }
    else if (k === "arrowleft" || k === "a") { keys.left = 1; e.preventDefault(); }
    else if (k === "arrowright" || k === "d") { keys.right = 1; e.preventDefault(); }
    else if (k === " ") { e.preventDefault(); if (state === "ready" || state === "over") newRun(); }
    else if (k === "p") togglePause();
    else if (k === "n") newRun();
    else if (k === "r") openRules();
    else if (k === "m") toggleSound();
  });
  document.addEventListener("keyup", function (e) {
    var k = e.key.toLowerCase();
    if (k === "arrowup" || k === "w") keys.gas = 0;
    else if (k === "arrowdown" || k === "s") keys.brk = 0;
    else if (k === "arrowleft" || k === "a") keys.left = 0;
    else if (k === "arrowright" || k === "d") keys.right = 0;
  });
  // Touch: hold the screen = gas, drag left/right = steer
  var touchId = null;
  stage.addEventListener("pointerdown", function (e) {
    if (e.target.closest("button, a") || state !== "play" || e.pointerType === "mouse") return;
    touchId = e.pointerId; touchGas = true;
    steerFrom(e);
  });
  stage.addEventListener("pointermove", function (e) { if (e.pointerId === touchId) steerFrom(e); });
  stage.addEventListener("pointerup", function () { touchId = null; touchGas = false; touchSteer = 0; });
  function steerFrom(e) {
    var r = stage.getBoundingClientRect();
    touchSteer = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2.4));
  }

  function togglePause() {
    if (state === "play") { state = "pause"; saveRun(); engineOff(); pauseOverlay.hidden = false; }
    else if (state === "pause") { state = "play"; engineOn(); pauseOverlay.hidden = true; }
  }
  pauseBtn.addEventListener("click", function () { if (state === "play" || state === "pause") togglePause(); });
  resumeBtn.addEventListener("click", function () { if (state === "pause") togglePause(); });
  startBtn.addEventListener("click", function () { if (state === "ready") newRun(); });
  continueBtn.addEventListener("click", function () { var r = peekRun(); if (r && state === "ready") resumeRun(r); else newRun(); });
  againBtn.addEventListener("click", function () { if (state === "over") newRun(); });
  newBtn.addEventListener("click", function () { newRun(); });
  function toggleSound() {
    stats.muted = !stats.muted; saveStats();
    soundBtn.textContent = stats.muted ? "Sound: Off" : "Sound: On";
    soundBtn.setAttribute("aria-pressed", String(!stats.muted));
    if (stats.muted) engineOff(); else engineOn();
  }
  soundBtn.addEventListener("click", toggleSound);
  function openRules() { rulesModal.hidden = false; }
  function closeRules() { rulesModal.hidden = true; }
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state === "play") { state = "pause"; saveRun(); engineOff(); pauseOverlay.hidden = false; }
  });
  window.addEventListener("pagehide", saveRun);

  // ---------- Update ----------
  function update(dt) {
    t += dt;
    shake = Math.max(0, shake - dt * 3);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 340 * dt; p.life -= dt;
      if (p.life <= 0) parts.splice(i, 1);
    }
    if (state !== "play") return;

    // 3-2-1-GO staging: the world holds its breath until the lights go out
    if (startCd > 0) {
      var pv = Math.ceil(startCd);
      startCd -= dt;
      if (Math.ceil(startCd) !== pv && startCd > 0) sndCount();
      if (startCd <= 0) {
        startCd = 0; goAt = t; sndGo(); engineTick();
        if (goToast) say(goToast, 2);
      }
      return;
    }

    var spPct = speed / MAX_SPD;
    var gas = keys.gas || touchGas;
    if (gas) speed += ACC * dt * (1 - spPct * 0.55);
    else if (keys.brk) speed -= BRK * dt;
    else speed -= COAST * dt;

    // off-road bite
    var offroad = Math.abs(playerX) > 1;
    if (offroad) {
      if (speed > OFF_MAX) speed -= OFF_BRK * dt;
      if (speed > 900 && Math.random() < 0.5) {
        parts.push({ x: W / 2 + playerX * 120 + (Math.random() * 60 - 30), y: H - 52,
          vx: (Math.random() - 0.5) * 60, vy: -40 - Math.random() * 60,
          life: 0.4 + Math.random() * 0.3, c: "#a8895e" });
      }
    }
    speed = Math.max(0, Math.min(MAX_SPD, speed));
    pos += speed * dt;

    // steering + centrifugal drift through curves
    var steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (touchGas && touchSteer) steer = touchSteer;
    playerX += steer * dt * 3.0 * Math.max(0.25, spPct);
    playerX -= dt * spPct * curveAt(Math.floor(pos / SEG)) * 0.32;
    playerX = Math.max(-2.6, Math.min(2.6, playerX));

    // traffic
    for (var j = 0; j < cars.length; j++) {
      var c = cars[j];
      c.z += c.spd * dt;
      if (c.z < pos - 2500) { c.z = pos + 24000 + Math.random() * 14000; c.offset = Math.random() * 1.6 - 0.8; c.hitCool = 0; }
      if (Math.abs(c.z - pos) < 170 && Math.abs(c.offset - playerX) < 0.3 && speed > c.spd * 0.6) crash(c);
    }

    // checkpoints
    if (pos >= cpAt(cps)) {
      cps++; timeLeft += CP_TIME; cpFlashAt = t;
      sndCp(); setScore();
      say("CHECKPOINT +" + CP_TIME + "s — keep the needle pinned", 2);
    }

    // countdown
    var prev = Math.ceil(timeLeft);
    timeLeft -= dt;
    if (Math.ceil(timeLeft) !== prev && timeLeft <= 5.05 && timeLeft > 0) sndTick();
    if (timeLeft <= 0) { timeLeft = 0; gameOver(); return; }

    engineTick();
    setScore();
    saveTimer += dt;
    if (saveTimer > 2) { saveTimer = 0; saveRun(); }
  }

  // ---------- Render ----------
  var proj = new Array(DRAW);
  (function () { for (var i = 0; i < DRAW; i++) proj[i] = { x: 0, y: 0, w: 0, s: 0, clip: H, ok: false }; })();

  function project(i, camX, camY, camZ, out) {
    var dz = i * SEG - camZ;
    if (dz < 40) { out.ok = false; return out; }
    var s = CAM_D / dz;
    out.x = W / 2 + s * (0 - camX) * W / 2;
    out.y = H / 2 - s * (segY(i) - camY) * H / 2;
    out.w = s * ROAD_W * W / 2;
    out.s = s;
    out.ok = true;
    return out;
  }

  function render() {
    // sky
    var sg = ctx.createLinearGradient(0, 0, 0, H / 2);
    sg.addColorStop(0, "#1c2e5e"); sg.addColorStop(0.72, "#a34f2a"); sg.addColorStop(1, "#ff9a3c");
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H / 2 + 2);
    // sun with retro slits
    var sunX = W / 2 - playerX * 26 - Math.sin(pos * 0.000008) * 90, sunY = H / 2 - 46;
    ctx.fillStyle = "#ffd83a";
    ctx.beginPath(); ctx.arc(sunX, sunY, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ff9a3c";
    for (var k = 0; k < 4; k++) ctx.fillRect(sunX - 36, sunY + 6 + k * 8, 72, 3);
    // headlight hills
    ctx.fillStyle = "#243a52";
    ctx.beginPath(); ctx.arc(W * 0.22 - playerX * 16, H / 2 + 42, 110, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.74 - playerX * 16, H / 2 + 52, 150, Math.PI, 0); ctx.fill();
    // ground base so hill gaps never show sky
    ctx.fillStyle = "#2a7a38"; ctx.fillRect(0, H / 2, W, H / 2);

    // --- road pass (near to far, hill-clipped) ---
    var camZ = pos - PLAYER_Z;
    var baseIdx = Math.floor(pos / SEG);
    var frac = pos / SEG - baseIdx;
    var camY = segY(baseIdx) + (segY(baseIdx + 1) - segY(baseIdx)) * frac + CAM_H;
    var x = 0, dx = -(curveAt(baseIdx) * frac), maxy = H;
    for (var n = 0; n < DRAW; n++) {
      var i = baseIdx + n;
      var p1 = project(i, playerX * ROAD_W - x, camY, camZ, proj[n]);
      var p2 = project(i + 1, playerX * ROAD_W - x - dx, camY, camZ, { x: 0, y: 0, w: 0, s: 0 });
      x += dx; dx += curveAt(i);
      p1.clip = maxy;
      if (!p1.ok || !p2.ok || p2.y >= p1.y || p2.y >= maxy) continue;
      var band = Math.floor(i / 3) % 2 === 0;
      // grass band
      ctx.fillStyle = band ? "#2f8f3f" : "#2a8238";
      ctx.fillRect(0, p2.y, W, p1.y - p2.y + 1);
      // rumble strips
      ctx.fillStyle = band ? "#d43a2f" : "#e8ecf2";
      quad(p1.x - p1.w * 1.16, p1.y, p1.w * 0.16, p2.x - p2.w * 1.16, p2.y, p2.w * 0.16);
      quad(p1.x + p1.w, p1.y, p1.w * 0.16, p2.x + p2.w, p2.y, p2.w * 0.16);
      // asphalt
      ctx.fillStyle = band ? "#585860" : "#525258";
      quad(p1.x - p1.w, p1.y, p1.w * 2, p2.x - p2.w, p2.y, p2.w * 2);
      // lane dashes
      if (band) {
        ctx.fillStyle = "#e8ecf2";
        quad(p1.x - p1.w * 0.02, p1.y, p1.w * 0.04, p2.x - p2.w * 0.02, p2.y, p2.w * 0.04);
        quad(p1.x + p1.w * 0.31, p1.y, p1.w * 0.04, p2.x + p2.w * 0.31, p2.y, p2.w * 0.04);
        quad(p1.x - p1.w * 0.35, p1.y, p1.w * 0.04, p2.x - p2.w * 0.35, p2.y, p2.w * 0.04);
      }
      // fog toward the sunset haze
      var fog = Math.exp(-4.6 * (n / DRAW) * (n / DRAW));
      if (fog < 0.98) {
        ctx.fillStyle = "rgba(255,154,60," + (0.98 - fog * 0.98).toFixed(2) + ")";
        ctx.fillRect(0, p2.y, W, p1.y - p2.y + 1);
      }
      maxy = p2.y;
    }

    // --- sprite pass (far to near) ---
    var carBucket = {};
    for (var ci = 0; ci < cars.length; ci++) {
      var cn = Math.floor(cars[ci].z / SEG) - baseIdx;
      if (cn >= 0 && cn < DRAW) (carBucket[cn] = carBucket[cn] || []).push(cars[ci]);
    }
    for (var sn = DRAW - 1; sn >= 0; sn--) {
      var sp = proj[sn];
      if (!sp.ok) continue;
      var si = baseIdx + sn;
      drawRoadside(si, sp);
      var gateN = Math.floor(cpAt(cps) / SEG) - baseIdx;
      if (sn === gateN) drawGate(sp);
      var list = carBucket[sn];
      if (list) for (var li = 0; li < list.length; li++) drawCar(list[li], sp);
    }

    drawPlayerCar();
    drawParts();
    var cf = Math.max(0, 1 - (t - cpFlashAt) / 0.35);
    if (cf > 0) { ctx.fillStyle = "rgba(255,216,58," + (cf * 0.16).toFixed(2) + ")"; ctx.fillRect(0, 0, W, H); }
    drawHud();
    // staging lights / GO! — drawn over the HUD, impossible to miss
    if (startCd > 0) {
      var num = Math.ceil(startCd);
      var pop = 1 + (startCd - Math.floor(startCd)) * 0.5;   // each digit punches in, then settles
      ctx.fillStyle = "rgba(10,8,6,.55)";
      ctx.fillRect(W / 2 - 80, 58, 160, 130);
      ctx.textAlign = "center";
      ctx.font = "900 " + Math.round(96 / pop) + "px system-ui, sans-serif";
      ctx.fillStyle = num === 1 ? "#ff5a4e" : num === 2 ? "#ffd83a" : "#3fae4e";
      ctx.fillText(num, W / 2, 158);
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.fillStyle = "#9aa4b6";
      ctx.fillText("S T A G I N G", W / 2, 180);
      ctx.textAlign = "left";
    } else if (t - goAt < 0.8) {
      var gt = (t - goAt) / 0.8;
      ctx.textAlign = "center";
      ctx.font = "900 " + Math.round(72 + gt * 46) + "px system-ui, sans-serif";
      ctx.globalAlpha = 1 - gt * gt;
      ctx.fillStyle = "#3fae4e";
      ctx.fillText("GO!", W / 2, 150);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
    if (toast && t < toastUntil) {
      ctx.font = "bold 15px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(W / 2 - 190, 56, 380, 24);
      ctx.fillStyle = "#ffd83a"; ctx.fillText(toast, W / 2, 73);
      ctx.textAlign = "left";
    }
  }
  function quad(x1, y1, w1, x2, y2, w2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x1 + w1, y1); ctx.lineTo(x2 + w2, y2); ctx.lineTo(x2, y2);
    ctx.closePath(); ctx.fill();
  }
  function clipped(p, fn) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, Math.max(0, p.clip)); ctx.clip();
    fn();
    ctx.restore();
  }
  function drawRoadside(i, p) {
    var h = hash(i * 3.7 + seed * 0.11);
    if (h > 0.62) return;
    var side = h < 0.31 ? -1 : 1;
    var off = 1.35 + hash(i * 9.1) * 1.6;
    var u = p.w / ROAD_W;                       // px per world unit at this depth
    var bx = p.x + p.w * off * side, by = p.y;
    if (bx < -2000 * u || bx > W + 2000 * u) return;   // fully off-screen
    clipped(p, function () {
      var kind = hash(i * 5.3);
      if (kind < 0.72) {           // palm
        var th = (4600 + hash(i) * 2200) * u;
        ctx.fillStyle = "#5a4030";
        ctx.fillRect(bx - 130 * u, by - th, 260 * u, th);
        ctx.fillStyle = "#1c6b34";
        for (var f = 0; f < 5; f++) {
          var fa = Math.PI + f * (Math.PI / 4);
          ctx.beginPath();
          ctx.ellipse(bx + Math.cos(fa) * 700 * u, by - th + Math.sin(fa) * 260 * u, 640 * u, 190 * u, fa * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (kind < 0.9) {     // rock
        ctx.fillStyle = "#7a7368";
        ctx.beginPath();
        ctx.moveTo(bx - 620 * u, by); ctx.lineTo(bx - 200 * u, by - 460 * u);
        ctx.lineTo(bx + 320 * u, by - 330 * u); ctx.lineTo(bx + 680 * u, by);
        ctx.closePath(); ctx.fill();
      } else {                      // billboard
        var bh = 3400 * u;
        ctx.fillStyle = "#4a4440";
        ctx.fillRect(bx - 90 * u, by - bh, 180 * u, bh);
        ctx.fillStyle = "#d43a2f";
        ctx.fillRect(bx - 1700 * u, by - bh - 1300 * u, 3400 * u, 1300 * u);
        ctx.fillStyle = "#fff3c4";
        ctx.fillRect(bx - 1400 * u, by - bh - 1000 * u, 2800 * u, 220 * u);
      }
    });
  }
  function drawGate(p) {
    clipped(p, function () {
      var gw = p.w * 1.22, gh = Math.max(14, p.w * 0.62);
      ctx.fillStyle = "#e8ecf2";
      ctx.fillRect(p.x - gw - p.w * 0.07, p.y - gh, p.w * 0.09, gh);
      ctx.fillRect(p.x + gw - p.w * 0.02, p.y - gh, p.w * 0.09, gh);
      ctx.fillStyle = "#141210";
      ctx.fillRect(p.x - gw, p.y - gh, gw * 2, gh * 0.36);
      ctx.fillStyle = "#ffd83a";
      ctx.font = "bold " + Math.max(6, gh * 0.2) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("CHECKPOINT", p.x, p.y - gh * 0.14);
      ctx.textAlign = "left";
    });
  }
  function drawCar(c, p) {
    var u = p.w;                       // half road width in px here
    var cw = u * 0.24, ch = cw * 0.62; // ~480 world units — a car, not a monster truck
    var cx = p.x + u * c.offset, cy = p.y;
    if (cx < -cw || cx > W + cw) return;
    clipped(p, function () {
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.beginPath(); ctx.ellipse(cx, cy, cw * 0.62, ch * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.c;             // body
      ctx.fillRect(cx - cw * 0.5, cy - ch * 0.72, cw, ch * 0.62);
      ctx.fillRect(cx - cw * 0.36, cy - ch, cw * 0.72, ch * 0.36);   // roof
      ctx.fillStyle = "#1a1e26";       // wheels
      ctx.fillRect(cx - cw * 0.54, cy - ch * 0.26, cw * 0.12, ch * 0.26);
      ctx.fillRect(cx + cw * 0.42, cy - ch * 0.26, cw * 0.12, ch * 0.26);
      ctx.fillStyle = "#ff3b30";       // tail lights
      ctx.fillRect(cx - cw * 0.4, cy - ch * 0.5, cw * 0.14, ch * 0.12);
      ctx.fillRect(cx + cw * 0.26, cy - ch * 0.5, cw * 0.14, ch * 0.12);
    });
  }
  function drawPlayerCar() {
    if (state === "ready") return;
    var bounce = (speed / MAX_SPD) * 2 + shake * 7;
    var cx = W / 2 + ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * 6 + touchSteer * 6;
    var cy = H - 46 + Math.sin(t * 30) * bounce * 0.4 + (Math.random() - 0.5) * shake * 6;
    var crashed = t - crashAt < 0.35;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) + touchSteer) * 0.045);
    // shadow
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.beginPath(); ctx.ellipse(0, 26, 66, 10, 0, 0, Math.PI * 2); ctx.fill();
    // wheels
    ctx.fillStyle = "#14161c";
    ctx.fillRect(-68, 2, 20, 26); ctx.fillRect(48, 2, 20, 26);
    // body
    ctx.fillStyle = crashed ? "#ff8c60" : "#d43a2f";
    ctx.beginPath();
    ctx.moveTo(-52, 24); ctx.lineTo(-40, -6); ctx.lineTo(-22, -18); ctx.lineTo(22, -18);
    ctx.lineTo(40, -6); ctx.lineTo(52, 24); ctx.closePath(); ctx.fill();
    // rear window
    ctx.fillStyle = "#20242e";
    ctx.beginPath(); ctx.moveTo(-20, -14); ctx.lineTo(20, -14); ctx.lineTo(28, -2); ctx.lineTo(-28, -2); ctx.closePath(); ctx.fill();
    // spoiler
    ctx.fillStyle = "#22262e";
    ctx.fillRect(-50, -26, 100, 8);
    ctx.fillRect(-40, -18, 8, 6); ctx.fillRect(32, -18, 8, 6);
    // brake/tail lights
    ctx.fillStyle = keys.brk ? "#ff5a4e" : "#8a1f16";
    ctx.fillRect(-44, 6, 22, 8); ctx.fillRect(22, 6, 22, 8);
    ctx.restore();
  }
  function drawParts() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2.4));
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }
  function drawHud() {
    // timer: big, top-centre — the star of a time trial
    var urgent = timeLeft < 5 && state === "play";
    ctx.fillStyle = "rgba(10,8,6,.62)";
    ctx.fillRect(W / 2 - 64, 0, 128, 46);
    ctx.textAlign = "center";
    ctx.font = "800 " + (urgent ? 30 + Math.sin(t * 14) * 3 : 28) + "px system-ui, sans-serif";
    ctx.fillStyle = state === "over" ? "#8a8f99" : urgent ? "#ff5a4e" : "#ffd83a";
    ctx.fillText(Math.ceil(timeLeft) + "s", W / 2, 30);
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.fillStyle = "#9aa4b6";
    ctx.fillText("TIME LEFT", W / 2, 41);
    // bottom strip: speed, score, checkpoints
    ctx.fillStyle = "rgba(10,8,6,.62)";
    ctx.fillRect(0, H - 34, W, 34);
    ctx.font = "800 20px system-ui, sans-serif";
    ctx.fillStyle = "#e8ecf2";
    ctx.fillText(Math.round(speed / 40) + " km/h", 14, H - 10);
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillStyle = "#9aa4b6";
    ctx.fillText("SCORE " + score(), 14, H - 24);
    ctx.textAlign = "right";
    ctx.font = "800 16px system-ui, sans-serif";
    ctx.fillStyle = "#e8ecf2";
    ctx.fillText("CP " + cps, W - 14, H - 12);
    ctx.textAlign = "left";
  }

  // ---------- Main loop ----------
  function loop(now) {
    var dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    ctx.setTransform(DPR, 0, 0, DPR, (Math.random() - 0.5) * shake * 10 * DPR, (Math.random() - 0.5) * shake * 6 * DPR);
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Boot ----------
  bestEl.textContent = stats.best;
  soundBtn.textContent = stats.muted ? "Sound: Off" : "Sound: On";
  soundBtn.setAttribute("aria-pressed", String(!stats.muted));
  var saved = peekRun();
  if (saved && typeof saved.pos === "number") {
    continueBtn.hidden = false;
    continueBtn.textContent = "Resume — " + Math.floor(saved.pos / 100) + " m";
    setSeed(saved.seed); pos = saved.pos; playerX = saved.x; speed = saved.spd;
    timeLeft = saved.time; cps = saved.cps;
    resetCars();
    setScore();
  } else {
    setSeed((Math.random() * 100000) | 0);
    resetCars();
  }
  requestAnimationFrame(function (n) { lastFrame = n; requestAnimationFrame(loop); });
})();
