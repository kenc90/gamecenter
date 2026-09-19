/* ===== Big 2 — game logic =====
   Single-file, dependency-free. Cantonese card classic: four players (you
   vs three computers) each hold 13 cards and race to shed them.
   - Individual ranks: 3 < 4 < ... < K < A < 2 (deuces are supreme);
    ties break by suit diamonds < clubs < hearts < spades.
   - Combo kinds: single, pair, triple, and the five-card ladder
     straight < flush < full house < iron < straight flush. A higher ladder
     kind beats any lower one; singles/pairs/triples need the same kind.
   - ♦3 holder opens the hand and must play it; tricks run clockwise and
     the owner leads again when a play comes back unbeaten.
   - First seat empty wins the hand; leftovers score penalties (2 = 20).
   - Running totals persist in gc-big2-stats; the hand in progress lives in
     gc-big2-hand. A ?seed=N URL param makes the shuffle deterministic (used
     by the automated checks). */
(function () {
  "use strict";

  // ---------- Configuration ----------
  var GLYPH = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣  (same order as blackjack)
  var RED = [false, true, true, false];
  var SUIT_NAME = ["spades", "hearts", "diamonds", "clubs"];
  var NAMES = ["You", "Mei", "Ravi", "Sofia"];
  var STATS_KEY = "gc-big2-stats";
  var HAND_KEY = "gc-big2-hand";
  var AI_DELAY = 800;

  // combo kinds — stable ids (persisted in saved hands, so do NOT renumber).
  // Five-card strength is ranked by the LADDER map next to cmpCombo:
  // straight < flush < full house < iron < straight flush.
  var SINGLE = 1, PAIR = 2, TRIP = 3, SEQ = 4, FULL = 5, IRON = 6, FLUSH = 7, SEQF = 8;

  // ---------- DOM refs ----------
  function $(id) { return document.getElementById(id); }
  var statusEl = $("status"), trickWell = $("trickWell"), trickCaption = $("trickCaption");
  var handWell = $("handWell"), playBtn = $("playBtn"), passBtn = $("passBtn"), dealBtn = $("dealBtn");
  var handNoEl = $("handNo"), scoreEl = $("score"), toastEl = $("toast");
  var rulesBtn = $("rulesBtn"), rulesModal = $("rulesModal"), newBtn = $("newBtn");
  var overModal = $("overModal"), overTitle = $("overTitle"), overBody = $("overBody");
  var overClose = $("overClose"), nextBtn = $("nextBtn");
  var countEls = [$("count0"), $("count1"), $("count2"), $("count3")];
  var flagEls = [$("flag0"), $("flag1"), $("flag2"), $("flag3")];
  var backEls = [$("backs1"), $("backs2"), $("backs3")];
  var seatEls = [null, $("seat1"), $("seat2"), $("seat3")];

  // ---------- Seeded shuffle (?seed=N makes automated games reproducible) ----------
  var urlSeed = /[?&]seed=(\d+)/.exec(location.search);
  function rngFactory() {
    if (urlSeed) {
      var a = parseInt(urlSeed[1], 10) >>> 0;
      return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        var t2 = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
        t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2;
        return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
      };
    }
    return Math.random;
  }

  // ---------- Card helpers ----------
  function rankLabel(r) {
    if (r === 1) return "A";
    if (r === 11) return "J";
    if (r === 12) return "Q";
    if (r === 13) return "K";
    return String(r);
  }
  function pow(r) { return r === 2 ? 15 : r === 1 ? 14 : r; }   // 2 is the boss
  // suit strength by GLYPH index (♠ ♥ ♦ ♣): Chinese convention — diamonds
  // are the lowest suit, so clubs beat diamonds
  var SUIT_POW = [3, 2, 0, 1];                                  // ♦ < ♣ < ♥ < ♠
  function spow(s) { return SUIT_POW[s]; }
  function isRed(c) { return RED[c.s]; }
  function cardPen(c) { return c.r === 2 ? 20 : c.r === 1 ? 14 : c.r; }
  function sortHand(h) {
    h.sort(function (a, b) { return pow(b.r) - pow(a.r) || spow(b.s) - spow(a.s); });
  }
  function hasDiamond3(c) { return c.r === 3 && c.s === 2; } // GLYPH order: ♦ is suit 2

  // ---------- Combo classification ----------
  // returns {type, key[], cards} or null. keys compare element-wise.
  function classify(cards) {
    var n = cards.length, i, j;
    var ps = [], ss = [];
    for (i = 0; i < n; i++) { ps.push(pow(cards[i].r)); ss.push(spow(cards[i].s)); }
    if (n === 1) return mk(SINGLE, [ps[0], ss[0]], cards);
    if (n === 2) {
      if (cards[0].r !== cards[1].r) return null;
      return mk(PAIR, [ps[0], Math.max(ss[0], ss[1]), Math.min(ss[0], ss[1])], cards);
    }
    if (n === 3) {
      if (cards[0].r !== cards[1].r || cards[1].r !== cards[2].r) return null;
      ss.sort(function (a, b) { return b - a; });
      return mk(TRIP, [ps[0], ss[0], ss[1], ss[2]], cards);
    }
    if (n !== 5) return null;

    // five-card kinds
    var sameSuit = true;
    for (i = 1; i < 5; i++) if (cards[i].s !== cards[0].s) { sameSuit = false; break; }
    ps.sort(function (a, b) { return b - a; });
    var distinct = true;
    for (i = 1; i < 5; i++) if (ps[i] === ps[i - 1]) distinct = false;
    var top = 0;
    if (distinct) {
      if (ps[0] === 15 && ps[1] === 14 && ps[2] === 5 && ps[3] === 4 && ps[4] === 3) top = 5; // wheel A-2-3-4-5
      else if (ps[0] !== 15) {
        var run = true;
        for (i = 1; i < 5; i++) if (ps[i] !== ps[i - 1] - 1) run = false;
        if (run) top = ps[0];
      }
    }
    if (top && sameSuit) return mk(SEQF, [top, spow(cards[0].s)], cards);
    if (top) return mk(SEQ, [top], cards);
    if (sameSuit) {
      // flush: compare card-by-card [pow, suit]
      var ord = orderForFlush(cards);
      var key = [];
      for (i = 0; i < 5; i++) { key.push(pow(ord[i].r), spow(ord[i].s)); }
      return mk(FLUSH, key, cards);
    }
    // full house / iron by rank counts
    var byRank = {}, k;
    for (i = 0; i < 5; i++) { k = cards[i].r; byRank[k] = (byRank[k] || 0) + 1; }
    var tripR = 0, pairR = 0, quadR = 0, kickR = 0;
    var maxSFor = {};
    for (i = 0; i < 5; i++) { k = cards[i].r; if (spow(cards[i].s) > (maxSFor[k] || 0)) maxSFor[k] = spow(cards[i].s); }
    for (k in byRank) {
      if (byRank[k] === 3) tripR = +k;
      else if (byRank[k] === 2) pairR = +k;
      else if (byRank[k] === 4) quadR = +k;
      else if (byRank[k] === 1) kickR = +k;
    }
    if (tripR && pairR) return mk(FULL, [pow(tripR), pow(pairR), maxSFor[tripR]], cards);
    if (quadR) return mk(IRON, [pow(quadR), pow(kickR), maxSFor[quadR], maxSFor[kickR]], cards);
    return null;
  }
  function orderForFlush(cards) {
    return cards.slice().sort(function (a, b) { return pow(b.r) - pow(a.r) || spow(b.s) - spow(a.s); });
  }
  function mk(type, key, cards) { return { type: type, key: key, cards: cards }; }

  // the five-card kinds form one hierarchy — a higher kind beats ANY lower
  var LADDER = {};
  LADDER[SEQ] = 1; LADDER[FLUSH] = 2; LADDER[FULL] = 3; LADDER[IRON] = 4; LADDER[SEQF] = 5;
  function cmpCombo(a, b) {
    if (!a || !b) return -999;
    if (a.type !== b.type) {
      if (LADDER[a.type] && LADDER[b.type]) return LADDER[a.type] > LADDER[b.type] ? 1 : -1;
      return -999; // singles/pairs/triples only ever beat their own kind
    }
    for (var i = 0; i < Math.min(a.key.length, b.key.length); i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] > b.key[i] ? 1 : -1;
    }
    return 0;
  }
  function comboName(c) {
    var cards = c.cards;
    switch (c.type) {
      case SINGLE: return "a " + rankLabel(cards[0].r);
      case PAIR: return "a pair of " + rankLabel(cards[0].r) + "s";
      case TRIP: return "three " + rankLabel(cards[0].r) + "s";
      case SEQ: return "a " + (c.key[0] === 5 ? "wheel" : rankLabel(labelForPow(c.key[0]))) + "-high straight";
      case SEQF: return "a " + (c.key[0] === 5 ? "wheel" : rankLabel(labelForPow(c.key[0]))) + "-high straight flush";
      case FULL: return "full house, " + rankLabel(powToRank(c.key[0])) + "s over " + rankLabel(powToRank(c.key[1])) + "s";
      case IRON: return "four " + rankLabel(powToRank(c.key[0])) + "s";
      case FLUSH: return "a " + SUIT_NAME[cards[0].s] + " flush";
    }
    return "a combo";
  }
  function labelForPow(p) { return p === 14 ? 1 : p; }       // straight top 14 = Ace
  function powToRank(p) { return p === 15 ? 2 : p === 14 ? 1 : p; }

  // ---------- Combo generation (AI + legality) ----------
  // Candidate moves from a hand: every single/pair/triple, and one cheap
  // exemplar of each five-card kind per (kind, strength) that matters.
  function genMoves(hand) {
    var out = [], i, j, g;
    for (i = 0; i < hand.length; i++) out.push(mk(SINGLE, [pow(hand[i].r), spow(hand[i].s)], [hand[i]]));
    var byRank = groupByRank(hand);
    for (var r in byRank) {
      g = byRank[r];
      for (i = 0; i < g.length; i++)
        for (j = i + 1; j < g.length; j++)
          out.push(classify([g[i], g[j]]));
      if (g.length >= 3)
        for (i = 0; i < g.length; i++)
          for (j = i + 1; j < g.length; j++)
            for (var q = j + 1; q < g.length; q++) {
              var t = classify([g[i], g[j], g[q]]);
              if (t) out.push(t);
            }
    }
    // straights & straight flushes: eleven window tops (wheel + 6..14)
    var tops = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    for (i = 0; i < tops.length; i++) {
      var need = straightPows(tops[i]);
      if (!need) continue;
      var picked = pickExact(hand, need);
      if (picked) {
        var sCombo = classify(picked);
        if (sCombo) out.push(sCombo);
      }
      for (var s = 0; s < 4; s++) {
        var sf = pickExact(hand, need, s);
        if (sf) { var c2 = classify(sf); if (c2) out.push(c2); }
      }
    }
    // flushes: one per suit with >= 5 cards (five lowest — the cheap one)
    var bySuit = [[], [], [], []];
    for (i = 0; i < hand.length; i++) bySuit[hand[i].s].push(hand[i]);
    for (s = 0; s < 4; s++) {
      if (bySuit[s].length >= 5) {
        var sorted = bySuit[s].slice().sort(function (a, b) { return pow(a.r) - pow(b.r) || spow(a.s) - spow(b.s); });
        out.push(mk(FLUSH, flushKey(sorted.slice(0, 5)), sorted.slice(0, 5)));
      }
    }
    // full houses: cheapest triple rank + cheapest different pair rank
    var tripRanks = [], pairRanks = [];
    for (r in byRank) { if (byRank[r].length >= 3) tripRanks.push(+r); if (byRank[r].length >= 2) pairRanks.push(+r); }
    tripRanks.sort(function (a, b) { return pow(a) - pow(b); });
    pairRanks.sort(function (a, b) { return pow(a) - pow(b); });
    for (i = 0; i < tripRanks.length; i++)
      for (j = 0; j < pairRanks.length; j++)
        if (pairRanks[j] !== tripRanks[i]) {
          var cards3 = byRank[tripRanks[i]].slice(0, 3), cards2 = byRank[pairRanks[j]].slice(0, 2);
          var fh = classify(cards3.concat(cards2));
          if (fh) out.push(fh);
          break; // cheapest pair for this triple is enough for the AI
        }
    // irons: quad + cheapest kicker (hand is sorted big-first, so scan up
    // from the tail to find the smallest spare card)
    for (r in byRank) if (byRank[r].length === 4) {
      for (i = hand.length - 1; i >= 0; i--) if (hand[i].r !== +r) {
        var ir = classify(byRank[r].concat([hand[i]]));
        if (ir) { out.push(ir); break; }
      }
    }
    return out;
  }
  function flushKey(cards) {
    var ord = orderForFlush(cards), key = [];
    for (var i = 0; i < ord.length; i++) key.push(pow(ord[i].r), spow(ord[i].s));
    return key;
  }
  function groupByRank(hand) {
    var m = {};
    for (var i = 0; i < hand.length; i++) { (m[hand[i].r] = m[hand[i].r] || []).push(hand[i]); }
    for (var r in m) m[r].sort(function (a, b) { return spow(a.s) - spow(b.s); }); // cheapest suit first
    return m;
  }
  function straightPows(top) {
    // pows of the five cards, low->high; wheel = A,2,3,4,5 with 2 playing low
    if (top === 5) return [3, 4, 5, 14, 15];
    if (top < 6 || top > 14) return null;
    var need = [];
    for (var p = top - 4; p <= top; p++) need.push(p); // contains a 15? no: top<=14 and lowest 3 -> fine
    if (need.indexOf(15) >= 0) return null;            // JQKA2 is not a straight here
    return need;
  }
  function pickExact(hand, powsArr, suit) {
    // choose one card per required pow (optionally all one suit), lowest suits first
    var out = [];
    for (var i = 0; i < powsArr.length; i++) {
      var best = null;
      for (var j = 0; j < hand.length; j++) {
        var c = hand[j];
        if (pow(c.r) !== powsArr[i]) continue;
        if (suit !== undefined && c.s !== suit) continue;
        if (out.indexOf(c) >= 0) continue;
        if (!best || spow(c.s) < spow(best.s)) best = c;
      }
      if (!best) return null;
      out.push(best);
    }
    return out;
  }
  function legalMoves(hand, table, mustOpen) {
    var all = genMoves(hand), out = [];
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      if (!m) continue;
      if (mustOpen && !containsDiamond3(m)) continue;
      if (table && cmpCombo(m, table.combo) <= 0) continue;
      out.push(m);
    }
    return out;
  }
  function containsDiamond3(combo) {
    for (var i = 0; i < combo.cards.length; i++) if (hasDiamond3(combo.cards[i])) return true;
    return false;
  }
  function cheapest(moves) {
    var best = null;
    for (var i = 0; i < moves.length; i++) if (!best || cmpCombo(moves[i], best) < 0) best = moves[i];
    return best;
  }

  // ---------- Game state ----------
  var hands = [[], [], [], []];
  var table = null;      // { by, cards, combo }
  var passing = [false, false, false, false];
  var turn = 0;
  var firstPlay = true;  // ♦3 constraint still pending this hand
  var handNo = 0;
  var scores = [0, 0, 0, 0];
  var phase = "idle";    // 'idle' | 'play' | 'over'
  var sel = {};          // index -> true, cards lifted in the human hand
  var aiTimer = null;

  // ---------- Persistence ----------
  function loadStats() {
    try {
      var v = JSON.parse(localStorage.getItem(STATS_KEY));
      if (v && v.scores && v.scores.length === 4) { scores = v.scores; handNo = v.handNo || 0; }
    } catch (e) {}
  }
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify({ scores: scores, handNo: handNo })); } catch (e) {}
  }
  function saveHand() {
    if (phase !== "play") return;
    try {
      localStorage.setItem(HAND_KEY, JSON.stringify({
        hands: hands, table: table, passing: passing, turn: turn,
        firstPlay: firstPlay, handNo: handNo, scores: scores
      }));
    } catch (e) {}
  }
  function clearHand() { try { localStorage.removeItem(HAND_KEY); } catch (e) {} }
  function loadHand() {
    try {
      var v = JSON.parse(localStorage.getItem(HAND_KEY));
      if (!v || !v.hands || v.hands.length !== 4) return false;
      var total = 0;
      for (var i = 0; i < 4; i++) total += v.hands[i].length;
      if (total === 0 || total > 52) return false;
      hands = v.hands; table = v.table; passing = v.passing; turn = v.turn;
      firstPlay = v.firstPlay; handNo = v.handNo; scores = v.scores;
      phase = "play";
      return true;
    } catch (e) { return false; }
  }

  // ---------- Dealing ----------
  function deal() {
    var rng = rngFactory();
    var deck = [];
    for (var s = 0; s < 4; s++) for (var r = 1; r <= 13; r++) deck.push({ s: s, r: r });
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    hands = [[], [], [], []];
    for (i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
    for (i = 0; i < 4; i++) sortHand(hands[i]);
    table = null;
    passing = [false, false, false, false];
    firstPlay = true;
    sel = {};
    handNo++;
    turn = 0;
    for (i = 0; i < 4; i++)
      for (var q = 0; q < hands[i].length; q++)
        if (hasDiamond3(hands[i][q])) turn = i;
    phase = "play";
    overModal.hidden = true;
    saveStats(); saveHand(); render();
    setStatus(NAMES[turn] === "You"
      ? "You hold \u26663 — open with any combo containing it"
      : NAMES[turn] + " holds \u26663 and opens…");
    takeTurn();
  }

  // ---------- Turn engine ----------
  function takeTurn() {
    if (phase !== "play") return;
    if (turn === 0) {
      // always tell the player what to do on their turn
      if (table && table.by !== 0) setStatus("Your turn — beat " + comboName(table.combo) + " or pass");
      else if (!statusEl.textContent || statusEl.style.visibility === "hidden") setStatus("Your turn — tap cards to lift, then press Play");
      render();
      return;
    }
    aiTimer = setTimeout(function () { aiAct(turn); }, AI_DELAY);
  }
  function aiAct(seat) {
    if (phase !== "play" || seat !== turn) return;
    var moves = legalMoves(hands[seat], table, firstPlay && table === null);
    var mv = null;
    if (moves.length) {
      mv = cheapest(moves);
      // leading: dump the cheapest single unless it is the last card(s) —
      // cheapest() cannot compare ACROSS kinds (single vs pair …), so the
      // singles have to be filtered explicitly first
      if (!table && mv.type !== SINGLE && hands[seat].length > 2) {
        var singles = legalMoves(hands[seat], null, firstPlay).filter(function (m) { return m.type === SINGLE; });
        mv = cheapest(singles) || mv;
      }
    }
    if (mv) doPlay(seat, mv.cards);
    else doPass(seat);
  }
  function nextOf(seat) { return (seat + 1) % 4; }
  function doPlay(seat, cards) {
    // remove the cards from the seat's hand
    for (var i = 0; i < cards.length; i++) {
      var idx = hands[seat].indexOf(cards[i]);
      if (idx >= 0) hands[seat].splice(idx, 1);
    }
    var combo = classify(cards);
    table = { by: seat, cards: cards, combo: combo };
    passing = [false, false, false, false];
    firstPlay = false;
    if (hands[seat].length === 0) { endHand(seat); return; }
    turn = nextOf(seat);
    saveHand(); render();
    setStatus(seat === 0 ? "" : NAMES[seat] + " is thinking…");
    takeTurn();
  }
  function doPass(seat) {
    passing[seat] = true;
    var nxt = nextOf(seat);
    if (nxt === table.by) {
      // every other seat folded — the combo wins the trick
      var w = table.by;
      table = null;
      passing = [false, false, false, false];
      turn = w;
      toast(NAMES[w] + (w === 0 ? " win" : " wins") + " the trick");
      setStatus(w === 0 ? "Trick won — lead anything" : NAMES[w] + " won the trick…");
    } else {
      turn = nxt;
    }
    saveHand(); render();
    takeTurn();
  }

  // ---------- Hand end ----------
  function endHand(winner) {
    phase = "over";
    clearHand();
    var pens = [0, 0, 0, 0];
    for (var i = 0; i < 4; i++) {
      for (var q = 0; q < hands[i].length; q++) pens[i] += cardPen(hands[i][q]);
      if (i === winner) pens[i] = 0;
      scores[i] += pens[i];
    }
    saveStats();
    overTitle.textContent = winner === 0 ? "You win the hand!" : NAMES[winner] + " wins the hand";
    var html = '<ul class="b2-results">';
    for (i = 0; i < 4; i++) {
      html += '<li><span>' + NAMES[i] + '</span>' +
        (i === winner
          ? '<span class="b2-out">out — 0 pts</span>'
          : '<span class="b2-pen">' + hands[i].length + ' cards · +' + pens[i] + '</span>') +
        '</li>';
    }
    html += '</ul><p style="margin:10px 0 0">Running totals — you: <b>' + scores[0] +
      '</b> · Mei: <b>' + scores[1] + '</b> · Ravi: <b>' + scores[2] + '</b> · Sofia: <b>' + scores[3] + '</b> (lower is better)</p>';
    overBody.innerHTML = html;
    overModal.hidden = false;
    render();
  }

  // ---------- Human input ----------
  function selectedCards() {
    var out = [];
    for (var i = 0; i < hands[0].length; i++) if (sel[i]) out.push(hands[0][i]);
    return out;
  }
  function humanTurn() { return phase === "play" && turn === 0; }
  function tryHumanPlay() {
    if (!humanTurn()) return;
    var cards = selectedCards();
    if (!cards.length) { toast("Pick the cards to play"); return; }
    var combo = classify(cards);
    if (!combo) { toast("That is not a legal Big 2 combo"); return; }
    if (firstPlay && !containsDiamond3(combo)) { toast("The opening play must contain \u26663"); return; }
    if (table && cmpCombo(combo, table.combo) <= 0) {
      if (combo.type === table.combo.type) toast("Bigger " + comboName(table.combo) + " required");
      else if (LADDER[combo.type] && LADDER[table.combo.type]) toast(comboName(combo) + " does not outrank " + comboName(table.combo));
      else toast("Only a bigger " + typeName(table.combo.type) + " beats that");
      return;
    }
    for (var i = 0; i < cards.length; i++) {
      var idx = hands[0].indexOf(cards[i]);
      if (idx >= 0) hands[0].splice(idx, 1);
    }
    sel = {};
    table = { by: 0, cards: cards, combo: combo };
    passing = [false, false, false, false];
    firstPlay = false;
    if (hands[0].length === 0) { endHand(0); return; }
    turn = nextOf(0);
    saveHand(); render();
    setStatus(NAMES[turn] + " is thinking…");
    takeTurn();
  }
  function tryHumanPass() {
    if (!humanTurn() || !table || table.by === 0) { toast("You lead — you cannot pass"); return; }
    doPass(0);
  }
  function typeName(t) {
    return t === SINGLE ? "single" : t === PAIR ? "pair" : t === TRIP ? "triple"
      : t === SEQ ? "straight" : t === FULL ? "full house" : t === IRON ? "iron"
      : t === FLUSH ? "flush" : "straight flush";
  }

  // ---------- Rendering ----------
  function cardEl(card) {
    var el = document.createElement("div");
    el.className = "c-card c-card--up" + (isRed(card) ? " c-card--red" : "");
    var g = GLYPH[card.s], rl = rankLabel(card.r);
    el.innerHTML =
      '<div class="c-card__corner c-card__tl"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>' +
      '<div class="c-card__pip">' + g + '</div>' +
      '<div class="c-card__corner c-card__br"><span class="r">' + rl + '</span><span class="s">' + g + '</span></div>';
    return el;
  }
  function layoutFan(well, els, stepFrac) {
    if (!els.length) return;
    var cw = els[0].offsetWidth;
    var gap = Math.round(cw * stepFrac);
    if (els.length > 1) {
      var room = well.clientWidth - cw;
      if ((els.length - 1) * gap > room) gap = Math.max(6, Math.floor(room / (els.length - 1)));
    }
    var totalW = cw + gap * (els.length - 1);
    var x0 = Math.max(0, Math.round((well.clientWidth - totalW) / 2));
    for (var i = 0; i < els.length; i++) {
      els[i].style.left = (x0 + i * gap) + "px";
      els[i].style.zIndex = String(i + 1);
      els[i].style.setProperty("--r", ((i - (els.length - 1) / 2) * 1.2) + "deg");
    }
  }
  var lastTableSig = "none";
  function render() {
    handNoEl.textContent = String(handNo || "—");
    scoreEl.textContent = String(scores[0]);
    // opponents
    for (var s = 1; s <= 3; s++) {
      countEls[s].textContent = String(hands[s].length);
      flagEls[s].textContent = phase === "play" && table && passing[s] ? "passed" : "";
      var well = backEls[s - 1];
      well.innerHTML = "";
      var n = Math.min(3, hands[s].length);
      for (var i = 0; i < n; i++) {
        var b = document.createElement("div");
        b.className = "c-card c-card--down";
        b.style.setProperty("--i", String(i));
        well.appendChild(b);
      }
      layoutFan(well, well.children, 0.34);
      seatEls[s].classList.toggle("b2-seat--turn", phase === "play" && turn === s);
    }
    countEls[0].textContent = String(hands[0].length);
    flagEls[0].textContent = phase === "play" && table && passing[0] ? "passed" : "";
    // trick well — leave it untouched while the play is unchanged; a pass
    // would otherwise rebuild the same cards and restart their drop animation
    var sig = table ? table.by + ":" + table.cards.map(function (c) { return c.r + "" + c.s; }).join(",") : "none";
    if (sig !== lastTableSig) {
      lastTableSig = sig;
      trickWell.innerHTML = "";
      if (table) {
        var sorted = table.cards.slice().sort(function (a, b) { return pow(a.r) - pow(b.r); });
        var els = [];
        for (i = 0; i < sorted.length; i++) {
          var el = cardEl(sorted[i]);
          trickWell.appendChild(el);
          els.push(el);
        }
        layoutFan(trickWell, els, 0.66);
      }
    } else if (table) {
      layoutFan(trickWell, trickWell.children, 0.66); // keeps the fan on resize
    }
    if (table) {
      trickCaption.textContent = NAMES[table.by] + " played " + comboName(table.combo);
    } else {
      trickCaption.textContent = phase === "play"
        ? (NAMES[turn] === "You" ? "Your lead — play anything" : NAMES[turn] + " leads…")
        : "Press Deal to start";
    }
    // human hand
    handWell.innerHTML = "";
    var hel = [];
    for (i = 0; i < hands[0].length; i++) {
      var ce = cardEl(hands[0][i]);
      if (sel[i]) ce.classList.add("b2-sel");
      // bind BOTH the index and the element — closing over the loop's shared
      // `ce` var would make every handler toggle the LAST card's lift instead
      (function (idx, el) {
        el.addEventListener("click", function () {
          if (!humanTurn()) return;
          if (sel[idx]) delete sel[idx]; else sel[idx] = true;
          el.classList.toggle("b2-sel");
          syncButtons();
        });
      })(i, ce);
      handWell.appendChild(ce);
      hel.push(ce);
    }
    layoutFan(handWell, hel, 0.62);
    syncButtons();
  }
  function syncButtons() {
    var playing = phase === "play";
    var mine = humanTurn();
    var leading = !table || table.by === 0;
    // Deal shows between hands; Play/Pass stay visible during the whole
    // hand (greyed out while the computers think) so players always see
    // what the next move is.
    dealBtn.hidden = playing;
    playBtn.hidden = !playing;
    passBtn.hidden = !playing;
    playBtn.disabled = !mine;
    passBtn.disabled = !mine || leading;
    if (mine && selectedCards().length) {
      // live legality: gray out Play on picks that cannot be played
      var combo = classify(selectedCards());
      if (combo && firstPlay && !table && !containsDiamond3(combo)) playBtn.disabled = true;
      else if (combo && table && cmpCombo(combo, table.combo) <= 0) playBtn.disabled = true;
    }
  }
  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = "b2-status" + (cls ? " b2-status--" + cls : "");
    if (!msg) statusEl.style.visibility = "hidden"; else statusEl.style.visibility = "visible";
  }

  // ---------- Toast ----------
  var toastId = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastId);
    toastId = setTimeout(function () { toastEl.hidden = true; }, 1700);
  }

  // ---------- Rules modal ----------
  function openRules() { rulesModal.hidden = false; }
  function closeRules() { rulesModal.hidden = true; }
  rulesBtn.addEventListener("click", openRules);
  rulesModal.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-close]")) closeRules();
  });

  // ---------- Buttons & keys ----------
  playBtn.addEventListener("click", tryHumanPlay);
  passBtn.addEventListener("click", tryHumanPass);
  dealBtn.addEventListener("click", function () { deal(); });
  newBtn.addEventListener("click", function () {
    clearTimeout(aiTimer);
    if (phase === "play") toast("Hand abandoned — fresh deal");
    deal();
  });
  nextBtn.addEventListener("click", function () { overModal.hidden = true; deal(); });
  overClose.addEventListener("click", function () { overModal.hidden = true; });
  document.addEventListener("keydown", function (e) {
    if (!rulesModal.hidden) { if (e.key === "Escape") closeRules(); return; }
    if (!overModal.hidden) { if (e.key === "Enter") { overModal.hidden = true; deal(); } return; }
    var k = e.key.toLowerCase();
    if (k === "r") { openRules(); e.preventDefault(); return; }
    if (!humanTurn()) return;
    if (e.key === "Enter") { tryHumanPlay(); e.preventDefault(); }
    else if (k === "p") { tryHumanPass(); e.preventDefault(); }
  });
  window.addEventListener("resize", function () { if (phase !== "idle") render(); });

  // ---------- Boot ----------
  loadStats();
  if (loadHand()) {
    render();
    setStatus(turn === 0 ? "Resumed — your turn" : NAMES[turn] + " is thinking…");
    takeTurn();
  } else {
    phase = "idle";
    hands = [[], [], [], []];
    render();
    setStatus("Press Deal");
  }
})();
