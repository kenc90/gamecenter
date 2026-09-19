/* ===== FreeCell — game logic =====
   Single-file, dependency-free. Standard FreeCell rules:
   - One deck, 8 tableau columns (four of 6, four of 5), all face-up.
   - 4 free cells hold one card each; 4 foundations build up in suit.
   - Tableau builds down in alternating colours.
   - Supermove limit: (1 + empty cells) × 2^(empty columns) — the empty
     destination column itself doesn't count as scratch space.
   - Auto button ships safe cards home once everything is exposed.
   - Pointer drag & drop, double-click to foundation, undo, hint, timer,
     moves, home counter, persistence. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
  const RED = [false, true, true, false];
  const COLS = 8, CELLS = 4, FOUDS = 4;
  const SAVE_KEY = "gc-freecell-save";
  const STATS_KEY = "gc-freecell-stats";

  // ---------- DOM refs ----------
  const boardEl = document.getElementById("board");
  const tableEl = document.getElementById("table");
  const upperEl = document.getElementById("upper");
  const tabEl = document.getElementById("tab");
  const cellEls = Array.prototype.slice.call(document.querySelectorAll(".slot--cell"));
  const foundEls = Array.prototype.slice.call(document.querySelectorAll(".slot--foundation"));
  const movesEl = document.getElementById("moves");
  const timerEl = document.getElementById("timer");
  const homeEl = document.getElementById("home");
  const autoBtn = document.getElementById("autoBtn");
  const undoBtn = document.getElementById("undoBtn");
  const hintBtn = document.getElementById("hintBtn");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const winOverlay = document.getElementById("winOverlay");
  const winStats = document.getElementById("winStats");
  const winNew = document.getElementById("winNew");
  const toastEl = document.getElementById("toast");

  // ---------- Game state ----------
  let tableau = [];   // 8 arrays
  let cells = [];     // 4 arrays of 0..1 cards
  let foundations = [];// 4 arrays
  let history = [];
  let moves = 0;
  let seconds = 0;
  let started = false;
  let won = false;
  let timerId = null;
  let busy = false;   // blocks input during the Auto cascade

  let GEO = { cw: 84, ch: 119, offUp: 30, offDown: 14 };

  // ---------- Card helpers ----------
  function rankLabel(r) {
    if (r === 1) return "A";
    if (r === 11) return "J";
    if (r === 12) return "Q";
    if (r === 13) return "K";
    return String(r);
  }
  function makeDeck() {
    const d = [];
    for (let s = 0; s < 4; s++)
      for (let r = 1; r <= 13; r++)
        d.push({ suit: s, rank: r, up: true });
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
    const probe = cellEls[0];
    if (!probe) return;
    const cw = probe.clientWidth || GEO.cw;
    const ch = probe.clientHeight || GEO.ch;
    GEO = {
      cw: cw, ch: ch,
      offUp: Math.max(11, Math.round(ch * 0.27)),
      offDown: Math.max(6, Math.round(ch * 0.14)),
    };
  }
  function availHeight() {
    const upper = upperEl ? upperEl.offsetHeight + 26 : 160;
    return Math.max(GEO.ch * 2.5, tableEl.clientHeight - upper - 80);
  }

  // ---------- New game ----------
  function newGame() {
    stopTimer();
    const deck = shuffle(makeDeck());
    tableau = []; cells = []; foundations = [];
    for (let i = 0; i < COLS; i++) tableau.push([]);
    for (let i = 0; i < CELLS; i++) cells.push([]);
    for (let i = 0; i < FOUDS; i++) foundations.push([]);
    history = []; moves = 0; seconds = 0;
    started = false; won = false; busy = false;
    for (let i = 0; i < deck.length; i++) tableau[i % COLS].push(deck[i]);
    winOverlay.hidden = true;
    timerEl.textContent = "00:00";
    render();
  }

  // ---------- Snapshot / undo ----------
  function ser(arr) { return arr.map((c) => [c.suit, c.rank, c.up ? 1 : 0]); }
  function des(arr) { return arr.map((a) => ({ suit: a[0], rank: a[1], up: !!a[2] })); }
  function snapshot() {
    return JSON.stringify({
      t: tableau.map(ser), c: cells.map(ser), f: foundations.map(ser),
      moves, seconds, started,
    });
  }
  function pushHistory() {
    history.push(snapshot());
    if (history.length > 250) history.shift();
  }
  function undo() {
    if (busy || !history.length) return;
    const s = JSON.parse(history.pop());
    tableau = s.t.map(des); cells = s.c.map(des); foundations = s.f.map(des);
    moves = s.moves; seconds = s.seconds; started = s.started;
    won = false; winOverlay.hidden = true;
    if (!started) stopTimer();
    render();
  }

  // ---------- Rules ----------
  function altColor(a, b) { return isRed(a) !== isRed(b); }
  // Face-up alternating descending run from index (FreeCell lifts these).
  function validRun(arr, from) {
    for (let i = from; i < arr.length; i++) {
      if (!arr[i].up) return false;
      if (i > from) {
        const a = arr[i - 1], b = arr[i];
        if (!altColor(a, b) || b.rank !== a.rank - 1) return false;
      }
    }
    return true;
  }
  function canToFoundation(card, fi) {
    const f = foundations[fi];
    if (!f.length) return card.rank === 1;
    const top = f[f.length - 1];
    return top.suit === card.suit && card.rank === top.rank + 1;
  }
  function canToTableau(card, ci) {
    const t = tableau[ci];
    if (!t.length) return true; // any card/sequence head may fill an empty column
    const top = t[t.length - 1];
    return top.up && altColor(card, top) && card.rank === top.rank - 1;
  }
  function emptyCellCount() { return cells.filter((c) => !c.length).length; }
  function emptyColCount(excludeDest) {
    let n = tableau.filter((c) => !c.length).length;
    if (excludeDest && n > 0) n--; // the destination isn't scratch space
    return Math.max(0, n);
  }
  // Max cards liftable to a given destination kind.
  function maxMovable(toEmptyCol) {
    return (1 + emptyCellCount()) * Math.pow(2, emptyColCount(toEmptyCol));
  }

  // ---------- Move application ----------
  // from/to = {pile:'tableau'|'cell'|'foundation', col}
  function sourceArray(from) {
    if (from.pile === "tableau") return tableau[from.col];
    if (from.pile === "cell") return cells[from.col];
    if (from.pile === "foundation") return foundations[from.col];
    return [];
  }
  function applyMove(from, to, count) {
    const src = sourceArray(from);
    const cards = src.splice(src.length - count, count);
    if (!cards.length) return false;
    cards.forEach((c) => (c.up = true));
    const dst = to.pile === "tableau" ? tableau[to.col]
      : to.pile === "cell" ? cells[to.col] : foundations[to.col];
    dst.push.apply(dst, cards);
    moves++;
    return true;
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

    // Free cells
    cellEls.forEach((slot, ci) => {
      slot.innerHTML = "";
      if (cells[ci].length) {
        const el = cardEl(cells[ci][cells[ci].length - 1]);
        el.dataset.pile = "cell";
        el.dataset.col = String(ci);
        slot.appendChild(el);
      }
    });

    // Foundations
    foundEls.forEach((slot, fi) => {
      slot.innerHTML = "";
      const f = foundations[fi];
      if (f.length) {
        const el = cardEl(f[f.length - 1]);
        el.dataset.pile = "foundation";
        el.dataset.col = String(fi);
        slot.appendChild(el);
      }
    });

    // Tableau
    tabEl.innerHTML = "";
    for (let ci = 0; ci < COLS; ci++) {
      const col = document.createElement("div");
      col.className = "c-col";
      col.dataset.col = String(ci);
      const cards = tableau[ci];
      // All cards start face-up; compress long stacks to fit the viewport.
      const off = cards.length > 1
        ? Math.min(GEO.offUp, Math.max(8, (avail - GEO.ch) / (cards.length - 1)))
        : GEO.offUp;
      let y = 0, lastTop = 0;
      for (let i = 0; i < cards.length; i++) {
        const el = cardEl(cards[i]);
        el.dataset.pile = "tableau";
        el.dataset.col = String(ci);
        el.style.top = y + "px";
        el.style.zIndex = String(i + 1);
        lastTop = y;
        col.appendChild(el);
        y += off;
      }
      col.style.height = Math.max(GEO.ch, Math.round(lastTop + GEO.ch)) + "px";
      tabEl.appendChild(col);
    }

    // Stats + buttons
    const homeN = foundations.reduce((a, f) => a + f.length, 0);
    movesEl.textContent = String(moves);
    homeEl.textContent = homeN + "/52";
    undoBtn.disabled = history.length === 0 || busy;
    autoBtn.disabled = busy || !autoReady();
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
  function saveGame() {
    if (won) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1, moves, seconds, started,
        tableau: tableau.map(ser), cells: cells.map(ser),
        foundations: foundations.map(ser), history: history.slice(),
      }));
    } catch (e) {}
  }
  function clearSaved() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  function loadSaved() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return false; }
    if (!o || !Array.isArray(o.tableau) || o.tableau.length !== COLS ||
        !Array.isArray(o.cells) || o.cells.length !== CELLS ||
        !Array.isArray(o.foundations) || o.foundations.length !== FOUDS) return false;
    tableau = o.tableau.map(des); cells = o.cells.map(des);
    foundations = o.foundations.map(des);
    history = Array.isArray(o.history) ? o.history : [];
    moves = o.moves || 0; seconds = o.seconds || 0;
    started = !!o.started; won = false; busy = false;
    return true;
  }

  // ---------- Win / Auto ----------
  function checkWin() {
    return foundations.every((f) => f.length === 13);
  }
  // Auto makes sense once nothing is hidden and no card sits in a cell.
  function autoReady() {
    if (checkWin() || busy) return false;
    if (cells.some((c) => c.length)) return false;
    return tableau.every((col) => col.every((c) => c.up));
  }
  function autoComplete() {
    if (!autoReady()) { toast("Empty the cells and expose every card first"); return; }
    busy = true;
    const step = () => {
      if (checkWin()) { busy = false; onWin(); return; }
      // Move the lowest safe tableau top card home; stop politely if stuck.
      let best = null;
      for (let ci = 0; ci < COLS; ci++) {
        const col = tableau[ci];
        if (!col.length) continue;
        const top = col[col.length - 1];
        for (let fi = 0; fi < FOUDS; fi++) {
          if (canToFoundation(top, fi)) {
            if (!best || top.rank < best.rank) best = { ci: ci, fi: fi, rank: top.rank };
            break;
          }
        }
      }
      if (!best) { busy = false; render(); return; } // stuck — back to you
      pushHistory(); startTimer();
      applyMove({ pile: "tableau", col: best.ci }, { pile: "foundation", col: best.fi }, 1);
      render();
      setTimeout(step, 120);
    };
    step();
  }
  function onWin() {
    won = true; busy = false;
    stopTimer();
    clearSaved();
    const st = saveWin();
    winStats.textContent =
      "Solved in " + fmt(seconds) + " with " + moves + " moves" +
      " · best " + (st.bestTime != null ? fmt(st.bestTime) : fmt(seconds)) +
      " (" + st.wins + (st.wins === 1 ? " win)" : " wins)");
    render();
    winOverlay.hidden = false;
  }

  // ---------- Hint ----------
  function findHint() {
    for (let ci = 0; ci < COLS; ci++) {
      const col = tableau[ci];
      if (!col.length) continue;
      const top = col[col.length - 1];
      for (let fi = 0; fi < FOUDS; fi++)
        if (canToFoundation(top, fi)) return { sel: '.c-card[data-pile="tableau"][data-col="' + ci + '"]' };
    }
    for (let ci = 0; ci < CELLS; ci++) {
      if (!cells[ci].length) continue;
      const top = cells[ci][0];
      for (let fi = 0; fi < FOUDS; fi++)
        if (canToFoundation(top, fi)) return { sel: '.c-card[data-pile="cell"][data-col="' + ci + '"]' };
    }
    // tableau -> tableau / tableau -> cell (uncovering work)
    for (let ci = 0; ci < COLS; ci++) {
      const col = tableau[ci];
      for (let i = 0; i < col.length; i++) {
        if (!validRun(col, i)) continue;
        const len = col.length - i;
        for (let dj = 0; dj < COLS; dj++) {
          if (dj === ci) continue;
          const dest = tableau[dj];
          if (!dest.length && i === 0) continue; // moving a whole column to empty is pointless
          if (len <= maxMovable(!dest.length) && canToTableau(col[i], dj))
            return { sel: '.c-card[data-pile="tableau"][data-col="' + ci + '"]', index: i };
        }
        if (i > 0) {
          const freeCell = cells.findIndex((c) => !c.length);
          if (freeCell >= 0)
            return { sel: '.c-card[data-pile="tableau"][data-col="' + ci + '"]', index: i };
        }
      }
    }
    return null;
  }
  function showHint() {
    if (busy || won) return;
    const h = findHint();
    if (!h) { flashEl(hintBtn); return; }
    let node = document.querySelector(h.sel);
    if (h.index != null) {
      const nodes = Array.prototype.slice.call(document.querySelectorAll(h.sel));
      node = nodes[h.index] || node;
    }
    if (node) { node.classList.add("c-card--hint"); setTimeout(() => node.classList.remove("c-card--hint"), 1900); }
  }
  function flashEl(el) {
    el.classList.add("c-card--hint");
    setTimeout(() => el.classList.remove("c-card--hint"), 1900);
  }

  // ---------- Drag & drop ----------
  let drag = null;

  function onPointerDown(e) {
    if (busy || won) return;
    const cardNode = e.target.closest && e.target.closest(".c-card");
    if (!cardNode || !cardNode._card) return;
    const pile = cardNode.dataset.pile;

    let from, pickup;
    if (pile === "cell") {
      const col = +cardNode.dataset.col;
      if (cells[col][0] !== cardNode._card) return;
      from = { pile: "cell", col: col };
      pickup = [cardNode._card];
    } else if (pile === "foundation") {
      const col = +cardNode.dataset.col;
      const f = foundations[col];
      if (f[f.length - 1] !== cardNode._card) return;
      from = { pile: "foundation", col: col };
      pickup = [cardNode._card];
    } else if (pile === "tableau") {
      const col = +cardNode.dataset.col;
      const arr = tableau[col];
      const idx = arr.indexOf(cardNode._card);
      if (idx < 0 || !cardNode._card.up || !validRun(arr, idx)) return;
      from = { pile: "tableau", col: col };
      pickup = arr.slice(idx);
    } else return;

    startDrag(e, cardNode, from, pickup);
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
    const sel = from.pile === "tableau"
      ? '.c-card[data-pile="tableau"][data-col="' + from.col + '"]'
      : from.pile === "cell" ? '.c-card[data-pile="cell"][data-col="' + from.col + '"]'
      : '.c-card[data-pile="foundation"][data-col="' + from.col + '"]';
    const nodes = document.querySelectorAll(sel);
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
    const ok = target && legal(drag, target);
    drag.layer.remove();
    clearDropHighlight();
    const wasDrag = drag;
    drag = null;
    if (!ok) { render(); return; }
    pushHistory(); startTimer();
    applyMove(wasDrag.from, target, wasDrag.pickup.length);
    render();
    if (checkWin()) onWin();
  }

  // Is `drag` -> target a legal move (rules + supermove length)?
  function legal(d, target) {
    const n = d.pickup.length;
    if (target.pile === "foundation") {
      return n === 1 && d.from.pile !== "foundation" && canToFoundation(d.pickup[0], target.col);
    }
    if (target.pile === "cell") {
      return n === 1 && d.from.pile !== "cell" && !cells[target.col].length;
    }
    // tableau
    if (d.from.pile === "tableau" && d.from.col === target.col) return false;
    if (n > maxMovable(!tableau[target.col].length)) return false;
    return canToTableau(d.pickup[0], target.col);
  }

  function findDrop(x, y) {
    for (let ci = 0; ci < CELLS; ci++) {
      const r = cellEls[ci].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        return { pile: "cell", col: ci };
    }
    for (let fi = 0; fi < FOUDS; fi++) {
      const r = foundEls[fi].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        return { pile: "foundation", col: fi };
    }
    const cols = tabEl.querySelectorAll(".c-col");
    for (let ci = 0; ci < cols.length; ci++) {
      const r = cols[ci].getBoundingClientRect();
      if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4)
        return { pile: "tableau", col: ci };
    }
    return null;
  }
  let highlighted = null;
  function highlightDrop(x, y) {
    const target = findDrop(x, y);
    clearDropHighlight();
    if (!target || !drag || !legal(drag, target)) return;
    highlighted = target.pile === "tableau"
      ? tabEl.querySelector('.c-col[data-col="' + target.col + '"]')
      : target.pile === "cell" ? cellEls[target.col] : foundEls[target.col];
    if (highlighted) highlighted.classList.add(target.pile === "tableau" ? "c-col--drop" : "c-slot--drop");
  }
  function clearDropHighlight() {
    if (highlighted) { highlighted.classList.remove("c-col--drop", "c-slot--drop"); highlighted = null; }
  }

  // ---------- Double-click -> foundation ----------
  function onDoubleClick(e) {
    if (busy || won) return;
    const cardNode = e.target.closest && e.target.closest(".c-card");
    if (!cardNode || !cardNode._card) return;
    const pile = cardNode.dataset.pile;
    let from;
    if (pile === "tableau") {
      const col = +cardNode.dataset.col, arr = tableau[col];
      if (arr[arr.length - 1] !== cardNode._card) return;
      from = { pile: "tableau", col: col };
    } else if (pile === "cell") {
      const col = +cardNode.dataset.col;
      if (cells[col][0] !== cardNode._card) return;
      from = { pile: "cell", col: col };
    } else return;
    const card = cardNode._card;
    for (let fi = 0; fi < FOUDS; fi++) {
      if (canToFoundation(card, fi)) {
        pushHistory(); startTimer();
        applyMove(from, { pile: "foundation", col: fi }, 1);
        render();
        if (checkWin()) onWin();
        return;
      }
    }
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
  autoBtn.addEventListener("click", autoComplete);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  window.addEventListener("resize", () => { if (!drag) render(); });
  document.addEventListener("keydown", (e) => {
    if (rulesOpen()) {
      if (e.key === "Escape") closeRules();
      return; // swallow game shortcuts while the dialog is open
    }
    if (e.key === "n" || e.key === "N") newGame();
    else if (e.key === "u" || e.key === "U" || (e.ctrlKey && e.key === "z")) { e.preventDefault(); undo(); }
    else if (e.key === "h" || e.key === "H") showHint();
    else if (e.key === "a" || e.key === "A") autoComplete();
    else if (e.key === "r" || e.key === "R") openRules();
  });

  // Resume the saved game if there is one, otherwise deal a fresh board.
  if (loadSaved()) {
    render();
    timerEl.textContent = fmt(seconds);
    if (started && !won) startTimer();
  } else {
    newGame();
  }
})();
