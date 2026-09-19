/* ===== Slide Puzzle (15-puzzle family) — game logic =====
   Single-file, dependency-free. Slide tiles through the one empty gap
   until every number reads in order.
   - 3x3 / 4x4 / 5x5 boards; shuffles walk backwards from the solved
     state, so every deal is guaranteed solvable.
   - Tiles in their final spot glow green; move counter + timer.
   - In-progress board persisted in localStorage (gc-slide-save), best
     time/moves per size in gc-slide-stats. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const SAVE_KEY = "gc-slide-save";
  const STATS_KEY = "gc-slide-stats";
  const GAP = 10;   // px between tiles; keep in sync with --gap styling
  const PAD = 10;   // board inner padding; keep in sync with .sl-board padding

  // ---------- DOM refs ----------
  const boardEl = document.getElementById("board");
  const movesEl = document.getElementById("moves");
  const timerEl = document.getElementById("timer");
  const bestEl = document.getElementById("best");
  const undoBtn = document.getElementById("undoBtn");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const winOverlay = document.getElementById("winOverlay");
  const winStats = document.getElementById("winStats");
  const winNew = document.getElementById("winNew");
  const segBtns = Array.prototype.slice.call(document.querySelectorAll(".c-seg__b"));

  // ---------- Game state ----------
  let n = 4;            // board is n x n
  let tiles = [];       // length n*n; value 0 marks the empty gap
  let empty = 0;        // index of the empty slot
  let moves = 0;
  let seconds = 0;
  let timerId = null;
  let won = false;
  let history = [];     // [from, to] index pairs of each slide (for undo)
  let tileEls = {};     // tile value -> DOM element

  // ---------- Helpers ----------
  function fmt(s) {
    const m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
  }
  function rowOf(i) { return Math.floor(i / n); }
  function colOf(i) { return i % n; }
  function isNeighbor(a, b) {
    return Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b)) === 1;
  }
  function neighborsOfEmpty() {
    const out = [], r = rowOf(empty), c = colOf(empty);
    if (r > 0) out.push(empty - n);
    if (r < n - 1) out.push(empty + n);
    if (c > 0) out.push(empty - 1);
    if (c < n - 1) out.push(empty + 1);
    return out;
  }
  function isSolved() {
    for (let i = 0; i < n * n - 1; i++) if (tiles[i] !== i + 1) return false;
    return tiles[n * n - 1] === 0;
  }

  // ---------- Shuffle: random legal slides away from the solved board ----------
  function shuffleBoard() {
    tiles = [];
    for (let v = 1; v < n * n; v++) tiles.push(v);
    tiles.push(0);
    empty = n * n - 1;
    let last = -1;                       // don't instantly undo the previous slide
    const steps = n * n * 80;
    for (let s = 0; s < steps; s++) {
      const opts = neighborsOfEmpty().filter(function (i) { return i !== last; });
      const pick = opts[Math.floor(Math.random() * opts.length)];
      last = empty;
      tiles[empty] = tiles[pick];
      tiles[pick] = 0;
      empty = pick;
    }
    // Astronomically unlikely, but never hand out an already-solved board.
    if (isSolved()) return shuffleBoard();
    history = [];
  }

  // ---------- Stats (best time / moves per board size) ----------
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function statsFor(size) {
    const all = loadStats();
    return all[size] || { wins: 0, bestTime: null, bestMoves: null };
  }
  function saveWin(size) {
    const all = loadStats();
    const st = all[size] || { wins: 0, bestTime: null, bestMoves: null };
    st.wins = (st.wins || 0) + 1;
    if (st.bestTime == null || seconds < st.bestTime) st.bestTime = seconds;
    if (st.bestMoves == null || moves < st.bestMoves) st.bestMoves = moves;
    all[size] = st;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(all)); } catch (e) {}
    return st;
  }
  function showBest() {
    const st = statsFor(n);
    bestEl.textContent = st.bestTime != null ? fmt(st.bestTime) : "\u2014";
    bestEl.title = st.bestMoves != null
      ? "best: " + fmt(st.bestTime) + " in " + st.bestMoves + " moves, " + st.wins + (st.wins === 1 ? " win" : " wins")
      : "no solve yet on this size";
  }

  // ---------- Persistence ----------
  function saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        n: n, moves: moves, seconds: seconds, tiles: tiles
      }));
    } catch (e) {}
  }
  function loadGame() {
    let s;
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return false; }
    if (!s || s.n !== 3 && s.n !== 4 && s.n !== 5) return false;
    if (!Array.isArray(s.tiles) || s.tiles.length !== s.n * s.n) return false;
    // Must be a permutation of 0..n*n-1.
    const seen = {};
    for (let i = 0; i < s.tiles.length; i++) {
      const v = s.tiles[i];
      if (typeof v !== "number" || v < 0 || v >= s.tiles.length || seen[v]) return false;
      seen[v] = true;
    }
    n = s.n;
    tiles = s.tiles.slice();
    moves = s.moves | 0;
    seconds = s.seconds | 0;
    won = false;
    if (isSolved()) return false;        // finished board — shuffle a fresh one
    empty = tiles.indexOf(0);
    markSeg();
    timerEl.textContent = fmt(seconds);
    rebuild();
    render();
    showBest();
    if (moves > 0) startTimer();         // resume the clock on a game in progress
    return true;
  }

  // ---------- Timer ----------
  function startTimer() {
    if (timerId) return;
    timerId = setInterval(function () {
      seconds++;
      timerEl.textContent = fmt(seconds);
      saveGame(); // keep the saved clock fresh even without moves
    }, 1000);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  // ---------- Rendering ----------
  function rebuild() {
    boardEl.innerHTML = "";
    boardEl.classList.remove("is-win");
    tileEls = {};
    for (let v = 1; v < n * n; v++) {
      const el = document.createElement("div");
      el.className = "sl-tile";
      el.dataset.v = String(v);
      el.textContent = String(v);
      boardEl.appendChild(el);
      tileEls[v] = el;
    }
    layout();
  }
  // Measure the board in px and place every tile (JS math, not CSS calc,
  // so tile sizing never depends on division by a custom property).
  function layout() {
    if (!boardEl.clientWidth) return;
    const size = boardEl.clientWidth - PAD * 2;
    const cw = (size - (n - 1) * GAP) / n;
    for (let i = 0; i < tiles.length; i++) {
      const v = tiles[i];
      if (!v) continue;
      const el = tileEls[v];
      el.style.width = el.style.height = cw + "px";
      el.style.left = PAD + colOf(i) * (cw + GAP) + "px";
      el.style.top = PAD + rowOf(i) * (cw + GAP) + "px";
      el.style.fontSize = Math.round(cw * 0.38) + "px";
      el.classList.toggle("is-correct", v === i + 1);
    }
  }
  function render() {
    layout();
    movesEl.textContent = String(moves);
    undoBtn.disabled = history.length === 0 || won;
    if (!won) saveGame(); // onWin() removes the save — don't re-write it
  }

  // ---------- Moves ----------
  function moveTile(i) {
    if (won || !isNeighbor(i, empty)) return;
    history.push([i, empty]); // remember both ends; after the move empty === i
    if (history.length > 1000) history.shift();
    tiles[empty] = tiles[i];
    tiles[i] = 0;
    empty = i;
    moves++;
    startTimer();
    render();
    if (isSolved()) onWin();
  }
  function undo() {
    if (!history.length || won) return;
    const pair = history.pop();
    const from = pair[0], to = pair[1]; // tile slid from -> to; gap now sits at from
    tiles[from] = tiles[to];
    tiles[to] = 0;
    empty = to;
    moves = Math.max(0, moves - 1);
    render();
  }
  function onWin() {
    won = true;
    stopTimer();
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {} // nothing to resume
    boardEl.classList.add("is-win");
    const st = saveWin(n);
    winStats.textContent =
      n + "\u00d7" + n + " solved in " + fmt(seconds) + " with " + moves + " moves" +
      " \u00b7 best " + (st.bestTime != null ? fmt(st.bestTime) : fmt(seconds)) +
      " (" + st.wins + (st.wins === 1 ? " win)" : " wins)");
    winOverlay.hidden = false;
    showBest();
    render();
  }

  // ---------- New game / difficulty ----------
  function newGame() {
    stopTimer();
    won = false;
    moves = 0; seconds = 0;
    winOverlay.hidden = true;
    timerEl.textContent = "00:00";
    shuffleBoard();
    rebuild();
    render();
    showBest();
  }
  function markSeg() {
    segBtns.forEach(function (b) {
      const on = +b.dataset.n === n;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  function setSize(next) {
    if (next === n) return;
    n = next;
    markSeg();
    newGame();
  }

  // ---------- Rules modal ----------
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  function rulesOpen() { return rulesModal && !rulesModal.hidden; }

  // ---------- Wire up ----------
  boardEl.addEventListener("click", function (e) {
    const el = e.target.closest && e.target.closest(".sl-tile");
    if (!el) return;
    const v = +el.dataset.v;
    const i = tiles.indexOf(v);
    if (i >= 0) moveTile(i);
  });
  undoBtn.addEventListener("click", undo);
  newBtn.addEventListener("click", newGame);
  winNew.addEventListener("click", newGame);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  segBtns.forEach(function (b) { b.addEventListener("click", function () { setSize(+b.dataset.n); }); });
  window.addEventListener("resize", layout);
  document.addEventListener("keydown", function (e) {
    if (rulesOpen()) {
      if (e.key === "Escape") closeRules();
      return;
    }
    // Arrows slide a tile into the gap from that direction.
    let src = -1;
    if (e.key === "ArrowLeft" && colOf(empty) < n - 1) src = empty + 1;
    else if (e.key === "ArrowRight" && colOf(empty) > 0) src = empty - 1;
    else if (e.key === "ArrowUp" && rowOf(empty) < n - 1) src = empty + n;
    else if (e.key === "ArrowDown" && rowOf(empty) > 0) src = empty - n;
    if (src >= 0) { e.preventDefault(); moveTile(src); return; }
    const k = e.key.toLowerCase();
    if (k === "n") newGame();
    else if (k === "u") undo();
    else if (k === "r") openRules();
  });

  // ---------- Boot ----------
  if (!loadGame()) newGame();
})();
