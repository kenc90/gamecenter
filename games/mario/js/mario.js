/* =====================================================================
   Super Plumber — a tiny dependency-free side-scrolling platformer.
   Five data-driven stages (World 1-1 .. 1-5), built on a tile grid with
   hand-tuned arcade physics (gravity, variable-height jump, coyote-time,
   jump buffering).
   All art is drawn with canvas 2D primitives — no image assets, no engine.
   ===================================================================== */
(function () {
  "use strict";

  // ---------- Canvas / world constants ----------
  var canvas = document.getElementById("screen");
  var ctx = canvas.getContext("2d");
  var TILE = 32, ROWS = 14, COLS = 224;
  var VIEW_W = canvas.width, VIEW_H = canvas.height;   // 800 x 448
  var GROUND_ROW = 12;                                 // rows 12 & 13 are dirt
  var TOP_Y = GROUND_ROW * TILE;                       // world y of the surface
  var FLAG_COL = 212;
  var FLAG_TRIGGER_X = FLAG_COL * TILE;
  var SPAWN_X = 3 * TILE, SPAWN_Y = TOP_Y - 28;

  // Tile ids
  var EMPTY = 0, GROUND = 1, BRICK = 2, STONE = 3, PIPE = 4, QUESTION = 5, USED = 6;
  function isSolid(t) {
    return t === GROUND || t === BRICK || t === STONE || t === PIPE ||
           t === QUESTION || t === USED;
  }

  // ---------- Physics tuning (per 60 Hz step) ----------
  var GRAV = 0.62, MAXFALL = 16;
  var ACCEL = 0.5, BRAKE = 0.5, FRICTION = 0.35;
  var WALK_MAX = 3.1, RUN_MAX = 4.5;
  var JUMP_V = -14.2, JUMP_CUT = -4.0;    // apex rise ~163px (≈5 tiles)
  var COYOTE = 6, BUFFER = 7;
  var ENEMY_SPEED = 0.9;
  var STEP_MS = 1000 / 60;

  // ---------- Persistence keys ----------
  var SAVE_KEY = "gc-mario-save", BEST_KEY = "gc-mario-best";

  // ---------- HUD / DOM ----------
  var overlayEl = document.getElementById("overlay");
  var overlayMsgEl = document.getElementById("overlayMsg");
  var overlaySubEl = document.getElementById("overlaySub");
  var overBtn = document.getElementById("overNew");
  var overNextEl = document.getElementById("overNext");
  var newBtn = document.getElementById("newGame");
  var pauseBtn = document.getElementById("pauseBtn");
  var stageBtn = document.getElementById("stageBtn");
  var stageMenu = document.getElementById("stageMenu");
  var stageLbl = document.getElementById("stageLbl");
  var rulesBtn = document.getElementById("rulesBtn");
  var rulesModal = document.getElementById("rulesModal");
  var statusEl = document.getElementById("status");
  var overlayAction = null;

  function say(t) { if (statusEl) statusEl.textContent = t; }

  // ---------- Game state ----------
  var grid, coins, enemies, popups, player;
  var mode = "ready";              // ready | playing | paused | over | win
  var score = 0, coinCount = 0, lives = 3, best = 0, elapsed = 0;
  var cam = 0, rafId = null, lastTime = 0, acc = 0, stepTick = 0;
  var hills = [], clouds = [], bushes = [];
  var keys = { left: false, right: false, run: false, jump: false };
  var coyote = 0, jumpBuffer = 0;
  var fx = [], lastBurst = 0;                 // win-scene fireworks (screen space)

  // ---------- Tile lookup / movement / collision ----------
  function get(c, r) {
    if (c < 0 || c >= COLS) return GROUND;    // invisible side walls
    if (r < 0 || r >= ROWS) return EMPTY;     // open top + pit floor
    return grid[r][c];
  }
  function moveX(e, dx) {
    e.x += dx;
    var top = Math.floor((e.y + 1) / TILE);
    var bot = Math.floor((e.y + e.h - 2) / TILE);
    var r;
    if (dx > 0) {
      var c = Math.floor((e.x + e.w - 1) / TILE);
      for (r = top; r <= bot; r++) if (isSolid(get(c, r))) { e.x = c * TILE - e.w; e.vx = 0; e.hitWall = 1; break; }
    } else if (dx < 0) {
      var c2 = Math.floor(e.x / TILE);
      for (r = top; r <= bot; r++) if (isSolid(get(c2, r))) { e.x = (c2 + 1) * TILE; e.vx = 0; e.hitWall = -1; break; }
    }
  }
  function moveY(e, dy) {
    e.y += dy;
    var l = Math.floor((e.x + 2) / TILE);
    var rr = Math.floor((e.x + e.w - 2) / TILE);
    e.onGround = false; e.bump = null;
    var c;
    if (dy > 0) {
      var r = Math.floor((e.y + e.h - 1) / TILE);
      for (c = l; c <= rr; c++) if (isSolid(get(c, r))) { e.y = r * TILE - e.h; e.vy = 0; e.onGround = true; break; }
    } else if (dy < 0) {
      var r2 = Math.floor(e.y / TILE);
      for (c = l; c <= rr; c++) if (isSolid(get(c, r2))) { e.y = (r2 + 1) * TILE; e.vy = 0; e.bump = { c: c, r: r2 }; break; }
    }
  }
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---------- Stage definitions (data-driven — add more stages here) ----------
  // Each field: pits [startCol,endCol) · bricks [col,row,width] ·
  // questions/pipes/coins [col,row] · enemies [col] · stairs [col,topRow].
  // Platform rows are kept at 8 (a comfortable ~4-tile jump from the ground)
  // and pits at most 3 wide so every stage stays fully clearable.
  // `sky` is an optional 3-stop gradient override ("time of day" per stage).
  var LEVELS = [
    {
      name: "1-1", cols: 224, flag: 212,
      sky: ["#5c94fc", "#69a6ff", "#8fc0ff"],           // bright morning
      pits: [[22, 24], [50, 53], [90, 92], [120, 123]],
      bricks: [[15, 8, 3], [30, 8, 3], [62, 8, 3], [98, 8, 4], [140, 8, 3]],
      questions: [[18, 8], [26, 8], [35, 8], [57, 6], [70, 6], [96, 8], [105, 8], [133, 6], [147, 8]],
      pipes: [[20, 9], [40, 8], [68, 9], [84, 8], [128, 8], [158, 9]],
      coins: [[15, 7], [16, 7], [17, 7], [49, 7], [50, 6], [51, 6], [52, 7],
              [66, 5], [68, 5], [70, 5], [110, 8], [112, 8], [114, 8], [135, 5], [137, 5]],
      enemies: [27, 29, 44, 55, 73, 86, 106, 116, 130, 145, 162, 178, 190],
      stairs: [[196, 11], [197, 10], [198, 9], [199, 8]]
    },
    {
      name: "1-2", cols: 224, flag: 214,
      sky: ["#4a7fe0", "#7ba4f5", "#ffd9a8"],           // golden afternoon
      pits: [[16, 18], [46, 48], [78, 80], [104, 106], [150, 152], [172, 174]],
      bricks: [[24, 8, 3], [33, 8, 4], [58, 8, 3], [70, 8, 3], [90, 8, 4],
               [116, 8, 4], [130, 8, 3], [158, 8, 4], [182, 8, 3]],
      questions: [[28, 8], [55, 8], [86, 8], [112, 8], [135, 6], [162, 8], [188, 6]],
      pipes: [[38, 9], [64, 8], [122, 9], [166, 8], [200, 9]],
      coins: [[24, 7], [25, 7], [26, 7], [33, 7], [34, 7], [35, 7], [36, 7],
              [45, 7], [46, 6], [47, 6], [70, 7], [71, 7], [72, 7],
              [90, 7], [91, 7], [92, 7], [93, 7], [116, 7], [117, 7], [118, 7],
              [149, 7], [150, 7], [158, 7], [159, 7], [160, 7], [161, 7], [182, 7], [183, 7], [184, 7]],
      enemies: [22, 31, 42, 52, 60, 74, 88, 97, 110, 124, 138, 146, 164, 176, 192, 202],
      stairs: [[206, 11], [207, 10], [208, 9], [209, 8]]
    },
    {
      name: "1-3", cols: 232, flag: 222,
      sky: ["#3f5fc4", "#8f7ad8", "#f0a878"],           // sunset
      pits: [[30, 32], [58, 60], [88, 90], [126, 128], [160, 162], [198, 200]],
      bricks: [[18, 8, 3], [26, 8, 3], [44, 8, 4], [52, 8, 3], [70, 8, 3], [80, 8, 3],
               [100, 8, 4], [110, 8, 3], [134, 8, 3], [142, 8, 4], [170, 8, 3], [180, 8, 3], [196, 8, 3]],
      questions: [[22, 8], [48, 8], [66, 6], [104, 8], [130, 6], [150, 8], [174, 6], [192, 8]],
      pipes: [[36, 9], [62, 8], [96, 9], [120, 8], [156, 9], [206, 8]],
      coins: [[18, 7], [19, 7], [20, 7], [26, 7], [27, 7], [44, 7], [45, 7], [46, 7], [47, 7],
              [52, 7], [53, 7], [54, 7], [70, 7], [71, 7], [80, 7], [81, 7], [82, 7],
              [100, 7], [101, 7], [102, 7], [110, 7], [111, 7], [112, 7],
              [134, 7], [135, 7], [142, 7], [143, 7], [144, 7], [145, 7],
              [170, 7], [171, 7], [172, 7], [180, 7], [181, 7], [182, 7]],
      enemies: [20, 34, 49, 64, 74, 84, 98, 112, 123, 138, 153, 164, 176, 188, 204, 210],
      stairs: [[212, 11], [213, 10], [214, 9], [215, 8]]
    },
    {
      name: "1-4", cols: 236, flag: 224,
      sky: ["#2b3a8f", "#5f5fae", "#b47ba0"],           // dusk
      pits: [[26, 28], [56, 58], [90, 92], [118, 120], [146, 149], [186, 188]],
      bricks: [[16, 8, 3], [34, 8, 4], [44, 8, 3], [62, 8, 3], [78, 8, 4], [96, 8, 3],
               [110, 8, 3], [128, 8, 4], [152, 8, 3], [162, 8, 3], [178, 8, 4], [200, 8, 3]],
      questions: [[22, 8], [50, 8], [72, 6], [104, 8], [124, 6], [140, 8], [170, 6], [196, 8], [208, 8]],
      pipes: [[30, 9], [58, 8], [86, 9], [116, 8], [156, 9], [184, 8], [212, 9]],
      coins: [[16, 7], [17, 7], [18, 7], [25, 7], [26, 6], [27, 6], [34, 7], [35, 7], [36, 7], [37, 7],
              [44, 7], [45, 7], [46, 7], [55, 7], [56, 6], [62, 7], [63, 7], [64, 7], [78, 7], [79, 7],
              [80, 7], [81, 7], [89, 7], [90, 6], [96, 7], [97, 7], [98, 7], [110, 7], [111, 7], [112, 7],
              [128, 7], [129, 7], [130, 7], [131, 7], [145, 7], [146, 6], [147, 6], [152, 7], [153, 7],
              [162, 7], [163, 7], [164, 7], [178, 7], [179, 7], [180, 7], [181, 7], [185, 7], [186, 6],
              [200, 7], [201, 7], [202, 7]],
      enemies: [20, 38, 48, 52, 66, 80, 94, 100, 112, 122, 132, 142, 158, 166, 180, 192, 204],
      stairs: [[218, 11], [219, 10], [220, 9], [221, 8]]
    },
    {
      name: "1-5", cols: 248, flag: 236,
      sky: ["#141a45", "#232a6b", "#3d4a8c"],           // night fortress
      pits: [[14, 16], [24, 26], [38, 40], [52, 54], [60, 62], [72, 74], [80, 82],
             [106, 108], [128, 130], [148, 150], [166, 168], [182, 184], [198, 200], [220, 222]],
      bricks: [[18, 8, 3], [28, 8, 3], [44, 8, 3], [56, 8, 3], [66, 8, 3], [76, 8, 3],
               [88, 8, 4], [98, 8, 3], [112, 8, 4], [124, 8, 3], [136, 8, 3], [144, 8, 3],
               [156, 8, 4], [172, 8, 3], [180, 8, 3], [192, 8, 3], [204, 8, 3], [214, 8, 3]],
      questions: [[24, 8], [40, 8], [62, 8], [84, 8], [104, 8], [120, 6], [140, 8], [160, 6], [188, 8], [210, 8]],
      pipes: [[34, 9], [70, 8], [94, 9], [130, 8], [152, 9], [176, 8], [200, 9], [226, 8]],
      coins: [[14, 7], [15, 6], [18, 7], [19, 7], [20, 7], [23, 7], [24, 6], [28, 7], [29, 7], [30, 7],
              [39, 7], [40, 7], [44, 7], [45, 7], [46, 7], [52, 7], [53, 7], [56, 7], [57, 7], [61, 7],
              [66, 7], [67, 7], [68, 7], [73, 7], [76, 7], [77, 7], [81, 7], [88, 7], [89, 7], [90, 7],
              [98, 7], [99, 7], [100, 7], [105, 7], [112, 7], [113, 7], [114, 7], [115, 7],
              [124, 7], [125, 7], [126, 7], [129, 7], [136, 7], [137, 7], [138, 7],
              [148, 7], [149, 7], [156, 7], [157, 7], [158, 7], [159, 7], [167, 7],
              [172, 7], [173, 7], [174, 7], [182, 7], [183, 7], [192, 7], [193, 7], [194, 7],
              [204, 7], [205, 7], [206, 7], [214, 7], [215, 7], [216, 7], [219, 7], [220, 6]],
      enemies: [20, 31, 46, 57, 68, 85, 90, 100, 111, 118, 123, 138, 145, 158, 163, 187, 194, 206, 212],
      stairs: [[230, 11], [231, 10], [232, 9], [233, 8]]
    }
  ];
  var curLevel = 0, LV = LEVELS[0];

  function inPit(c) {
    for (var i = 0; i < LV.pits.length; i++) if (c >= LV.pits[i][0] && c < LV.pits[i][1]) return true;
    return false;
  }
  function buildLevel(saved, idx) {
    if (idx == null) idx = curLevel;
    curLevel = idx; LV = LEVELS[idx];
    COLS = LV.cols; FLAG_COL = LV.flag; FLAG_TRIGGER_X = FLAG_COL * TILE;

    var c, r;
    grid = [];
    for (r = 0; r < ROWS; r++) { var row = []; for (c = 0; c < COLS; c++) row.push(EMPTY); grid.push(row); }

    // ground (rows 12,13) with pits carved out
    for (c = 0; c < COLS; c++) {
      if (inPit(c)) continue;
      grid[12][c] = GROUND; grid[13][c] = GROUND;
    }
    LV.bricks.forEach(function (b) { for (var i = 0; i < b[2]; i++) grid[b[1]][b[0] + i] = BRICK; });
    LV.questions.forEach(function (q) { grid[q[1]][q[0]] = QUESTION; });
    // pipes (2 wide, from topRow down to just above ground)
    LV.pipes.forEach(function (p) {
      for (var rr = p[1]; rr <= GROUND_ROW - 1; rr++) { grid[rr][p[0]] = PIPE; grid[rr][p[0] + 1] = PIPE; }
    });
    // end staircase
    LV.stairs.forEach(function (s) { for (var rr = s[1]; rr <= GROUND_ROW - 1; rr++) grid[rr][s[0]] = STONE; });

    // coins
    coins = LV.coins.map(function (cs, i) {
      return { c: cs[0], r: cs[1], x: cs[0] * TILE + 6, y: cs[1] * TILE + 4, w: 20, h: 24, taken: false, id: i };
    });
    // enemies (goombas)
    enemies = LV.enemies.map(function (ec, i) {
      return { x: ec * TILE + 2, y: TOP_Y - 26, w: 28, h: 26, vx: 0, vy: 0, dir: -1, dead: false, deadTimer: 0, id: i };
    });
    popups = [];

    // restore saved run
    if (saved) {
      if (saved.grid) grid = saved.grid;
      (saved.coinTaken || []).forEach(function (v, i) { if (coins[i]) coins[i].taken = !!v; });
      (saved.enemyDead || []).forEach(function (v, i) { if (enemies[i]) enemies[i].dead = !!v; });
    }
    buildDecor();
  }
  function buildDecor() {
    hills = []; clouds = []; bushes = [];
    for (var x = 0; x < COLS * TILE; x += 640) hills.push({ x: x + 120, w: 260, h: 120, col: "#1aa52b" });
    for (var x2 = 200; x2 < COLS * TILE; x2 += 480) bushes.push({ x: x2, s: 1 + (x2 % 3) * 0.15 });
    for (var i = 0; i * 300 < COLS * TILE; i++) clouds.push({ x: i * 300 + 80, y: 40 + (i % 3) * 34, s: 0.8 + (i % 4) * 0.12 });
  }

  function resetPlayer() {
    player = { x: SPAWN_X, y: SPAWN_Y, w: 20, h: 28, vx: 0, vy: 0, facing: 1, onGround: false, hitWall: 0, bump: null, walk: 0 };
    coyote = 0; jumpBuffer = 0;
    cam = 0;
  }

  // ---------- State transitions ----------
  function showOverlay(msg, btnLabel, action) {
    overlayEl.classList.remove("overlay--win");
    if (overlaySubEl) { overlaySubEl.hidden = true; overlaySubEl.innerHTML = ""; }
    if (overNextEl) overNextEl.hidden = true;
    overlayMsgEl.textContent = msg;
    if (overBtn) overBtn.textContent = btnLabel;
    overlayAction = action;
    overlayEl.hidden = false;
  }
  function hideOverlay() { overlayEl.hidden = true; overlayAction = null; }

  // Victory: a gold banner + run stats over an animated fireworks backdrop.
  function showOverlayWin() {
    var secs = Math.floor(elapsed / 1000);
    var hasNext = curLevel < LEVELS.length - 1;
    overlayMsgEl.textContent = "Course Clear!";
    if (overlaySubEl) {
      overlaySubEl.innerHTML =
        "STAGE <b>" + LV.name + "</b> &middot; SCORE <b>" + score + "</b> &middot; COINS <b>" + coinCount + "</b> &middot; " +
        "TIME <b>" + secs + "s</b> &middot; BEST <b>" + best + "</b>";
      overlaySubEl.hidden = false;
    }
    if (overBtn) overBtn.textContent = hasNext ? "Next Stage ▸" : "Play Again";
    overlayAction = hasNext ? nextStage : startNewGame;
    if (overNextEl) {
      overNextEl.hidden = !hasNext;
      if (hasNext) overNextEl.textContent = "Replay " + LV.name;
    }
    overlayEl.classList.add("overlay--win");
    overlayEl.hidden = false;
  }

  // Load a stage into play. keepProgress carries score/coins/lives into the
  // next stage; a fresh start (or stage select) resets the run.
  function loadLevel(idx, keepProgress) {
    buildLevel(null, idx);
    resetPlayer();
    if (!keepProgress) { score = 0; coinCount = 0; lives = 3; }
    elapsed = 0; stepTick = 0; fx = [];
    mode = "playing";
    hideOverlay();
    if (overNextEl) overNextEl.hidden = true;
    setPauseBtn(); updateStageBtn();
    save();
  }
  function startNewGame() {
    loadLevel(curLevel, false);
    say("Stage " + LV.name + " — run right, jump on the mushrooms, reach the flag!");
  }
  function nextStage() {
    if (curLevel < LEVELS.length - 1) {
      loadLevel(curLevel + 1, true);
      say("Stage " + LV.name + " — go! Score carries over.");
    } else {
      startNewGame();
    }
  }
  function showReady() {
    buildLevel(null); resetPlayer();
    score = 0; coinCount = 0; lives = 3; elapsed = 0;
    mode = "ready";
    showOverlay("Press Space (or Start) to play", "Start", startNewGame);
    setPauseBtn(); draw();
  }
  function showResume() {
    resetFromSave();
    mode = "paused";
    showOverlay("Welcome back — paused", "Continue", resumeSaved);
    setPauseBtn(); draw();
  }
  function resumeSaved() { hideOverlay(); setPaused(false); }
  function togglePause() { if (mode === "playing") setPaused(true); else if (mode === "paused") setPaused(false); }
  function setPaused(p) {
    if (p && mode === "playing") {
      mode = "paused"; showOverlay("Paused", "Continue", resumeSaved); save();
    } else if (!p && mode === "paused") {
      hideOverlay(); mode = "playing"; lastTime = 0; acc = 0;
    }
    setPauseBtn();
    say(p ? "Paused — press Space to resume." : "Stack the run, grab the coins.");
  }
  function gameOver() {
    mode = "over";
    clearSave();
    showOverlay("Game over — " + score + " pts", "Play again", startNewGame);
    setPauseBtn(); draw();
    say("Game over. Press Space or Play again.");
  }
  function winGame() {
    if (mode === "win") return;
    mode = "win";
    clearSave();
    if (score > best) { best = score; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
    keys.left = keys.right = keys.run = keys.jump = false;
    fx = []; lastBurst = 0;
    showOverlayWin();
    setPauseBtn(); draw();
    say("Stage clear! You reached the flag.");
  }

  function killPlayer(byPit) {
    lives--;
    if (lives <= 0) { gameOver(); return; }
    resetPlayer();
    say(byPit ? "You fell in a pit! " + lives + " lives left." : "Ouch! " + lives + " lives left.");
  }

  function setPauseBtn() {
    var lbl = pauseBtn.querySelector(".btn__lbl");
    var ico = pauseBtn.querySelector(".btn__ico");
    var on = mode === "paused";
    if (lbl) lbl.textContent = on ? "Resume" : "Pause";
    if (ico) ico.innerHTML = on
      ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M8 5.5v13l11-6.5z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg>';
    pauseBtn.setAttribute("aria-pressed", String(on));
    pauseBtn.setAttribute("title", on ? "Resume" : "Pause");
  }

  // ---------- Stage selector (header) ----------
  function updateStageBtn() {
    if (stageLbl) stageLbl.textContent = "Stage " + LV.name;
    if (stageMenu) {
      Array.prototype.forEach.call(stageMenu.querySelectorAll(".stagemenu__item"), function (it, i) {
        it.classList.toggle("is-current", i === curLevel);
      });
    }
  }
  function buildStageMenu() {
    if (!stageMenu) return;
    stageMenu.innerHTML = "";
    LEVELS.forEach(function (lv, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "stagemenu__item";
      b.innerHTML = '<span class="stagemenu__no">' + lv.name + "</span>" +
                    '<span class="stagemenu__nm">Stage ' + lv.name + "</span>";
      b.addEventListener("click", function () { selectStage(i); closeStageMenu(); });
      stageMenu.appendChild(b);
    });
  }
  function openStageMenu() { if (!stageMenu) return; updateStageBtn(); stageMenu.hidden = false; stageBtn.setAttribute("aria-expanded", "true"); }
  function closeStageMenu() { if (!stageMenu) return; stageMenu.hidden = true; stageBtn.setAttribute("aria-expanded", "false"); }
  function toggleStageMenu() { if (stageMenu && !stageMenu.hidden) closeStageMenu(); else openStageMenu(); }
  function selectStage(i) {
    if (i < 0 || i >= LEVELS.length) return;
    loadLevel(i, false);
    say("Stage " + LV.name + " selected — go!");
  }

  // ---------- Simulation step ----------
  function update() {
    // horizontal intent
    var dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var max = keys.run ? RUN_MAX : WALK_MAX;
    if (dir !== 0) {
      player.vx += dir * ACCEL;
      if (player.vx > max) player.vx = Math.max(max, player.vx - BRAKE);
      else if (player.vx < -max) player.vx = Math.min(-max, player.vx + BRAKE);
      player.facing = dir;
    } else if (player.vx > 0) { player.vx = Math.max(0, player.vx - FRICTION); }
    else if (player.vx < 0) { player.vx = Math.min(0, player.vx + FRICTION); }

    // jump (with buffer + coyote)
    if (jumpBuffer > 0 && (player.onGround || coyote > 0)) {
      player.vy = JUMP_V; player.onGround = false; coyote = 0; jumpBuffer = 0;
    }
    player.vy = Math.min(player.vy + GRAV, MAXFALL);
    if (!keys.jump && player.vy < JUMP_CUT) player.vy = JUMP_CUT;   // variable height

    player.hitWall = 0; moveX(player, player.vx);
    player.bump = null; moveY(player, player.vy);
    if (player.onGround) { coyote = COYOTE; } else if (coyote > 0) { coyote--; }
    if (jumpBuffer > 0) jumpBuffer--;

    if (Math.abs(player.vx) > 0.4 && player.onGround) player.walk += Math.abs(player.vx);
    if (player.bump) handleBump(player.bump.c, player.bump.r);

    collectCoins();
    updateEnemies();
    updatePopups();

    if (player.y > ROWS * TILE + 40) { killPlayer(true); return; }
    if (player.x + player.w >= FLAG_TRIGGER_X) { winGame(); return; }

    elapsed += STEP_MS;
    stepTick++;
    if (stepTick % 90 === 0) save();     // periodic autosave
  }

  function handleBump(c, r) {
    var t = grid[r][c];
    if (t === QUESTION) {
      grid[r][c] = USED;
      popups.push({ x: c * TILE + 8, y: r * TILE - 6, life: 26 });
      coinCount++; score += 200;
    } else if (t === BRICK) {
      // small bump for now (bricks are solid in this build)
    }
  }
  function collectCoins() {
    for (var i = 0; i < coins.length; i++) {
      var co = coins[i];
      if (!co.taken && aabb(player, co)) { co.taken = true; coinCount++; score += 100; }
    }
  }
  function updateEnemies() {
    for (var i = 0; i < enemies.length; i++) {
      var en = enemies[i];
      if (en.dead) { if (en.deadTimer > 0) en.deadTimer--; continue; }
      if (en.x < cam - 120 || en.x > cam + VIEW_W + 200) continue;   // sleep off-screen
      en.vy = Math.min(en.vy + GRAV, MAXFALL);
      en.hitWall = 0;
      moveX(en, en.dir * ENEMY_SPEED);
      if (en.hitWall) en.dir *= -1;
      moveY(en, en.vy);
      if (en.y > ROWS * TILE + 40) { en.dead = true; continue; }
      if (aabb(player, en)) {
        var pBottom = player.y + player.h;
        if (player.vy > 0 && (pBottom - en.y) < en.h * 0.6) {
          en.dead = true; en.deadTimer = 26;
          player.vy = -6.5; player.y = en.y - player.h;
          score += 100;
        } else { killPlayer(false); return; }
      }
    }
  }
  function updatePopups() {
    for (var i = popups.length - 1; i >= 0; i--) { popups[i].y -= 1.6; if (--popups[i].life <= 0) popups.splice(i, 1); }
  }

  // ---------- Rendering ----------
  function draw() {
    cam = Math.max(0, Math.min(Math.round(player.x + player.w / 2 - VIEW_W / 2), COLS * TILE - VIEW_W));
    drawSky();
    drawParallax();
    ctx.save();
    ctx.translate(-cam, 0);
    drawTiles();
    drawFlag();
    drawCoins();
    drawEnemies();
    drawPopups();
    drawPlayer();
    ctx.restore();
    drawHUD();
  }
  function drawSky() {
    // Each stage can carry its own 3-stop sky gradient ("time of day").
    var sky = LV.sky || ["#5c94fc", "#69a6ff", "#8fc0ff"];
    var g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, sky[0]); g.addColorStop(0.7, sky[1]); g.addColorStop(1, sky[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
  function drawParallax() {
    // far hills
    for (var i = 0; i < hills.length; i++) {
      var h = hills[i], sx = h.x - cam * 0.4;
      if (sx < -h.w || sx > VIEW_W) continue;
      ctx.fillStyle = "#1aa52b";
      ctx.beginPath();
      ctx.moveTo(sx, TOP_Y + 8);
      ctx.quadraticCurveTo(sx + h.w / 2, TOP_Y - h.h, sx + h.w, TOP_Y + 8);
      ctx.closePath(); ctx.fill();
    }
    // bushes
    for (var b = 0; b < bushes.length; b++) {
      var bu = bushes[b], bx = bu.x - cam * 0.72;
      if (bx < -80 || bx > VIEW_W) continue;
      drawBush(bx, TOP_Y + 6, bu.s);
    }
    // clouds
    for (var c = 0; c < clouds.length; c++) {
      var cl = clouds[c], cx = cl.x - cam * 0.28;
      if (cx < -120 || cx > VIEW_W) continue;
      drawCloud(cx, cl.y, cl.s);
    }
  }
  function drawCloud(x, y, s) {
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.beginPath();
    ctx.arc(x, y + 8 * s, 14 * s, 0, 7); ctx.arc(x + 18 * s, y, 18 * s, 0, 7);
    ctx.arc(x + 40 * s, y + 6 * s, 15 * s, 0, 7); ctx.arc(x + 20 * s, y + 14 * s, 16 * s, 0, 7);
    ctx.fill();
  }
  function drawBush(x, y, s) {
    ctx.fillStyle = "#0f8f2a";
    ctx.beginPath();
    ctx.arc(x, y, 16 * s, Math.PI, 0); ctx.arc(x + 20 * s, y, 20 * s, Math.PI, 0); ctx.arc(x + 42 * s, y, 16 * s, Math.PI, 0);
    ctx.rect(x - 16 * s, y, 74 * s, 8);
    ctx.fill();
  }
  function drawTiles() {
    var c0 = Math.floor(cam / TILE) - 1, c1 = c0 + Math.ceil(VIEW_W / TILE) + 2;
    for (var c = Math.max(0, c0); c < Math.min(COLS, c1); c++) {
      for (var r = 0; r < ROWS; r++) {
        var t = grid[r][c];
        if (t !== EMPTY) drawTile(c, r, t);
      }
    }
  }
  function drawTile(c, r, t) {
    var x = c * TILE, y = r * TILE;
    if (t === GROUND) {
      var grass = !isSolid(get(c, r - 1));
      ctx.fillStyle = "#c1591b"; ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "rgba(0,0,0,.14)";
      ctx.fillRect(x, y + 16, TILE, 2); ctx.fillRect(x + 15, y, 2, TILE);
      if (grass) { ctx.fillStyle = "#3fbf2f"; ctx.fillRect(x, y, TILE, 8); ctx.fillStyle = "#57d646"; ctx.fillRect(x, y, TILE, 4); }
    } else if (t === BRICK) {
      ctx.fillStyle = "#b5451b"; ctx.fillRect(x, y, TILE, TILE);
      ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
      ctx.beginPath(); ctx.moveTo(x, y + 16); ctx.lineTo(x + TILE, y + 16);
      ctx.moveTo(x + 16, y); ctx.lineTo(x + 16, y + 16); ctx.moveTo(x + 8, y + 16); ctx.lineTo(x + 8, y + TILE);
      ctx.moveTo(x + 24, y + 16); ctx.lineTo(x + 24, y + TILE); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.14)"; ctx.fillRect(x, y, TILE, 3);
    } else if (t === STONE) {
      ctx.fillStyle = "#8a5a34"; ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "rgba(0,0,0,.2)"; ctx.fillRect(x, y + TILE - 5, TILE, 5);
      ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.fillRect(x, y, TILE, 3);
    } else if (t === QUESTION) {
      ctx.fillStyle = "#e8a013"; ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "#f7d51d"; ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
      ctx.fillStyle = "#7a4a05"; ctx.font = "bold 20px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("?", x + TILE / 2, y + TILE / 2 + 1);
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillRect(x + 3, y + 3, 3, 3); ctx.fillRect(x + TILE - 6, y + 3, 3, 3);
      ctx.fillRect(x + 3, y + TILE - 6, 3, 3); ctx.fillRect(x + TILE - 6, y + TILE - 6, 3, 3);
    } else if (t === USED) {
      ctx.fillStyle = "#9a6a2a"; ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "#6a451a"; ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
    } else if (t === PIPE) {
      var top = !isSolid(get(c, r - 1));
      ctx.fillStyle = "#2ec43f"; ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "#1f9e30"; ctx.fillRect(x + TILE - 6, y, 6, TILE);
      ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fillRect(x + 4, y, 5, TILE);
      if (top) { ctx.fillStyle = "#25b23a"; ctx.fillRect(x - 3, y, TILE + 6, 14); ctx.fillStyle = "rgba(0,0,0,.2)"; ctx.fillRect(x - 3, y + 12, TILE + 6, 2); }
    }
  }
  function drawFlag() {
    var x = FLAG_COL * TILE + 12, groundY = TOP_Y;
    // pole
    ctx.fillStyle = "#3aa63a"; ctx.fillRect(x - 2, 40, 4, groundY - 40);
    ctx.fillStyle = "#cfe"; ctx.beginPath(); ctx.arc(x, 40, 6, 0, 7); ctx.fill();
    ctx.fillStyle = "#0e7a1f"; ctx.fillRect(x - 10, groundY - 12, 20, 12);
    // banner
    ctx.fillStyle = "#e23b2e";
    ctx.beginPath(); ctx.moveTo(x - 2, 46); ctx.lineTo(x - 2, 66); ctx.lineTo(x + 26, 56); ctx.closePath(); ctx.fill();
  }
  function drawCoins() {
    for (var i = 0; i < coins.length; i++) {
      var co = coins[i];
      if (co.taken) continue;
      if (co.x < cam - 40 || co.x > cam + VIEW_W + 40) continue;
      var sway = Math.sin((stepTick + i * 8) / 14);
      var w = 6 + Math.abs(sway) * 4;
      ctx.fillStyle = "#c99700"; ctx.beginPath(); ctx.ellipse(co.x + 10, co.y + 12, w, 12, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#ffd83a"; ctx.beginPath(); ctx.ellipse(co.x + 10, co.y + 12, w * 0.66, 9, 0, 0, 7); ctx.fill();
    }
  }
  function drawEnemies() {
    for (var i = 0; i < enemies.length; i++) {
      var en = enemies[i];
      if (en.x < cam - 40 || en.x > cam + VIEW_W + 40) continue;
      if (en.dead && en.deadTimer <= 0) continue;
      drawGoomba(en);
    }
  }
  function drawGoomba(en) {
    var x = en.x, y = en.y, w = en.w, h = en.h;
    if (en.dead) { h = 8; y = en.y + (en.h - 8); }   // squashed
    ctx.fillStyle = "#8a4b1e";
    ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.55, w / 2, Math.PI, 0); ctx.rect(x, y + h * 0.5, w, h * 0.5); ctx.fill();
    ctx.fillStyle = "#e0b57f"; ctx.fillRect(x + 3, y + h * 0.7, w - 6, h * 0.3);
    if (!en.dead) {
      ctx.fillStyle = "#fff"; ctx.fillRect(x + 5, y + 12, 6, 7); ctx.fillRect(x + w - 11, y + 12, 6, 7);
      ctx.fillStyle = "#000"; ctx.fillRect(x + 7, y + 14, 3, 5); ctx.fillRect(x + w - 9, y + 14, 3, 5);
      // feet
      ctx.fillStyle = "#5a2f10"; var off = Math.sin(stepTick / 6) * 2;
      ctx.fillRect(x + 2 + off, y + h - 3, 9, 3); ctx.fillRect(x + w - 11 - off, y + h - 3, 9, 3);
    }
  }
  function drawPopups() {
    for (var i = 0; i < popups.length; i++) {
      var p = popups[i];
      ctx.fillStyle = "#ffd83a"; ctx.beginPath(); ctx.ellipse(p.x + 8, p.y, 6, 9, 0, 0, 7); ctx.fill();
    }
  }
  function drawPlayer() {
    var x = Math.round(player.x), y = Math.round(player.y), w = player.w, h = player.h, f = player.facing;
    var running = Math.abs(player.vx) > 0.6 && player.onGround;
    var stride = running ? Math.sin(player.walk / 3.5) : 0;
    var air = !player.onGround;
    // feet / shoes
    ctx.fillStyle = "#6b3a12";
    if (air) { ctx.fillRect(x + 1, y + h - 6, 9, 6); ctx.fillRect(x + w - 10, y + h - 8, 9, 6); }
    else { ctx.fillRect(x + 1 + stride * 3, y + h - 5, 9, 5); ctx.fillRect(x + w - 10 - stride * 3, y + h - 5, 9, 5); }
    // overalls (blue)
    ctx.fillStyle = "#2a5ad6"; ctx.fillRect(x + 2, y + 15, w - 4, h - 19);
    // shirt / arms (red)
    ctx.fillStyle = "#e23b2e"; ctx.fillRect(x + 1, y + 13, w - 2, 6);
    ctx.fillRect(f > 0 ? x + w - 5 : x, y + 14, 5, 8);   // leading arm
    // overall strap buttons
    ctx.fillStyle = "#ffd83a"; ctx.fillRect(x + 5, y + 16, 2, 2); ctx.fillRect(x + w - 7, y + 16, 2, 2);
    // head (skin)
    ctx.fillStyle = "#f0b07a"; ctx.fillRect(x + 3, y + 4, w - 6, 11);
    // cap (red) + brim
    ctx.fillStyle = "#e23b2e"; ctx.fillRect(x + 2, y, w - 4, 5); ctx.fillRect(f > 0 ? x + 4 : x - 1, y + 4, w - 5, 3);
    // eye + moustache
    ctx.fillStyle = "#20140a";
    ctx.fillRect(f > 0 ? x + w - 8 : x + 6, y + 8, 2, 4);
    ctx.fillRect(x + (f > 0 ? 6 : 4), y + 12, w - 8, 2);
  }
  function drawHUD() {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.fillRect(0, 0, VIEW_W, 30);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText("SCORE " + pad(score, 6), 14, 16);
    ctx.fillText("COINS x" + pad(coinCount, 2), 180, 16);
    ctx.fillText("LIVES x" + Math.max(0, lives), 340, 16);
    ctx.textAlign = "center";
    ctx.fillText("WORLD " + LV.name, VIEW_W / 2 + 60, 16);
    ctx.textAlign = "right";
    var secs = Math.floor(elapsed / 1000);
    ctx.fillText("TIME " + pad(Math.max(0, 400 - secs % 400), 3), VIEW_W - 14, 16);
    ctx.restore();
  }
  function pad(n, w) { n = String(n | 0); while (n.length < w) n = "0" + n; return n; }

  // ---------- Loop ----------
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (mode === "win") { winTick(t); return; }
    if (mode !== "playing") { lastTime = t; return; }
    if (!lastTime) lastTime = t;
    var delta = Math.min(t - lastTime, 120);   // clamp after tab-out
    lastTime = t;
    acc += delta;
    while (acc >= STEP_MS) { acc -= STEP_MS; update(); if (mode !== "playing") break; }
    draw();
  }
  // During the win scene the world stays frozen at the flagpole while bursts of
  // fireworks keep animating on top (drawn in screen space, no camera shift).
  function winTick(t) {
    stepTick++;
    if (t - lastBurst > 430) { spawnBurst(); lastBurst = t; }
    for (var i = fx.length - 1; i >= 0; i--) {
      var p = fx[i]; p.vy += 0.12; p.vx *= 0.985; p.x += p.vx; p.y += p.vy;
      if (--p.life <= 0) fx.splice(i, 1);
    }
    draw();
    ctx.save();
    for (var j = 0; j < fx.length; j++) {
      var q = fx[j];
      ctx.globalAlpha = Math.max(0, q.life / q.max);
      ctx.fillStyle = q.col;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function spawnBurst() {
    var cols = ["#ff4a3d", "#ffd83a", "#3fbf2f", "#5c94fc", "#ff8ac2", "#ffffff"];
    var ox = 110 + Math.random() * (VIEW_W - 220);
    var oy = 54 + Math.random() * 150;
    var col = cols[(Math.random() * cols.length) | 0];
    for (var i = 0; i < 32; i++) {
      var a = (i / 32) * Math.PI * 2, sp = 1.4 + Math.random() * 2.4, L = 40 + ((Math.random() * 22) | 0);
      fx.push({ x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.4, life: L, max: L, r: 1.5 + Math.random() * 1.8, col: col });
    }
  }

  // ---------- Input ----------
  function jumpPressed() { jumpBuffer = BUFFER; keys.jump = true; }
  document.addEventListener("keydown", function (e) {
    if (rulesOpen()) return;
    var k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); keys.left = true; }
    else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); keys.right = true; }
    else if (k === "ArrowUp" || k === "w" || k === "W") { e.preventDefault(); jumpPressed(); }
    else if (k === " ") {
      e.preventDefault();
      if (mode === "playing") jumpPressed();
      else if (mode === "ready" || mode === "over") startNewGame();
      else if (mode === "win") { if (overlayAction) overlayAction(); }
      else if (mode === "paused") resumeSaved();
    }
    else if (k === "Escape") { e.preventDefault(); if (stageMenu && !stageMenu.hidden) closeStageMenu(); }
    else if (k === "p" || k === "P") { e.preventDefault(); togglePause(); }
    else if (k === "Shift") { keys.run = true; }
    else if (k === "r" || k === "R") { startNewGame(); }
  });
  document.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") keys.left = false;
    else if (k === "ArrowRight" || k === "d" || k === "D") keys.right = false;
    else if (k === "ArrowUp" || k === "w" || k === "W" || k === " ") keys.jump = false;
    else if (k === "Shift") keys.run = false;
  });
  window.addEventListener("blur", function () { keys.left = keys.right = keys.run = keys.jump = false; });

  // Touch pad (hold-to-act)
  function bindHold(el, on, off) {
    el.addEventListener("pointerdown", function (e) { e.preventDefault(); on(); });
    el.addEventListener("pointerup", off); el.addEventListener("pointercancel", off); el.addEventListener("pointerleave", off);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tpad__btn"), function (b) {
    var act = b.dataset.act;
    if (act === "left") bindHold(b, function () { keys.left = true; }, function () { keys.left = false; });
    else if (act === "right") bindHold(b, function () { keys.right = true; }, function () { keys.right = false; });
    else if (act === "jump") bindHold(b, function () { if (mode === "playing") jumpPressed(); else if (overlayAction) overlayAction(); }, function () { keys.jump = false; });
  });

  // Buttons
  newBtn.addEventListener("click", startNewGame);
  pauseBtn.addEventListener("click", togglePause);
  overBtn && overBtn.addEventListener("click", function () { if (overlayAction) overlayAction(); });
  overNextEl && overNextEl.addEventListener("click", startNewGame);
  if (stageBtn) stageBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleStageMenu(); });
  document.addEventListener("click", function (e) {
    if (!stageMenu || stageMenu.hidden) return;
    if (e.target.closest && e.target.closest("#stagePick")) return;
    closeStageMenu();
  });

  // Rules modal
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  function rulesOpen() { return rulesModal && !rulesModal.hidden; }
  rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });

  // ---------- Persistence ----------
  function save() {
    if (mode !== "playing" && mode !== "paused") return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        level: curLevel,
        grid: grid, px: Math.round(player.x), py: Math.round(player.y),
        score: score, coins: coinCount, lives: lives,
        coinTaken: coins.map(function (c) { return c.taken ? 1 : 0; }),
        enemyDead: enemies.map(function (e) { return e.dead ? 1 : 0; }),
      }));
    } catch (e) {}
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  function loadBest() { try { best = localStorage.getItem(BEST_KEY) | 0; } catch (e) { best = 0; } }
  function readSave() {
    try {
      var o = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (!o || !o.grid || typeof o.px !== "number") return null;
      o.level = Math.min(Math.max(o.level | 0, 0), LEVELS.length - 1);
      // A grid saved from a different (or older) layout can't be restored.
      if (!o.grid[0] || o.grid[0].length !== LEVELS[o.level].cols) return null;
      return o;
    } catch (e) { return null; }
  }
  function resetFromSave() {
    var o = readSave();
    if (!o) { showReady(); return; }
    var lvl = Math.min(Math.max(o.level | 0, 0), LEVELS.length - 1);
    buildLevel(o, lvl);
    player = { x: o.px, y: o.py, w: 20, h: 28, vx: 0, vy: 0, facing: 1, onGround: false, hitWall: 0, bump: null, walk: 0 };
    score = o.score | 0; coinCount = o.coins | 0; lives = (o.lives == null ? 3 : o.lives); elapsed = 0;
    coyote = 0; jumpBuffer = 0;
  }

  document.addEventListener("visibilitychange", function () { if (document.hidden && mode === "playing") setPaused(true); });
  window.addEventListener("beforeunload", save);

  // ---------- Boot ----------
  loadBest();
  buildStageMenu();
  var savedRun = readSave();
  if (savedRun) showResume(); else showReady();
  updateStageBtn();
  rafId = requestAnimationFrame(frame);
})();
