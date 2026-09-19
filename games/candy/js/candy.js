/* ===== Sweet Crush (match-3 lite) — game logic =====
   Single-file, dependency-free. Endless 8x8 board, six colours.
   - Swap adjacent candies (click-click or drag) to line up 3+.
   - 4 in a line bakes a striped candy (clears its row/column), 5 bakes a
     colour bomb (swap it to vaporise a colour); specials detonate each
     other in chain reactions.
   - Cascades re-trigger until the board is stable; input is locked while
     anything is animating. Dead boards reshuffle themselves.
   - Stable board + score persisted in localStorage (gc-candy-save), best
     score in gc-candy-stats. Saves only happen between resolutions, so a
     mid-cascade state is never stored. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  var N = 8, COLORS = 6;
  var PAD = 8;   // board inner padding; keep in sync with .cd-board padding
  var GAP = 4;   // px between cells
  var T_SWAP = 200, T_POP = 230, T_FALL = 330;
  var SAVE_KEY = "gc-candy-save";
  var STATS_KEY = "gc-candy-stats";

  // ---------- DOM refs ----------
  var boardEl = document.getElementById("board");
  var scoreEl = document.getElementById("score");
  var movesEl = document.getElementById("moves");
  var bestEl = document.getElementById("best");
  var rulesBtn = document.getElementById("rulesBtn");
  var newBtn = document.getElementById("newBtn");
  var rulesModal = document.getElementById("rulesModal");
  var toastEl = document.getElementById("toast");

  // ---------- State ----------
  var grid = [];          // grid[r][c] = { color, special, el } | null
  var cells = [];         // checkered background divs
  var score = 0, moves = 0, best = 0;
  var locked = false;     // true while anything animates / resolves
  var sel = null;         // selected cell {r,c} for click-click swaps
  var pressed = null;     // pointerdown origin for drag swaps
  var tile = 44;          // candy size in px, recomputed by layout()
  var toastId = null;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(r, c) { return r * N + c; }
  function unkey(k) { return [Math.floor(k / N), k % N]; }
  function inBounds(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

  // ---------- Stats ----------
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify({ best: best })); } catch (e) {}
  }

  // ---------- Geometry / rendering ----------
  function tileSize() { return (boardEl.clientWidth - PAD * 2 - GAP * (N - 1)) / N; }
  function px(r, c) { return PAD + c * (tile + GAP); }
  function py(r, c) { return PAD + r * (tile + GAP); }

  function makeCells() {
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var d = document.createElement("div");
        d.className = "cd-cell" + ((r + c) % 2 ? " cd-cell--b" : "");
        boardEl.appendChild(d);
        cells.push(d);
      }
    }
  }
  function layout() {
    tile = tileSize();
    var i = 0;
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++, i++) {
        var cell = cells[i];
        cell.style.width = cell.style.height = tile + "px";
        cell.style.left = px(r, c) + "px";
        cell.style.top = py(r, c) + "px";
      }
    }
    for (r = 0; r < N; r++) {
      for (c = 0; c < N; c++) {
        var cd = grid[r] && grid[r][c];
        if (cd && cd.el) place(cd.el, r, c);
      }
    }
  }
  function place(el, r, c) {
    el.style.width = el.style.height = tile + "px";
    el.style.left = px(r, c) + "px";
    el.style.top = py(r, c) + "px";
    el.style.fontSize = Math.round(tile * 0.42) + "px";
  }
  // Put a fresh candy above the board without a slide, so it falls in later.
  function placeNoAnim(el, r, c) {
    el.style.transition = "none";
    place(el, r, c);
    void el.offsetWidth; // force reflow so the next move animates
    el.style.transition = "";
  }

  function candyClass(color, special) {
    var cls = "cd cd--" + color;
    if (special === "bomb") cls += " cd--bomb";
    else if (special === "sh") cls += " cd--striped-h";
    else if (special === "sv") cls += " cd--striped-v";
    return cls;
  }
  function makeCandy(r, c, color, special, above) {
    var el = document.createElement("div");
    el.className = candyClass(color, special);
    el.dataset.rc = key(r, c);
    boardEl.appendChild(el);
    if (above) placeNoAnim(el, above, c);
    else place(el, r, c);
    return { color: color, special: special || null, el: el };
  }
  function setCandyColor(cd, color, special) {
    cd.color = color;
    cd.special = special || null;
    cd.el.className = candyClass(color, cd.special);
  }
  function refreshEl(cd) { cd.el.className = candyClass(cd.color, cd.special); }

  // ---------- Match detection ----------
  // Returns runs: { cells:[k...], dir:'h'|'v', len }. Colour -1 = no candy.
  function colorAt(r, c) {
    var cd = inBounds(r, c) && grid[r] && grid[r][c];
    return cd ? cd.color : -1;
  }
  function findRuns() {
    var runs = [], r, c, run;
    for (r = 0; r < N; r++) {
      run = [0];
      for (c = 1; c < N; c++) {
        if (colorAt(r, c) !== -1 && colorAt(r, c) === colorAt(r, run[run.length - 1])) run.push(c);
        else { if (run.length >= 3) runs.push({ cells: rowKeys(r, run), dir: "h", len: run.length }); run = [c]; }
      }
      if (run.length >= 3) runs.push({ cells: rowKeys(r, run), dir: "h", len: run.length });
    }
    for (c = 0; c < N; c++) {
      run = [0];
      for (r = 1; r < N; r++) {
        if (colorAt(r, c) !== -1 && colorAt(r, c) === colorAt(run[run.length - 1], c)) run.push(r);
        else { if (run.length >= 3) runs.push({ cells: colKeys(c, run), dir: "v", len: run.length }); run = [r]; }
      }
      if (run.length >= 3) runs.push({ cells: colKeys(c, run), dir: "v", len: run.length });
    }
    return runs;
  }
  function rowKeys(r, cols) { return cols.map(function (c) { return key(r, c); }); }
  function colKeys(c, rows) { return rows.map(function (r) { return key(r, c); }); }
  function hasRuns() { return findRuns().length > 0; }

  // ---------- Clearing / specials ----------
  function allCellsSet() {
    var s = {};
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) if (grid[r][c]) s[key(r, c)] = 1;
    return s;
  }
  function majorityColor() {
    var count = [0, 0, 0, 0, 0, 0];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      var cd = grid[r][c];
      if (cd && cd.special !== "bomb") count[cd.color]++;
    }
    var bi = 0;
    for (var i = 1; i < COLORS; i++) if (count[i] > count[bi]) bi = i;
    return bi;
  }
  function colorSet(color) {
    var s = {};
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      var cd = grid[r][c];
      if (cd && cd.color === color) s[key(r, c)] = 1;
    }
    return s;
  }

  /* Expand a base clear set through special detonations.
     created: { key: 'sh'|'sv'|'bomb' } — freshly baked specials, never cleared
     and never detonated in this round. Returns final set of keys to clear. */
  function expandClear(base, created) {
    var cleared = {}, queue = [];
    Object.keys(base).forEach(function (k) { k = +k; if (!created[k]) { cleared[k] = 1; queue.push(k); } });
    var guard = 0;
    while (queue.length && guard++ < 4096) {
      var k = queue.pop(), rc = unkey(k), cd = grid[rc[0]][rc[1]];
      if (!cd || !cd.special || created[k]) continue;
      var effect = {};
      var r0 = rc[0], c0 = rc[1];
      if (cd.special === "sh") { for (var c = 0; c < N; c++) effect[key(r0, c)] = 1; }
      else if (cd.special === "sv") { for (var r = 0; r < N; r++) effect[key(r, c0)] = 1; }
      else if (cd.special === "bomb") effect = colorSet(majorityColor());
      Object.keys(effect).forEach(function (ek) {
        ek = +ek;
        if (cleared[ek] || created[ek] || !grid[unkey(ek)[0]][unkey(ek)[1]]) return;
        cleared[ek] = 1;
        queue.push(ek);
      });
    }
    return cleared;
  }

  // Remove cleared candies, bake created specials, then gravity + refill.
  async function clearAndFall(cleared, created, chain) {
    var count = 0;
    Object.keys(cleared).forEach(function (k) {
      var rc = unkey(+k), cd = grid[rc[0]][rc[1]];
      if (!cd) return;
      count++;
      cd.el.classList.add("is-clearing");
      cd.el.classList.remove("is-sel", "is-hint");
      grid[rc[0]][rc[1]] = null;
    });
    Object.keys(created).forEach(function (k) {
      var rc = unkey(+k), cd = grid[rc[0]][rc[1]];
      if (cd) { cd.special = created[k]; refreshEl(cd); }
    });
    var gained = count * 60 * chain;
    score += gained;
    if (count) showScorePop(gained, chain);
    updateBar();
    if (count) {
      await sleep(T_POP);
      Object.keys(cleared).forEach(function (k) {
        var el = boardEl.querySelector('.cd[data-rc="' + k + '"].is-clearing');
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      gravity();
      await sleep(T_FALL);
    }
  }
  function showScorePop(gained, chain) {
    if (chain < 2 && gained < 600) return;
    var pop = document.createElement("div");
    pop.className = "cd-pop";
    pop.textContent = (chain >= 2 ? "chain x" + chain + "!  +" : "+") + gained;
    pop.style.left = (boardEl.clientWidth / 2 - 60) + "px";
    pop.style.top = (boardEl.clientHeight * 0.3) + "px";
    pop.style.width = "120px";
    pop.style.textAlign = "center";
    pop.style.fontSize = Math.round(tile * 0.4) + "px";
    boardEl.appendChild(pop);
    setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 750);
    if (chain >= 3) {
      boardEl.classList.add("is-shake");
      setTimeout(function () { boardEl.classList.remove("is-shake"); }, 350);
    }
  }

  // Collapse each column downwards, spawn fresh candies above.
  function gravity() {
    for (var c = 0; c < N; c++) {
      var stack = [];
      for (var r = N - 1; r >= 0; r--) {
        if (grid[r][c]) stack.push(grid[r][c]);
        else grid[r][c] = null;
      }
      var fill = 0;
      for (r = N - 1; r >= 0; r--, fill++) {
        var cd;
        if (fill < stack.length) {
          cd = stack[fill];
          grid[r][c] = cd;
          place(cd.el, r, c);
          cd.el.dataset.rc = key(r, c);
        } else {
          // Spawn above the edge (position committed by reflow), then move in
          // immediately — the CSS transition renders the fall.
          cd = makeCandy(r, c, (Math.random() * COLORS) | 0, null, -(fill - stack.length + 1));
          cd.el.dataset.rc = key(r, c);
          grid[r][c] = cd;
          place(cd.el, r, c);
        }
      }
    }
  }

  // ---------- Resolution pipeline ----------
  async function resolveFrom(initialCleared) {
    var chain = 0;
    // Detonate any specials caught in the initial blast too.
    if (initialCleared) await clearAndFall(expandClear(initialCleared, {}), {}, ++chain);
    var runs = findRuns(), guard = 0;
    while (runs.length && guard++ < 60) {
      var base = {}, created = {};
      // Runs are sorted long-first so the juiciest special claims its cell.
      runs.sort(function (a, b) { return b.len - a.len; });
      runs.forEach(function (run) {
        run.cells.forEach(function (k) { base[k] = 1; });
        if (run.len >= 5) created[creationCell(run)] = "bomb";
        else if (run.len === 4) created[creationCell(run)] = run.dir === "h" ? "sh" : "sv";
      });
      var cleared = expandClear(base, created);
      await clearAndFall(cleared, created, ++chain);
      runs = findRuns();
    }
    if (!hasMovesLeft()) {
      showToast("No moves left — reshuffling!");
      await sleep(500);
      shuffleBoard();
    }
    saveGame();
  }
  // Prefer the player's swap cell as the special's home; otherwise the middle.
  function creationCell(run) {
    if (lastSwapCells.indexOf(run.cells[0]) >= 0) return run.cells[0];
    for (var i = 1; i < run.cells.length; i++) if (lastSwapCells.indexOf(run.cells[i]) >= 0) return run.cells[i];
    return run.cells[Math.floor(run.cells.length / 2)];
  }
  var lastSwapCells = [];

  function hasMovesLeft() {
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      var cd = grid[r][c];
      if (cd && cd.special === "bomb") return true;
    }
    var pairs = [];
    for (r = 0; r < N; r++) for (c = 0; c < N; c++) {
      if (c + 1 < N) pairs.push([[r, c], [r, c + 1]]);
      if (r + 1 < N) pairs.push([[r, c], [r + 1, c]]);
    }
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i][0], b = pairs[i][1];
      var ta = grid[a[0]][a[1]], tb = grid[b[0]][b[1]];
      grid[a[0]][a[1]] = tb; grid[b[0]][b[1]] = ta;
      var ok = hasRuns();
      grid[a[0]][a[1]] = ta; grid[b[0]][b[1]] = tb;
      if (ok) return true;
    }
    return false;
  }

  function shuffleBoard() {
    var tries = 0;
    do {
      for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
        var cd = grid[r][c];
        if (!cd) continue;
        // Break accidental 3-runs while dealing, keep special status.
        var color;
        var guard = 0;
        do {
          color = (Math.random() * COLORS) | 0;
          guard++;
        } while (guard < 30 && ((c >= 2 && grid[r][c - 1] && grid[r][c - 2] && grid[r][c - 1].color === color && grid[r][c - 2].color === color) ||
                                (r >= 2 && grid[r - 1][c] && grid[r - 2][c] && grid[r - 1][c].color === color && grid[r - 2][c].color === color)));
        setCandyColor(cd, color, cd.special);
      }
      tries++;
    } while ((hasRuns() || !hasMovesLeft()) && tries < 40);
  }

  // ---------- Swapping ----------
  async function trySwap(a, b) {
    if (locked || !inBounds(a.r, a.c) || !inBounds(b.r, b.c)) return;
    if (Math.abs(a.r - b.r) + Math.abs(a.c - b.c) !== 1) return;
    var ca = grid[a.r][a.c], cb = grid[b.r][b.c];
    if (!ca || !cb) return;

    locked = true;
    clearSel();
    // Exchange in the model + animate.
    grid[a.r][a.c] = cb; grid[b.r][b.c] = ca;
    ca.el.dataset.rc = key(b.r, b.c);
    cb.el.dataset.rc = key(a.r, a.c);
    place(ca.el, b.r, b.c);
    place(cb.el, a.r, a.c);
    await sleep(T_SWAP);

    var initial = null;
    lastSwapCells = [key(a.r, a.c), key(b.r, b.c)];

    if (ca.special === "bomb" || cb.special === "bomb") {
      moves++;
      if (ca.special === "bomb" && cb.special === "bomb") {
        initial = allCellsSet();
      } else {
        // bomb ends up where the *other* candy started (grid already swapped)
        var bombAt = ca.special === "bomb" ? { r: b.r, c: b.c } : { r: a.r, c: a.c };
        var victim = ca.special === "bomb" ? cb : ca;
        initial = colorSet(victim.color);
        initial[key(bombAt.r, bombAt.c)] = 1;
      }
      boardEl.classList.add("is-shake");
      setTimeout(function () { boardEl.classList.remove("is-shake"); }, 350);
    } else if (hasRuns()) {
      moves++;
    } else {
      // Illegal: snap back.
      grid[a.r][a.c] = ca; grid[b.r][b.c] = cb;
      ca.el.dataset.rc = key(a.r, a.c);
      cb.el.dataset.rc = key(b.r, b.c);
      place(ca.el, a.r, a.c);
      place(cb.el, b.r, b.c);
      await sleep(T_SWAP);
      locked = false;
      return;
    }
    await resolveFrom(initial);
    updateBar();
    saveGame();
    locked = false;
  }

  // ---------- Board lifecycle ----------
  function freshBoard() {
    boardEl.querySelectorAll(".cd, .cd-pop").forEach(function (el) { el.parentNode.removeChild(el); });
    grid = [];
    for (var r = 0; r < N; r++) {
      grid.push([]);
      for (var c = 0; c < N; c++) {
        var color;
        do { color = (Math.random() * COLORS) | 0; }
        while ((c >= 2 && grid[r][c - 1].color === color && grid[r][c - 2].color === color) ||
               (r >= 2 && grid[r - 1][c].color === color && grid[r - 2][c].color === color));
        grid[r].push(makeCandy(r, c, color, null));
      }
    }
    if (!hasMovesLeft()) shuffleBoard();
    layout();
  }
  function newGame() {
    score = 0; moves = 0;
    locked = true;
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    clearSel();
    freshBoard();
    updateBar();
    saveGame();
    locked = false;
  }

  function updateBar() {
    scoreEl.textContent = String(score);
    movesEl.textContent = String(moves);
    if (score > best) { best = score; saveStats(); }
    bestEl.textContent = String(best);
  }

  // ---------- Persistence ----------
  var SPEC_CODE = { null: 0, sh: 1, sv: 2, bomb: 3 };
  var CODE_SPEC = ["", "sh", "sv", "bomb"];
  function saveGame() {
    // Only ever store genuinely stable boards: fully populated and nothing
    // left matching. (Mid-cascade grids have holes, so they are skipped.)
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) if (!grid[r][c]) return;
    if (hasRuns()) return;
    try {
      var cellsData = [];
      for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
        var cd = grid[r][c];
        cellsData.push(cd ? [cd.color, SPEC_CODE[String(cd.special)] || 0] : [0, 0]);
      }
      localStorage.setItem(SAVE_KEY, JSON.stringify({ score: score, moves: moves, cells: cellsData }));
    } catch (e) {}
  }
  function loadGame() {
    var s;
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return false; }
    if (!s || !Array.isArray(s.cells) || s.cells.length !== N * N) return false;
    boardEl.querySelectorAll(".cd, .cd-pop").forEach(function (el) { el.parentNode.removeChild(el); });
    grid = [];
    for (var r = 0; r < N; r++) {
      grid.push([]);
      for (var c = 0; c < N; c++) {
        var cell = s.cells[r * N + c];
        var color = cell[0] | 0, spec = CODE_SPEC[cell[1] & 3] || null;
        if (color < 0 || color >= COLORS) { grid[r].push(null); continue; }
        grid[r].push(makeCandy(r, c, color, spec));
      }
      // Reject broken saves (holes)
      for (var cc = 0; cc < N; cc++) if (!grid[r][cc]) return false;
    }
    score = s.score | 0;
    moves = s.moves | 0;
    // A stored board must be stable and playable; otherwise deal a fresh one.
    if (hasRuns() || !hasMovesLeft()) return false;
    layout();
    updateBar();
    return true;
  }

  // ---------- Toast ----------
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastId) clearTimeout(toastId);
    toastId = setTimeout(function () { toastEl.hidden = true; toastId = null; }, 1800);
  }

  // ---------- Input ----------
  function clearSel() {
    if (sel && grid[sel.r] && grid[sel.r][sel.c] && grid[sel.r][sel.c].el) grid[sel.r][sel.c].el.classList.remove("is-sel");
    sel = null;
  }
  function cellFromEvent(e) {
    var el = e.target.closest && e.target.closest(".cd");
    if (!el) return null;
    var k = +el.dataset.rc;
    var rc = unkey(k);
    return { r: rc[0], c: rc[1] };
  }
  boardEl.addEventListener("pointerdown", function (e) {
    if (locked) return;
    var cell = cellFromEvent(e);
    if (!cell) return;
    e.preventDefault();
    pressed = { r: cell.r, c: cell.c, x: e.clientX, y: e.clientY };
    if (sel && Math.abs(sel.r - cell.r) + Math.abs(sel.c - cell.c) === 1) {
      var from = sel; clearSel();
      trySwap(from, cell);
      pressed = null;
      return;
    }
    clearSel();
    if (grid[cell.r][cell.c]) {
      sel = cell;
      grid[cell.r][cell.c].el.classList.add("is-sel");
    }
  });
  boardEl.addEventListener("pointermove", function (e) {
    if (!pressed || locked) return;
    var dx = e.clientX - pressed.x, dy = e.clientY - pressed.y;
    var threshold = Math.max(10, tile * 0.4);
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
    var dir = Math.abs(dx) > Math.abs(dy)
      ? { r: 0, c: dx > 0 ? 1 : -1 }
      : { r: dy > 0 ? 1 : -1, c: 0 };
    var origin = { r: pressed.r, c: pressed.c };
    var target = { r: pressed.r + dir.r, c: pressed.c + dir.c };
    pressed = null;
    clearSel();
    if (inBounds(target.r, target.c)) trySwap(origin, target);
  });
  window.addEventListener("pointerup", function () { pressed = null; });
  window.addEventListener("pointercancel", function () { pressed = null; });

  // ---------- Rules modal ----------
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  document.addEventListener("keydown", function (e) {
    if (rulesModal && !rulesModal.hidden) {
      if (e.key === "Escape") closeRules();
      return;
    }
    var k = (e.key || "").toLowerCase();
    if (k === "n") newGame();
    else if (k === "r") openRules();
  });
  newBtn.addEventListener("click", newGame);
  window.addEventListener("resize", layout);

  // ---------- Boot ----------
  var st = loadStats();
  best = st.best | 0;
  makeCells();
  if (!loadGame()) { freshBoard(); saveGame(); }
  updateBar();
})();
