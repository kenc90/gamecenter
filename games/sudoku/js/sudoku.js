/* ===== Sudoku — game logic =====
   Generates a full valid grid via randomized backtracking, then digs holes
   while keeping the puzzle uniquely solvable (a capped solution-count solver).
   Interaction: click / keyboard entry, peer + same-value highlighting,
   wrong-number mistake counter (3 strikes), limited hints, undo, timer and
   full autosave/resume in localStorage. */
(function () {
  "use strict";

  const SAVE_KEY = "gc-sudoku-save";
  const DIFF = {
    easy: { clues: 45, label: "Easy" },
    medium: { clues: 34, label: "Medium" },
    hard: { clues: 28, label: "Hard" },
  };
  const MAX_MISTAKES = 3;
  const MAX_HINTS = 3;

  // ---------- DOM ----------
  const boardEl = document.getElementById("board");
  const padEl = document.getElementById("pad");
  const timerEl = document.getElementById("timer");
  const mistakesEl = document.getElementById("mistakes");
  const diffLabelEl = document.getElementById("diffLabel");
  const eraseBtn = document.getElementById("eraseBtn");
  const hintBtn = document.getElementById("hintBtn");
  const undoBtn = document.getElementById("undoBtn");
  const newBtn = document.getElementById("newBtn");
  const overlay = document.getElementById("overlay");
  const overTitle = document.getElementById("overTitle");
  const overMsg = document.getElementById("overMsg");
  const overNew = document.getElementById("overNew");
  const diffBtns = {
    easy: document.getElementById("diffEasy"),
    medium: document.getElementById("diffMedium"),
    hard: document.getElementById("diffHard"),
  };

  // ---------- Precomputed neighbours ----------
  const rowOf = (i) => (i / 9) | 0;
  const colOf = (i) => i % 9;
  const boxOf = (i) => ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);
  const PEERS = [];
  (function buildPeers() {
    for (let i = 0; i < 81; i++) {
      const set = new Set();
      const r = rowOf(i), c = colOf(i);
      for (let k = 0; k < 9; k++) { set.add(r * 9 + k); set.add(k * 9 + c); }
      const br = ((r / 3) | 0) * 3, bc = ((c / 3) | 0) * 3;
      for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 3; cc++) set.add((br + rr) * 9 + (bc + cc));
      set.delete(i);
      PEERS.push(Array.from(set));
    }
  })();

  // ---------- State ----------
  let solution, givens, values, selected, difficulty = "medium";
  let mistakes, hintsLeft, seconds, timerId, undoStack, over, started;
  let cells = [];

  // ---------- Generation ----------
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function canPlace(arr, i, v) {
    const peers = PEERS[i];
    for (let k = 0; k < peers.length; k++) if (arr[peers[k]] === v) return false;
    return true;
  }
  function fillGrid(arr, i) {
    if (i === 81) return true;
    if (arr[i] !== 0) return fillGrid(arr, i + 1);
    const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const v of nums) {
      if (canPlace(arr, i, v)) { arr[i] = v; if (fillGrid(arr, i + 1)) return true; arr[i] = 0; }
    }
    return false;
  }
  // Count solutions up to `limit` (used to guarantee uniqueness). MRV heuristic.
  function countSolutions(arr, limit) {
    let best = -1, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (arr[i]) continue;
      let cnt = 0;
      for (let v = 1; v <= 9; v++) if (canPlace(arr, i, v)) cnt++;
      if (cnt === 0) return 0;
      if (cnt < bestCount) { bestCount = cnt; best = i; }
      if (cnt === 1) break;
    }
    if (best === -1) return 1; // solved
    let total = 0;
    for (let v = 1; v <= 9; v++) {
      if (canPlace(arr, best, v)) {
        arr[best] = v;
        total += countSolutions(arr, limit - total);
        arr[best] = 0;
        if (total >= limit) break;
      }
    }
    return total;
  }
  function generate(targetClues) {
    const full = new Array(81).fill(0);
    fillGrid(full, 0);
    solution = full.slice();
    const puzzle = full.slice();
    let clues = 81;
    const order = shuffle(Array.from({ length: 81 }, (_, i) => i));
    for (const i of order) {
      if (clues <= targetClues) break;
      const backup = puzzle[i];
      puzzle[i] = 0;
      const test = puzzle.slice();
      if (countSolutions(test, 2) !== 1) puzzle[i] = backup; // removing breaks uniqueness
      else clues--;
    }
    return puzzle;
  }

  // ---------- New game ----------
  function newGame(diff) {
    difficulty = diff || difficulty;
    const puzzle = generate(DIFF[difficulty].clues);
    givens = puzzle.map((v) => v !== 0);
    values = puzzle.slice();
    selected = -1; mistakes = 0; hintsLeft = MAX_HINTS; seconds = 0; over = false;
    undoStack = []; started = false;
    stopTimer();
    overlay.hidden = true;
    buildCells();
    syncDiff();
    refresh();
    save();
  }

  function buildCells() {
    if (cells.length) return;
    for (let i = 0; i < 81; i++) {
      const b = document.createElement("button");
      b.className = "cell";
      b.type = "button";
      b.dataset.i = String(i);
      b.dataset.r = String(rowOf(i));
      b.dataset.c = String(colOf(i));
      b.setAttribute("role", "gridcell");
      boardEl.appendChild(b);
      cells.push(b);
    }
  }

  function isError(i) {
    const v = values[i];
    return v !== 0 && v !== solution[i];
  }

  function refresh() {
    const selVal = selected >= 0 ? values[selected] : 0;
    for (let i = 0; i < 81; i++) {
      const el = cells[i];
      el.textContent = values[i] || "";
      let cls = "cell";
      if (givens[i]) cls += " cell--given";
      if (i === selected) cls += " cell--selected";
      else if (selected >= 0 && (PEERS[selected].indexOf(i) >= 0)) cls += " cell--peer";
      if (selVal && values[i] === selVal && i !== selected) cls += " cell--same";
      if (isError(i)) cls += " cell--error";
      el.className = cls;
    }
    // Counters
    mistakesEl.textContent = mistakes + "/" + MAX_MISTAKES;
    timerEl.textContent = fmt(seconds);
    hintBtn.textContent = "Hint" + (hintsLeft > 0 ? " (" + hintsLeft + ")" : "");
    hintBtn.disabled = hintsLeft <= 0 || over;
    undoBtn.disabled = !undoStack.length || over;
    // Grey out digits already placed 9 times
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 81; i++) counts[values[i]]++;
    padEl.querySelectorAll(".digit").forEach((d) => {
      d.classList.toggle("digit--done", counts[+d.dataset.v] >= 9);
    });
  }

  // ---------- Input ----------
  function select(i) { selected = i; refresh(); }

  function pushUndo() { undoStack.push(values.slice()); if (undoStack.length > 100) undoStack.shift(); }

  function setValue(v) {
    if (over || selected < 0 || givens[selected]) return;
    if (values[selected] === v) return;
    pushUndo();
    values[selected] = v;
    startTimer();
    if (v && v !== solution[selected]) {
      mistakes++;
      cells[selected].classList.add("cell--new");
      setTimeout(() => cells[selected] && cells[selected].classList.remove("cell--new"), 200);
      if (mistakes >= MAX_MISTAKES) { gameOver(false); save(); refresh(); return; }
    }
    if (v && v === solution[selected]) cells[selected].classList.add("cell--new");
    refresh();
    if (isSolved()) gameOver(true);
    save();
  }

  function erase() {
    if (over || selected < 0 || givens[selected]) return;
    if (!values[selected]) return;
    pushUndo();
    values[selected] = 0;
    refresh(); save();
  }

  function hint() {
    if (over || hintsLeft <= 0) return;
    let target = (selected >= 0 && !givens[selected] && values[selected] !== solution[selected]) ? selected : -1;
    if (target < 0) { // nearest empty/wrong cell
      for (let i = 0; i < 81; i++) if (!givens[i] && values[i] !== solution[i]) { target = i; break; }
    }
    if (target < 0) return;
    pushUndo();
    selected = target;
    values[target] = solution[target];
    hintsLeft--;
    startTimer();
    refresh();
    cells[target].classList.add("cell--new");
    if (isSolved()) gameOver(true);
    save();
  }

  function undo() {
    if (over || !undoStack.length) return;
    values = undoStack.pop();
    refresh(); save();
  }

  function isSolved() { for (let i = 0; i < 81; i++) if (values[i] !== solution[i]) return false; return true; }

  function gameOver(win) {
    over = true; stopTimer();
    overTitle.textContent = win ? "Solved! 🎉" : "Out of mistakes";
    overMsg.textContent = win
      ? "Finished in " + fmt(seconds) + " with " + mistakes + " mistake" + (mistakes === 1 ? "" : "s") + "."
      : "Three wrong entries — give it another go.";
    overlay.hidden = false;
    try { if (win) localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  // ---------- Timer ----------
  function startTimer() { if (timerId || over) return; started = true; timerId = setInterval(() => { seconds++; timerEl.textContent = fmt(seconds); }, 1000); }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
  function fmt(s) { const m = (s / 60) | 0, ss = s % 60; return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss; }

  // ---------- Persistence ----------
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        difficulty, solution, values, givens: givens.map(Number),
        mistakes, hintsLeft, seconds, over: over ? 1 : 0, started: started ? 1 : 0,
      }));
    } catch (e) {}
  }
  function load() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return false; }
    if (!o || !Array.isArray(o.values) || o.values.length !== 81 || !Array.isArray(o.solution)) return false;
    solution = o.solution; values = o.values.slice(); givens = o.givens.map(Boolean);
    difficulty = DIFF[o.difficulty] ? o.difficulty : "medium";
    mistakes = o.mistakes | 0; hintsLeft = o.hintsLeft; seconds = o.seconds | 0; over = !!o.over;
    started = !!o.started;
    selected = -1; undoStack = [];
    buildCells(); syncDiff(); refresh();
    if (!over && started && !isSolved()) startTimer();
    if (over) { overlay.hidden = false; }
    return true;
  }

  function syncDiff() {
    diffLabelEl.textContent = DIFF[difficulty].label;
    Object.keys(diffBtns).forEach((k) => diffBtns[k].setAttribute("aria-selected", String(k === difficulty)));
  }

  // ---------- Events ----------
  boardEl.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (cell) select(+cell.dataset.i);
  });
  padEl.addEventListener("click", (e) => {
    const d = e.target.closest(".digit");
    if (d) setValue(+d.dataset.v);
  });
  eraseBtn.addEventListener("click", erase);
  hintBtn.addEventListener("click", hint);
  undoBtn.addEventListener("click", undo);
  newBtn.addEventListener("click", () => newGame(difficulty));
  overNew.addEventListener("click", () => newGame(difficulty));
  Object.keys(diffBtns).forEach((k) => diffBtns[k].addEventListener("click", () => newGame(k)));

  document.addEventListener("keydown", (e) => {
    if (e.key >= "1" && e.key <= "9") { setValue(+e.key); }
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") { erase(); }
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (selected < 0) { select(0); return; }
      let r = rowOf(selected), c = colOf(selected);
      if (e.key === "ArrowUp") r = (r + 8) % 9;
      else if (e.key === "ArrowDown") r = (r + 1) % 9;
      else if (e.key === "ArrowLeft") c = (c + 8) % 9;
      else if (e.key === "ArrowRight") c = (c + 1) % 9;
      select(r * 9 + c);
    }
  });

  // ---------- Boot ----------
  if (!load()) newGame("medium");
})();
