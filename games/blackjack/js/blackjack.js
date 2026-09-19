/* ===== Blackjack — game logic =====
   Single-file, dependency-free. House rules: dealer stands on all 17s,
   blackjack pays 3:2, double-down allowed, one split per hand (two hands
   max), insurance omitted.
   - Fresh shuffled 6-deck shoe each hand.
   - Bet with chips; bankroll persisted in localStorage (default $500).
   - Hit / Stand / Double / Split; hands play out one by one, then the
     dealer plays the face-down hole card once every hand is done. */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
  const RED = [false, true, true, false];
  const START_BANK = 500;
  const BANK_KEY = "gc-blackjack-bank";
  const HANDS = 6; // decks per shoe

  // ---------- DOM refs ----------
  const dealerEl = document.getElementById("dealer");
  const playerEl = document.getElementById("player");
  const player2El = document.getElementById("player2");
  const hand0El = document.getElementById("hand0");
  const hand1El = document.getElementById("hand1");
  const label0El = document.getElementById("label0");
  const dealerCountEl = document.getElementById("dealerCount");
  const playerCountEl = document.getElementById("playerCount");
  const player2CountEl = document.getElementById("player2Count");
  const stake0El = document.getElementById("stake0");
  const stake1El = document.getElementById("stake1");
  const statusEl = document.getElementById("status");
  const bankEl = document.getElementById("bank");
  const betEl = document.getElementById("bet");
  const roundEl = document.getElementById("round");
  const chipsEl = document.getElementById("chips");
  const dealBtn = document.getElementById("dealBtn");
  const hitBtn = document.getElementById("hitBtn");
  const standBtn = document.getElementById("standBtn");
  const doubleBtn = document.getElementById("doubleBtn");
  const splitBtn = document.getElementById("splitBtn");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const toastEl = document.getElementById("toast");
  const chipBtns = Array.prototype.slice.call(document.querySelectorAll(".bj-chip"));

  // ---------- Game state ----------
  let shoe = [];
  let bank = START_BANK;
  let bet = 0;       // the stake wagered this round (per hand once split)
  let hands = [];    // [{ cards, bet, done, bust, doubled, fromSplit }]
  let active = 0;    // which hand is being played
  let dealer = [];
  let phase = "bet";   // 'bet' | 'player' | 'dealer' | 'over'
  let round = 0;
  let dealerHidden = true;

  // ---------- Card helpers ----------
  function rankLabel(r) {
    if (r === 1) return "A";
    if (r === 11) return "J";
    if (r === 12) return "Q";
    if (r === 13) return "K";
    return String(r);
  }
  function isRed(c) { return RED[c.suit]; }
  function makeShoe() {
    const d = [];
    for (let deck = 0; deck < HANDS; deck++)
      for (let s = 0; s < 4; s++)
        for (let r = 1; r <= 13; r++)
          d.push({ suit: s, rank: r });
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }
  function draw() {
    if (shoe.length < 15) shoe = makeShoe(); // keep the shoe topped up
    return shoe.pop();
  }
  // Best value of a hand: aces flex 11 then 1.
  function handValue(hand) {
    let total = 0, aces = 0;
    for (const c of hand) {
      if (c.rank === 1) { total += 11; aces++; }
      else if (c.rank >= 11) total += 10;
      else total += c.rank;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }
  const isBlackjack = (hand) =>
    hand.length === 2 && handValue(hand) === 21;

  // ---------- Hand helpers (split support) ----------
  function newHand(cards, stake) {
    return { cards: cards, bet: stake, done: false, bust: false, doubled: false, fromSplit: false };
  }
  function cur() { return hands[active]; }
  function cardValue(c) { return c.rank === 1 ? 11 : Math.min(10, c.rank); }
  // A 21 on the first two cards only counts as a natural if the hand was
  // never split — 21 off a split pair is just an ordinary 21.
  function isNatural(h) {
    return !h.fromSplit && h.cards.length === 2 && handValue(h.cards) === 21;
  }
  // One split per round: the pair must be the only hand, and the player
  // must be able to fund the extra stake.
  function canSplit(h) {
    return hands.length === 1 && h.cards.length === 2 &&
      cardValue(h.cards[0]) === cardValue(h.cards[1]) && bank >= h.bet;
  }

  // ---------- Bankroll persistence ----------
  function loadBank() {
    let v;
    try { v = parseInt(localStorage.getItem(BANK_KEY), 10); } catch (e) { v = NaN; }
    return isNaN(v) || v < 0 ? START_BANK : v;
  }
  function saveBank() {
    try { localStorage.setItem(BANK_KEY, String(bank)); } catch (e) {}
  }

  // ---------- Toast ----------
  let toastId = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastId);
    toastId = setTimeout(() => { toastEl.hidden = true; }, 1700);
  }

  // ---------- Rendering ----------
  function cardEl(card, faceDown) {
    const el = document.createElement("div");
    const up = !faceDown;
    el.className = "c-card " + (up ? "c-card--up" : "c-card--down") + (up && isRed(card) ? " c-card--red" : "");
    if (up) {
      const g = GLYPH[card.suit], rl = rankLabel(card.rank);
      el.innerHTML =
        '<div class="c-card__corner c-card__tl"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>' +
        '<div class="c-card__pip">' + g + '</div>' +
        '<div class="c-card__corner c-card__br"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>';
    }
    return el;
  }
  function renderHand(well, hand, hideSecond) {
    const prev = +(well.dataset.count || 0);
    well.innerHTML = "";
    hand.forEach((card, i) => {
      const faceDown = hideSecond && i === 1;
      const el = cardEl(card, faceDown);
      // Only cards added since the last render animate in; existing cards
      // are rebuilt in place without the deal-in flash.
      if (i >= prev) el.classList.add("bj-new");
      el.style.setProperty("--i", String(i));
      el.style.zIndex = String(i + 1);
      well.appendChild(el);
    });
    well.dataset.count = String(hand.length);
    // Fan the cards with real px offsets (CSS calc on the inherited --cw
    // isn't readable back via getComputedStyle), then widen the well so the
    // absolute fan stays centred under its label.
    const els = well.children;
    if (els.length) {
      const cw = els[0].offsetWidth;
      const fan = Math.round(cw * 0.46); // keep in sync with --fan in style.css
      for (let i = 0; i < els.length; i++) els[i].style.left = i * fan + "px";
      well.style.width = (cw + (els.length - 1) * fan) + "px";
    } else {
      well.style.width = "";
    }
  }
  function render() {
    renderHand(dealerEl, dealer, dealerHidden);
    if (!hands.length) renderHand(playerEl, [], false);
    hands.forEach(function (h, i) {
      const well = i === 0 ? playerEl : player2El;
      const wrap = i === 0 ? hand0El : hand1El;
      const countEl = i === 0 ? playerCountEl : player2CountEl;
      const stakeEl = i === 0 ? stake0El : stake1El;
      renderHand(well, h.cards, false);
      countEl.textContent = h.cards.length ? String(handValue(h.cards)) : "";
      stakeEl.textContent = h.cards.length ? "$" + h.bet + (h.doubled ? " \u00d72" : "") : "";
      wrap.classList.toggle("bj-hand--active", phase === "player" && i === active && !h.done);
      wrap.classList.toggle("bj-hand--done", phase === "player" && h.done && hands.length > 1);
    });
    hand1El.hidden = hands.length < 2;
    label0El.textContent = hands.length > 1 ? "Hand 1" : "You";

    const dv = dealer.length ? (dealerHidden ? handValue([dealer[0]]) : handValue(dealer)) : 0;
    dealerCountEl.textContent = dealer.length ? String(dv) : "";

    bankEl.textContent = "$" + bank;
    const atStake = hands.length ? hands.reduce(function (s, h) { return s + h.bet; }, 0) : bet;
    betEl.textContent = "$" + atStake;
    roundEl.textContent = round ? "#" + round : "\u2014";

    // Buttons by phase.
    const h = phase === "player" && hands.length ? cur() : null;
    const canAct = !!h && !h.done;
    dealBtn.disabled = phase !== "bet" || bet <= 0 || bet > bank;
    hitBtn.disabled = !canAct;
    standBtn.disabled = !canAct;
    doubleBtn.disabled = !canAct || h.cards.length !== 2 || bank < h.bet;
    splitBtn.disabled = !(canAct && canSplit(h));
    // Chips only live in the bet phase.
    chipBtns.forEach((b) => { b.disabled = phase !== "bet"; });

    statusEl.className = "bj-status" + (statusEl.dataset.tone ? " bj-status--" + statusEl.dataset.tone : "");
  }
  function setStatus(msg, tone) {
    statusEl.textContent = msg;
    statusEl.dataset.tone = tone || "";
  }

  // ---------- Betting ----------
  function addChip(val) {
    if (phase !== "bet") return;
    if (val === 0) { bet = 0; render(); return; }
    if (bet + val > bank) { toast("Not enough in the bank"); return; }
    bet += val;
    render();
  }

  // ---------- Turn flow ----------
  function deal() {
    if (phase !== "bet" || bet <= 0 || bet > bank) return;
    shoe = makeShoe();
    round++;
    bank -= bet;          // stake moves to escrow; payouts return to the bank
    hands = [newHand([draw(), draw()], bet)];
    active = 0;
    dealer = [draw(), draw()];
    dealerHidden = true;
    phase = "player";
    // Fresh round: every card is new, so let them all animate in.
    dealerEl.dataset.count = "0";
    playerEl.dataset.count = "0";
    player2El.dataset.count = "0";
    setStatus("Your move", "");
    render();

    if (isNatural(hands[0]) || isBlackjack(dealer)) { dealerHidden = false; settle(); }
  }
  function hit() {
    if (phase !== "player") return;
    const h = cur();
    h.cards.push(draw());
    render();
    const v = handValue(h.cards);
    if (v > 21) { h.done = true; h.bust = true; advance(); }
    else if (v === 21) { h.done = true; advance(); }
  }
  function doubleDown() {
    if (phase !== "player") return;
    const h = cur();
    if (h.cards.length !== 2 || bank < h.bet) return;
    bank -= h.bet;         // the extra stake goes to escrow too
    h.bet *= 2;
    h.doubled = true;
    h.done = true;
    h.cards.push(draw());
    if (handValue(h.cards) > 21) h.bust = true;
    render();
    advance();
  }
  function split() {
    if (phase !== "player") return;
    const h = cur();
    if (!canSplit(h)) return;
    bank -= h.bet;         // fund the second hand's stake
    const moved = h.cards.pop();
    const h2 = newHand([moved], h.bet);
    h.fromSplit = true;
    h2.fromSplit = true;
    h.cards.push(draw());
    h2.cards.push(draw());
    hands.push(h2);
    if (h.cards[0].rank === 1) {
      // House rule: split aces each get exactly one card, then stand.
      h.done = h2.done = true;
      h.splitAces = h2.splitAces = true;
      setStatus("Split aces — one card each", "");
      render();
      dealerPlay();
    } else {
      setStatus("Split! Play hand 1", "");
      render();
    }
  }
  function stand() {
    if (phase !== "player") return;
    cur().done = true;
    advance();
  }
  // Move to the next unfinished hand, or let the dealer play when done.
  function advance() {
    const next = hands.findIndex(function (h) { return !h.done; });
    if (next !== -1) {
      active = next;
      setStatus("Hand " + (active + 1), "");
      render();
      return;
    }
    dealerPlay();
  }
  function dealerPlay() {
    phase = "dealer";
    dealerHidden = false;
    render();
    if (!hands.some(function (h) { return !h.bust; })) { settle(); return; } // all bust: just reveal
    // Dealer hits to 17 (stands on soft 17 too).
    const step = () => {
      if (handValue(dealer) < 17) {
        dealer.push(draw());
        render();
        setTimeout(step, 520);
        return;
      }
      settle();
    };
    setTimeout(step, 480);
  }
  // One hand's verdict vs the dealer: winner, message and money returned.
  function handResult(h, dv, dBJ, i) {
    const pv = handValue(h.cards);
    const nat = isNatural(h);
    let win;
    if (h.bust) win = false;
    else if (nat && !dBJ) win = true;
    else if (dBJ && !nat) win = false;
    else if (dBJ) win = null;
    else if (dv > 21) win = true;
    else if (pv > dv) win = true;
    else if (pv < dv) win = false;
    else win = null;
    let msg;
    if (hands.length > 1) {
      const label = h.bust ? "bust" : win === true ? "win" : win === null ? "push" : "lose";
      msg = "H" + (i + 1) + " " + pv + "\u2013" + dv + " " + label;
    } else if (h.bust) msg = "Bust \u2014 " + pv;
    else if (nat && win) msg = "Blackjack! 3:2";
    else if (dBJ && !win) msg = "Dealer blackjack";
    else if (dBJ) msg = "Push \u2014 both blackjack";
    else if (dv > 21) msg = "Dealer busts \u2014 you win!";
    else if (win) msg = "You win " + pv + "\u2013" + dv;
    else if (win === null) msg = "Push " + pv + "\u2013" + dv;
    else msg = "Dealer wins " + dv + "\u2013" + pv;
    return { win: win, msg: msg, pay: win === true ? Math.round(h.bet * (nat ? 2.5 : 2)) : win === null ? h.bet : 0 };
  }
  function settle() {
    phase = "over";
    dealerHidden = false;
    const dv = handValue(dealer), dBJ = isBlackjack(dealer);
    let pay = 0, stake = 0;
    const parts = hands.map(function (h, i) {
      const r = handResult(h, dv, dBJ, i);
      pay += r.pay;
      stake += h.bet;
      return r;
    });
    bank += pay;
    const net = pay - stake;
    let msg = parts.map(function (r) { return r.msg; }).join("   \u00b7   ");
    if (parts.length > 1) msg += net === 0 ? " \u2014 even" : (net > 0 ? " \u2014 +$" : " \u2014 \u2212$") + Math.abs(net);
    setStatus(msg, net > 0 ? "win" : net < 0 ? "lose" : "push");
    saveBank();
    phase = "bet";
    // Prepare a fresh betting round but keep cards visible until next deal.
    render();
    if (bank <= 0) {
      setStatus("Out of chips \u2014 press New Bank", "lose");
      toast("Bank empty! Hit New Bank to keep playing.");
    }
  }
  function resetBank() {
    bank = START_BANK;
    bet = 0; round = 0;
    hands = []; active = 0; dealer = [];
    dealerHidden = false;
    phase = "bet";
    saveBank();
    setStatus("Place your bet", "");
    render();
  }

  // ---------- Rules modal ----------
  function openRules() { if (rulesModal) rulesModal.hidden = false; }
  function closeRules() { if (rulesModal) rulesModal.hidden = true; }
  function rulesOpen() { return rulesModal && !rulesModal.hidden; }

  // ---------- Wire up ----------
  chipsEl.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".bj-chip");
    if (b && !b.disabled) addChip(+b.dataset.val);
  });
  dealBtn.addEventListener("click", deal);
  hitBtn.addEventListener("click", hit);
  standBtn.addEventListener("click", stand);
  doubleBtn.addEventListener("click", doubleDown);
  splitBtn.addEventListener("click", split);
  newBtn.addEventListener("click", resetBank);
  if (rulesBtn) rulesBtn.addEventListener("click", openRules);
  if (rulesModal) rulesModal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });
  document.addEventListener("keydown", (e) => {
    if (rulesOpen()) {
      if (e.key === "Escape") closeRules();
      return;
    }
    switch (e.key.toLowerCase()) {
      case "h": if (!hitBtn.disabled) hit(); break;
      case "s": if (!standBtn.disabled) stand(); break;
      case "d": if (!doubleBtn.disabled) doubleDown(); break;
      case "p": if (!splitBtn.disabled) split(); break;
      case "r": openRules(); break;
      case " ":
        // A focused button already turns Space into a native click.
        if (e.target.closest && e.target.closest("button")) break;
        e.preventDefault();
        if (phase === "bet") { if (!dealBtn.disabled) deal(); }
        else if (!hitBtn.disabled) hit();
        break;
    }
  });

  // ---------- Boot ----------
  bank = loadBank();
  setStatus("Place your bet", "");
  render();
})();
