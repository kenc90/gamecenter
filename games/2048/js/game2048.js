/* ===== 2048 — game logic =====
   Tiles are rendered as absolutely-positioned nodes keyed by a stable id, so
   moving just updates each node's CSS transform -> the .12s transition slides
   them. Merged-away tiles are kept for one animation frame (the "dying" list)
   so you see them glide into the survivor, then removed. */
(function () {
  "use strict";

  const SIZE = 4;
  const BEST_KEY = "gc-2048-best";
  const SAVE_KEY = "gc-2048-save";
  const VECTORS = { up: { dr: -1, dc: 0 }, down: { dr: 1, dc: 0 }, left: { dr: 0, dc: -1 }, right: { dr: 0, dc: 1 } };

  // ---------- DOM ----------
  const boardEl = document.getElementById("board");
  const gridEl = document.getElementById("grid");
  const tilesEl = document.getElementById("tiles");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const scoreBox = scoreEl.parentElement;
  const newBtn = document.getElementById("newGame");
  const undoBtn = document.getElementById("undo");
  const overlay = document.getElementById("overlay");
  const overlayMsg = document.getElementById("overlayMsg");
  const overNew = document.getElementById("overNew");
  const keepBtn = document.getElementById("keepGoing");

  // Build the 16 background cells once.
  for (let i = 0; i < SIZE * SIZE; i++) {
    const c = document.createElement("div");
    c.className = "grid__cell";
    gridEl.appendChild(c);
  }

  // ---------- State ----------
  let grid, all, dying, score, best, won, keepPlaying, idSeq, prev;

  function emptyGrid() {
    const g = [];
    for (let r = 0; r < SIZE; r++) { g.push([]); for (let c = 0; c < SIZE; c++) g[r].push(null); }
    return g;
  }
  const inb = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

  function newGame() {
    grid = emptyGrid(); all = []; dying = [];
    score = 0; won = false; keepPlaying = false; idSeq = 1; prev = null;
    overlay.hidden = true;
    addRandom(); addRandom();
    render(); save();
  }

  function cellsList() {
    const out = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!grid[r][c]) out.push({ r, c });
    return out;
  }
  function addRandom() {
    const spots = cellsList();
    if (!spots.length) return;
    const s = spots[Math.floor(Math.random() * spots.length)];
    const tile = { id: idSeq++, value: Math.random() < 0.9 ? 2 : 4, r: s.r, c: s.c, isNew: true, pop: false };
    grid[s.r][s.c] = tile; all.push(tile);
  }

  function snapshot() {
    return {
      tiles: all.map((t) => ({ id: t.id, value: t.value, r: t.r, c: t.c })),
      score, won, keepPlaying, idSeq,
    };
  }
  function restore(s) {
    grid = emptyGrid();
    all = s.tiles.map((t) => { const o = { id: t.id, value: t.value, r: t.r, c: t.c, isNew: false, pop: false }; grid[t.r][t.c] = o; return o; });
    dying = []; score = s.score; won = s.won; keepPlaying = s.keepPlaying; idSeq = s.idSeq;
  }
  function undo() {
    if (!prev) return;
    restore(prev); prev = null;
    overlay.hidden = true;
    renderAll(); updateScore(); save();
  }

  // ---------- Move ----------
  function traversals(v) {
    const xs = [0, 1, 2, 3], ys = [0, 1, 2, 3];
    if (v.dr === 1) ys.reverse();
    if (v.dc === 1) xs.reverse();
    return { xs, ys };
  }
  function withinBoundsFree(tile, v) {
    // Walk from tile in direction v to the farthest empty cell + the cell after it.
    let r = tile.r, c = tile.c, nr, nc;
    do { nr = r + v.dr; nc = c + v.dc; r = nr; c = nc; }
    while (inb(nr, nc) && !grid[nr][nc]);
    // r,c now is first non-empty or out of bounds
    if (inb(r, c)) return { farthest: { r: r - v.dr, c: c - v.dc }, next: grid[r][c] };
    return { farthest: { r: r - v.dr, c: c - v.dc }, next: null };
  }

  function move(dir) {
    if (overlayOpen()) return;
    const v = VECTORS[dir];
    const t = traversals(v);
    let moved = false, gain = 0;

    // Reset per-move flags.
    all.forEach((tile) => { tile.isNew = false; tile.pop = false; });
    dying = [];
    const snapshotPrev = snapshot();

    for (const c of t.xs) {
      for (const r of t.ys) {
        const tile = grid[r][c];
        if (!tile) continue;
        const { farthest, next } = withinBoundsFree(tile, v);
        if (next && next.value === tile.value && !next.pop) {
          // Merge tile into next.
          grid[tile.r][tile.c] = null;
          next.value *= 2; next.pop = true;
          gain += next.value;
          if (next.value === 2048 && !won) won = true;
          tile.r = next.r; tile.c = next.c; // slide absorbed tile onto survivor
          dying.push(tile);
          // remove from active list
          const idx = all.indexOf(tile); if (idx >= 0) all.splice(idx, 1);
          moved = true;
        } else if (farthest.r !== tile.r || farthest.c !== tile.c) {
          grid[tile.r][tile.c] = null;
          grid[farthest.r][farthest.c] = tile;
          tile.r = farthest.r; tile.c = farthest.c;
          moved = true;
        }
      }
    }

    if (!moved) return;
    prev = snapshotPrev;
    score += gain;
    addRandom();
    if (gain > 0) flashScore();
    updateScore();
    renderAll();

    setTimeout(() => {
      // Drop absorbed tiles once their slide finishes.
      dying.forEach((tile) => { const node = nodeById(tile.id); if (node) node.remove(); });
      dying = [];
    }, 140);

    save();
    if (won && !keepPlaying) showOverlay("You made 2048! 🎉", true);
    else if (isGameOver()) showOverlay("Game over", false);
  }

  function isGameOver() {
    if (cellsList().length) return false;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const val = grid[r][c].value;
      if ((inb(r + 1, c) && grid[r + 1][c].value === val) || (inb(r, c + 1) && grid[r][c + 1].value === val)) return false;
    }
    return true;
  }
  function overlayOpen() { return !overlay.hidden; }
  function showOverlay(msg, canKeep) {
    overlayMsg.textContent = msg;
    keepBtn.hidden = !(canKeep && !keepPlaying);
    overlay.hidden = false;
  }

  // ---------- Rendering ----------
  function geom() {
    const cs = getComputedStyle(boardEl);
    const cell = parseFloat(cs.getPropertyValue("--cell")) || 96;
    const gap = parseFloat(cs.getPropertyValue("--gap")) || 12;
    return { cell, gap };
  }
  function posOf(tile, g) {
    const x = g.gap + tile.c * (g.cell + g.gap);
    const y = g.gap + tile.r * (g.cell + g.gap);
    return "translate(" + x + "px," + y + "px)";
  }
  function nodeById(id) { return tilesEl.querySelector('[data-id="' + id + '"]'); }
  function valueClass(v) { return v <= 2048 && (v & (v - 1)) === 0 ? "tile--" + v : "tile--super"; }

  function renderAll() {
    const g = geom();
    const present = new Set();
    all.concat(dying).forEach((tile) => {
      present.add(tile.id);
      let node = nodeById(tile.id);
      if (!node) { node = document.createElement("div"); node.className = "tile"; node.dataset.id = tile.id; tilesEl.appendChild(node); }
      if (node.textContent !== String(tile.value)) node.textContent = tile.value;
      node.style.setProperty("--pos", posOf(tile, g));
      node.className = "tile " + valueClass(tile.value) + (tile.isNew ? " tile--new" : tile.pop ? " tile--pop" : "");
    });
    // Remove any stray nodes.
    Array.prototype.slice.call(tilesEl.children).forEach((node) => {
      if (!present.has(+node.dataset.id)) node.remove();
    });
  }

  function updateScore() {
    scoreEl.textContent = score;
    if (score > best) { best = score; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
    bestEl.textContent = best;
    undoBtn.disabled = !prev;
  }
  function flashScore() { scoreBox.classList.add("score--flash"); setTimeout(() => scoreBox.classList.remove("score--flash"), 300); }

  // ---------- Persistence ----------
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        tiles: all.map((t) => ({ id: t.id, value: t.value, r: t.r, c: t.c })),
        score, won, keepPlaying, idSeq,
      }));
    } catch (e) {}
  }
  function load() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return false; }
    if (!o || !Array.isArray(o.tiles)) return false;
    restore({ tiles: o.tiles, score: o.score | 0, won: !!o.won, keepPlaying: !!o.keepPlaying, idSeq: o.idSeq | 0 });
    dying = []; prev = null;
    renderAll(); updateScore();
    if (won && !keepPlaying) showOverlay("You made 2048! 🎉", true);
    else if (isGameOver()) showOverlay("Game over", false);
    return true;
  }

  // ---------- Input ----------
  const KEYMAP = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right",
  };
  document.addEventListener("keydown", (e) => {
    const dir = KEYMAP[e.key];
    if (!dir) return;
    e.preventDefault();
    move(dir);
  });

  // Touch swipe
  let sx = 0, sy = 0, tracking = false;
  boardEl.addEventListener("pointerdown", (e) => { tracking = true; sx = e.clientX; sy = e.clientY; });
  boardEl.addEventListener("pointerup", (e) => {
    if (!tracking) return; tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < 24) return; // too small
    if (ax > ay) move(dx > 0 ? "right" : "left");
    else move(dy > 0 ? "down" : "up");
  });
  boardEl.addEventListener("pointercancel", () => { tracking = false; });

  newBtn.addEventListener("click", newGame);
  overNew.addEventListener("click", newGame);
  undoBtn.addEventListener("click", undo);
  keepBtn.addEventListener("click", () => { keepPlaying = true; overlay.hidden = true; save(); });
  window.addEventListener("resize", renderAll);

  // ---------- Boot ----------
  try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { best = 0; }
  boardEl.focus();
  if (!load()) newGame();
})();
