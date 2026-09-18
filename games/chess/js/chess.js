/* ===== Chess — game logic =====
   A self-contained rules engine: full legal move generation (castling, en
   passant, promotion), check / checkmate / stalemate detection, a negamax +
   alpha-beta AI (Easy / Medium / Hard), two-player hot-seat play, undo, board
   flip, algebraic move history, and localStorage persistence so a refresh
   resumes the current game. */
(function () {
  "use strict";

  /* ---------- constants ---------- */
  var GLYPH = { k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F" };
  var VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  var SAVE_KEY = "gc-chess-save";
  var MATE = 100000;

  var KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  var KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  /* ---------- elements ---------- */
  var boardEl = document.getElementById("board");
  var statusEl = document.getElementById("status");
  var modePvpEl = document.getElementById("modePvp");
  var modeAiEl = document.getElementById("modeAi");
  var diffRowEl = document.getElementById("diffRow");
  var diffBtns = { easy: document.getElementById("diffEasy"), med: document.getElementById("diffMed"), hard: document.getElementById("diffHard") };
  var promoEl = document.getElementById("promo");
  var promoOptsEl = document.getElementById("promoOpts");
  var promoCancelEl = document.getElementById("promoCancel");
  var newBtn = document.getElementById("newBtn");
  var undoBtn = document.getElementById("undoBtn");
  var flipBtn = document.getElementById("flipBtn");
  var rulesBtn = document.getElementById("rulesBtn");
  var modalEl = document.getElementById("rulesModal");

  /* ---------- state ---------- */
  var g;               // active position: {board, turn, castling, ep}
  var hist = [];       // stack of snapshots (index 0 = start) for undo + redo-free history
  var meta = {};       // {moveList:[san], capturedW:[], capturedB:[], lastMove}
  var mode = "pvp";    // "pvp" | "ai"
  var diff = "med";    // "easy" | "med" | "hard"
  var flipped = false;
  var selected = null; // {r,c}
  var legalCache = []; // legal moves for selected piece
  var pending = null;  // promotion awaiting user choice: {move, afterFn}
  var aiBusy = false;
  var gameOver = false;

  /* ---------- setup helpers ---------- */
  function startPosition() {
    var back = ["r", "n", "b", "q", "k", "b", "n", "r"];
    var board = [];
    for (var r = 0; r < 8; r++) board.push(new Array(8).fill(null));
    for (var c = 0; c < 8; c++) {
      board[0][c] = "b" + back[c];
      board[1][c] = "bp";
      board[6][c] = "wp";
      board[7][c] = "w" + back[c];
    }
    return { board: board, turn: "w", castling: { wk: true, wq: true, bk: true, bq: true }, ep: null };
  }

  function cloneBoard(b) {
    var n = [];
    for (var r = 0; r < 8; r++) n.push(b[r].slice());
    return n;
  }
  function cloneState(s) {
    return { board: cloneBoard(s.board), turn: s.turn, castling: { wk: s.castling.wk, wq: s.castling.wq, bk: s.castling.bk, bq: s.castling.bq }, ep: s.ep ? [s.ep[0], s.ep[1]] : null };
  }
  function inside(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  /* ---------- attack detection ---------- */
  function isAttacked(board, r, c, by) {
    // pawns
    var pr = by === "w" ? r + 1 : r - 1;
    if (inside(pr, c - 1) && board[pr][c - 1] === by + "p") return true;
    if (inside(pr, c + 1) && board[pr][c + 1] === by + "p") return true;
    // knights
    for (var i = 0; i < 8; i++) {
      var kr = r + KNIGHT[i][0], kc = c + KNIGHT[i][1];
      if (inside(kr, kc) && board[kr][kc] === by + "n") return true;
    }
    // king
    for (var j = 0; j < 8; j++) {
      var ar = r + KING[j][0], ac = c + KING[j][1];
      if (inside(ar, ac) && board[ar][ac] === by + "k") return true;
    }
    // sliders
    function rays(dirs, types) {
      for (var d = 0; d < dirs.length; d++) {
        var rr = r + dirs[d][0], cc = c + dirs[d][1];
        while (inside(rr, cc)) {
          var p = board[rr][cc];
          if (p) { if (p[0] === by && types.indexOf(p[1]) !== -1) return true; break; }
          rr += dirs[d][0]; cc += dirs[d][1];
        }
      }
      return false;
    }
    if (rays(ORTH, ["r", "q"])) return true;
    if (rays(DIAG, ["b", "q"])) return true;
    return false;
  }

  function kingSquare(board, color) {
    var k = color + "k";
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) if (board[r][c] === k) return [r, c];
    return null;
  }
  function inCheck(state, color) {
    var kp = kingSquare(state.board, color);
    if (!kp) return false;
    var opp = color === "w" ? "b" : "w";
    return isAttacked(state.board, kp[0], kp[1], opp);
  }

  /* ---------- pseudo-legal move generation ---------- */
  function pseudoMoves(state, r, c) {
    var board = state.board;
    var piece = board[r][c];
    if (!piece) return [];
    var color = piece[0], type = piece[1];
    var moves = [];
    function push(tr, tc, extra) {
      var m = { fr: r, fc: c, tr: tr, tc: tc, piece: piece, captured: board[tr][tc] || null };
      if (extra) for (var k in extra) m[k] = extra[k];
      moves.push(m);
    }
    if (type === "p") {
      var dir = color === "w" ? -1 : 1;
      var startRow = color === "w" ? 6 : 1;
      var promoRow = color === "w" ? 0 : 7;
      var fr = r + dir;
      if (inside(fr, c) && !board[fr][c]) {
        if (fr === promoRow) { ["q", "r", "b", "n"].forEach(function (pp) { push(fr, c, { promo: pp }); }); }
        else {
          push(fr, c);
          var fr2 = r + dir * 2;
          if (r === startRow && !board[fr2][c]) push(fr2, c, { double: true });
        }
      }
      [-1, 1].forEach(function (dc) {
        var tc = c + dc, tr = r + dir;
        if (!inside(tr, tc)) return;
        var t = board[tr][tc];
        if (t && t[0] !== color) {
          if (tr === promoRow) ["q", "r", "b", "n"].forEach(function (pp) { push(tr, tc, { promo: pp }); });
          else push(tr, tc);
        } else if (!t && state.ep && state.ep[0] === tr && state.ep[1] === tc) {
          push(tr, tc, { ep: true, captured: board[r][tc] });
        }
      });
    } else if (type === "n" || type === "k") {
      var offs = type === "n" ? KNIGHT : KING;
      for (var i = 0; i < offs.length; i++) {
        var tr = r + offs[i][0], tc = c + offs[i][1];
        if (!inside(tr, tc)) continue;
        var t = board[tr][tc];
        if (!t || t[0] !== color) push(tr, tc);
      }
      if (type === "k") addCastling(state, r, c, color, moves);
    } else {
      var dirs = type === "b" ? DIAG : type === "r" ? ORTH : DIAG.concat(ORTH);
      for (var d = 0; d < dirs.length; d++) {
        var rr = r + dirs[d][0], cc = c + dirs[d][1];
        while (inside(rr, cc)) {
          var t = board[rr][cc];
          if (!t) push(rr, cc);
          else { if (t[0] !== color) push(rr, cc); break; }
          rr += dirs[d][0]; cc += dirs[d][1];
        }
      }
    }
    return moves;
  }

  function addCastling(state, r, c, color, moves) {
    var board = state.board;
    if (inCheck(state, color)) return;
    var opp = color === "w" ? "b" : "w";
    var row = color === "w" ? 7 : 0;
    if (c !== 4 || r !== row) return;
    var kingRight = color === "w" ? state.castling.wk : state.castling.bk;
    var queenRight = color === "w" ? state.castling.wq : state.castling.bq;
    // king-side: squares f,g (5,6) empty and not attacked; rook at h(7)
    if (kingRight && !board[row][5] && !board[row][6] &&
        !isAttacked(board, row, 5, opp) && !isAttacked(board, row, 6, opp) && board[row][7] === color + "r") {
      moves.push({ fr: r, fc: c, tr: row, tc: 6, piece: color + "k", captured: null, castle: "k" });
    }
    // queen-side: squares b,c,d (1,2,3) empty; king path d,c not attacked; rook at a(0)
    if (queenRight && !board[row][1] && !board[row][2] && !board[row][3] &&
        !isAttacked(board, row, 3, opp) && !isAttacked(board, row, 2, opp) && board[row][0] === color + "r") {
      moves.push({ fr: r, fc: c, tr: row, tc: 2, piece: color + "k", captured: null, castle: "q" });
    }
  }

  /* ---------- make move (returns new state) ---------- */
  function makeMove(state, m) {
    var board = cloneBoard(state.board);
    var castling = { wk: state.castling.wk, wq: state.castling.wq, bk: state.castling.bk, bq: state.castling.bq };
    var piece = board[m.fr][m.fc];
    var color = piece[0], type = piece[1];
    board[m.fr][m.fc] = null;
    board[m.tr][m.tc] = m.promo ? color + m.promo : piece;

    if (m.ep) board[m.fr][m.tc] = null;              // remove en-passant pawn
    if (m.castle) {
      var row = color === "w" ? 7 : 0;
      if (m.castle === "k") { board[row][5] = board[row][7]; board[row][7] = null; }
      else { board[row][3] = board[row][0]; board[row][0] = null; }
    }
    // castling rights
    if (type === "k") { if (color === "w") { castling.wk = castling.wq = false; } else { castling.bk = castling.bq = false; } }
    if (type === "r") {
      if (color === "w" && m.fr === 7 && m.fc === 0) castling.wq = false;
      if (color === "w" && m.fr === 7 && m.fc === 7) castling.wk = false;
      if (color === "b" && m.fr === 0 && m.fc === 0) castling.bq = false;
      if (color === "b" && m.fr === 0 && m.fc === 7) castling.bk = false;
    }
    if (m.captured && m.captured[1] === "r") {
      if (m.tr === 7 && m.tc === 0) castling.wq = false;
      if (m.tr === 7 && m.tc === 7) castling.wk = false;
      if (m.tr === 0 && m.tc === 0) castling.bq = false;
      if (m.tr === 0 && m.tc === 7) castling.bk = false;
    }
    var ep = (type === "p" && m.double) ? [(m.fr + m.tr) / 2, m.fc] : null;
    return { board: board, turn: color === "w" ? "b" : "w", castling: castling, ep: ep };
  }

  function legalMoves(state, r, c) {
    var piece = state.board[r][c];
    if (!piece || piece[0] !== state.turn) return [];
    return pseudoMoves(state, r, c).filter(function (m) {
      return !inCheck(makeMove(state, m), state.turn);
    });
  }
  function allLegal(state) {
    var out = [];
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var p = state.board[r][c];
      if (p && p[0] === state.turn) out = out.concat(legalMoves(state, r, c));
    }
    return out;
  }

  /* ---------- algebraic notation ---------- */
  var FILES = "abcdefgh";
  function sqName(r, c) { return FILES[c] + (8 - r); }
  function toSAN(state, m) {
    if (m.castle) return m.castle === "k" ? "O-O" : "O-O-O";
    var piece = m.piece, type = piece[1];
    var dest = sqName(m.tr, m.tc);
    var s = "";
    if (type === "p") {
      if (m.captured) s += FILES[m.fc] + "x";
      s += dest;
      if (m.promo) s += "=" + m.promo.toUpperCase();
    } else {
      s += type.toUpperCase();
      // disambiguation among same-type pieces reaching the same square
      var same = [];
      for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
        if (state.board[r][c] === piece && !(r === m.fr && c === m.fc)) {
          if (legalMoves(state, r, c).some(function (x) { return x.tr === m.tr && x.tc === m.tc; })) same.push([r, c]);
        }
      }
      if (same.length) {
        var sameFile = same.some(function (p) { return p[1] === m.fc; });
        var sameRank = same.some(function (p) { return p[0] === m.fr; });
        if (!sameFile) s += FILES[m.fc];
        else if (!sameRank) s += (8 - m.fr);
        else s += FILES[m.fc] + (8 - m.fr);
      }
      if (m.captured) s += "x";
      s += dest;
    }
    var after = makeMove(state, m);
    if (inCheck(after, after.turn)) {
      s += allLegal(after).length === 0 ? "#" : "+";
    }
    return s;
  }

  /* ---------- evaluation + search (negamax + alpha-beta) ---------- */
  var PST_N = [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50]
  ];
  var PST_P = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0]
  ];
  function evaluateFor(state) {
    // score from the perspective of state.turn (side to move)
    var score = 0;
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var p = state.board[r][c];
      if (!p) continue;
      var type = p[1], v = VALUE[type];
      if (type === "n") v += PST_N[p[0] === "w" ? r : 7 - r][c];
      else if (type === "p") v += PST_P[p[0] === "w" ? r : 7 - r][c];
      score += p[0] === state.turn ? v : -v;
    }
    return score;
  }
  function orderMoves(moves) {
    moves.sort(function (a, b) {
      var av = (a.captured ? VALUE[a.captured[1]] : 0) + (a.promo ? 800 : 0);
      var bv = (b.captured ? VALUE[b.captured[1]] : 0) + (b.promo ? 800 : 0);
      return bv - av;
    });
  }
  function negamax(state, depth, alpha, beta, ply) {
    var moves = allLegal(state);
    if (moves.length === 0) return inCheck(state, state.turn) ? -(MATE - ply) : 0;
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
    if (randomness && Math.random() < randomness) {
      return scored[Math.floor(Math.random() * scored.length)].m;
    }
    return scored[0].m;
  }

  /* ---------- snapshot / persistence ---------- */
  function snapshot() {
    return { g: cloneState(g), meta: JSON.parse(JSON.stringify(meta)) };
  }
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        snap: snapshot(),
        // hist entries are snapshots shaped { g, meta } — clone them as such
        // (passing them to cloneState would throw and silently abort the save).
        hist: hist.map(function (h) { return { g: cloneState(h.g), meta: JSON.parse(JSON.stringify(h.meta)) }; }),
        meta: { moveList: meta.moveList, capturedW: meta.capturedW, capturedB: meta.capturedB },
        mode: mode, diff: diff, flipped: flipped
      }));
    } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (!d || !d.snap || !d.snap.g) return false;
      g = d.snap.g; hist = d.hist || []; meta = d.meta || { moveList: [], capturedW: [], capturedB: [] }; meta.lastMove = d.snap.meta ? d.snap.meta.lastMove : null;
      mode = d.mode || "pvp"; diff = d.diff || "med"; flipped = !!d.flipped;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- applying a real move (UI) ---------- */
  function applyMove(m) {
    var san = toSAN(g, m);
    var mover = g.turn;
    // track captures (kept in save data)
    if (m.captured) {
      (mover === "w" ? meta.capturedW : meta.capturedB).push(m.captured);
    }
    var ng = makeMove(g, m);
    // history stack grows with the resulting position
    hist.push(snapshot());
    g = ng;
    meta.moveList.push(san);
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
    var side = g.turn === "w" ? "White" : "Black";
    if (!moves.length) {
      gameOver = true;
      if (check) statusEl.textContent = "Checkmate — " + (g.turn === "w" ? "Black" : "White") + " wins.";
      else statusEl.textContent = "Stalemate — it's a draw.";
      return;
    }
    gameOver = false;
    statusEl.textContent = side + " to move" + (check ? " — check!" : ".");
    if (mode === "ai" && g.turn === "b" && !check) statusEl.textContent = "Computer is thinking…";
  }

  function scheduleAi() {
    if (aiBusy) return;
    aiBusy = true;
    setTimeout(function () {
      var depth = diff === "easy" ? 1 : diff === "med" ? 2 : 3;
      var randomness = diff === "easy" ? 0.45 : diff === "med" ? 0.12 : 0;
      var m = bestMoveFor(g, depth, randomness);
      aiBusy = false;
      if (m) applyMove(m); else refreshStatus();
    }, 120);
  }

  /* ---------- interaction ---------- */
  function onSquareClick(r, c) {
    if (gameOver || aiBusy) return;
    if (mode === "ai" && g.turn === "b") return; // block human during computer turn
    var piece = g.board[r][c];

    if (selected) {
      var chosen = legalCache.filter(function (m) { return m.tr === r && m.tc === c; });
      if (chosen.length) {
        if (chosen[0].promo) openPromo(chosen);
        else applyMove(chosen[0]);
        return;
      }
      if (piece && piece[0] === g.turn) { selectSquare(r, c); return; }
      selected = null; legalCache = []; render(); return;
    }
    if (piece && piece[0] === g.turn) selectSquare(r, c);
  }

  function selectSquare(r, c) {
    selected = { r: r, c: c };
    legalCache = legalMoves(g, r, c);
    render();
  }

  function openPromo(chosen) {
    promoOptsEl.innerHTML = "";
    var color = g.turn;
    ["q", "r", "b", "n"].forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.innerHTML = '<span class="pc pc--' + color + '">' + GLYPH[t] + "</span>";
      b.addEventListener("click", function () {
        var mv = chosen.filter(function (m) { return m.promo === t; })[0];
        closePromo();
        if (mv) applyMove(mv);
      });
      promoOptsEl.appendChild(b);
    });
    promoEl.hidden = false;
    pending = true;
  }
  function closePromo() { promoEl.hidden = true; pending = null; }
  promoCancelEl.addEventListener("click", function () { closePromo(); selected = null; legalCache = []; render(); });

  /* ---------- render ---------- */
  function render() {
    boardEl.innerHTML = "";
    var checkSq = inCheck(g, g.turn) ? kingSquare(g.board, g.turn) : null;
    var hintSet = {};
    if (selected) legalCache.forEach(function (m) { hintSet[m.tr + "," + m.tc] = m; });

    for (var i = 0; i < 64; i++) {
      var viewRow = Math.floor(i / 8), viewCol = i % 8;
      var r = flipped ? 7 - viewRow : viewRow;
      var c = flipped ? 7 - viewCol : viewCol;
      var sq = document.createElement("div");
      var light = (r + c) % 2 === 1;
      sq.className = "sq " + (light ? "sq--light" : "sq--dark");
      sq.setAttribute("role", "gridcell");
      sq.dataset.r = r; sq.dataset.c = c;

      // coordinates on edges
      if (viewCol === 0) { var rk = document.createElement("span"); rk.className = "sq__coord sq__rank"; rk.textContent = 8 - r; sq.appendChild(rk); }
      if (viewRow === 7) { var fl = document.createElement("span"); fl.className = "sq__coord sq__file"; fl.textContent = FILES[c]; sq.appendChild(fl); }

      var p = g.board[r][c];
      if (p) {
        var span = document.createElement("span");
        span.className = "pc pc--" + p[0];
        span.textContent = GLYPH[p[1]];
        sq.appendChild(span);
      }
      sq.setAttribute("aria-label", sqName(r, c) + (p ? " " + p : ""));

      if (selected && selected.r === r && selected.c === c) sq.classList.add("sq--selected");
      if (meta.lastMove && ((meta.lastMove.fr === r && meta.lastMove.fc === c) || (meta.lastMove.tr === r && meta.lastMove.tc === c))) sq.classList.add("sq--last");
      if (checkSq && checkSq[0] === r && checkSq[1] === c) sq.classList.add("sq--check");
      var hint = hintSet[r + "," + c];
      if (hint) {
        var h = document.createElement("span");
        h.className = "hint" + (hint.captured || hint.ep ? " hint--cap" : "");
        sq.appendChild(h);
      }
      sq.addEventListener("click", function () { onSquareClick(+this.dataset.r, +this.dataset.c); });
      boardEl.appendChild(sq);
    }
    renderSide();
  }

  function renderSide() {
    undoBtn.disabled = hist.length <= 1;
  }

  /* ---------- controls ---------- */
  function newGame() {
    g = startPosition();
    hist = [snapshot()];
    meta = { moveList: [], capturedW: [], capturedB: [], lastMove: null };
    selected = null; legalCache = []; gameOver = false; aiBusy = false; pending = null;
    refreshStatus();
    render();
    save();
    if (mode === "ai" && flipped && g.turn === "b") scheduleAi();
  }

  function undo() {
    if (hist.length <= 1) return;
    // step back; in AI mode undo a full pair (computer + human) when possible
    function pop() {
      hist.pop();
      var prev = hist[hist.length - 1];
      g = cloneState(prev.g);
      meta = JSON.parse(JSON.stringify(prev.meta));
    }
    pop();
    if (mode === "ai" && g.turn === "b" && hist.length > 1) pop();
    selected = null; legalCache = []; gameOver = false; pending = false;
    refreshStatus();
    render();
    save();
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
    if (e.key === "Escape") { closeRules(); if (pending) { closePromo(); selected = null; legalCache = []; render(); } return; }
    if (!modalEl.hidden || pending) return;          // modal / promotion owns the keyboard
    if (e.metaKey || e.ctrlKey || e.altKey) return;  // leave browser shortcuts alone
    var k = e.key.toLowerCase();
    if (k === "n") { e.preventDefault(); newGame(); }
    else if (k === "u") { e.preventDefault(); undo(); }
    else if (k === "r") { e.preventDefault(); openRules(); }
  });

  /* ---------- boot ---------- */
  function boot() {
    if (!load()) { g = startPosition(); hist = [snapshot()]; meta = { moveList: [], capturedW: [], capturedB: [], lastMove: null }; }
    modePvpEl.setAttribute("aria-selected", String(mode === "pvp"));
    modeAiEl.setAttribute("aria-selected", String(mode === "ai"));
    diffRowEl.hidden = mode !== "ai";
    Object.keys(diffBtns).forEach(function (k) { diffBtns[k].setAttribute("aria-selected", String(k === diff)); });
    if (!hist.length) hist = [snapshot()];
    refreshStatus();
    render();
    if (mode === "ai" && g.turn === "b" && !gameOver) scheduleAi();
  }
  boot();
})();
