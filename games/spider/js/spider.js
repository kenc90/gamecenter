/* ===== Spider Solitaire — game logic =====
   Single-file, dependency-free. Standard Spider rules:
   - 104 cards (two decks), 10 columns. Difficulty = 1/2/4 suits.
   - Build down by rank in ANY suit; lift only same-suit descending runs.
   - A finished K→A same-suit run is auto-collected to the runs tray.
   - Stock deals one row (10 cards); blocked while any column is empty.
   - Pointer-based drag & drop (mouse + touch), double-click to auto-place,
     undo, hint, score (500 start, -1/move, +100/run), timer, persistence. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
  const RED = [false, true, true, false];                 // by suit index
  const COLS = 10;
  const SAVE_KEY = "gc-spider-save";
  const STATS_KEY = "gc-spider-stats";

  // ---------- DOM refs ----------
  const boardEl = document.getElementById("board");
  const tableEl = document.getElementById("table");
  const upperEl = document.getElementById("upper");
  const tabEl = document.getElementById("tab");
  const stockEl = document.getElementById("stock");
  const runsEl = document.getElementById("runs");
  const movesEl = document.getElementById("moves");
  const timerEl = document.getElementById("timer");
  const scoreEl = document.getElementById("score");
  const runsCountEl = document.getElementById("runsCount");
  const undoBtn = document.getElementById("undoBtn");
  const hintBtn = document.getElementById("hintBtn");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const winOverlay = document.getElementById("winOverlay");
  const winStats = document.getElementById("winStats");
  const winNew = document.getElementById("winNew");
  const toastEl = document.getElementById("toast");
  const segBtns = Array.prototype.slice.call(document.querySelectorAll(".c-seg__b"));

  // ---------- Game state ----------
  let tableau = [];
  let stock = [];
  let runs = [];          // suit index per collected K→A run
  let history = [];
  let moves = 0;
  let score = 500;
  let seconds = 0;
  let started = false;
  let won = false;
  let timerId = null;
  let variant = 1;      // number of suits in play: 1, 2 or 4

  // Cached geometry (px) measured from the stock slot.
  let GEO = { cw: 70, ch: 100, offUp: 28, offDown: 13 };

  // ---------- Card helpers ----------
  function rankLabel(r) {
    if (r === 1) return "A";
    if (r === 11) return "J";
    if (r === 12) return "Q";
    if (r === 13) return "K";
    return String(r);
  }
  function suitsInPlay() {
    return variant === 1 ? [0] : variant === 2 ? [0, 1] : [0, 1, 2, 3];
  }
  function makeDeck() {
    // 104 cards = 8 full suit-runs split evenly across the suits in play.
    const suits = suitsInPlay();
    const sets = 8 / suits.length;
    const d = [];
    for (let s = 0; s < suits.length; s++)
      for (let set = 0; set < sets; set++)
        for (let r = 1; r <= 13; r++)
          d.push({ suit: suits[s], rank: r, up: false });
    return d;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  const isRed = (c) => RED[c.suit];

  // ---------- Toast ----------
  let toastId = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastId);
    toastId = setTimeout(() => { toastEl.hidden = true; }, 1700);
  }

  // ---------- Geometry ----------
  function measure() {
    const cw = stockEl.clientWidth || GEO.cw;
    const ch = stockEl.clientHeight || GEO.ch;
    GEO = {
      cw: cw, ch: ch,
      offUp: Math.max(10, Math.round(ch * 0.27)),
      offDown: Math.max(6, Math.round(ch * 0.13)),
    };
  }
  // Vertical space a column may use before its stack must compress.
  function availHeight() {
    const upper = upperEl ? upperEl.offsetHeight + 26 : 140; // + row margin
    return Math.max(GEO.ch * 2.5, tableEl.clientHeight - upper - 80);
  }

  // ---------- New game / dealing ----------
  function newGame() {
    stopTimer();
    const deck = shuffle(makeDeck());
    tableau = [];
    for (let i = 0; i < COLS; i++) tableau.push([]);
    runs = [];
    history = []; moves = 0; score = 500; seconds = 0;
    started = false; won = false;
    let k = 0;
    // First four columns get 6 cards, the rest 5 — exactly 54 dealt.
    for (let c = 0; c < COLS; c++) {
      const n = c < 4 ? 6 : 5;
      for (let i = 0; i < n; i++) tableau[c].push(deck[k++]);
      tableau[c][tableau[c].length - 1].up = true;
    }
    stock = deck.slice(k); // 50 cards = 5 deals
    winOverlay.hidden = true;
    timerEl.textContent = "00:00";
    render();
  }

  // ---------- Snapshot / undo ----------
  function ser(arr) { return arr.map((c) => [c.suit, c.rank, c.up ? 1 : 0]); }
  function des(arr) { return arr.map((a) => ({ suit: a[0], rank: a[1], up: !!a[2] })); }
  function snapshot() {
    return JSON.stringify({
      t: tableau.map(ser), s: ser(stock), r: runs.slice(),
      moves, score, seconds, started,
    });
  }
  function pushHistory() {
    history.push(snapshot());
    if (history.length > 250) history.shift();
  }
  function undo() {
    if (won || !history.length) return;
    const s = JSON.parse(history.pop());
    tableau = s.t.map(des); stock = des(s.s);
    runs = s.r.slice();
    moves = s.moves; score = s.score; seconds = s.seconds; started = s.started;
    if (!started) stopTimer();
    render();
  }

  // ---------- Movement validation ----------
  // Lift a run only when it is face-up, same-suit and descending by 1.
  function validRun(arr, from) {
    for (let i = from; i < arr.length; i++) {
      if (!arr[i].up) return false;
      if (i > from) {
        const a = arr[i - 1], b = arr[i];
        if (b.suit !== a.suit || b.rank !== a.rank - 1) return false;
      }
    }
    return true;
  }
  function canToTableau(card, ci) {
    const t = tableau[ci];
    if (!t.length) return true; // any card may fill an empty column
    const top = t[t.length - 1];
    return top.up && top.rank === card.rank + 1;
  }

  // ---------- Move application ----------
  function applyMove(from, to, count) {
    const cards = tableau[from.col].splice(tableau[from.col].length - count, count);
    if (!cards.length) return false;
    cards.forEach((c) => (c.up = true));
    tableau[to.col] = tableau[to.col].concat(cards);
    // Reveal the newly exposed card.
    const src = tableau[from.col];
    if (src.length && !src[src.length - 1].up) src[src.length - 1].up = true;
    moves++;
    score = Math.max(0, score - 1);
    return true;
  }

  // Sweep every column tail for finished K→A same-suit runs.
  function collectRuns() {
    let found = true;
    while (found) {
      found = false;
      for (let ci = 0; ci < COLS; ci++) {
        const col = tableau[ci];
        if (col.length < 10) continue;
        const start = col.length - 10;
        if (!col[start].up || col[start].rank !== 13) continue;
        let ok = true, suit = col[start].suit;
        for (let i = 1; i < 10; i++) {
          const c = col[start + i];
          if (!c.up || c.suit !== suit || c.rank !== 13 - i) { ok = false; break; }
        }
        if (!ok) continue;
        col.splice(start, 10);
        runs.push(suit);
        score += 100;
        if (col.length && !col[col.length - 1].up) col[col.length - 1].up = true;
        found = true;
      }
    }
  }

  // ---------- Stock deal ----------
  function deal() {
    if (won) return;
    if (!stock.length) { if (tableau.some((c) => !c.length)) toast("Fill the empty columns first"); return; }
    if (tableau.some((c) => !c.length)) { toast("Fill empty columns before dealing"); return; }
    pushHistory(); startTimer();
    for (let ci = 0; ci < COLS; ci++) {
      const c = stock.pop();
      c.up = true;
      tableau[ci].push(c);
    }
    moves++;
    collectRuns();
    render();
    checkWin();
  }

  // ---------- Rendering ----------
  function cardEl(card) {
    const el = document.createElement("div");
    el.className = "c-card " + (card.up ? "c-card--up" : "c-card--down") + (card.up && isRed(card) ? " c-card--red" : "");
    if (card.up) {
      const g = GLYPH[card.suit], rl = rankLabel(card.rank);
      el.innerHTML =
        '<div class="c-card__corner c-card__tl"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>' +
        '<div class="c-card__pip">' + g + '</div>' +
        '<div class="c-card__corner c-card__br"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>';
    }
    el._card = card;
    return el;
  }

  function render() {
    measure();
    const avail = availHeight();

    // Stock: face-down back + remaining deals label.
    stockEl.innerHTML = "";
    if (stock.length) {
      const b = cardEl({ suit: 0, rank: 1, up: false });
      b.dataset.pile = "stock";
      const n = document.createElement("span");
      n.className = "sp-stock-n";
      n.textContent = Math.ceil(stock.length / COLS) + (Math.ceil(stock.length / COLS) === 1 ? " deal" : " deals");
      stockEl.appendChild(b);
      stockEl.appendChild(n);
      stockEl.removeAttribute("data-empty");
    } else {
      stockEl.setAttribute("data-empty", "empty");
    }

    // Runs tray.
    runsEl.innerHTML = "";
    runs.forEach((s) => {
      const t = document.createElement("div");
      t.className = "sp-run" + (RED[s] ? " sp-run--red" : "");
      t.textContent = GLYPH[s];
      runsEl.appendChild(t);
    });

    // Tableau — per-column offsets compress so long stacks fit the viewport.
    tabEl.innerHTML = "";
    for (let ci = 0; ci < COLS; ci++) {
      const col = document.createElement("div");
      col.className = "c-col";
      col.dataset.col = String(ci);
      const cards = tableau[ci];

      let down = 0, upCount = 0;
      cards.forEach((c) => (c.up ? upCount++ : down++));
      let need = down * GEO.offDown + Math.max(0, upCount - 1) * GEO.offUp + GEO.ch;
      const k = need > avail && cards.length > 1
        ? Math.max(0.12, (avail - GEO.ch) / (need - GEO.ch)) : 1;

      let y = 0, lastTop = 0;
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const el = cardEl(card);
        el.dataset.pile = "tableau";
        el.dataset.col = String(ci);
        el.style.top = Math.round(y) + "px";
        el.style.zIndex = String(i + 1);
        lastTop = y;
        col.appendChild(el);
        y += (card.up ? GEO.offUp : GEO.offDown) * k;
      }
      col.style.height = Math.max(GEO.ch, Math.round(lastTop + GEO.ch)) + "px";
      tabEl.appendChild(col);
    }

    // Stats + buttons
    movesEl.textContent = String(moves);
    scoreEl.textContent = String(score);
    runsCountEl.textContent = runs.length + "/8";
    undoBtn.disabled = history.length === 0;
    winOverlay.hidden = !won;

    saveGame();
  }

  // ---------- Timer ----------
  function startTimer() {
    if (timerId) return;
    started = true;
    timerId = setInterval(() => {
      seconds++;
      timerEl.textContent = fmt(seconds);
    }, 1000);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
  function fmt(s) {
    const m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  // ---------- Persistence ----------
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { wins: 0, bestTime: null }; }
    catch (e) { return { wins: 0, bestTime: null }; }
  }
  function saveWin() {
    const st = loadStats();
    st.wins = (st.wins || 0) + 1;
    if (st.bestTime == null || seconds < st.bestTime) st.bestTime = seconds;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch (e) {}
    return st;
  }
  function serialize() {
    return {
      v: 2, variant: variant, moves: moves, score: score,
      seconds: seconds, started: started,
      tableau: tableau.map(ser), stock: ser(stock), runs: runs.slice(),
      history: history.slice(),
    };
  }
  function saveGame() {
    if (won) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); } catch (e) {}
  }
  function clearSaved() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }
  function loadSaved() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return false; }
    if (!o || !Array.isArray(o.tableau) || o.tableau.length !== COLS) return false;
    variant = [1, 2, 4].indexOf(o.variant) !== -1 ? o.variant : 1;
    tableau = o.tableau.map(des);
    stock = des(o.stock || []);
    runs = Array.isArray(o.runs) ? o.runs : [];
    history = Array.isArray(o.history) ? o.history : [];
    moves = o.moves || 0; score = o.score == null ? 500 : o.score;
    seconds = o.seconds || 0; started = !!o.started;
    won = false;
    syncSeg();
    return true;
  }
  function syncSeg() {
    segBtns.forEach((b) => {
      const on = +b.dataset.suits === variant;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  // ---------- Win ----------
  function checkWin() {
    if (runs.length < 8) return;
    won = true;
    stopTimer();
    clearSaved();
    const st = saveWin();
    winStats.textContent =
      "Solved in " + fmt(seconds) + " with " + moves + " moves · score " + score +
      " · best " + (st.bestTime != null ? fmt(st.bestTime) : fmt(seconds)) +
      " (" + st.wins + (st.wins === 1 ? " win)" : " wins)");
    render();
    winOverlay.hidden = false;
  }

  // ---------- Hint ----------
  // Prefer moves that expose a face-down card, then same-suit joins.
  function findHint() {
    let fallback = null;
    for (let ci = 0; ci < COLS; ci++) {
      const col = tableau[ci];
      for (let i = 0; i < col.length; i++) {
        if (!col[i].up || !validRun(col, i)) continue;
        for (let dj = 0; dj < COLS; dj++) {
          if (dj === ci || !canToTableau(col[i], dj)) continue;
          const dest = tableau[dj];
          if (dest.length && dest[dest.length - 1].suit === col[i].suit) {
            return { col: ci, index: i }; // perfect join
          }
          if (i > 0 && !dest.length) return { col: ci, index: i }; // frees a hidden card
          if (!fallback) fallback = { col: ci, index: i };
        }
      }
    }
    if (fallback) return fallback;
    if (stock.length) return { deal: true };
    return null;
  }
  function showHint() {
    if (won) return;
    const h = findHint();
    if (!h) { toast("No moves left — undo or deal"); return; }
    if (h.deal) { flash(stockEl); return; }
    const nodes = document.querySelectorAll(
      '.c-card[data-pile="tableau"][data-col="' + h.col + '"]');
    const node = nodes[h.index];
    if (node) { node.classList.add("c-card--hint"); setTimeout(() => node.classList.remove("c-card--hint"), 1900); }
  }
  function flash(el) {
    el.classList.add("c-card--hint");
    setTimeout(() => el.classList.remove("c-card--hint"), 1900);
  }

  // ---------- Drag & drop ----------
  let drag = null;

  function onPointerDown(e) {
    if (won) return;
    const t = e.target;
    if (t.closest && t.closest("#stock")) { deal(); return; }

    const cardNode = t.closest && t.closest(".c-card");
    if (!cardNode || !cardNode._card) return;
    if (cardNode.dataset.pile !== "tableau") return;
    const col = +cardNode.dataset.col;
    const arr = tableau[col];
    const idx = arr.indexOf(cardNode._card);
    if (idx < 0 || !cardNode._card.up) return;
    if (!validRun(arr, idx)) return;
    startDrag(e, cardNode, { pile: "tableau", col: col }, arr.slice(idx));
  }

  function startDrag(e, anchor, from, pickup) {
    const rect = anchor.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.className = "drag-layer";
    // The layer lives on <body>, outside .c-board where --cw/--ch live.
    layer.style.setProperty("--cw", GEO.cw + "px");
    layer.style.setProperty("--ch", GEO.ch + "px");
    pickup.forEach((card, i) => {
      const el = cardEl(card);
      el.style.left = "0";
      el.style.top = i * GEO.offUp + "px";
      el.style.zIndex = String(i + 1);
      layer.appendChild(el);
    });
    document.body.appendChild(layer);
    markMoving(from, pickup.length, true);

    drag = {
      from: from, pickup: pickup, layer: layer,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
    };
    positionLayer(e.clientX, e.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }
  function positionLayer(x, y) {
    if (!drag) return;
    drag.layer.style.transform =
      "translate(" + (x - drag.grabX) + "px," + (y - drag.grabY) + "px)";
  }
  function markMoving(from, count, on) {
    const nodes = document.querySelectorAll(
      '.c-card[data-pile="tableau"][data-col="' + from.col + '"]');
    for (let i = nodes.length - count; i < nodes.length; i++)
      if (nodes[i]) nodes[i].classList.toggle("c-card--moving", on);
  }
  function onPointerMove(e) { positionLayer(e.clientX, e.clientY); highlightDrop(e.clientX, e.clientY); }
  function onPointerUp(e) {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (!drag) return;
    const target = findDrop(e.clientX, e.clientY);
    const ok = target && attemptDrop(target);
    drag.layer.remove();
    clearDropHighlight();
    const wasDrag = drag;
    drag = null;
    if (!ok) { render(); return; }
    pushHistory(); startTimer();
    applyMove(wasDrag.from, target, wasDrag.pickup.length);
    collectRuns();
    render();
    checkWin();
  }
  function attemptDrop(target) {
    if (target.col === drag.from.col) return false;
    return canToTableau(drag.pickup[0], target.col);
  }
  function findDrop(x, y) {
    const cols = tabEl.querySelectorAll(".c-col");
    for (let ci = 0; ci < cols.length; ci++) {
      const r = cols[ci].getBoundingClientRect();
      if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 8)
        return { pile: "tableau", col: ci };
    }
    return null;
  }
  let highlighted = null;
  function highlightDrop(x, y) {
    const target = findDrop(x, y);
    clearDropHighlight();
    if (!target || !drag) return;
    if (target.col === drag.from.col || !canToTableau(drag.pickup[0], target.col)) return;
    highlighted = tabEl.querySelector('.c-col[data-col="' + target.col + '"]');
    if (highlighted) highlighted.classList.add("c-col--drop");
  }
  function clearDropHighlight() {
    if (highlighted) { highlighted.classList.remove("c-col--drop"); highlighted = null; }
  }

  // ---------- Double-click -> best fitting column ----------
  function onDoubleClick(e) {
    if (won) return;
    const cardNode = e.target.closest && e.target.closest(".c-card");
    if (!cardNode || !cardNode._card) return;
    if (cardNode.dataset.pile !== "tableau") return;
    const fromCol = +cardNode.dataset.col;
    const arr = tableau[fromCol];
    const card = arr[arr.length - 1];
    if (card !== cardNode._card || !card.up) return; // top card only
    let empty = -1, join = -1, plain = -1;
    for (let dj = 0; dj < COLS; dj++) {
      if (dj === fromCol) continue;
      const dest = tableau[dj];
      if (!dest.length) { if (empty < 0 && fromCol !== dj) empty = dj; continue; }
      const top = dest[dest.length - 1];
      if (top.up && top.rank === card.rank + 1) {
        if (top.suit === card.suit) { join = dj; break; }
        if (plain < 0) plain = dj;
      }
    }
    const to = join >= 0 ? join : plain >= 0 ? plain : empty;
    if (to < 0) return;
    pushHistory(); startTimer();
    applyMove({ pile: "tableau", col: fromCol }, { pile: "tableau", col: to }, 1);
    collectRuns();
    render();
    checkWin();
  }

  // ---------- Rules modal ----------
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  function rulesOpen() { return rulesModal && !rulesModal.hidden; }

  // ---------- Wire up ----------
  boardEl.addEventListener("pointerdown", onPointerDown);
  boardEl.addEventListener("dblclick", onDoubleClick);
  newBtn.addEventListener("click", newGame);
  winNew.addEventListener("click", newGame);
  undoBtn.addEventListener("click", undo);
  hintBtn.addEventListener("click", showHint);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  segBtns.forEach((b) => b.addEventListener("click", () => {
    const v = +b.dataset.suits;
    if (v === variant) return;
    variant = v;
    syncSeg();
    newGame(); // difficulty changes the deck — a fresh game is the only sane way
  }));
  window.addEventListener("resize", () => { if (!drag) render(); });
  document.addEventListener("keydown", (e) => {
    if (rulesOpen()) {
      if (e.key === "Escape") closeRules();
      return; // swallow game shortcuts while the dialog is open
    }
    if (e.key === "n" || e.key === "N") newGame();
    else if (e.key === "u" || e.key === "U" || (e.ctrlKey && e.key === "z")) { e.preventDefault(); undo(); }
    else if (e.key === "h" || e.key === "H") showHint();
    else if (e.key === "r" || e.key === "R") openRules();
    else if (e.key === " ") { e.preventDefault(); deal(); }
  });

  // Resume the saved game if there is one, otherwise deal a fresh web.
  if (loadSaved()) {
    render();
    timerEl.textContent = fmt(seconds);
    if (started && !won) startTimer();
  } else {
    syncSeg();
    newGame();
  }
})();
