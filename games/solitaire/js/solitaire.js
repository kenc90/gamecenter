/* ===== Solitaire (Klondike) — game logic =====
   Single-file, dependency-free. Standard Klondike rules:
   - 7 tableau columns, descending alternate-colour builds.
   - 4 foundations, ascending by suit from Ace.
   - Stock -> Waste (draw 1 or 3), recycle when empty.
   - Pointer-based drag & drop (mouse + touch) with click-to-select fallback
     is not needed because dragging covers both; double-click auto-finishes a
     card to its foundation. Undo, hint, score, timer and win detection. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const SUITS = ["spades", "hearts", "diamonds", "clubs"];
  const GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
  const RED = [false, true, true, false];                  // by suit index
  const FOUND_GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"];
  const STATS_KEY = "gc-solitaire-stats";
  const SAVE_KEY = "gc-solitaire-save"; // resumable in-progress game

  // ---------- DOM refs ----------
  const boardEl = document.getElementById("board");
  const tabEl = document.getElementById("tab");
  const stockEl = document.getElementById("stock");
  const wasteEl = document.getElementById("waste");
  const foundEls = Array.prototype.slice.call(document.querySelectorAll(".slot--foundation"));
  const movesEl = document.getElementById("moves");
  const timerEl = document.getElementById("timer");
  const scoreEl = document.getElementById("score");
  const drawModeBtn = document.getElementById("drawMode");
  const undoBtn = document.getElementById("undoBtn");
  const hintBtn = document.getElementById("hintBtn");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const winOverlay = document.getElementById("winOverlay");
  const winStats = document.getElementById("winStats");
  const winNew = document.getElementById("winNew");

  // ---------- Game state ----------
  let stock = [];
  let waste = [];
  let foundations = [[], [], [], []];
  let tableau = [[], [], [], [], [], [], []];
  let history = [];
  let moves = 0;
  let score = 0;
  let drawCount = 1;
  let started = false;
  let won = false;
  let seconds = 0;
  let timerId = null;
  let busy = false; // blocks input during auto-complete

  // Cached geometry (px) measured from a slot so the layout stays responsive.
  let GEO = { cw: 80, ch: 113, offUp: 32, offDown: 16, fan: 24 };

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
        d.push({ suit: s, rank: r, up: false });
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
  const keyOf = (c) => c.suit * 13 + c.rank;

  // ---------- Geometry ----------
  function measure() {
    const probe = boardEl.querySelector(".slot");
    if (!probe) return;
    const cw = probe.clientWidth || GEO.cw;
    const ch = probe.clientHeight || GEO.ch;
    GEO = {
      cw: cw, ch: ch,
      offUp: Math.max(12, Math.round(ch * 0.30)),
      offDown: Math.max(7, Math.round(ch * 0.15)),
      fan: Math.round(cw * 0.26),
    };
  }

  // ---------- New game / dealing ----------
  function newGame() {
    stopTimer();
    const deck = shuffle(makeDeck());
    stock = []; waste = []; foundations = [[], [], [], []];
    tableau = [[], [], [], [], [], [], []];
    history = []; moves = 0; score = 0; seconds = 0;
    started = false; won = false; busy = false;
    let k = 0;
    for (let col = 0; col < 7; col++) {
      for (let n = 0; n <= col; n++) {
        const card = deck[k++];
        card.up = (n === col); // only the last dealt card is face-up
        tableau[col].push(card);
      }
    }
    stock = deck.slice(k);
    stock.forEach((c) => (c.up = false));
    winOverlay.hidden = true;
    timerEl.textContent = "00:00";
    render();
  }

  // ---------- Snapshot / undo ----------
  function snapshot() {
    return JSON.stringify({
      stock: ser(stock), waste: ser(waste),
      f: foundations.map(ser), t: tableau.map(ser),
      moves, score, seconds, started,
    });
  }
  function ser(arr) { return arr.map((c) => [c.suit, c.rank, c.up ? 1 : 0]); }
  function des(arr) { return arr.map((a) => ({ suit: a[0], rank: a[1], up: !!a[2] })); }
  function pushHistory() {
    history.push(snapshot());
    if (history.length > 200) history.shift();
  }
  function undo() {
    if (busy || !history.length) return;
    const s = JSON.parse(history.pop());
    stock = des(s.stock); waste = des(s.waste);
    foundations = s.f.map(des); tableau = s.t.map(des);
    moves = s.moves; score = s.score; seconds = s.seconds; started = s.started;
    won = false; winOverlay.hidden = true;
    if (!started) stopTimer();
    render();
  }

  // ---------- Movement validation ----------
  function canToFoundation(card, fi) {
    const f = foundations[fi];
    if (!f.length) return card.rank === 1;
    const top = f[f.length - 1];
    return top.suit === card.suit && card.rank === top.rank + 1;
  }
  function canToTableau(card, ci) {
    const t = tableau[ci];
    if (!t.length) return card.rank === 13;
    const top = t[t.length - 1];
    return top.up && isRed(card) !== isRed(top) && card.rank === top.rank - 1;
  }
  function validRun(arr, from) {
    for (let i = from; i < arr.length; i++) {
      if (!arr[i].up) return false;
      if (i > from) {
        const a = arr[i - 1], b = arr[i];
        if (isRed(a) === isRed(b) || b.rank !== a.rank - 1) return false;
      }
    }
    return true;
  }

  // ---------- Move application ----------
  // from = {pile:'tableau'|'waste'|'foundation', col}  to = {pile:'tableau'|'foundation', col}
  function applyMove(from, to, count) {
    const cards = take(from, count);
    if (!cards.length) return false;
    place(to, cards);
    flipsFor(from);
    moves++;
    addScore(from.pile, to.pile, cards[0], from.col);
    return true;
  }
  function take(from, count) {
    if (from.pile === "waste") return waste.splice(Math.max(0, waste.length - count), count);
    if (from.pile === "foundation") return foundations[from.col].splice(Math.max(0, foundations[from.col].length - count), count);
    if (from.pile === "tableau") return tableau[from.col].splice(Math.max(0, tableau[from.col].length - count), count);
    return [];
  }
  function place(to, cards) {
    if (to.pile === "foundation") foundations[to.col] = foundations[to.col].concat(cards);
    else if (to.pile === "tableau") tableau[to.col] = tableau[to.col].concat(cards);
    else if (to.pile === "waste") waste = waste.concat(cards);
    cards.forEach((c) => (c.up = true));
  }
  // Reveal the newly exposed tableau card (and award the flip bonus).
  function flipsFor(from) {
    if (from.pile !== "tableau") return;
    const col = tableau[from.col];
    if (col.length && !col[col.length - 1].up) {
      col[col.length - 1].up = true;
      bumpScore(5);
    }
  }
  function addScore(fromPile, toPile, card, fromCol) {
    let d = 0;
    if (fromPile === "waste" && toPile === "foundation") d = 10;
    else if (fromPile === "tableau" && toPile === "foundation") d = 10;
    else if (fromPile === "waste" && toPile === "tableau") d = 5;
    else if (fromPile === "foundation" && toPile === "tableau") d = -15;
    else if (fromPile === "tableau" && toPile === "tableau" && card.rank === 13) d = 3;
    bumpScore(d);
  }
  function bumpScore(d) { score = Math.max(0, score + d); }

  // ---------- Stock draw / recycle ----------
  function draw() {
    if (busy || won) return;
    if (!stock.length) {
      if (!waste.length) return;
      pushHistory(); startTimer();
      stock = waste.reverse().map((c) => ((c.up = false), c));
      waste = [];
      bumpScore(-100);
      moves++;
      render();
      return;
    }
    pushHistory(); startTimer();
    const n = Math.min(drawCount, stock.length);
    for (let i = 0; i < n; i++) {
      const c = stock.pop();
      c.up = true;
      waste.push(c);
    }
    moves++;
    render();
  }

  // ---------- Rendering ----------
  function cardEl(card) {
    const el = document.createElement("div");
    el.className = "card " + (card.up ? "card--up" : "card--down") + (card.up && isRed(card) ? " card--red" : "");
    if (card.up) {
      const g = GLYPH[card.suit], rl = rankLabel(card.rank);
      el.innerHTML =
        '<div class="card__corner card__tl"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>' +
        '<div class="card__pip">' + g + '</div>' +
        '<div class="card__corner card__br"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>';
    }
    el._card = card;
    return el;
  }

  function render() {
    measure();

    // Stock
    stockEl.innerHTML = "";
    if (stock.length) {
      stockEl.removeAttribute("data-empty");
      const b = cardEl({ suit: 0, rank: 1, up: false });
      b.dataset.pile = "stock";
      stockEl.appendChild(b);
    } else {
      stockEl.setAttribute("data-empty", waste.length ? "replay" : "empty");
    }

    // Waste — fan up to 3 recent cards
    wasteEl.innerHTML = "";
    const showN = Math.min(3, waste.length);
    for (let i = waste.length - showN; i < waste.length; i++) {
      const el = cardEl(waste[i]);
      el.dataset.pile = "waste";
      el.style.left = (i - (waste.length - showN)) * GEO.fan + "px";
      el.style.zIndex = String(i + 1);
      wasteEl.appendChild(el);
    }

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
    for (let ci = 0; ci < 7; ci++) {
      const col = document.createElement("div");
      col.className = "col";
      col.dataset.col = String(ci);
      let y = 0, lastTop = 0;
      for (let i = 0; i < tableau[ci].length; i++) {
        const card = tableau[ci][i];
        const el = cardEl(card);
        el.dataset.pile = "tableau";
        el.dataset.col = String(ci);
        el.style.top = y + "px";
        el.style.zIndex = String(i + 1);
        lastTop = y;
        col.appendChild(el);
        y += card.up ? GEO.offUp : GEO.offDown;
      }
      col.style.height = Math.max(GEO.ch, lastTop + GEO.ch) + "px";
      tabEl.appendChild(col);
    }

    // Stats + buttons
    movesEl.textContent = String(moves);
    scoreEl.textContent = String(score);
    undoBtn.disabled = history.length === 0 || busy;
    drawModeBtn.textContent = "Draw " + drawCount;
    winOverlay.hidden = !won;

    saveGame(); // keep the resumable snapshot in sync with every change
  }

  // ---------- Timer ----------
  function startTimer() {
    if (timerId) return;           // already ticking
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

  // ---------- Resumable game state ----------
  function serialize() {
    return {
      v: 1, drawCount: drawCount, moves: moves, score: score,
      seconds: seconds, started: started, won: won,
      stock: ser(stock), waste: ser(waste),
      foundations: foundations.map(ser), tableau: tableau.map(ser),
      history: history.slice(),
    };
  }
  function saveGame() {
    if (won) return; // finished games are cleared, not saved
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
    if (!o || !Array.isArray(o.tableau) || o.tableau.length !== 7 ||
        !Array.isArray(o.foundations) || o.foundations.length !== 4) return false;
    stock = des(o.stock || []); waste = des(o.waste || []);
    foundations = o.foundations.map(des); tableau = o.tableau.map(des);
    history = Array.isArray(o.history) ? o.history : [];
    drawCount = o.drawCount === 3 ? 3 : 1;
    moves = o.moves || 0; score = o.score || 0; seconds = o.seconds || 0;
    started = !!o.started; won = false; busy = false;
    return true;
  }

  // ---------- Win / auto-complete ----------
  function checkWin() {
    return foundations.every((f) => f.length === 13);
  }
  function autoCompleteReady() {
    if (checkWin()) return true;
    // Auto-finish only makes sense once every card is exposed and stock is gone.
    if (stock.length || waste.length) return false;
    return tableau.every((col) => col.every((c) => c.up));
  }
  function onWin() {
    won = true; busy = false;
    stopTimer();
    clearSaved();                 // finished game shouldn't auto-resume
    const st = saveWin();
    winStats.textContent =
      "Solved in " + fmt(seconds) + " with " + moves + " moves · score " + score +
      " · best " + (st.bestTime != null ? fmt(st.bestTime) : fmt(seconds)) +
      " (" + st.wins + (st.wins === 1 ? " win)" : " wins)");
    winOverlay.hidden = false;
  }
  function autoComplete() {
    if (busy) return;
    busy = true;
    const step = () => {
      if (checkWin()) { busy = false; onWin(); return; }
      // find any top tableau card that fits a foundation
      for (let ci = 0; ci < 7; ci++) {
        const col = tableau[ci];
        if (!col.length) continue;
        const top = col[col.length - 1];
        for (let fi = 0; fi < 4; fi++) {
          if (canToFoundation(top, fi)) {
            pushHistory();
            applyMove({ pile: "tableau", col: ci }, { pile: "foundation", col: fi }, 1);
            render();
            setTimeout(step, 130);
            return;
          }
        }
      }
      busy = false; // stuck (shouldn't happen when fully revealed)
    };
    step();
  }

  // ---------- Hint ----------
  function findHint() {
    // tableau -> foundation
    for (let ci = 0; ci < 7; ci++) {
      const col = tableau[ci];
      if (col.length && col[col.length - 1].up) {
        const top = col[col.length - 1];
        for (let fi = 0; fi < 4; fi++)
          if (canToFoundation(top, fi)) return { sel: '.card[data-pile="tableau"][data-col="' + ci + '"]' };
      }
    }
    // waste -> foundation
    if (waste.length) {
      const top = waste[waste.length - 1];
      for (let fi = 0; fi < 4; fi++)
        if (canToFoundation(top, fi)) return { sel: '.card[data-pile="waste"]' };
    }
    // tableau -> tableau (longest beneficial run first)
    for (let ci = 0; ci < 7; ci++) {
      const col = tableau[ci];
      for (let i = 0; i < col.length; i++) {
        if (!col[i].up) continue;
        if (!validRun(col, i)) continue;
        for (let dj = 0; dj < 7; dj++) {
          if (dj === ci) continue;
          if (canToTableau(col[i], dj) && (col[i].rank !== 13 || i > 0))
            return { sel: '.card[data-pile="tableau"][data-col="' + ci + '"]', index: i };
        }
      }
    }
    if (stock.length) return { stock: true };
    return null;
  }
  function showHint() {
    if (busy || won) return;
    const h = findHint();
    if (!h) { flash(hintBtn); return; }
    if (h.stock) { flash(stockEl); return; }
    let node = document.querySelector(h.sel);
    if (h.index != null) {
      const nodes = document.querySelectorAll(h.sel);
      // data-col selects all cards in the column; pick the right one by top offset order
      const colCards = Array.prototype.slice.call(nodes);
      node = colCards[h.index] || node;
    }
    if (node) { node.classList.add("card--hint"); setTimeout(() => node.classList.remove("card--hint"), 1900); }
  }
  function flash(el) {
    el.classList.add("card--hint");
    setTimeout(() => el.classList.remove("card--hint"), 1900);
  }

  // ---------- Drag & drop ----------
  let drag = null; // {pickup:[], from:{pile,col}, layer, grabX, grabY}

  function onPointerDown(e) {
    if (busy || won) return;
    const t = e.target;

    if (t.closest && t.closest("#stock")) { draw(); return; }

    const cardNode = t.closest && t.closest(".card");
    if (!cardNode || !cardNode._card) return;
    const pile = cardNode.dataset.pile;

    let from, count, startIdx;
    if (pile === "waste") {
      from = { pile: "waste" }; count = 1; startIdx = waste.length - 1;
      if (cardNode._card !== waste[waste.length - 1]) return; // only the top waste card
    } else if (pile === "foundation") {
      const col = +cardNode.dataset.col;
      from = { pile: "foundation", col: col }; count = 1;
      if (cardNode._card !== foundations[col][foundations[col].length - 1]) return;
    } else if (pile === "tableau") {
      const col = +cardNode.dataset.col;
      const arr = tableau[col];
      const idx = arr.indexOf(cardNode._card);
      if (idx < 0 || !cardNode._card.up) return;
      if (!validRun(arr, idx)) return; // can't lift an unstacked/broken sequence
      from = { pile: "tableau", col: col }; count = arr.length - idx;
    } else {
      return;
    }

    const pickup = sourceArray(from).slice(-count);
    startDrag(e, cardNode, from, pickup);
  }

  function sourceArray(from) {
    if (from.pile === "waste") return waste;
    if (from.pile === "foundation") return foundations[from.col];
    if (from.pile === "tableau") return tableau[from.col];
    return [];
  }

  function startDrag(e, anchor, from, pickup) {
    // No preventDefault(): cards already set user-select/touch-action to none,
    // and cancelling pointerdown can suppress the double-click that follows.
    const rect = anchor.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.className = "drag-layer";
    // The layer is appended to <body>, outside .board where --cw/--ch live, so
    // copy the geometry vars onto it; otherwise the cloned cards collapse to 0.
    layer.style.setProperty("--cw", GEO.cw + "px");
    layer.style.setProperty("--ch", GEO.ch + "px");
    pickup.forEach((card, i) => {
      const el = cardEl(card);
      el.classList.add("card--drag");
      el.style.left = "0";
      el.style.top = i * GEO.offUp + "px";
      el.style.zIndex = String(i + 1);
      layer.appendChild(el);
    });
    document.body.appendChild(layer);

    // Dim the cards left behind in their original pile.
    markMoving(from, pickup.length, true);

    drag = {
      from: from, pickup: pickup, layer: layer,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      offStack: pickup.length,
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
      ? '.card[data-pile="tableau"][data-col="' + from.col + '"]'
      : from.pile === "waste" ? '.card[data-pile="waste"]'
      : '.card[data-pile="foundation"][data-col="' + from.col + '"]';
    const nodes = document.querySelectorAll(sel);
    for (let i = nodes.length - count; i < nodes.length; i++)
      if (nodes[i]) nodes[i].classList.toggle("card--moving", on);
  }

  function onPointerMove(e) { positionLayer(e.clientX, e.clientY); highlightDrop(e.clientX, e.clientY); }

  function onPointerUp(e) {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (!drag) return;
    const target = findDrop(e.clientX, e.clientY);
    const ok = target && attemptDrop(target);
    if (drag.layer) drag.layer.remove();
    clearDropHighlight();
    const wasDrag = drag;
    drag = null;
    if (!ok) render(); // snap back
    else afterMove(wasDrag.from, target);
  }

  function attemptDrop(target) {
    const from = drag.from, pickup = drag.pickup;
    if (target.pile === "foundation") {
      if (pickup.length !== 1) return false;
      if (from.pile === "foundation") return false;
      if (!canToFoundation(pickup[0], target.col)) return false;
      pushHistory(); startTimer();
      applyMove(from, target, pickup.length);
      return true;
    }
    // tableau
    if (from.pile === "tableau" && from.col === target.col) return false;
    if (!canToTableau(pickup[0], target.col)) return false;
    pushHistory(); startTimer();
    applyMove(from, target, pickup.length);
    return true;
  }

  function afterMove(from, to) {
    render();
    if (checkWin()) { onWin(); return; }
    if (autoCompleteReady()) autoComplete();
  }

  // ---------- Drop target hit-testing ----------
  function findDrop(x, y) {
    for (let fi = 0; fi < 4; fi++) {
      const r = foundEls[fi].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        return { pile: "foundation", col: fi };
    }
    const cols = tabEl.querySelectorAll(".col");
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
    if (!target) return;
    let el = target.pile === "foundation" ? foundEls[target.col] : tabEl.querySelector('.col[data-col="' + target.col + '"]');
    // only highlight when the move is actually legal
    if (!el || !drag) return;
    const legal = target.pile === "foundation"
      ? (drag.pickup.length === 1 && target.pile !== drag.from.pile && canToFoundation(drag.pickup[0], target.col))
      : !(target.col === drag.from.col && drag.from.pile === "tableau") && canToTableau(drag.pickup[0], target.col);
    if (legal) { el.classList.add(target.pile === "foundation" ? "slot--drop" : "col--drop"); highlighted = el; }
  }
  function clearDropHighlight() {
    if (highlighted) { highlighted.classList.remove("slot--drop", "col--drop"); highlighted = null; }
  }

  // ---------- Double-click -> foundation ----------
  function onDoubleClick(e) {
    if (busy || won) return;
    const cardNode = e.target.closest && e.target.closest(".card");
    if (!cardNode || !cardNode._card) return;
    const pile = cardNode.dataset.pile;
    if (pile === "stock") return;
    let from;
    if (pile === "tableau") {
      const col = +cardNode.dataset.col, arr = tableau[col];
      if (arr[arr.length - 1] !== cardNode._card) return; // only top card
      from = { pile: "tableau", col: col };
    } else if (pile === "waste") {
      if (waste[waste.length - 1] !== cardNode._card) return;
      from = { pile: "waste" };
    } else if (pile === "foundation") {
      return;
    } else return;
    const card = cardNode._card;
    for (let fi = 0; fi < 4; fi++) {
      if (canToFoundation(card, fi)) {
        pushHistory(); startTimer();
        applyMove(from, { pile: "foundation", col: fi }, 1);
        afterMove(from, { pile: "foundation", col: fi });
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
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  drawModeBtn.addEventListener("click", () => {
    if (busy) return;
    drawCount = drawCount === 1 ? 3 : 1;
    drawModeBtn.textContent = "Draw " + drawCount;
    saveGame();
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
    else if (e.key === "r" || e.key === "R") openRules();
    else if (e.key === " ") { e.preventDefault(); draw(); }
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
