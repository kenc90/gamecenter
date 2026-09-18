/* ===== Tic Tac Toe — game logic ===== */
(function () {
  "use strict";

  const SCORE_KEY = "gc-ttt-score";
  const PREF_KEY = "gc-ttt-pref";
  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
    [0, 4, 8], [2, 4, 6],            // diagonals
  ];
  const HUMAN = "X", AI = "O";

  // ---------- DOM ----------
  const boardEl = document.getElementById("board");
  const cells = Array.prototype.slice.call(boardEl.querySelectorAll(".cell"));
  const statusEl = document.getElementById("status");
  const modePvpBtn = document.getElementById("modePvp");
  const modeAiBtn = document.getElementById("modeAi");
  const diffRow = document.getElementById("diffRow");
  const diffEasyBtn = document.getElementById("diffEasy");
  const diffHardBtn = document.getElementById("diffHard");
  const xScoreEl = document.getElementById("xScore");
  const oScoreEl = document.getElementById("oScore");
  const dScoreEl = document.getElementById("dScore");
  const xLabelEl = document.getElementById("xLabel");
  const oLabelEl = document.getElementById("oLabel");
  const newRoundBtn = document.getElementById("newRound");
  const resetBtn = document.getElementById("resetScores");

  // ---------- State ----------
  let board, current, over, mode = "ai", difficulty = "hard";
  let scores = { x: 0, o: 0, d: 0 };

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(SCORE_KEY));
      if (s) scores = { x: s.x | 0, o: s.o | 0, d: s.d | 0 };
    } catch (e) {}
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY));
      if (p) { mode = p.mode === "pvp" ? "pvp" : "ai"; difficulty = p.difficulty === "easy" ? "easy" : "hard"; }
    } catch (e) {}
  }
  function saveScores() { try { localStorage.setItem(SCORE_KEY, JSON.stringify(scores)); } catch (e) {} }
  function savePref() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ mode, difficulty })); } catch (e) {} }

  function newRound() {
    board = ["", "", "", "", "", "", "", "", ""];
    current = HUMAN; over = false;
    cells.forEach((c) => {
      c.textContent = ""; c.className = "cell"; c.disabled = false;
      c.removeAttribute("aria-label");
    });
    syncLabels();
    setStatus();
    // If computer plays first it never does (human is X and always starts), but keep hook:
    if (mode === "ai" && current === AI) aiTurn();
  }

  function setStatus(msg) {
    if (msg) { statusEl.textContent = msg; return; }
    if (mode === "ai") statusEl.textContent = "Your move — X";
    else statusEl.textContent = "Player " + current + "'s move";
  }

  function syncLabels() {
    if (mode === "ai") { xLabelEl.textContent = "You (X)"; oLabelEl.textContent = "CPU (O)"; }
    else { xLabelEl.textContent = "Player X"; oLabelEl.textContent = "Player O"; }
    diffRow.hidden = mode !== "ai";
    modePvpBtn.setAttribute("aria-selected", String(mode === "pvp"));
    modeAiBtn.setAttribute("aria-selected", String(mode === "ai"));
    diffEasyBtn.setAttribute("aria-selected", String(difficulty === "easy"));
    diffHardBtn.setAttribute("aria-selected", String(difficulty === "hard"));
  }

  function renderCell(i, mark) {
    const c = cells[i];
    c.textContent = mark;
    c.classList.add("cell--filled", mark === "X" ? "cell--x" : "cell--o");
    c.disabled = true;
    c.setAttribute("aria-label", "cell " + (i + 1) + " " + mark);
  }

  function winner(b) {
    for (const line of LINES) {
      const [a, d, e] = line;
      if (b[a] && b[a] === b[d] && b[a] === b[e]) return { mark: b[a], line };
    }
    if (b.every((v) => v)) return { mark: null, line: null, draw: true };
    return null;
  }

  function finish(res) {
    over = true;
    cells.forEach((c) => (c.disabled = true));
    if (res.draw) { scores.d++; setStatus("It's a draw"); }
    else {
      res.line.forEach((i) => cells[i].classList.add("cell--win"));
      if (mode === "ai") {
        if (res.mark === HUMAN) { scores.x++; setStatus("You win! 🎉"); }
        else { scores.o++; setStatus("Computer wins"); }
      } else {
        if (res.mark === "X") { scores.x++; setStatus("Player X wins!"); }
        else { scores.o++; setStatus("Player O wins!"); }
      }
    }
    renderScores();
    saveScores();
  }

  function renderScores() {
    xScoreEl.textContent = scores.x;
    oScoreEl.textContent = scores.o;
    dScoreEl.textContent = scores.d;
  }

  function play(i) {
    if (over || board[i]) return;
    board[i] = current;
    renderCell(i, current);
    const res = winner(board);
    if (res) { finish(res); return; }
    current = current === "X" ? "O" : "X";
    setStatus();
    if (mode === "ai" && current === AI) setTimeout(aiTurn, 180);
  }

  // ---------- Computer ----------
  function aiTurn() {
    if (over) return;
    let move;
    if (difficulty === "easy") move = easyMove();
    else move = bestMove();
    if (move == null) return;
    play(move);
  }

  function emptyIndices(b) {
    const out = [];
    for (let i = 0; i < 9; i++) if (!b[i]) out.push(i);
    return out;
  }

  // Easy: mostly random, but occasionally takes a win / blocks a loss.
  function easyMove() {
    const empties = emptyIndices(board);
    if (Math.random() < 0.55) {
      const win = findImmediate(AI);
      if (win != null) return win;
      const block = findImmediate(HUMAN);
      if (block != null) return block;
    }
    return empties[Math.floor(Math.random() * empties.length)];
  }
  function findImmediate(mark) {
    for (const line of LINES) {
      const vals = line.map((i) => board[i]);
      const markCount = vals.filter((v) => v === mark).length;
      const emptyCount = vals.filter((v) => v === "").length;
      if (markCount === 2 && emptyCount === 1) return line[vals.indexOf("")];
    }
    return null;
  }

  // Unbeatable: minimax with alpha-beta, prefers faster wins.
  function bestMove() {
    let best = -Infinity, move = null;
    for (const i of emptyIndices(board)) {
      board[i] = AI;
      const score = minimax(board, 0, false, -Infinity, Infinity, 1);
      board[i] = "";
      if (score > best) { best = score; move = i; }
    }
    return move;
  }
  function minimax(b, depth, isMax, alpha, beta, turn) {
    const res = winner(b);
    if (res) {
      if (res.draw) return 0;
      return res.mark === AI ? 10 - turn : turn - 10;
    }
    if (isMax) {
      let best = -Infinity;
      for (const i of emptyIndices(b)) {
        b[i] = AI;
        best = Math.max(best, minimax(b, depth + 1, false, alpha, beta, turn + 1));
        b[i] = "";
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const i of emptyIndices(b)) {
        b[i] = HUMAN;
        best = Math.min(best, minimax(b, depth + 1, true, alpha, beta, turn + 1));
        b[i] = "";
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  // ---------- Events ----------
  boardEl.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    // In AI mode, only let the human (X) act on their turn.
    if (mode === "ai" && current === AI) return;
    play(+cell.dataset.i);
  });
  newRoundBtn.addEventListener("click", newRound);
  resetBtn.addEventListener("click", () => { scores = { x: 0, o: 0, d: 0 }; renderScores(); saveScores(); });
  modePvpBtn.addEventListener("click", () => { mode = "pvp"; savePref(); newRound(); });
  modeAiBtn.addEventListener("click", () => { mode = "ai"; savePref(); newRound(); });
  diffEasyBtn.addEventListener("click", () => { difficulty = "easy"; savePref(); syncLabels(); });
  diffHardBtn.addEventListener("click", () => { difficulty = "hard"; savePref(); syncLabels(); });

  // ---------- Boot ----------
  load();
  renderScores();
  newRound();
})();
