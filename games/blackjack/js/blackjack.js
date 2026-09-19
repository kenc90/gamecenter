/* ===== Blackjack — game logic =====
   Single-file, dependency-free. House rules: dealer stands on all 17s,
   blackjack pays 3:2, double-down allowed, insurance omitted.
   - Fresh shuffled 6-deck shoe each hand.
   - Bet with chips; bankroll persisted in localStorage (default $500).
   - Hit / Stand / Double; dealer plays out face-down hole card on Stand. */
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
  const dealerCountEl = document.getElementById("dealerCount");
  const playerCountEl = document.getElementById("playerCount");
  const statusEl = document.getElementById("status");
  const bankEl = document.getElementById("bank");
  const betEl = document.getElementById("bet");
  const roundEl = document.getElementById("round");
  const chipsEl = document.getElementById("chips");
  const dealBtn = document.getElementById("dealBtn");
  const hitBtn = document.getElementById("hitBtn");
  const standBtn = document.getElementById("standBtn");
  const doubleBtn = document.getElementById("doubleBtn");
  const newBtn = document.getElementById("newBtn");
  const rulesBtn = document.getElementById("rulesBtn");
  const rulesModal = document.getElementById("rulesModal");
  const toastEl = document.getElementById("toast");
  const chipBtns = Array.prototype.slice.call(document.querySelectorAll(".bj-chip"));

  // ---------- Game state ----------
  let shoe = [];
  let bank = START_BANK;
  let bet = 0;
  let player = [];
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
    well.innerHTML = "";
    hand.forEach((card, i) => {
      const faceDown = hideSecond && i === 1;
      const el = cardEl(card, faceDown);
      el.style.setProperty("--i", String(i));
      el.style.zIndex = String(i + 1);
      well.appendChild(el);
    });
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
    renderHand(playerEl, player, false);

    const pv = player.length ? handValue(player) : 0;
    playerCountEl.textContent = pv ? String(pv) : "";
    if (!dealer.length) dealerCountEl.textContent = "";
    else if (dealerHidden) dealerCountEl.textContent = String(handValue([dealer[0]]));
    else dealerCountEl.textContent = String(handValue(dealer));

    bankEl.textContent = "$" + bank;
    betEl.textContent = "$" + bet;
    roundEl.textContent = round ? "#" + round : "—";

    // Buttons by phase.
    const canAct = phase === "player";
    dealBtn.disabled = phase !== "bet" || bet <= 0 || bet > bank;
    hitBtn.disabled = !canAct;
    standBtn.disabled = !canAct;
    doubleBtn.disabled = !canAct || player.length !== 2 || bank < bet * 2;
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
    player = [draw(), draw()];
    dealer = [draw(), draw()];
    dealerHidden = true;
    phase = "player";
    setStatus("Your move", "");
    render();

    const pBJ = isBlackjack(player), dBJ = isBlackjack(dealer);
    if (pBJ || dBJ) { dealerHidden = false; settle(); }
  }
  function hit() {
    if (phase !== "player") return;
    player.push(draw());
    render();
    const v = handValue(player);
    if (v > 21) { dealerHidden = false; setStatus("Bust — " + v, "lose"); endRound(false); }
    else if (v === 21) stand();
  }
  function doubleDown() {
    if (phase !== "player" || player.length !== 2 || bank < bet * 2) return;
    bank -= bet;           // the extra stake
    bet *= 2;
    player.push(draw());
    render();
    if (handValue(player) > 21) { dealerHidden = false; setStatus("Bust — " + handValue(player), "lose"); endRound(false); }
    else stand();
  }
  function stand() {
    if (phase !== "player") return;
    phase = "dealer";
    dealerHidden = false;
    render();
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
  function settle() {
    phase = "over";
    dealerHidden = false;
    const pv = handValue(player), dv = handValue(dealer);
    const pBJ = isBlackjack(player), dBJ = isBlackjack(dealer);

    if (pv > 21) return endRound(false, "Bust — " + pv);
    if (pBJ && !dBJ) return endRound(true, "Blackjack! 3:2", true);
    if (dBJ && !pBJ) return endRound(false, "Dealer blackjack");
    if (dBJ && pBJ) return endRound(null, "Push — both blackjack");
    if (dv > 21) return endRound(true, "Dealer busts — you win!");
    if (pv > dv) return endRound(true, "You win " + pv + "–" + dv);
    if (pv < dv) return endRound(false, "Dealer wins " + dv + "–" + pv);
    return endRound(null, "Push " + pv + "–" + dv);
  }
  // outcome: true=win, false=lose, null=push. Bet is settled from escrow.
  function endRound(win, msg, blackjack) {
    if (msg) setStatus(msg, win === null ? "push" : win ? "win" : "lose");
    if (win === true) bank += blackjack ? Math.round(bet * 2.5) : bet * 2;
    else if (win === null) bank += bet;      // push returns the stake
    // loss: stake stays in escrow, nothing returns.
    saveBank();
    phase = "bet";
    // Prepare a fresh betting round but keep cards visible until next deal.
    render();
    if (bank <= 0) {
      setStatus("Out of chips — press New Bank", "lose");
      toast("Bank empty! Hit New Bank to keep playing.");
    }
  }
  function resetBank() {
    bank = START_BANK;
    bet = 0; round = 0;
    player = []; dealer = [];
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
