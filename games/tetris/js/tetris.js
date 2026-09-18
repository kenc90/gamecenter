/* ===== Tetris (cyberpunk) — game logic =====
   Canvas-rendered 10x20 well with keyboard / touch-pad / swipe control,
   7-bag randomiser, SRS-style wall kicks, ghost piece, score / lines / level,
   and full state persistence so a refresh resumes. Fixed neon palette — this
   game intentionally ignores the center's light/dark mode. */
(function () {
  "use strict";

  var COLS = 10, ROWS = 20, CELL = 25;      // canvas is 250x500
  var BEST_KEY = "gc-tetris-best";
  var SAVE_KEY = "gc-tetris-save";

  // Cyberpunk neon piece colours (fixed — no light/dark variants).
  var SHAPES = {
    I: { c: "#05d9e8", m: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]] },
    J: { c: "#4455ff", m: [[1, 0, 0], [1, 1, 1], [0, 0, 0]] },
    L: { c: "#ff9f1c", m: [[0, 0, 1], [1, 1, 1], [0, 0, 0]] },
    O: { c: "#fcee0a", m: [[1, 1], [1, 1]] },
    S: { c: "#01ffc3", m: [[0, 1, 1], [1, 1, 0], [0, 0, 0]] },
    T: { c: "#b026ff", m: [[0, 1, 0], [1, 1, 1], [0, 0, 0]] },
    Z: { c: "#ff2a6d", m: [[1, 1, 0], [0, 1, 1], [0, 0, 0]] },
  };
  // Rotation states: 0 = spawn, 1 = CW, 2 = 180, 3 = CCW.
  var STATES = {};
  Object.keys(SHAPES).forEach(function (k) {
    var m = SHAPES[k].m, states = [m];
    for (var i = 0; i < 3; i++) states.push(rotateCW(states[i]));
    STATES[k] = states;
  });
  // Clockwise wall-kick offsets per rotation transition, tried in order.
  var KICKS = {
    "0>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "1>0": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "3>0": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "0>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  };

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var nextCanvas = document.getElementById("next");
  var nctx = nextCanvas.getContext("2d");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var linesEl = document.getElementById("lines");
  var levelEl = document.getElementById("level");
  var statusEl = document.getElementById("status");
  var captionEl = document.querySelector(".board-status");
  var overlayEl = document.getElementById("overlay");
  var overlayMsgEl = document.getElementById("overlayMsg");
  var newBtn = document.getElementById("newGame");
  var pauseBtn = document.getElementById("pauseBtn");
  var rulesBtn = document.getElementById("rulesBtn");
  var rulesModal = document.getElementById("rulesModal");

  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;

  var grid, cur, bag, nextKind, score, lines, best = 0, level;
  var alive, paused, clearFlash;          // clearFlash: rows mid flash-clear
  var flashUntil = 0;
  var lastTime = 0, acc = 0, rafId = null;
  var softDrop = false;

  function rotateCW(m) {
    var n = m.length, out = [];
    for (var r = 0; r < n; r++) { out.push([]); for (var c = 0; c < n; c++) out[r].push(m[n - 1 - c][r]); }
    return out;
  }
  function gravityMs() { return Math.max(60, 850 - (level - 1) * 75); }

  // ---------- Persistence ----------
  function save() {
    if (!alive) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        grid: grid, cur: cur, bag: bag, nextKind: nextKind,
        score: score, lines: lines, level: level,
      }));
    } catch (e) {}
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  function loadBest() { try { best = localStorage.getItem(BEST_KEY) | 0; } catch (e) { best = 0; } }
  function loadSaved() {
    try {
      var o = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (!o || !o.grid || !o.cur || !o.nextKind) return false;
      grid = o.grid; cur = o.cur; bag = o.bag || []; nextKind = o.nextKind;
      score = o.score | 0; lines = o.lines | 0; level = o.level | 1;
      alive = true; paused = false; clearFlash = null;
      return true;
    } catch (e) { return false; }
  }

  // ---------- Piece flow ----------
  function refill() {
    if (!bag.length) {
      bag = Object.keys(SHAPES).slice();
      for (var i = bag.length - 1; i > 0; i--) {        // shuffle (Fisher-Dates)
        var j = (Math.random() * (i + 1)) | 0, t = bag[i]; bag[i] = bag[j]; bag[j] = t;
      }
    }
  }
  function spawn(kind) {
    var k = kind || nextKind;
    refill();
    nextKind = bag.pop();
    var m = STATES[k][0];
    return { k: k, r: 0, x: ((COLS - m.length) / 2) | 0, y: k === "I" ? -1 : 0 };
  }
  function cells(p, r, x, y) {
    var m = STATES[p.k][r], out = [];
    for (var rr = 0; rr < m.length; rr++)
      for (var cc = 0; cc < m.length; cc++)
        if (m[rr][cc]) out.push([x + cc, y + rr]);
    return out;
  }
  function fits(p, r, x, y) {
    return cells(p, r, x, y).every(function (c) {
      return c[0] >= 0 && c[0] < COLS && c[1] < ROWS && (c[1] < 0 || !grid[c[1]][c[0]]);
    });
  }

  function step() {                                   // one gravity tick down
    if (fits(cur, cur.r, cur.x, cur.y + 1)) { cur.y++; return; }
    if (cur.y <= 0 && !cells(cur, cur.r, cur.x, cur.y).some(function (c) { return c[1] >= 0; })) {
      return gameOver();                              // top-out on spawn
    }
    lockPiece();
  }
  function hardDrop() {
    var d = 0;
    while (fits(cur, cur.r, cur.x, cur.y + 1)) { cur.y++; d++; }
    score += d * 2;
    lockPiece();
  }
  function lockPiece() {
    cells(cur, cur.r, cur.x, cur.y).forEach(function (c) {
      if (c[1] >= 0) grid[c[1]][c[0]] = SHAPES[cur.k].c;
    });
    cur = null;
    startClear();
  }

  // ---------- Rendering ----------
  function draw() { render(); }
  function render() {
    // Well background + faint grid.
    ctx.fillStyle = "#0a0018";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(176, 38, 255, .10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 1; x < COLS; x++) { ctx.moveTo(x * CELL + .5, 0); ctx.lineTo(x * CELL + .5, canvas.height); }
    for (var y = 1; y < ROWS; y++) { ctx.moveTo(0, y * CELL + .5); ctx.lineTo(canvas.width, y * CELL + .5); }
    ctx.stroke();

    // Locked stack.
    for (var gy = 0; gy < ROWS; gy++)
      for (var gx = 0; gx < COLS; gx++)
        if (grid[gy][gx]) block(ctx, gx, gy, grid[gy][gx], clearFlash && clearFlash.indexOf(gy) !== -1);

    if (!alive && !clearFlash) return;                // game over: stack only

    if (cur) {
      // Ghost piece (landing preview).
      var gyy = cur.y;
      while (fits(cur, cur.r, cur.x, gyy + 1)) gyy++;
      ctx.strokeStyle = "rgba(234, 230, 255, .30)";
      ctx.lineWidth = 1.5;
      cells(cur, cur.r, cur.x, gyy).forEach(function (c) {
        if (c[1] >= 0) ctx.strokeRect(c[0] * CELL + 3, c[1] * CELL + 3, CELL - 6, CELL - 6);
      });
      // Active piece.
      cells(cur, cur.r, cur.x, cur.y).forEach(function (c) {
        if (c[1] >= 0) block(ctx, c[0], c[1], SHAPES[cur.k].c, false);
      });
    }
  }
  function block(c, x, y, color, flash) {
    var px = x * CELL, py = y * CELL, s = CELL;
    c.fillStyle = flash ? "#ffffff" : color;
    c.fillRect(px + 1, py + 1, s - 2, s - 2);
    if (!flash) {
      c.fillStyle = "rgba(255, 255, 255, .30)";        // top bevel
      c.fillRect(px + 1, py + 1, s - 2, 3);
      c.fillStyle = "rgba(0, 0, 0, .38)";              // bottom shade
      c.fillRect(px + 1, py + s - 4, s - 2, 3);
    }
  }
  function drawNext() {
    nctx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
    if (!nextKind || (!alive && !paused)) return;   // keep the queue hidden pre-start
    var m = STATES[nextKind][0], filled = [];
    for (var r = 0; r < m.length; r++)
      for (var c = 0; c < m.length; c++)
        if (m[r][c]) filled.push([c, r]);
    var minx = 9, maxx = -9, miny = 9, maxy = -9;
    filled.forEach(function (f) {
      minx = Math.min(minx, f[0]); maxx = Math.max(maxx, f[0]);
      miny = Math.min(miny, f[1]); maxy = Math.max(maxy, f[1]);
    });
    var ns = 20, ox = (nextCanvas.width - (maxx - minx + 1) * ns) / 2 - minx * ns;
    var oy = (nextCanvas.height - (maxy - miny + 1) * ns) / 2 - miny * ns;
    var color = SHAPES[nextKind].c;
    filled.forEach(function (f) {
      nctx.fillStyle = color;
      nctx.fillRect(ox + f[0] * ns + 1, oy + f[1] * ns + 1, ns - 2, ns - 2);
      nctx.fillStyle = "rgba(255,255,255,.3)";
      nctx.fillRect(ox + f[0] * ns + 1, oy + f[1] * ns + 1, ns - 2, 2);
    });
  }

  function renderHUD() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
    linesEl.textContent = lines;
    levelEl.textContent = level;
  }
  function say(msg) {
    statusEl.textContent = msg;                        // screen readers
    if (captionEl) captionEl.textContent = msg;        // visible caption
  }

  // ---------- Game state transitions ----------
  function resetBoard() {
    grid = [];
    for (var y = 0; y < ROWS; y++) { var row = []; for (var x = 0; x < COLS; x++) row.push(null); grid.push(row); }
    bag = []; score = 0; lines = 0; level = 1;
    nextKind = null; cur = null;
    refill(); nextKind = bag.pop();
    cur = spawn();
    paused = false; clearFlash = null; softDrop = false;
    acc = 0; lastTime = 0;
  }
  function newGame() {
    resetBoard();
    alive = true;
    overlayEl.hidden = true;
    setPauseBtn();
    say("Stack the falling blocks, clear the lines.");
    save();
    renderHUD(); drawNext(); draw();
  }
  // Fresh load with no saved run: draw an empty well and wait for the player.
  function showReady() {
    resetBoard();
    alive = false;
    overlayEl.hidden = false;
    var btn = document.getElementById("overNew");
    if (btn) btn.textContent = "Start";
    overlayMsgEl.textContent = "Press Space (or Start) to play";
    setPauseBtn();
    say("Press Space or tap Start to begin.");
    renderHUD(); drawNext(); draw();
  }

  function gameOver() {
    alive = false;
    cur = null;
    clearSave();
    var btn = document.getElementById("overNew");
    if (btn) btn.textContent = "Play again";
    overlayMsgEl.textContent = "Game over — " + score + " pts";
    overlayEl.hidden = false;
    say("Game over! Press Space (or R / New Game) to try again.");
    render();
  }

  function togglePause() { if (alive) setPaused(!paused); }
  function setPaused(p) {
    paused = p;
    setPauseBtn();
    save();
    say(p ? "Paused — press P or Space to resume." : "Stack the falling blocks, clear the lines.");
    if (!p) { lastTime = 0; acc = 0; }
    draw();
  }
  function setPauseBtn() {
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(!!paused));
  }

  // ---------- Player actions ----------
  function move(dx) {
    if (!alive || paused) return;
    if (fits(cur, cur.r, cur.x + dx, cur.y)) { cur.x += dx; draw(); }
  }
  function rotate(dir) {
    if (!alive || paused) return;
    var from = cur.r, to = (cur.r + (dir || 1) + 4) % 4;
    var kicks = KICKS[from + ">" + to] || [[0, 0]];
    for (var i = 0; i < kicks.length; i++) {
      var kx = kicks[i][0], ky = kicks[i][1];
      if (fits(cur, to, cur.x + kx, cur.y - ky)) {
        cur.r = to; cur.x += kx; cur.y -= ky; draw(); return;
      }
    }
  }
  function softToggle(on) {
    if (on && !alive) return;
    softDrop = on && !paused;
    acc = Math.max(acc, gravityMs());                  // react immediately
  }

  // ---------- Loop ----------
  function loop(t) {
    rafId = requestAnimationFrame(loop);
    if (!alive || paused) { lastTime = t; return; }
    if (clearFlash) {                                  // mid line-clear flash
      if (t >= flashUntil) finishClear();
      render();
      return;
    }
    if (!lastTime) lastTime = t;
    acc += t - lastTime;
    lastTime = t;
    var iv = softDrop ? Math.min(50, gravityMs()) : gravityMs();
    while (acc >= iv) { acc -= iv; step(); if (!alive || clearFlash) break; }
    render();
  }

  // ---------- Scoring / line clears ----------
  function startClear() {
    var full = [];
    for (var y = 0; y < ROWS; y++) if (grid[y].every(function (v) { return v; })) full.push(y);
    if (!full.length) { afterLock(); return; }
    clearFlash = full;
    flashUntil = performance.now() + 260;
    render();
  }
  function finishClear() {
    var n = clearFlash.length;
    // Remove flashed rows (ascending order so earlier splices don't shift
    // the later indexes), then regrow the well to full height on top.
    clearFlash.slice().sort(function (a, b) { return a - b; }).forEach(function (y) {
      grid.splice(y, 1);
    });
    while (grid.length < ROWS) { var row = []; for (var x = 0; x < COLS; x++) row.push(null); grid.push(row); }
    clearFlash = null;
    score += [0, 100, 300, 500, 800][n] * level;
    lines += n;
    level = ((lines / 10) | 0) + 1;
    if (score > best) { best = score; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
    if (n === 4) say("TETRIS! Four lines cleared.");
    renderHUD();
    afterLock();
  }
  function afterLock() {
    cur = spawn();
    if (!fits(cur, cur.r, cur.x, cur.y) &&
        !fits(cur, (cur.r + 1) % 4, cur.x, cur.y) &&
        !fits(cur, (cur.r + 3) % 4, cur.x, cur.y)) {
      render(); drawNext();
      return gameOver();
    }
    acc = 0;
    save();
    renderHUD(); drawNext(); render();
  }

  // ---------- Input ----------
  document.addEventListener("keydown", function (e) {
    if (rulesOpen()) { if (e.key === "Escape") closeRules(); return; }
    var k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); move(-1); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); move(1); }
    else if (k === "ArrowUp" || k === "w" || k === "W") { e.preventDefault(); rotate(1); }
    else if (k === "x" || k === "X") { e.preventDefault(); rotate(-1); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { e.preventDefault(); softToggle(true); }
    else if (k === " ") {
      e.preventDefault();
      if (!alive) newGame();
      else if (e.repeat) return;
      else if (paused) setPaused(false);
      else hardDrop();
    }
    else if (k === "p" || k === "P") { togglePause(); }
    else if (k === "r" || k === "R") { newGame(); }
    else if (k === "Enter") { if (!alive) { e.preventDefault(); newGame(); } }
  });
  document.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "ArrowDown" || k === "s" || k === "S") softToggle(false);
  });

  // Touch pad: taps fire once, holds auto-repeat for left/right/down.
  Array.prototype.forEach.call(document.querySelectorAll(".tpad__btn"), function (b) {
    var act = b.dataset.act, holdTimer = null, holdInt = null;
    function fire() {
      if (!alive) { if (act) newGame(); return; }
      if (act === "left") move(-1);
      else if (act === "right") move(1);
      else if (act === "rotate") rotate(1);
      else if (act === "drop") hardDrop();
    }
    b.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      fire();
      if (act === "left" || act === "right") {
        holdTimer = setTimeout(function () {
          holdInt = setInterval(fire, 110);
        }, 300);
      } else if (act === "down") {
        softToggle(true);
      }
    });
    function release() {
      clearTimeout(holdTimer); clearInterval(holdInt);
      holdTimer = holdInt = null;
      if (act === "down") softToggle(false);
    }
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("pointerleave", release);
    if (act === "down") {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); });
    }
  });

  // Swipe on the well: horizontal shifts, up rotates, down hard-drops, tap rotates.
  var sw = null;
  canvas.addEventListener("pointerdown", function (e) { sw = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  canvas.addEventListener("pointerup", function (e) {
    if (!sw) return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y, dt = Date.now() - sw.t;
    sw = null;
    if (!alive) { newGame(); return; }
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) { if (dt < 350) rotate(1); return; }
    if (Math.abs(dx) > Math.abs(dy)) {
      var n = Math.max(1, Math.round(Math.abs(dx) / 40));
      for (var i = 0; i < n; i++) move(dx > 0 ? 1 : -1);
    } else if (dy < 0) rotate(1);
    else hardDrop();
  });

  newBtn.addEventListener("click", function () { newGame(); });
  document.getElementById("overNew").addEventListener("click", function () { newGame(); });
  pauseBtn.addEventListener("click", togglePause);

  // ---------- Rules modal ----------
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  function rulesOpen() { return rulesModal && !rulesModal.hidden; }
  rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });

  // ---------- Boot ----------
  loadBest();
  if (!loadSaved()) showReady();   // fresh load waits for the player to start
  renderHUD();
  setPauseBtn();
  drawNext();
  draw();
  rafId = requestAnimationFrame(loop);
})();
