/* ===== Snake (Nokia-style) — game logic =====
   Canvas-rendered grid snake with keyboard / swipe / on-screen-pad control,
   score + best, pause, and full state persistence so a refresh resumes. */
(function () {
  "use strict";

  var COLS = 23, ROWS = 15, CELL = 20;
  var BEST_KEY = "gc-snake-best";
  var SAVE_KEY = "gc-snake-save";

  // LCD palette (fixed — a Nokia screen isn't theme-dependent).
  var C_BG = "#9db854", C_GRID = "rgba(28,42,8,.10)", C_PIXEL = "#1c2a08";

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var statusEl = document.getElementById("status");
  var overlayEl = document.getElementById("overlay");
  var overlayMsgEl = document.getElementById("overlayMsg");
  var newBtn = document.getElementById("newGame");
  var pauseBtn = document.getElementById("pauseBtn");
  var rulesBtn = document.getElementById("rulesBtn");
  var rulesModal = document.getElementById("rulesModal");

  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;

  var snake, dir, turnQueue, food, score, best = 0, alive, paused;
  var lastTime = 0, acc = 0, stepMs = 150, rafId = null;

  // ---------- Persistence ----------
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        snake: snake, dir: dir, food: food, score: score, stepMs: stepMs,
      }));
    } catch (e) {}
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  function loadBest() { try { best = localStorage.getItem(BEST_KEY) | 0; } catch (e) { best = 0; } }

  function loadSaved() {
    try {
      var o = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (!o || !o.snake || !o.snake.length) return false;
      snake = o.snake; dir = o.dir; food = o.food; score = o.score | 0;
      stepMs = o.stepMs || 150;
      turnQueue = [];
      alive = true; paused = false;
      return true;
    } catch (e) { return false; }
  }

  // ---------- Game setup ----------
  function newGame() {
    var cy = (ROWS >> 1), cx = (COLS >> 1) - 1;
    snake = [{ x: cx + 2, y: cy }, { x: cx + 1, y: cy }, { x: cx, y: cy }];
    dir = { x: 1, y: 0 };
    turnQueue = [];
    score = 0; stepMs = 150;
    alive = true; paused = false;
    spawnFood();
    overlayEl.hidden = true;
    setPauseBtn();
    statusEl.textContent = "Eat the dots, don't hit the walls or yourself.";
    save();
    draw();
  }

  function spawnFood() {
    var free = [];
    for (var y = 0; y < ROWS; y++)
      for (var x = 0; x < COLS; x++)
        if (!snake.some(function (s) { return s.x === x && s.y === y; })) free.push({ x: x, y: y });
    food = free.length ? free[(Math.random() * free.length) | 0] : null;
  }

  // ---------- Loop ----------
  function loop(t) {
    rafId = requestAnimationFrame(loop);
    if (!alive || paused) { lastTime = t; return; }
    if (!lastTime) lastTime = t;
    acc += t - lastTime;
    lastTime = t;
    if (acc >= stepMs) { acc = 0; tick(); }
  }

  function tick() {
    // Apply one buffered turn (ignore reversals).
    while (turnQueue.length) {
      var nd = turnQueue.shift();
      if (nd.x === -dir.x && nd.y === -dir.y) continue;   // no 180° reversal
      if (nd.x === dir.x && nd.y === dir.y) continue;      // no-op
      dir = nd; break;
    }
    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    // Wall collision.
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) { return gameOver(); }
    // Self collision (the tail cell is fine because it moves away this tick —
    // unless we're about to grow, which is handled by checking against body
    // minus the last segment when no food is eaten).
    var eating = food && head.x === food.x && head.y === food.y;
    var body = eating ? snake : snake.slice(0, -1);
    if (body.some(function (s) { return s.x === head.x && s.y === head.y; })) { return gameOver(); }

    snake.unshift(head);
    if (eating) {
      score += 10;
      if (score > best) { best = score; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
      stepMs = Math.max(65, 150 - (snake.length - 3) * 3);
      spawnFood();
    } else {
      snake.pop();
    }
    renderHUD();
    save();
    draw();
  }

  function gameOver() {
    alive = false;
    clearSave();
    overlayMsgEl.textContent = "Game over — " + score + " pts";
    overlayEl.hidden = false;
    statusEl.textContent = "Ouch! Press New Game (or R) to try again.";
    draw();
  }

  // ---------- Rendering ----------
  function px(x) { return x * CELL; }
  function draw() {
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Faint LCD dot grid.
    ctx.fillStyle = C_GRID;
    for (var y = 0; y < ROWS; y++)
      for (var x = 0; x < COLS; x++) ctx.fillRect(px(x) + CELL / 2 - 1, px(y) + CELL / 2 - 1, 2, 2);

    // Food.
    if (food) drawCell(food.x, food.y, true);

    // Snake.
    ctx.fillStyle = C_PIXEL;
    for (var i = 0; i < snake.length; i++) drawCell(snake[i].x, snake[i].y, false);
  }
  function drawCell(x, y, round) {
    var pad = 2, s = CELL - pad * 2;
    ctx.fillStyle = C_PIXEL;
    var gx = px(x) + pad, gy = px(y) + pad;
    if (round) {   // food as a filled block with a notch (berry-ish)
      ctx.beginPath();
      ctx.arc(gx + s / 2, gy + s / 2, s / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(gx, gy, s, s);
    }
  }

  function renderHUD() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
  }

  // ---------- Input ----------
  var DIRS = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  };
  function turn(name) {
    var nd = DIRS[name];
    if (!nd || !alive) return;
    if (paused) { setPaused(false); }
    if (turnQueue.length < 2) turnQueue.push(nd);
  }
  function togglePause() { if (alive) setPaused(!paused); }
  function setPaused(p) {
    paused = p;
    setPauseBtn();
    statusEl.textContent = p ? "Paused — press Space to resume." : "Eat the dots, don't hit the walls or yourself.";
    if (!p) { lastTime = 0; acc = 0; }
  }
  function setPauseBtn() {
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(!!paused));
  }

  document.addEventListener("keydown", function (e) {
    if (rulesOpen()) { if (e.key === "Escape") closeRules(); return; }
    var k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") { e.preventDefault(); turn("up"); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { e.preventDefault(); turn("down"); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); turn("left"); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); turn("right"); }
    else if (k === " ") { e.preventDefault(); togglePause(); }
    else if (k === "r" || k === "R") { newGame(); }
  });

  // Swipe on the screen.
  var sw = null;
  canvas.addEventListener("pointerdown", function (e) { sw = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener("pointerup", function (e) {
    if (!sw) return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    sw = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;         // tap, not a swipe
    if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? "right" : "left");
    else turn(dy > 0 ? "down" : "up");
  });

  Array.prototype.forEach.call(document.querySelectorAll(".dpad__btn[data-dir]"), function (b) {
    b.addEventListener("click", function () { turn(b.dataset.dir); });
  });
  document.getElementById("dpadPause").addEventListener("click", togglePause);

  newBtn.addEventListener("click", newGame);
  document.getElementById("overNew").addEventListener("click", newGame);
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
  if (!loadSaved()) newGame();
  renderHUD();
  setPauseBtn();
  draw();
  rafId = requestAnimationFrame(loop);
})();
