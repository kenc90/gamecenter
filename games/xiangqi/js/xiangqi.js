/* ===== Chinese Chess (Xiangqi) — game logic =====
   A self-contained rules engine: legal move generation for every piece with
   palace / river / horse-leg / elephant-eye / cannon-screen and flying-general
   rules, check & mate/stalemate detection, a negamax + alpha-beta AI
   (Easy / Medium / Hard), two-player hot-seat play, undo, board flip, a move
   list, and localStorage persistence so a refresh resumes the game. */
(function () {
  "use strict";

  var ROWS = 10, COLS = 9;
  var SAVE_KEY = "gc-xiangqi-save";
  var MATE = 100000;
  var FILES9 = "abcdefghi";

  var GLYPH = {
    r: { k: "\u5E26", a: "\u4ED5", b: "\u76F8", n: "\u99AC", r: "\u8ECA", c: "\u70AE", p: "\u5175" },
    b: { k: "\u5C06", a: "\u58EB", b: "\u8C61", n: "\u99AC", r: "\u8ECA", c: "\u782E", p: "\u5352" }
  };
  var LETTER = { k: "K", a: "A", b: "E", n: "H", r: "R", c: "C", p: "P" };
  var VALUE = { k: 10000, r: 900, c: 450, n: 400, b: 100, a: 200, p: 100 };

  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  // horse: target offset + the blocking "leg" (dominant single step)
  var HORSE = [[2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0],
               [1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1]];
  var ELEPHANT = [[2, 2], [2, -2], [-2, 2], [-2, -2]];

  /* ---------- elements ---------- */
  var boardEl = document.getElementById("board");
  var statusEl = document.getElementById("status");
  var modePvpEl = document.getElementById("modePvp");
  var modeAiEl = document.getElementById("modeAi");
  var diffRowEl = document.getElementById("diffRow");
  var diffBtns = { easy: document.getElementById("diffEasy"), med: document.getElementById("diffMed"), hard: document.getElementById("diffHard") };
  var capRedEl = document.getElementById("capByRed");
  var capBlackEl = document.getElementById("capByBlack");
  var movesEl = document.getElementById("moves");
  var newBtn = document.getElementById("newBtn");
  var undoBtn = document.getElementById("undoBtn");
  var flipBtn = document.getElementById("flipBtn");
  var rulesBtn = document.getElementById("rulesBtn");
  var modalEl = document.getElementById("rulesModal");

  /* ---------- state ---------- */
  var g, hist = [], meta = {};
  var mode = "pvp", diff = "med", flipped = false;
  var selected = null, legalCache = [], aiBusy = false, gameOver = false;

  function startPosition() {
    var board = [];
    for (var r = 0; r < ROWS; r++) board.push(new Array(COLS).fill(null));
    var back = ["r", "n", "b", "a", "k", "a", "b", "n", "r"];
    for (var c = 0; c < COLS; c++) { board[0][c] = "b" + back[c]; board[9][c] = "r" + back[c]; }
    board[2][1] = "bc"; board[2][7] = "bc";
    board[7][1] = "rc"; board[7][7] = "rc";
    [0, 2, 4, 6, 8].forEach(function (c) { board[3][c] = "bp"; board[6][c] = "rp"; });
    return { board: board, turn: "r" };
  }
  function cloneBoard(b) { var n = []; for (var r = 0; r < ROWS; r++) n.push(b[r].slice()); return n; }
  function inside(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
  function opp(s) { return s === "r" ? "b" : "r"; }

  function inPalace(side, r, c) { return c >= 3 && c <= 5 && (side === "r" ? r >= 7 && r <= 9 : r >= 0 && r <= 2); }
  function ownHalf(side, r) { return side === "r" ? r >= 5 : r <= 4; }   // elephant/advisor side check for elephant
  function crossedRiver(side, r) { return side === "r" ? r <= 4 : r >= 5; }

  function generalSquare(board, side) {
    var k = side + "k";
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) if (board[r][c] === k) return [r, c];
    return null;
  }
  function generalsFace(board) {
    var rk = generalSquare(board, "r"), bk = generalSquare(board, "b");
    if (!rk || !bk || rk[1] !== bk[1]) return false;
    var lo = Math.min(rk[0], bk[0]) + 1, hi = Math.max(rk[0], bk[0]);
    for (var r = lo; r < hi; r++) if (board[r][rk[1]]) return false;
    return true;
  }

  /* ---------- attack detection (point query) ---------- */
  function isAttacked(board, r, c, by) {
    // chariots & cannons on orthogonal rays
    for (var d = 0; d < 4; d++) {
      var dr = ORTH[d][0], dc = ORTH[d][1], rr = r + dr, cc = c + dc, screen = false;
      while (inside(rr, cc)) {
        var p = board[rr][cc];
        if (p) {
          if (!screen) {
            if (p[0] === by && p[1] === "r") return true;   // chariot, clear path
            screen = true;
          } else {
            if (p[0] === by && p[1] === "c") return true;   // cannon behind one screen
            break;
          }
        }
        rr += dr; cc += dc;
      }
    }
    // horses (respecting their legs)
    for (var h = 0; h < 8; h++) {
      var or = r - HORSE[h][0], oc = c - HORSE[h][1];
      if (!inside(or, oc) || board[or][oc] !== by + "n") continue;
      var lr = or + HORSE[h][2], lc = oc + HORSE[h][3];
      if (board[lr][lc]) continue;                          // leg blocked
      return true;
    }
    // soldiers
    if (by === "r") {
      if (inside(r + 1, c) && board[r + 1][c] === "rp") return true;                    // forward red
      if (r <= 4 && inside(r, c - 1) && board[r][c - 1] === "rp") return true;          // sideways (crossed)
      if (r <= 4 && inside(r, c + 1) && board[r][c + 1] === "rp") return true;
    } else {
      if (inside(r - 1, c) && board[r - 1][c] === "bp") return true;
      if (r >= 5 && inside(r, c - 1) && board[r][c - 1] === "bp") return true;
      if (r >= 5 && inside(r, c + 1) && board[r][c + 1] === "bp") return true;
    }
    return false;
  }

  function inCheck(state, side) {
    var gen = generalSquare(state.board, side);
    if (!gen) return true;
    if (generalsFace(state.board)) return true;
    return isAttacked(state.board, gen[0], gen[1], opp(side));
  }

  /* ---------- pseudo move generation ---------- */
  function pseudoMoves(board, r, c) {
    var piece = board[r][c];
    if (!piece) return [];
    var side = piece[0], type = piece[1], moves = [];
    function push(tr, tc) {
      moves.push({ fr: r, fc: c, tr: tr, tc: tc, piece: piece, captured: board[tr][tc] || null });
    }
    if (type === "k" || type === "a") {
      var offs = type === "k" ? ORTH : DIAG;
      for (var i = 0; i < offs.length; i++) {
        var tr = r + offs[i][0], tc = c + offs[i][1];
        if (!inside(tr, tc) || !inPalace(side, tr, tc)) continue;
        var t = board[tr][tc];
        if (!t || t[0] !== side) push(tr, tc);
      }
    } else if (type === "e" || type === "b") {
      for (var e = 0; e < 4; e++) {
        var er = r + ELEPHANT[e][0], ec = c + ELEPHANT[e][1];
        if (!inside(er, ec) || !ownHalf(side, er)) continue;               // can't cross river
        if (board[r + ELEPHANT[e][0] / 2][c + ELEPHANT[e][1] / 2]) continue; // blocked eye
        var tp = board[er][ec];
        if (!tp || tp[0] !== side) push(er, ec);
      }
    } else if (type === "n") {
      for (var h = 0; h < 8; h++) {
        var hr = r + HORSE[h][0], hc = c + HORSE[h][1];
        if (!inside(hr, hc)) continue;
        if (board[r + HORSE[h][2]][c + HORSE[h][3]]) continue;             // blocked leg
        var th = board[hr][hc];
        if (!th || th[0] !== side) push(hr, hc);
      }
    } else if (type === "r") {
      slide(board, r, c, side, ORTH, push);
    } else if (type === "c") {
      // move like a rook (no capture) OR capture by jumping exactly one screen
      for (var dd = 0; dd < 4; dd++) {
        var dr2 = ORTH[dd][0], dc2 = ORTH[dd][1], rr = r + dr2, cc = c + dc2, jumped = false;
        while (inside(rr, cc)) {
          var q = board[rr][cc];
          if (!jumped) {
            if (!q) push(rr, cc);
            else jumped = true;
          } else if (q) {
            if (q[0] !== side) push(rr, cc);
            break;
          }
          rr += dr2; cc += dc2;
        }
      }
    } else if (type === "p") {
      var dir = side === "r" ? -1 : 1;
      var steps = [[r + dir, c]];                                  // always one step forward
      if (crossedRiver(side, r)) steps.push([r, c - 1], [r, c + 1]); // sideways once past the river
      steps.forEach(function (t) {
        var tr2 = t[0], tc2 = t[1];
        if (!inside(tr2, tc2)) return;
        var en = board[tr2][tc2];
        if (!en || en[0] !== side) push(tr2, tc2);                  // empty = move, enemy = capture
      });
    }
    return moves;
  }
  function slide(board, r, c, side, dirs, push) {
    for (var d = 0; d < dirs.length; d++) {
      var rr = r + dirs[d][0], cc = c + dirs[d][1];
      while (inside(rr, cc)) {
        var t = board[rr][cc];
        if (!t) push(rr, cc);
        else { if (t[0] !== side) push(rr, cc); break; }
        rr += dirs[d][0]; cc += dirs[d][1];
      }
    }
  }

  function makeMove(state, m) {
    var board = cloneBoard(state.board);
    board[m.tr][m.tc] = board[m.fr][m.fc];
    board[m.fr][m.fc] = null;
    return { board: board, turn: opp(state.turn) };
  }
  function legalMoves(state, r, c) {
    var piece = state.board[r][c];
    if (!piece || piece[0] !== state.turn) return [];
    return pseudoMoves(state.board, r, c).filter(function (m) {
      return !inCheck(makeMove(state, m), state.turn);
    });
  }
  function allLegal(state) {
    var out = [];
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
      var p = state.board[r][c];
      if (p && p[0] === state.turn) out = out.concat(legalMoves(state, r, c));
    }
    return out;
  }

  /* ---------- evaluation + search ---------- */
  function evaluateFor(state) {
    var score = 0;
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
      var p = state.board[r][c];
      if (!p) continue;
      var type = p[1], v = VALUE[type];
      if (type === "p" && crossedRiver(p[0], r)) v += 40;
      score += p[0] === state.turn ? v : -v;
    }
    return score;
  }
  function orderMoves(moves) {
    moves.sort(function (a, b) {
      return (b.captured ? VALUE[b.captured[1]] : 0) - (a.captured ? VALUE[a.captured[1]] : 0);
    });
  }
  function negamax(state, depth, alpha, beta, ply) {
    var moves = allLegal(state);
    if (moves.length === 0) return -(MATE - ply);   // mated or stalemated: side to move loses
    if (depth <= 0) return evaluateFor(state);
    orderMoves(moves);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var val = -negamax(makeMove(state, moves[i]), depth - 1, -beta, -alpha, ply + 1);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  function bestMoveFor(state, depth, randomness) {
    var moves = allLegal(state);
    if (!moves.length) return null;
    orderMoves(moves);
    var scored = moves.map(function (m) {
      return { m: m, v: -negamax(makeMove(state, m), depth - 1, -Infinity, Infinity, 1) };
    });
    scored.sort(function (a, b) { return b.v - a.v; });
    if (randomness && Math.random() < randomness) return scored[Math.floor(Math.random() * scored.length)].m;
    return scored[0].m;
  }

  /* ---------- notation ---------- */
  function coord(r, c) { return FILES9[c] + (10 - r); }
  function toRecord(m) {
    var label = LETTER[m.piece[1]] + " " + coord(m.fr, m.fc) + "\u2192" + coord(m.tr, m.tc);
    if (m.captured) label += "\u00d7" + LETTER[m.captured[1]];
    return label;
  }

  /* ---------- persistence ---------- */
  function snapshot() { return { board: cloneBoard(g.board), turn: g.turn, meta: JSON.parse(JSON.stringify(meta)) }; }
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        snap: snapshot(), hist: hist.map(function (h) { return { board: h.board, turn: h.turn, meta: h.meta }; }),
        mode: mode, diff: diff, flipped: flipped
      }));
    } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (!d || !d.snap || !d.snap.board) return false;
      g = { board: d.snap.board, turn: d.snap.turn };
      hist = (d.hist || []).map(function (h) { return { board: h.board, turn: h.turn, meta: h.meta }; });
      meta = d.snap.meta || { moveList: [], capturedR: [], capturedB: [], lastMove: null };
      mode = d.mode || "pvp"; diff = d.diff || "med"; flipped = !!d.flipped;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- UI move application ---------- */
  function applyMove(m) {
    var rec = toRecord(m);
    var mover = g.turn;
    if (m.captured) (mover === "r" ? meta.capturedR : meta.capturedB).push(m.captured);
    var ng = makeMove(g, m);
    hist.push(snapshot());
    g = ng;
    meta.moveList.push(rec);
    meta.lastMove = { fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc };
    selected = null; legalCache = [];
    refreshStatus();
    render();
    save();
    if (mode === "ai" && !gameOver && g.turn === "b") scheduleAi();
  }

  function refreshStatus() {
    var check = inCheck(g, g.turn);
    var moves = allLegal(g);
    var side = g.turn === "r" ? "Red" : "Black";
    if (!moves.length) {
      gameOver = true;
      statusEl.textContent = (check ? "Checkmate — " : "Stalemate — ") + (g.turn === "r" ? "Black" : "Red") + " wins.";
      return;
    }
    gameOver = false;
    statusEl.textContent = side + " to move" + (check ? " — check!" : ".");
  }
  function scheduleAi() {
    if (aiBusy) return;
    aiBusy = true;
    statusEl.textContent = "Computer is thinking…";
    setTimeout(function () {
      var depth = diff === "easy" ? 1 : diff === "med" ? 2 : 3;
      var randomness = diff === "easy" ? 0.5 : diff === "med" ? 0.15 : 0;
      var m = bestMoveFor(g, depth, randomness);
      aiBusy = false;
      if (m) applyMove(m); else refreshStatus();
    }, 60);
  }

  /* ---------- interaction ---------- */
  function onPointClick(r, c) {
    if (gameOver || aiBusy) return;
    if (mode === "ai" && g.turn === "b") return;
    var piece = g.board[r][c];
    if (selected) {
      var chosen = legalCache.filter(function (m) { return m.tr === r && m.tc === c; });
      if (chosen.length) { applyMove(chosen[0]); return; }
      if (piece && piece[0] === g.turn) { selectSquare(r, c); return; }
      selected = null; legalCache = []; render(); return;
    }
    if (piece && piece[0] === g.turn) selectSquare(r, c);
  }
  function selectSquare(r, c) { selected = { r: r, c: c }; legalCache = legalMoves(g, r, c); render(); }

  /* ---------- board lattice (static) ---------- */
  function buildLines() {
    var U = 40, W = U * (COLS - 1), H = U * (ROWS - 1);   // 320 x 360 of intersection space
    function pt(c, r) { return [20 + c * U, 20 + r * U]; }
    var s = '<svg class="board-lines" viewBox="0 0 360 400" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">';
    var stroke = 'stroke="#6b4a24" stroke-width="1.4" vector-effect="non-scaling-stroke" fill="none"';
    for (var c = 0; c < COLS; c++) {                                 // verticals, broken at river
      var x = 20 + c * U;
      s += '<line x1="' + x + '" y1="20" x2="' + x + '" y2="180" ' + stroke + '/>';
      s += '<line x1="' + x + '" y1="220" x2="' + x + '" y2="380" ' + stroke + '/>';
    }
    for (var r = 0; r < ROWS; r++) {                                 // horizontals
      var y = 20 + r * U;
      s += '<line x1="20" y1="' + y + '" x2="340" y2="' + y + '" ' + stroke + '/>';
    }
    s += '<rect x="18" y="18" width="324" height="364" ' + stroke.replace('stroke-width="1.4"', 'stroke-width="2.4"') + '/>';
    // palace diagonals
    s += '<line x1="140" y1="20" x2="220" y2="100" ' + stroke + '/><line x1="220" y1="20" x2="140" y2="100" ' + stroke + '/>';
    s += '<line x1="140" y1="300" x2="220" y2="380" ' + stroke + '/><line x1="220" y1="300" x2="140" y2="380" ' + stroke + '/>';
    s += '<text x="90" y="205" fill="rgba(107,74,36,.35)" font-size="22" font-family="serif">\u695a\u6cb3</text>';
    s += '<text x="212" y="205" fill="rgba(107,74,36,.35)" font-size="22" font-family="serif">\u6f22\u754c</text>';
    s += "</svg>";
    boardEl.insertAdjacentHTML("afterbegin", s);
  }

  /* ---------- render ---------- */
  var linesBuilt = false;
  function render() {
    if (!linesBuilt) { buildLines(); linesBuilt = true; }
    // remove old point cells (keep the svg line overlay)
    Array.prototype.slice.call(boardEl.querySelectorAll(".pt")).forEach(function (n) { n.remove(); });
    var checkSq = inCheck(g, g.turn) ? generalSquare(g.board, g.turn) : null;
    var hintSet = {};
    if (selected) legalCache.forEach(function (m) { hintSet[m.tr + "," + m.tc] = m; });

    for (var i = 0; i < ROWS * COLS; i++) {
      var viewRow = Math.floor(i / COLS), viewCol = i % COLS;
      var r = flipped ? (ROWS - 1 - viewRow) : viewRow;
      var c = flipped ? (COLS - 1 - viewCol) : viewCol;
      var cell = document.createElement("div");
      cell.className = "pt";
      cell.dataset.r = r; cell.dataset.c = c;

      var p = g.board[r][c];
      if (p) {
        var tok = document.createElement("span");
        tok.className = "tok tok--" + p[0];
        tok.textContent = GLYPH[p[0]][p[1]];
        cell.appendChild(tok);
      }
      cell.setAttribute("aria-label", coord(r, c) + (p ? " " + LETTER[p[1]] : ""));
      if (selected && selected.r === r && selected.c === c) cell.classList.add("pt--sel");
      if (meta.lastMove && ((meta.lastMove.fr === r && meta.lastMove.fc === c) || (meta.lastMove.tr === r && meta.lastMove.tc === c))) cell.classList.add("pt--last");
      if (checkSq && checkSq[0] === r && checkSq[1] === c) cell.classList.add("pt--check");
      var hint = hintSet[r + "," + c];
      if (hint) {
        var dot = document.createElement("span");
        dot.className = "dot" + (hint.captured ? " dot--cap" : "");
        cell.appendChild(dot);
      }
      cell.addEventListener("click", function () { onPointClick(+this.dataset.r, +this.dataset.c); });
      boardEl.appendChild(cell);
    }
    renderSide();
  }

  function renderSide() {
    capRedEl.innerHTML = meta.capturedR.map(function (p) { return '<span class="tk tk--b">' + GLYPH[p[0]][p[1]] + "</span>"; }).join(" ");
    capBlackEl.innerHTML = meta.capturedB.map(function (p) { return '<span class="tk tk--r">' + GLYPH[p[0]][p[1]] + "</span>"; }).join(" ");
    movesEl.innerHTML = "";
    for (var i = 0; i < meta.moveList.length; i += 2) {
      var n = document.createElement("span"); n.className = "moves__n"; n.textContent = (i / 2 + 1) + ".";
      var w = document.createElement("span"); w.className = "moves__mv"; w.textContent = meta.moveList[i];
      var b = document.createElement("span"); b.className = "moves__mv"; b.textContent = meta.moveList[i + 1] || "";
      movesEl.appendChild(n); movesEl.appendChild(w); movesEl.appendChild(b);
    }
    movesEl.scrollTop = movesEl.scrollHeight;
    undoBtn.disabled = hist.length <= 1;
  }

  /* ---------- controls ---------- */
  function newGame() {
    g = startPosition();
    hist = [snapshot()];
    meta = { moveList: [], capturedR: [], capturedB: [], lastMove: null };
    selected = null; legalCache = []; gameOver = false; aiBusy = false;
    refreshStatus(); render(); save();
  }
  function undo() {
    if (hist.length <= 1) return;
    function pop() {
      hist.pop();
      var prev = hist[hist.length - 1];
      g = { board: cloneBoard(prev.board), turn: prev.turn };
      meta = JSON.parse(JSON.stringify(prev.meta));
    }
    pop();
    if (mode === "ai" && g.turn === "b" && hist.length > 1) pop();
    selected = null; legalCache = []; gameOver = false;
    refreshStatus(); render(); save();
  }
  function setMode(m) {
    mode = m;
    modePvpEl.setAttribute("aria-selected", String(m === "pvp"));
    modeAiEl.setAttribute("aria-selected", String(m === "ai"));
    diffRowEl.hidden = m !== "ai";
    newGame();
  }
  function setDiff(d) {
    diff = d;
    Object.keys(diffBtns).forEach(function (k) { diffBtns[k].setAttribute("aria-selected", String(k === d)); });
    save();
  }

  /* ---------- rules modal ---------- */
  function openRules() { modalEl.hidden = false; }
  function closeRules() { modalEl.hidden = true; }
  rulesBtn.addEventListener("click", openRules);
  modalEl.addEventListener("click", function (e) { if (e.target.hasAttribute("data-close") || e.target.closest("[data-close]")) closeRules(); });

  /* ---------- events ---------- */
  newBtn.addEventListener("click", newGame);
  undoBtn.addEventListener("click", undo);
  flipBtn.addEventListener("click", function () { flipped = !flipped; render(); save(); });
  modePvpEl.addEventListener("click", function () { setMode("pvp"); });
  modeAiEl.addEventListener("click", function () { setMode("ai"); });
  diffBtns.easy.addEventListener("click", function () { setDiff("easy"); });
  diffBtns.med.addEventListener("click", function () { setDiff("med"); });
  diffBtns.hard.addEventListener("click", function () { setDiff("hard"); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeRules();
    else if (e.key === "r" || e.key === "R") { if (modalEl.hidden) newGame(); }
  });

  /* ---------- boot ---------- */
  function boot() {
    if (!load()) { g = startPosition(); hist = [snapshot()]; meta = { moveList: [], capturedR: [], capturedB: [], lastMove: null }; }
    modePvpEl.setAttribute("aria-selected", String(mode === "pvp"));
    modeAiEl.setAttribute("aria-selected", String(mode === "ai"));
    diffRowEl.hidden = mode !== "ai";
    Object.keys(diffBtns).forEach(function (k) { diffBtns[k].setAttribute("aria-selected", String(k === diff)); });
    if (!hist.length) hist = [snapshot()];
    refreshStatus(); render();
    if (mode === "ai" && g.turn === "b" && !gameOver) scheduleAi();
  }
  boot();
})();
