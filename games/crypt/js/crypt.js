/* =====================================================================
   Crypt Crawler — a Wolfenstein-style raycaster in plain canvas.
   One ray per screen column against a seeded grid map; sprites are
   billboarded rects depth-clipped by the per-column z-buffer. Floors
   regenerate bit-identically from {seed, floor}, so the run save only
   needs the player state. No libraries, no assets.
   ===================================================================== */
(function () {
  "use strict";

  var W = 320, H = 200;            // internal render size (upscaled, pixelated)
  var MW = 21, MH = 21;            // map dimensions in tiles
  var TAU = Math.PI * 2;
  var FOV_PLANE = 0.66;            // ~66° field of view, classic look
  var MOVE_SPD = 3.1, RUN_MUL = 1.7, TURN_SPD = 2.75;
  var P_RAD = 0.25;                // player collision radius
  var SHOT_DMG = 34;               // three shots per skeleton
  var E_HP = 100;

  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var DPR = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;

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
  var STATS_KEY = "gc-crypt-stats", RUN_KEY = "gc-crypt-run";
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { best: 0, muted: false }; }
    catch (e) { return { best: 0, muted: false }; }
  }
  function saveStats() { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {} }
  var stats = loadStats();

  // ---------- Seeded RNG ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Floor generation (deterministic per seed+floor) ----------
  // map values: 1 wall, 0 floor, 2 exit door
  function genFloor(seed, floor) {
    var rnd = mulberry32(seed * 7919 + floor * 104729);
    var map = new Uint8Array(MW * MH).fill(1);
    function cell(cx, cy) { return map[cy * MW + cx]; }
    function setc(cx, cy, v) { if (cx > 0 && cy > 0 && cx < MW - 1 && cy < MH - 1) map[cy * MW + cx] = v; }
    // recursive backtracker on odd cells
    var stack = [[1, 1]];
    map[1 * MW + 1] = 0;
    while (stack.length) {
      var cur = stack[stack.length - 1];
      var cx = cur[0], cy = cur[1], dirs = [];
      [[2, 0], [-2, 0], [0, 2], [0, -2]].forEach(function (d) {
        var nx = cx + d[0], ny = cy + d[1];
        if (nx > 0 && ny > 0 && nx < MW - 1 && ny < MH - 1 && map[ny * MW + nx] === 1) dirs.push([nx, ny, cx + d[0] / 2, cy + d[1] / 2]);
      });
      if (!dirs.length) { stack.pop(); continue; }
      var p = dirs[(rnd() * dirs.length) | 0];
      map[p[3] * MW + p[2]] = 0;
      map[p[1] * MW + p[0]] = 0;
      stack.push([p[0], p[1]]);
    }
    // punch extra openings so it's a dungeon, not a corn maze
    var extra = 26;
    while (extra--) {
      var x = 2 + ((rnd() * (MW - 4)) | 0), y = 2 + ((rnd() * (MH - 4)) | 0);
      if (map[y * MW + x] === 1 && ((x % 2 === 0) !== (y % 2 === 0))) map[y * MW + x] = 0;
    }
    // BFS from spawn to find the farthest cell for the exit door
    var dist = new Int16Array(MW * MH).fill(-1);
    var q = [1 * MW + 1]; dist[q[0]] = 0;
    var far = q[0];
    while (q.length) {
      var idx = q.shift(), ix = idx % MW, iy = (idx / MW) | 0;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nx = ix + d[0], ny = iy + d[1], ni = ny * MW + nx;
        if (nx >= 0 && ny >= 0 && nx < MW && ny < MH && map[ni] === 0 && dist[ni] < 0) {
          dist[ni] = dist[idx] + 1; q.push(ni);
          if (dist[ni] > dist[far]) far = ni;
        }
      });
    }
    // exit door: open the cell beyond the farthest one and wall it in
    var ex = far % MW, ey = (far / MW) | 0;
    var doorX = ex, doorY = ey;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(function (d) {
      var nx = ex + d[0], ny = ey + d[1];
      if (nx > 0 && ny > 0 && nx < MW - 1 && ny < MH - 1 && map[ny * MW + nx] === 1) { doorX = nx; doorY = ny; return true; }
      return false;
    });
    map[doorY * MW + doorX] = 2;
    // entities on open cells, away from spawn
    var openCells = [];
    for (var i = 0; i < MW * MH; i++) if (map[i] === 0 && dist[i] > 5) openCells.push(i);
    function takeCell() { return openCells.splice((rnd() * openCells.length) | 0, 1)[0]; }
    var nEnemies = Math.min(3 + floor, 9), nGold = 2 + ((rnd() * 3) | 0);
    var enemies = [], loot = [];
    while (nEnemies-- > 0 && openCells.length) {
      var ci = takeCell();
      enemies.push({ x: (ci % MW) + 0.5, y: ((ci / MW) | 0) + 0.5, hp: E_HP, dead: false, alert: false, lostSight: 0, cool: 0, bob: rnd() * TAU });
    }
    while (nGold-- > 0 && openCells.length) {
      var li = takeCell();
      loot.push({ x: (li % MW) + 0.5, y: ((li / MW) | 0) + 0.5, kind: "gold", taken: false });
    }
    var nHeal = 2;
    while (nHeal-- > 0 && openCells.length) {
      var hi = takeCell();
      loot.push({ x: (hi % MW) + 0.5, y: ((hi / MW) | 0) + 0.5, kind: "med", taken: false });
    }
    return { map: map, spawn: { x: 1.5, y: 1.5, a: 0.8 }, exit: { x: doorX, y: doorY }, enemies: enemies, loot: loot };
  }

  // ---------- Game state ----------
  var state = "ready";             // ready | play | pause | over
  var seed = 0, floor = 1, level = null;
  var px = 0, py = 0, pa = 0;      // player x, y, angle
  var hp = 100, kills = 0, gold = 0;
  var zbuf = new Float32Array(W);
  var t = 0, lastFrame = 0, diedAt = 0;
  var shootAt = -9, hurtAt = -9, toast = "", toastUntil = 0;
  var showMap = false;
  var keys = { fwd: 0, back: 0, left: 0, right: 0, strafeL: 0, strafeR: 0, run: 0 };
  var saveTimer = 0;

  function score() { return kills * 10 + gold * 150 + (floor - 1) * 200; }
  function setScore() {
    scoreEl.textContent = score();
    if (score() > stats.best) { stats.best = score(); saveStats(); }
    bestEl.textContent = stats.best;
  }

  function say(msg, secs) { toast = msg; toastUntil = t + (secs || 2.2); }

  // ---------- Sound (tiny WebAudio blips, no assets) ----------
  var audioCtx = null;
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
  function sndShot() { beep(900, 0.07, "square", 0.05, 120); }
  function sndHit() { beep(300, 0.09, "sawtooth", 0.05, 90); }
  function sndKill() { beep(220, 0.25, "sawtooth", 0.06, 40); }
  function sndHurt() { beep(160, 0.18, "square", 0.06, 60); }
  function sndPick() { beep(660, 0.08, "triangle", 0.05); setTimeout(function () { beep(990, 0.12, "triangle", 0.05); }, 80); }
  function sndDoor() { beep(523, 0.09, "triangle", 0.05); setTimeout(function () { beep(784, 0.09, "triangle", 0.05); }, 90); setTimeout(function () { beep(1047, 0.16, "triangle", 0.05); }, 180); }
  function sndDie() { beep(400, 0.6, "sawtooth", 0.07, 35); }

  // ---------- Run save ----------
  function saveRun() {
    if (state !== "play" && state !== "pause") return;
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify({ seed: seed, floor: floor, x: px, y: py, a: pa, hp: hp, kills: kills, gold: gold }));
    } catch (e) {}
  }
  function clearRun() { try { localStorage.removeItem(RUN_KEY); } catch (e) {} }
  function peekRun() {
    try { return JSON.parse(localStorage.getItem(RUN_KEY)); } catch (e) { return null; }
  }

  // ---------- Flow ----------
  function startFloor(f, keepPos) {
    floor = f;
    level = genFloor(seed, f);
    if (!keepPos) { px = level.spawn.x; py = level.spawn.y; pa = level.spawn.a; }
  }
  function newRun() {
    seed = (Math.random() * 100000) | 0;
    hp = 100; kills = 0; gold = 0;
    startFloor(1);
    state = "play";
    readyOverlay.hidden = true; pauseOverlay.hidden = true; overOverlay.hidden = true;
    setScore();
    say("Floor 1 — something down here is already awake", 3);
  }
  function resumeRun(r) {
    seed = r.seed; hp = r.hp; kills = r.kills || 0; gold = r.gold || 0;
    startFloor(r.floor, true);
    px = r.x; py = r.y; pa = r.a;
    state = "play";
    readyOverlay.hidden = true; pauseOverlay.hidden = true; overOverlay.hidden = true;
    setScore();
    say("Back to floor " + floor + ". The dark kept your spot", 2.6);
  }
  function gameOver() {
    state = "over"; diedAt = t;
    sndDie();
    clearRun();
    var s = score(), isBest = s >= stats.best && s > 0;
    overTitle.textContent = isBest ? "Died famous!" : "You became décor";
    overMedal.textContent = isBest ? "🏆" : "💀";
    overStats.textContent = "Score " + s + " · Floor " + floor + " · " + kills + " skeletons, " + gold + " idols";
    overOverlay.hidden = false;
    setScore();
  }
  function nextFloor() {
    floor++;
    sndDoor();
    startFloor(floor);
    saveRun();
    setScore();
    var lines = ["The stairs were a lie. Floor " + floor, "Floor " + floor + " — the torches are watching you", "Deeper. Warmer. Worse.", "Floor " + floor + " smells like ribs"];
    say(lines[(floor - 2) % lines.length], 3);
  }

  // ---------- Input ----------
  function shoot() {
    if (state !== "play") return;
    shootAt = t;
    sndShot();
    // hitscan: march the center ray, walls stop it, first skeleton within radius eats it
    var dx = Math.cos(pa), dy = Math.sin(pa), step = 0.04, dist = 0;
    while (dist < 13) {
      dist += step;
      var mx = (px + dx * dist) | 0, my = (py + dy * dist) | 0;
      var tv = level.map[my * MW + mx];
      if (tv === 1) return;                       // hit a wall
      if (tv === 2) return;                       // slams the exit door
      for (var i = 0; i < level.enemies.length; i++) {
        var e = level.enemies[i];
        if (e.dead) continue;
        var ex = e.x - px, ey = e.y - py;
        var along = ex * dx + ey * dy;
        if (along > 0 && along < 13) {
          var lat = Math.abs(ex * -dy + ey * dx);   // perpendicular offset from the ray
          if (lat < 0.36 && Math.abs(along - dist) < step * 1.6) { e.hp -= SHOT_DMG; sndHit(); if (e.hp <= 0) { e.dead = true; kills++; setScore(); sndKill(); } return; }
        }
      }
    }
  }
  document.addEventListener("keydown", function (e) {
    if (rulesModal && !rulesModal.hidden) { if (e.key === "Escape") closeRules(); return; }
    var k = e.key.toLowerCase();
    if (k === "arrowup" || k === "w") { keys.fwd = 1; e.preventDefault(); }
    else if (k === "arrowdown" || k === "s") { keys.back = 1; e.preventDefault(); }
    else if (k === "arrowleft") { keys.left = 1; e.preventDefault(); }
    else if (k === "arrowright") { keys.right = 1; e.preventDefault(); }
    else if (k === "a") keys.strafeL = 1;
    else if (k === "d") keys.strafeR = 1;
    else if (k === "shift") keys.run = 1;
    else if (k === " ") { e.preventDefault(); if (state === "ready") newRun(); else if (state === "over") newRun(); else shoot(); }
    else if (k === "tab") { e.preventDefault(); showMap = !showMap; }
    else if (k === "p") togglePause();
    else if (k === "n") { newRun(); }
    else if (k === "r") openRules();
    else if (k === "m") toggleSound();
  });
  document.addEventListener("keyup", function (e) {
    var k = e.key.toLowerCase();
    if (k === "arrowup" || k === "w") keys.fwd = 0;
    else if (k === "arrowdown" || k === "s") keys.back = 0;
    else if (k === "arrowleft") keys.left = 0;
    else if (k === "arrowright") keys.right = 0;
    else if (k === "a") keys.strafeL = 0;
    else if (k === "d") keys.strafeR = 0;
    else if (k === "shift") keys.run = 0;
  });
  // Mouse: click locks the pointer for proper FPS mouse-look (Esc releases
  // and politely pauses). Touch: drag to turn, tap to fire.
  var locked = false;
  function requestLock() {
    try {
      var p = stage.requestPointerLock();
      if (p && p.catch) p.catch(function () {});   // e.g. browser's brief re-lock cooldown after Esc
    } catch (e) {}
  }
  document.addEventListener("pointerlockchange", function () {
    locked = document.pointerLockElement === stage;
    if (!locked && state === "play") { state = "pause"; saveRun(); pauseOverlay.hidden = false; }
  });
  document.addEventListener("mousemove", function (e) {
    if (locked && state === "play") pa += (e.movementX || 0) * 0.0022;
  });
  stage.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || state !== "play" || (e.target.closest && e.target.closest("button, a"))) return;
    if (locked) shoot(); else requestLock();
  });
  var dragX = null, dragMoved = 0;
  stage.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse") return;   // mouse goes through the lock flow above
    if (e.target.closest("button, a")) return;
    if (state !== "play") return;            // overlays handle ready / pause / over
    dragX = e.clientX; dragMoved = 0;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });
  stage.addEventListener("pointermove", function (e) {
    if (dragX === null) return;
    var dx = e.clientX - dragX; dragX = e.clientX;
    dragMoved += Math.abs(dx);
    pa += dx * 0.0062;
  });
  stage.addEventListener("pointerup", function () {
    if (dragX !== null && dragMoved < 6) shoot();
    dragX = null;
  });

  function togglePause() {
    if (state === "play") { state = "pause"; saveRun(); pauseOverlay.hidden = false; }
    else if (state === "pause") {
      state = "play"; pauseOverlay.hidden = true;
      if (!locked && matchMedia("(pointer: fine)").matches) say("Click the screen to grab the mouse", 2.5);
    }
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
    if (!stats.muted) beep(660, 0.06, "triangle", 0.04);
  }
  soundBtn.addEventListener("click", toggleSound);
  function openRules() { rulesModal.hidden = false; }
  function closeRules() { rulesModal.hidden = true; }
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state === "play") { state = "pause"; saveRun(); pauseOverlay.hidden = false; }
  });
  window.addEventListener("pagehide", saveRun);

  // ---------- Update ----------
  function tryMove(nx, ny) {
    // axis-separated collision against wall tiles; the exit door advances the floor
    var tx = level.map[(py | 0) * MW + ((nx + P_RAD * Math.sign(nx - px)) | 0)];
    if (tx === 2) { nextFloor(); return; }
    if (tx === 0) px = nx;
    var ty = level.map[((ny + P_RAD * Math.sign(ny - py)) | 0) * MW + (px | 0)];
    if (ty === 2) { nextFloor(); return; }
    if (ty === 0) py = ny;
  }
  function update(dt) {
    t += dt;
    if (state !== "play") return;

    var spd = MOVE_SPD * (keys.run ? RUN_MUL : 1) * dt;
    var turn = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    pa += turn * TURN_SPD * dt;
    var dx = Math.cos(pa), dy = Math.sin(pa);
    var mx = 0, my = 0;
    if (keys.fwd) { mx += dx; my += dy; }
    if (keys.back) { mx -= dx * 0.72; my -= dy * 0.72; }
    if (keys.strafeL) { mx += dy; my -= dx; }
    if (keys.strafeR) { mx -= dy; my += dx; }
    var ml = Math.hypot(mx, my);
    if (ml > 0.01) {
      mx = mx / ml * spd; my = my / ml * spd;
      tryMove(px + mx, py);
      tryMove(px, py + my);
    }

    // loot pickup
    for (var i = 0; i < level.loot.length; i++) {
      var l = level.loot[i];
      if (l.taken) continue;
      if (Math.hypot(l.x - px, l.y - py) < 0.55) {
        l.taken = true;
        if (l.kind === "gold") { gold++; setScore(); sndPick(); say("Gold idol! Worth 150 and absolutely nothing in regrets", 2); }
        else { hp = Math.min(100, hp + 25); sndPick(); say("+25 HP — tastes like bandages", 1.8); }
      }
    }

    // skeletons
    for (var j = 0; j < level.enemies.length; j++) {
      var e = level.enemies[j];
      if (e.dead) continue;
      var ex = px - e.x, ey = py - e.y, d = Math.hypot(ex, ey);
      if (d < 10 && hasLOS(e.x, e.y, px, py)) {
        if (!e.alert) { e.alert = true; beep(140, 0.3, "sawtooth", 0.045, 70); }   // bones rattle
        e.lostSight = 0;
        if (d > 0.68) {
          var es = (1.35 + floor * 0.12) * dt; if (es > 2.4 * dt) es = 2.4 * dt;
          var nx2 = e.x + ex / d * es, ny2 = e.y + ey / d * es;
          if (level.map[(e.y | 0) * MW + (nx2 | 0)] === 0) e.x = nx2;
          if (level.map[(ny2 | 0) * MW + (e.x | 0)] === 0) e.y = ny2;
        } else {
          e.cool -= dt;
          if (e.cool <= 0) {
            e.cool = 1.0;
            hp -= Math.min(17, 8 + floor * 2);
            hurtAt = t; sndHurt();
            if (hp <= 0) { hp = 0; gameOver(); return; }
          }
        }
      } else if (e.alert) {
        e.lostSight += dt;
        if (e.lostSight > 3) e.alert = false;
      }
    }

    // autosave
    saveTimer += dt;
    if (saveTimer > 2) { saveTimer = 0; saveRun(); }
  }
  function hasLOS(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy), steps = (d / 0.22) | 0;
    for (var i = 1; i < steps; i++) {
      var cx = (x0 + dx * i / steps) | 0, cy = (y0 + dy * i / steps) | 0;
      var tv = level.map[cy * MW + cx];
      if (tv === 1) return false;
    }
    return true;
  }

  // ---------- Render ----------
  var FOG = "#0c0a08";
  function render() {
    // ceiling & floor
    ctx.fillStyle = "#100d0a"; ctx.fillRect(0, 0, W, H / 2);
    var fg = ctx.createLinearGradient(0, H / 2, 0, H);
    fg.addColorStop(0, "#151109"); fg.addColorStop(1, "#3a2f1e");
    ctx.fillStyle = fg; ctx.fillRect(0, H / 2, W, H / 2);

    // one ray per column (DDA)
    var dirX = Math.cos(pa), dirY = Math.sin(pa);
    var planeX = -dirY * FOV_PLANE, planeY = dirX * FOV_PLANE;
    for (var x = 0; x < W; x++) {
      var camX = 2 * x / W - 1;
      var rdx = dirX + planeX * camX, rdy = dirY + planeY * camX;
      var mapX = px | 0, mapY = py | 0;
      var ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9));
      var stepX, stepY, sideX, sideY;
      if (rdx < 0) { stepX = -1; sideX = (px - mapX) * ddx; } else { stepX = 1; sideX = (mapX + 1 - px) * ddx; }
      if (rdy < 0) { stepY = -1; sideY = (py - mapY) * ddy; } else { stepY = 1; sideY = (mapY + 1 - py) * ddy; }
      var hit = 0, side = 0, guard = 64;
      while (!hit && guard--) {
        if (sideX < sideY) { sideX += ddx; mapX += stepX; side = 0; }
        else { sideY += ddy; mapY += stepY; side = 1; }
        var tv = (mapX >= 0 && mapY >= 0 && mapX < MW && mapY < MH) ? level.map[mapY * MW + mapX] : 1;
        if (tv >= 1) hit = tv;
      }
      var perp = side === 0 ? (sideX - ddx) : (sideY - ddy);
      if (perp < 0.01) perp = 0.01;
      zbuf[x] = perp;
      var lh = H / perp;
      var y0 = H / 2 - lh / 2;
      var wx = side === 0 ? py + perp * rdy : px + perp * rdx;
      wx -= Math.floor(wx);
      var fogv = Math.min(1, perp / 11);
      if (hit === 2) {
        // exit door: shimmering gold-green
        var pulse = 0.72 + 0.28 * Math.sin(t * 4 + x * 0.08);
        var r = Math.round((200 * pulse) * (1 - fogv * 0.7) + 12 * fogv * 0.7);
        var g = Math.round((170 * pulse) * (1 - fogv * 0.7) + 10 * fogv * 0.7);
        ctx.fillStyle = "rgb(" + r + "," + g + ",60)";
        ctx.fillRect(x, y0, 1, lh);
      } else {
        var base = side === 0 ? 138 : 108;                 // N/S brighter than E/W
        var seam = (wx * 4) % 1 < 0.12 ? 0.72 : 1;         // vertical mortar seams
        var lum = Math.round(base * seam * (1 - fogv) + 12 * fogv);
        ctx.fillStyle = "rgb(" + lum + "," + Math.round(lum * 0.95) + "," + Math.round(lum * 0.86) + ")";
        ctx.fillRect(x, y0, 1, lh);
        // two horizontal brick courses
        ctx.fillStyle = "rgba(20,16,12," + (0.55 * (1 - fogv)).toFixed(2) + ")";
        ctx.fillRect(x, y0 + lh * 0.33, 1, Math.max(1, lh * 0.03));
        ctx.fillRect(x, y0 + lh * 0.66, 1, Math.max(1, lh * 0.03));
      }
    }

    drawSprites(dirX, dirY, planeX, planeY);
    drawGun();
    if (locked) {   // crosshair — the OS cursor is hidden while the pointer is locked
      ctx.strokeStyle = "rgba(221,213,194,.85)";
      ctx.beginPath();
      ctx.moveTo(W / 2 - 6, H / 2); ctx.lineTo(W / 2 + 6, H / 2);
      ctx.moveTo(W / 2, H / 2 - 6); ctx.lineTo(W / 2, H / 2 + 6);
      ctx.stroke();
    }

    // hurt flash + subtle torch flicker vignette
    var hf = Math.max(0, 1 - (t - hurtAt) / 0.4);
    if (hf > 0) { ctx.fillStyle = "rgba(200,30,20," + (hf * 0.35).toFixed(2) + ")"; ctx.fillRect(0, 0, W, H); }
    var vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.42, W / 2, H / 2, H * 0.85);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.45)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    drawHUD();
    if (showMap) drawMinimap();
    if (toast && t < toastUntil) {
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(W / 2 - 150, 22, 300, 14);
      ctx.fillStyle = "#ffd83a"; ctx.fillText(toast, W / 2, 33);
      ctx.textAlign = "left";
    }
  }

  function drawSprites(dirX, dirY, planeX, planeY) {
    var all = [];
    var i;
    for (i = 0; i < level.enemies.length; i++) {
      var e = level.enemies[i];
      all.push({ x: e.x, y: e.y, kind: e.dead ? "corpse" : "bone", e: e });
    }
    for (i = 0; i < level.loot.length; i++) {
      var l = level.loot[i];
      if (!l.taken) all.push({ x: l.x, y: l.y, kind: l.kind });
    }
    all.forEach(function (s) { s.d = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py); });
    all.sort(function (a, b) { return b.d - a.d; });

    var invDet = 1 / (planeX * dirY - dirX * planeY);
    for (i = 0; i < all.length; i++) {
      var s = all[i], sx = s.x - px, sy = s.y - py;
      var tx = invDet * (dirY * sx - dirX * sy);
      var ty = invDet * (-planeY * sx + planeX * sy);   // depth
      if (ty < 0.25 || ty > 13) continue;
      var scr = (W / 2) * (1 + tx / ty);
      var size = Math.abs(H / ty);
      var sw = size * 0.62, sh = size * 0.9;
      var x0 = Math.round(scr - sw / 2), x1 = Math.round(scr + sw / 2);
      var yTop = Math.round(H / 2 + size * 0.5 - sh);   // feet on the floor line
      if (x1 < 0 || x0 >= W) continue;
      // column clip against the z-buffer so walls hide sprites properly
      ctx.save();
      ctx.beginPath();
      for (var cx = Math.max(0, x0); cx < Math.min(W, x1); cx++) {
        if (zbuf[cx] > ty) ctx.rect(cx, 0, 1, H);
      }
      ctx.clip();
      if (s.kind === "bone") drawSkeleton(scr, yTop, sw, sh, s.e);
      else if (s.kind === "corpse") drawCorpse(scr, yTop + sh, sw);
      else if (s.kind === "gold") drawIdol(scr, yTop + sh, size);
      else drawMed(scr, yTop + sh, size);
      ctx.restore();
    }
  }
  function drawSkeleton(scr, yTop, sw, sh, e) {
    var bob = e.alert ? Math.sin(t * 9 + e.bob) * sh * 0.03 : Math.sin(t * 2 + e.bob) * sh * 0.012;
    var cx = scr;
    ctx.fillStyle = "#d9d2bd";
    // ribcage
    ctx.fillRect(cx - sw * 0.22, yTop + sh * 0.32 + bob, sw * 0.44, sh * 0.34);
    ctx.fillStyle = "#8f8875";
    ctx.fillRect(cx - sw * 0.22, yTop + sh * 0.42 + bob, sw * 0.44, sh * 0.03);
    ctx.fillRect(cx - sw * 0.22, yTop + sh * 0.52 + bob, sw * 0.44, sh * 0.03);
    // arms
    ctx.fillStyle = "#d9d2bd";
    ctx.fillRect(cx - sw * 0.36, yTop + sh * 0.33 + bob, sw * 0.11, sh * 0.3);
    ctx.fillRect(cx + sw * 0.25, yTop + sh * 0.33 + bob, sw * 0.11, sh * 0.3);
    // legs
    ctx.fillRect(cx - sw * 0.18, yTop + sh * 0.66 + bob, sw * 0.13, sh * 0.34);
    ctx.fillRect(cx + sw * 0.05, yTop + sh * 0.66 + bob, sw * 0.13, sh * 0.34);
    // skull
    ctx.fillStyle = "#eee7d2";
    ctx.beginPath();
    ctx.arc(cx, yTop + sh * 0.2 + bob, sw * 0.19, 0, TAU);
    ctx.fill();
    // eyes — red when hunting you
    ctx.fillStyle = e.alert ? "#ff3b30" : "#1c1a14";
    ctx.fillRect(cx - sw * 0.12, yTop + sh * 0.16 + bob, sw * 0.08, sw * 0.08);
    ctx.fillRect(cx + sw * 0.04, yTop + sh * 0.16 + bob, sw * 0.08, sw * 0.08);
    // hit flash
    if (e.hp < E_HP && t - shootAt < 0.08) { ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fillRect(scr - sw / 2, yTop, sw, sh); }
  }
  function drawCorpse(scr, feet, sw) {
    ctx.fillStyle = "#5a1f1a";
    ctx.fillRect(scr - sw * 0.4, feet - sw * 0.08, sw * 0.8, sw * 0.1);
    ctx.fillStyle = "#c9c2ad";
    ctx.beginPath(); ctx.arc(scr - sw * 0.28, feet - sw * 0.1, sw * 0.12, 0, TAU); ctx.fill();
    ctx.fillRect(scr - sw * 0.1, feet - sw * 0.12, sw * 0.42, sw * 0.08);
  }
  function drawIdol(scr, feet, size) {
    var s = size * 0.3, tw = Math.sin(t * 3) * 0.1 + 0.9;
    ctx.fillStyle = "rgba(255," + Math.round(200 * tw) + ",58," + (0.35 * tw).toFixed(2) + ")";
    ctx.beginPath(); ctx.arc(scr, feet - s * 0.6, s * 1.15, 0, TAU); ctx.fill();
    ctx.fillStyle = "#ffd83a";
    ctx.beginPath();
    ctx.moveTo(scr - s * 0.5, feet); ctx.lineTo(scr + s * 0.5, feet);
    ctx.lineTo(scr + s * 0.3, feet - s * 0.9); ctx.lineTo(scr, feet - s * 1.3);
    ctx.lineTo(scr - s * 0.3, feet - s * 0.9);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#8a5c00";
    ctx.fillRect(scr - s * 0.12, feet - s * 0.75, s * 0.24, s * 0.24);
  }
  function drawMed(scr, feet, size) {
    var s = size * 0.26;
    ctx.fillStyle = "#e8ecf2";
    ctx.fillRect(scr - s * 0.6, feet - s * 1.1, s * 1.2, s * 1.1);
    ctx.fillStyle = "#d43a2f";
    ctx.fillRect(scr - s * 0.16, feet - s * 0.95, s * 0.32, s * 0.8);
    ctx.fillRect(scr - s * 0.45, feet - s * 0.66, s * 0.9, s * 0.32);
  }
  function drawGun() {
    var recoil = Math.max(0, 1 - (t - shootAt) / 0.14);
    var gy = H - 46 + recoil * 9;
    var bob = Math.sin(t * 7) * (keys.fwd || keys.back || keys.strafeL || keys.strafeR ? 2 : 0.6);
    var cx = W / 2;
    // blocky pistol, right-center like Wolfenstein
    ctx.fillStyle = "#3c424c"; ctx.fillRect(cx - 9, gy + 12 + bob, 18, 34);          // grip/hull
    ctx.fillStyle = "#59616e"; ctx.fillRect(cx - 6, gy + bob, 12, 22);               // slide
    ctx.fillStyle = "#22262c"; ctx.fillRect(cx - 3, gy - 8 + bob, 6, 12);            // barrel
    if (recoil > 0.4) {
      ctx.fillStyle = "rgba(255,220,120," + recoil.toFixed(2) + ")";
      ctx.beginPath(); ctx.arc(cx, gy - 12 + bob, 9 * recoil, 0, TAU); ctx.fill();
    }
  }
  function drawHUD() {
    ctx.fillStyle = "rgba(8,7,5,.72)";
    ctx.fillRect(0, H - 18, W, 18);
    ctx.font = "bold 9px ui-monospace, monospace";
    // HP bar
    ctx.fillStyle = "#c9c2ad"; ctx.fillText("HP", 6, H - 6);
    ctx.fillStyle = "#241f18"; ctx.fillRect(24, H - 13, 64, 8);
    ctx.fillStyle = hp > 35 ? "#3fae4e" : "#d43a2f";
    ctx.fillRect(24, H - 13, 64 * hp / 100, 8);
    ctx.fillStyle = "#ffd83a";
    ctx.fillText("FLOOR " + floor, 100, H - 6);
    ctx.fillStyle = "#c9c2ad";
    ctx.fillText("KILLS " + kills, 164, H - 6);
    ctx.fillText("GOLD " + gold, 224, H - 6);
    ctx.fillStyle = "#e8ecf2";
    ctx.fillText("SCORE " + score(), 268, H - 6);
  }
  function drawMinimap() {
    var S = 4, OX = W - MW * S - 6, OY = 6;
    ctx.fillStyle = "rgba(8,7,5,.7)";
    ctx.fillRect(OX - 2, OY - 2, MW * S + 4, MH * S + 4);
    for (var y = 0; y < MH; y++) for (var x = 0; x < MW; x++) {
      var tv = level.map[y * MW + x];
      ctx.fillStyle = tv === 1 ? "#4a4438" : tv === 2 ? "#ffd83a" : "#14110c";
      ctx.fillRect(OX + x * S, OY + y * S, S, S);
    }
    level.enemies.forEach(function (e) {
      if (e.dead) return;
      ctx.fillStyle = e.alert ? "#ff3b30" : "#a04038";
      ctx.fillRect(OX + e.x * S - 1, OY + e.y * S - 1, 2, 2);
    });
    ctx.fillStyle = "#4de1ff";
    ctx.fillRect(OX + px * S - 1, OY + py * S - 1, 3, 3);
    ctx.strokeStyle = "#4de1ff";
    ctx.beginPath();
    ctx.moveTo(OX + px * S, OY + py * S);
    ctx.lineTo(OX + (px + Math.cos(pa) * 2.4) * S, OY + (py + Math.sin(pa) * 2.4) * S);
    ctx.stroke();
  }

  // ---------- Main loop ----------
  function loop(now) {
    var dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Boot ----------
  bestEl.textContent = stats.best;
  soundBtn.textContent = stats.muted ? "Sound: Off" : "Sound: On";
  soundBtn.setAttribute("aria-pressed", String(!stats.muted));
  var saved = peekRun();
  if (saved && typeof saved.x === "number") {
    continueBtn.hidden = false;
    continueBtn.textContent = "Continue — floor " + saved.floor;
    // show the saved world behind the ready overlay
    seed = saved.seed; hp = saved.hp; kills = saved.kills || 0; gold = saved.gold || 0;
    startFloor(saved.floor, true); px = saved.x; py = saved.y; pa = saved.a;
    setScore();
  } else {
    seed = (Math.random() * 100000) | 0;
    startFloor(1);
  }
  requestAnimationFrame(function (n) { lastFrame = n; requestAnimationFrame(loop); });
})();
