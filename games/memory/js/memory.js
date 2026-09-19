/* ===== Memory (Concentration) — game logic =====
   Single-file, dependency-free. Flip two cards, match the pair.
   - 6 / 10 / 15 pairs of real playing cards (same suit + rank x2).
   - Moves count two-card attempts; timer starts on the first flip.
   - Best time + win count persisted per difficulty in localStorage. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
  const RED = [false, true, true, false];
  const STATS_KEY = "gc-memory-stats";
  const GRID = { 6: 4, 10: 5, 15: 6 };   // pairs -> columns
  const FLIP_BACK_MS = 800;

  // ---------- DOM refs ----------
  const boardEl = document.getElementById("board");
  const pairsEl = document.getElementById("pairs");
  const movesEl = document.getElementById("moves");
  const timerEl = document.getElementById("timer");
  const bestEl = document.getElementById("best");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const winOverlay = document.getElementById("winOverlay");
  const winStats = document.getElementById("winStats");
  const winNew = document.getElementById("winNew");
  const segBtns = Array.prototype.slice.call(document.querySelectorAll(".c-seg__b"));

  // ---------- Game state ----------
  let pairCount = 6;
  let cards = [];        // {key, suit, rank, matched, el}
  let open = [];         // currently face-down-pending cards (0..2)
  let lock = false;      // input locked during the flip-back pause
  let moves = 0;
  let matched = 0;
  let seconds = 0;
  let timerId = null;
  let won = false;

  // ---------- Helpers ----------
  function rankLabel(r) {
    if (r === 1) return "A";
    if (r === 11) return "J";
    if (r === 12) return "Q";
    if (r === 13) return "K";
    return String(r);
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function fmt(s) {
    const m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  // ---------- Stats ----------
  function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function statsFor(n) {
    const all = loadStats();
    return all[n] || { wins: 0, best: null };
  }
  function saveWin(n) {
    const all = loadStats();
    const st = all[n] || { wins: 0, best: null };
    st.wins = (st.wins || 0) + 1;
    if (st.best == null || seconds < st.best) st.best = seconds;
    all[n] = st;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(all)); } catch (e) {}
    return st;
  }
  function showBest() {
    const st = statsFor(pairCount);
    bestEl.textContent = st.best != null ? fmt(st.best) : "—";
  }

  // ---------- Timer ----------
  function startTimer() {
    if (timerId) return;
    timerId = setInterval(() => {
      seconds++;
      timerEl.textContent = fmt(seconds);
    }, 1000);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  // ---------- New game ----------
  function newGame() {
    stopTimer();
    won = false; lock = false;
    moves = 0; matched = 0; seconds = 0; open = [];
    winOverlay.hidden = true;
    timerEl.textContent = "00:00";

    // Pick `pairCount` distinct cards from a 52 deck, then double each one.
    const deck = [];
    for (let s = 0; s < 4; s++)
      for (let r = 1; r <= 13; r++)
        deck.push({ suit: s, rank: r });
    shuffle(deck);
    const chosen = deck.slice(0, pairCount);
    cards = [];
    chosen.forEach((c) => {
      cards.push({ key: c.suit * 13 + c.rank, suit: c.suit, rank: c.rank, matched: false, el: null });
      cards.push({ key: c.suit * 13 + c.rank, suit: c.suit, rank: c.rank, matched: false, el: null });
    });
    shuffle(cards);
    render();
    showBest();
  }

  // ---------- Rendering ----------
  function render() {
    boardEl.innerHTML = "";
    boardEl.style.setProperty("--cols", GRID[pairCount]);
    cards.forEach((card, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "m-card" + (RED[card.suit] ? " m-card--red" : "");
      btn.dataset.i = String(i);
      btn.setAttribute("aria-label", "Card " + (i + 1) + ", face down");
      btn.innerHTML =
        '<span class="m-card__inner">' +
          '<span class="m-face m-face--back"></span>' +
          '<span class="m-face m-face--front">' +
            '<span class="m-rank">' + rankLabel(card.rank) + '</span>' +
            '<span class="m-glyph">' + GLYPH[card.suit] + '</span>' +
          '</span>' +
        '</span>';
      card.el = btn;
      boardEl.appendChild(btn);
    });
    movesEl.textContent = String(moves);
    pairsEl.textContent = matched + "/" + pairCount;
  }

  // ---------- Flip logic ----------
  function onBoardClick(e) {
    if (lock || won) return;
    const btn = e.target.closest && e.target.closest(".m-card");
    if (!btn || !boardEl.contains(btn)) return;
    const card = cards[+btn.dataset.i];
    if (!card || card.matched || btn.classList.contains("is-up")) return;

    startTimer();
    flipUp(card, true);
    open.push(card);

    if (open.length < 2) return;
    const [a, b] = open;
    open = [];
    moves++;
    movesEl.textContent = String(moves);

    if (a.key === b.key) {
      a.matched = b.matched = true;
      matched++;
      pairsEl.textContent = matched + "/" + pairCount;
      [a, b].forEach((c) => {
        c.el.classList.add("is-matched", "just-matched");
        c.el.setAttribute("aria-label", "Matched " + rankLabel(c.rank) + " " + GLYPH[c.suit]);
        setTimeout(() => c.el.classList.remove("just-matched"), 500);
      });
      if (matched === pairCount) onWin();
      return;
    }

    // Mismatch: red-ring beat, then flip both back.
    lock = true;
    a.el.classList.add("is-wrong");
    b.el.classList.add("is-wrong");
    setTimeout(() => {
      a.el.classList.remove("is-wrong");
      b.el.classList.remove("is-wrong");
      flipUp(a, false);
      flipUp(b, false);
      lock = false;
    }, FLIP_BACK_MS);
  }
  function flipUp(card, up) {
    card.el.classList.toggle("is-up", up);
    card.el.setAttribute("aria-label", up
      ? "Face up " + rankLabel(card.rank) + " " + GLYPH[card.suit]
      : "Face down card at position " + (+card.el.dataset.i + 1));
  }

  function onWin() {
    won = true;
    stopTimer();
    const st = saveWin(pairCount);
    winStats.textContent =
      pairCount + " pairs in " + fmt(seconds) + " with " + moves + " moves" +
      " · best " + (st.best != null ? fmt(st.best) : fmt(seconds)) +
      " (" + st.wins + (st.wins === 1 ? " win)" : " wins)");
    winOverlay.hidden = false;
    showBest();
  }

  // ---------- Difficulty ----------
  function setDifficulty(n) {
    if (n === pairCount) return;
    pairCount = n;
    segBtns.forEach((b) => {
      const on = +b.dataset.pairs === n;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    newGame();
  }

  // ---------- Rules modal ----------
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  function rulesOpen() { return rulesModal && !rulesModal.hidden; }

  // ---------- Wire up ----------
  boardEl.addEventListener("click", onBoardClick);
  newBtn.addEventListener("click", newGame);
  winNew.addEventListener("click", newGame);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  segBtns.forEach((b) => b.addEventListener("click", () => setDifficulty(+b.dataset.pairs)));
  document.addEventListener("keydown", (e) => {
    if (rulesOpen()) {
      if (e.key === "Escape") closeRules();
      return;
    }
    if (e.key === "n" || e.key === "N") newGame();
    else if (e.key === "r" || e.key === "R") openRules();
  });

  newGame();
})();
