/* ===== Windows XP Minesweeper clone — game logic ===== */
(function () {
  "use strict";

  // ---------- Configuration ----------
  const LEVELS = {
    easy:   { cols: 9,  rows: 9,  mines: 10, label: "Easy" },
    medium: { cols: 16, rows: 16, mines: 40, label: "Maximum" },
    expert: { cols: 30, rows: 16, mines: 99, label: "Expert" },
  };

  const FLAG = { NONE: 0, FLAG: 1, QUESTION: 2 };

  const THEMES = ["xp", "vista", "classic", "cyberpunk", "virus", "ocean", "crayon"];

  // ---------- DOM refs ----------
  const fieldEl = document.getElementById("field");
  const smileyEl = document.getElementById("smiley");
  const mineCounterEl = document.getElementById("mineCounter");
  const timerEl = document.getElementById("timer");
  const windowEl = document.getElementById("gameWindow");
  const overlayEl = document.getElementById("overlay");
  const overlayMsgEl = document.getElementById("overlayMsg");
  const modalRoot = document.getElementById("modal-root");
  const rollbackBtn = document.getElementById("rollbackBtn");
  const statusBar = document.getElementById("statusBar");
  const matrixCanvas = document.getElementById("matrixRain");
  const windowTitleEl = document.getElementById("windowTitle");
  const btnCloseEl = document.getElementById("btnClose");
  const backLinkEl = document.querySelector("a.gc-back");

  // ---------- Game state ----------
  let level = "expert";
  let theme = "xp";
  let godMode = false;
  let cols, rows, totalMines;
  let cells = [];        // flat array of cell objects
  let minesPlaced = false;
  let gameOver = false;
  let gameStarted = false;
  let firstClickCell = -1;
  let flagCount = 0;
  let revealedCount = 0;
  let time = 0;
  let timerId = null;
  let checkpoint = null;   // pre-move snapshot for God Mode rollback
  let canRollback = false;

  // ---------- Helpers ----------
  const idx = (c, r) => r * cols + c;
  const inBounds = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;
  const cellAt = (c, r) => cells[idx(c, r)];

  function neighbors(c, r) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;
        if (inBounds(c + dc, r + dr)) out.push(idx(c + dc, r + dr));
      }
    }
    return out;
  }

  // ---------- Seven-segment LED displays ----------
  const SEG_MAP = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
    "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "abcdfg",
    "-": "g", " ": "",
  };

  function buildLed(container) {
    container.innerHTML = "";
    const digits = [];
    for (let i = 0; i < 3; i++) {
      const d = document.createElement("div");
      d.className = "led-digit";
      const segs = {};
      "abcdefg".split("").forEach((s) => {
        const seg = document.createElement("i");
        seg.className = "seg " + s;
        d.appendChild(seg);
        segs[s] = seg;
      });
      container.appendChild(d);
      digits.push(segs);
    }
    return digits;
  }

  function renderLed(digits, str) {
    const s = String(str).padStart(3, " ").slice(-3);
    for (let i = 0; i < 3; i++) {
      const on = SEG_MAP[s[i]] ?? "";
      for (const seg in digits[i]) {
        digits[i][seg].classList.toggle("on", on.includes(seg));
      }
    }
  }

  let mineDigits, timerDigits;

  function formatCounter(n) {
    if (n < 0) return ("-" + Math.min(99, -n)).padStart(3, " ");
    return String(Math.min(999, n)).padStart(3, " ");
  }

  function updateMineCounter() {
    renderLed(mineDigits, formatCounter(totalMines - flagCount));
  }
  function updateTimer() {
    renderLed(timerDigits, String(Math.min(999, time)).padStart(3, " "));
  }

  // ---------- Smiley faces (theme-aware SVG) ----------
  let faceState = "normal";

  function classicFace(state) {
    const eyes = `<circle cx="9" cy="10.5" r="1.7" fill="#3a2a00"/>`
      + `<circle cx="17" cy="10.5" r="1.7" fill="#3a2a00"/>`;
    const smile = `<path d="M7 15 Q13 20.5 19 15" fill="none" stroke="#3a2a00" stroke-width="1.8" stroke-linecap="round"/>`;
    let inner;
    if (state === "worried") inner = eyes + `<ellipse cx="13" cy="16.8" rx="2.8" ry="3.6" fill="#3a2a00"/>`;
    else if (state === "dead") inner =
      `<g stroke="#3a2a00" stroke-width="1.7" stroke-linecap="round" fill="none">`
      + `<path d="M7 8.6 l4 4 M11 8.6 l-4 4"/><path d="M15 8.6 l4 4 M19 8.6 l-4 4"/></g>`
      + `<ellipse cx="13" cy="17" rx="2.6" ry="3.2" fill="#3a2a00"/>`;
    else if (state === "cool") inner =
      `<g fill="#141414"><rect x="4.6" y="9" width="7" height="4.6" rx="2"/>`
      + `<rect x="14.4" y="9" width="7" height="4.6" rx="2"/>`
      + `<rect x="11" y="10.4" width="4" height="1.4"/></g>` + smile;
    else inner = eyes + smile;
    return `<svg viewBox="0 0 26 26" width="26" height="26" class="face-classic" aria-hidden="true">`
      + `<circle cx="13" cy="13" r="11.5" fill="#ffd23f" stroke="#8a6d00" stroke-width="1"/>`
      + inner + `</svg>`;
  }

  function cyberFace(state) {
    const cyan = "#0affff", mag = "#ff2b6b";
    const eyes = `<rect x="7.4" y="7.2" width="2.6" height="5" rx="1.2" fill="${cyan}"/>`
      + `<rect x="16" y="7.2" width="2.6" height="5" rx="1.2" fill="${cyan}"/>`;
    const smile = `<path d="M7.5 16.5 Q13 21 18.5 16.5" fill="none" stroke="${cyan}" stroke-width="1.8" stroke-linecap="round"/>`;
    let inner;
    if (state === "worried") inner = eyes + `<rect x="10.4" y="16" width="5.2" height="4.2" rx="1" fill="${cyan}"/>`;
    else if (state === "dead") inner =
      `<g stroke="${mag}" stroke-width="1.9" stroke-linecap="round" fill="none">`
      + `<path d="M7 8 l4.6 4.6 M11.6 8 l-4.6 4.6"/><path d="M14.4 8 l4.6 4.6 M19 8 l-4.6 4.6"/>`
      + `<path d="M9 18.5 l2 -1.6 l2 1.6 l2 -1.6 l2 1.6"/></g>`;
    else if (state === "cool") inner =
      `<rect x="4.6" y="8" width="16.8" height="4.4" rx="1.8" fill="${cyan}"/>`
      + `<rect x="6" y="9" width="14" height="1" rx="0.5" fill="rgba(255,255,255,.7)"/>` + smile;
    else inner = eyes + smile;
    return `<svg viewBox="0 0 26 26" width="26" height="26" class="face-cyber" aria-hidden="true">`
      + `<circle cx="13" cy="13" r="11.5" fill="#0b1220" stroke="${cyan}" stroke-width="1.4"/>`
      + `<circle cx="13" cy="13" r="9" fill="none" stroke="${mag}" stroke-width="0.5" opacity=".45"/>`
      + inner + `</svg>`;
  }

  function virusFace(state) {
    const g = "#4dff7c", y = "#ffe14d", red = "#ff5a5a";
    const eyes = `<rect x="7.4" y="7.2" width="2.6" height="5" rx="1.2" fill="${g}"/>`
      + `<rect x="16" y="7.2" width="2.6" height="5" rx="1.2" fill="${g}"/>`;
    const smile = `<path d="M7.5 16.5 Q13 21 18.5 16.5" fill="none" stroke="${g}" stroke-width="1.8" stroke-linecap="round"/>`;
    let inner;
    if (state === "worried") inner = eyes + `<rect x="10.4" y="16" width="5.2" height="4.2" rx="1" fill="${y}"/>`;
    else if (state === "dead") inner =
      `<g stroke="${red}" stroke-width="1.9" stroke-linecap="round" fill="none">`
      + `<path d="M7 8 l4.6 4.6 M11.6 8 l-4.6 4.6"/><path d="M14.4 8 l4.6 4.6 M19 8 l-4.6 4.6"/>`
      + `<path d="M9 18.5 l2 -1.6 l2 1.6 l2 -1.6 l2 1.6"/></g>`;
    else if (state === "cool") inner =
      `<rect x="4.6" y="8" width="16.8" height="4.4" rx="1.8" fill="${g}"/>`
      + `<rect x="6" y="9" width="14" height="1" rx="0.5" fill="rgba(255,255,255,.7)"/>` + smile;
    else inner = eyes + smile;
    return `<svg viewBox="0 0 26 26" width="26" height="26" class="face-virus" aria-hidden="true">`
      + `<circle cx="13" cy="13" r="11.5" fill="#06180b" stroke="${g}" stroke-width="1.4"/>`
      + `<circle cx="13" cy="13" r="9" fill="none" stroke="${y}" stroke-width="0.5" opacity=".5"/>`
      + inner + `</svg>`;
  }

  function oceanFace(state) {
    const blue = "#0a5aa8", foam = "#bfe6f5", line = "#0b6ea8", red = "#c62828";
    const eyes = `<circle cx="9" cy="10.5" r="1.8" fill="${blue}"/>`
      + `<circle cx="17" cy="10.5" r="1.8" fill="${blue}"/>`;
    const smile = `<path d="M7 15 Q13 20.5 19 15" fill="none" stroke="${blue}" stroke-width="1.9" stroke-linecap="round"/>`;
    let inner;
    if (state === "worried") inner = eyes + `<ellipse cx="13" cy="16.8" rx="2.8" ry="3.6" fill="${blue}"/>`;
    else if (state === "dead") inner =
      `<g stroke="${red}" stroke-width="1.8" stroke-linecap="round" fill="none">`
      + `<path d="M7 8.6 l4 4 M11 8.6 l-4 4"/><path d="M15 8.6 l4 4 M19 8.6 l-4 4"/></g>`
      + `<ellipse cx="13" cy="17" rx="2.6" ry="3.2" fill="${red}"/>`;
    else if (state === "cool") inner =
      `<g fill="${blue}"><rect x="4.6" y="9" width="7" height="4.6" rx="2"/>`
      + `<rect x="14.4" y="9" width="7" height="4.6" rx="2"/>`
      + `<rect x="11" y="10.4" width="4" height="1.4"/></g>` + smile;
    else inner = eyes + smile;
    return `<svg viewBox="0 0 26 26" width="26" height="26" class="face-ocean" aria-hidden="true">`
      + `<circle cx="13" cy="13" r="11.5" fill="${foam}" stroke="${line}" stroke-width="1.4"/>`
      + `<circle cx="9.5" cy="9" r="3.2" fill="rgba(255,255,255,.55)"/>`
      + inner + `</svg>`;
  }

  function faceSvg(state, t) {
    if (t === "cyberpunk") return cyberFace(state);
    if (t === "virus") return virusFace(state);
    if (t === "ocean") return oceanFace(state);
    return classicFace(state);
  }
  function renderFace(state) {
    faceState = state;
    smileyEl.innerHTML = faceSvg(state, theme);
    smileyEl.setAttribute("data-face", state);
  }

  // ---------- Board rendering ----------
  function buildBoard() {
    const cfg = LEVELS[level];
    cols = cfg.cols; rows = cfg.rows; totalMines = cfg.mines;

    fieldEl.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
    fieldEl.style.gridTemplateRows = `repeat(${rows}, var(--cell))`;
    fieldEl.innerHTML = "";
    fieldEl.classList.remove("locked");

    cells = new Array(cols * rows);
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const el = document.createElement("div");
        el.className = "cell";
        el.dataset.c = c; el.dataset.r = r;
        frag.appendChild(el);
        cells[idx(c, r)] = {
          mine: false, adj: 0, revealed: false, flag: FLAG.NONE, el,
        };
      }
    }
    fieldEl.appendChild(frag);

    minesPlaced = false;
    gameOver = false;
    gameStarted = false;
    flagCount = 0;
    revealedCount = 0;
    firstClickCell = -1;
    stopTimer();
    time = 0;
    updateTimer();
    updateMineCounter();
    renderFace("normal");
    windowEl.classList.remove("win");
    canRollback = false;
    if (rollbackBtn) { rollbackBtn.hidden = true; }
    smileyEl.title = "New game";
    markChecked();
    layout();
  }

  // Compute the largest cell size (in px) that lets the current grid fit
  // within the viewport without overflowing, then expose it as --cell.
  function layout() {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pad = parseFloat(getComputedStyle(fieldEl.closest(".desktop")).paddingLeft) || 0;

    // Pass 1: render at a reference size to measure fixed chrome (title bar,
    // menu, counters, bevels). This overhead does not depend on cell size.
    // Lift the max-size clamp so offsetWidth/Height report the true size.
    fieldEl.style.setProperty("--cell", "20px");
    const prevMax = windowEl.style.cssText;
    windowEl.style.maxWidth = "none";
    windowEl.style.maxHeight = "none";
    const overheadX = windowEl.offsetWidth - fieldEl.offsetWidth;
    const overheadY = windowEl.offsetHeight - fieldEl.offsetHeight;
    windowEl.style.cssText = prevMax;

    const availFieldW = vw - pad * 2 - overheadX;
    const availFieldH = vh - pad * 2 - overheadY;

    let size = Math.floor(Math.min(availFieldW / cols, availFieldH / rows));
    size = Math.max(8, Math.min(size, 46));
    fieldEl.style.setProperty("--cell", size + "px");
  }

  function placeMines(safeIndex) {
    const safeZone = new Set([safeIndex, ...neighbors(
      safeIndex % cols, Math.floor(safeIndex / cols)
    )]);
    let placed = 0;
    // If board is too small to guarantee a full safe zone, relax.
    const maxSafe = cols * rows - totalMines;
    const allowSafe = safeZone.size <= maxSafe;
    while (placed < totalMines) {
      const i = Math.floor(Math.random() * cells.length);
      if (cells[i].mine) continue;
      if (allowSafe && safeZone.has(i)) continue;
      cells[i].mine = true;
      placed++;
    }
    minesPlaced = true;
    computeAdj();
  }

  function computeAdj() {
    for (let i = 0; i < cells.length; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      cells[i].adj = neighbors(c, r).filter((n) => cells[n].mine).length;
    }
  }

  // ---------- Cell visuals ----------
  const MINE_SVG = `<svg viewBox="0 0 16 16" class="mine"><g class="spikes" stroke="currentColor" stroke-width="1.4">
    <line x1="8" y1="1" x2="8" y2="15"/><line x1="1" y1="8" x2="15" y2="8"/>
    <line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></g>
    <circle cx="8" cy="8" r="4.2" fill="currentColor"/><circle class="hl" cx="6.4" cy="6.4" r="1.2"/></svg>`;
  // Virus particle: radial spikes tipped with glycoprotein knobs around a body.
  const spoke = (a) => `<g transform="rotate(${a} 8 8)"><line x1="8" y1="4.2" x2="8" y2="2.4"/><circle cx="8" cy="1.7" r="1.1"/></g>`;
  const MINE_VIRUS = `<svg viewBox="0 0 16 16" class="mine mine-virus">`
    + `<g class="spikes" stroke="currentColor" stroke-width="1.3" fill="currentColor">`
    + [0, 45, 90, 135, 180, 225, 270, 315].map(spoke).join("") + `</g>`
    + `<circle cx="8" cy="8" r="4.4" fill="currentColor"/><circle class="hl" cx="6.5" cy="6.5" r="1.2"/></svg>`;
  function mineSvg(t) { return t === "virus" ? MINE_VIRUS : MINE_SVG; }

  const FLAG_CLASSIC = `<svg viewBox="0 0 16 16" class="flag"><rect x="3" y="2.5" width="2" height="11" fill="currentColor"/>
    <path d="M5 3 L13 5.5 L5 8 Z" fill="#d40000"/><rect x="2" y="13" width="6" height="1.6" fill="currentColor"/></svg>`;
  const FLAG_CYBER = `<svg viewBox="0 0 16 16" class="flag flag-cyber">
    <rect x="3" y="2" width="1.6" height="11.5" fill="#0affff"/>
    <path d="M4.6 2.4 L13.5 5.2 L4.6 8 Z" fill="#ff2b6b" stroke="#0affff" stroke-width="0.6" stroke-linejoin="round"/>
    <rect x="1.6" y="13.2" width="6.4" height="1.8" rx="0.6" fill="#0affff"/></svg>`;
  const FLAG_VIRUS = `<svg viewBox="0 0 16 16" class="flag flag-virus">
    <rect x="3" y="2" width="1.8" height="11.5" fill="#79ff9a"/>
    <path d="M4.8 2.4 L13 5 L4.8 7.6 Z" fill="#ffe14d" stroke="#1f7a2e" stroke-width="0.6" stroke-linejoin="round"/>
    <rect x="1.6" y="13.2" width="6.4" height="1.8" rx="0.6" fill="#79ff9a"/></svg>`;
  function flagSvg(t) {
    if (t === "cyberpunk") return FLAG_CYBER;
    if (t === "virus") return FLAG_VIRUS;
    return FLAG_CLASSIC;
  }

  function paintCell(i) {
    const cell = cells[i];
    const el = cell.el;
    el.className = "cell";
    el.innerHTML = "";
    if (cell.revealed) {
      el.classList.add("revealed");
      if (cell.mine) {
        el.innerHTML = mineSvg(theme);
        if (i === firstClickCell) el.classList.add("mine-hit");
      } else if (cell.adj > 0) {
        el.textContent = cell.adj;
        el.dataset.n = cell.adj;
      }
    } else {
      if (cell.flag === FLAG.FLAG) el.innerHTML = flagSvg(theme);
      else if (cell.flag === FLAG.QUESTION) { el.textContent = "?"; el.classList.add("question"); }
    }
  }

  // ---------- Reveal / flood fill ----------
  function reveal(startIndex) {
    const stack = [startIndex];
    while (stack.length) {
      const i = stack.pop();
      const cell = cells[i];
      if (cell.revealed || cell.flag === FLAG.FLAG) continue;
      cell.revealed = true;
      cell.flag = FLAG.NONE;
      revealedCount++;
      paintCell(i);
      if (cell.adj === 0 && !cell.mine) {
        const c = i % cols, r = Math.floor(i / cols);
        for (const n of neighbors(c, r)) {
          if (!cells[n].revealed) stack.push(n);
        }
      }
    }
  }

  function explode(i, reason) {
    firstClickCell = i;
    cells[i].revealed = true;
    gameOver = true;
    stopTimer();
    fieldEl.classList.add("locked");
    renderFace("dead");

    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j];
      if (cell.mine && cell.flag !== FLAG.FLAG) {
        cell.revealed = true;
        paintCell(j);
      } else if (!cell.mine && cell.flag === FLAG.FLAG) {
        // wrong flag
        cell.el.className = "cell wrong";
        cell.el.innerHTML = flagSvg(theme);
      }
    }
    paintCell(i);
    cells[i].el.classList.add("mine-hit");

    clearSave();

    if (godMode && checkpoint) {
      // God Mode: allow undoing the fatal move instead of ending the game.
      canRollback = true;
      rollbackBtn.hidden = false;
      smileyEl.title = "Rollback (God Mode)";
      setStatus("Boom! Click Rollback (or the smiley) to undo the fatal move.");
    } else {
      setStatus("Boom! You hit a mine.");
    }
  }

  function checkWin() {
    if (revealedCount === cols * rows - totalMines) {
      gameOver = true;
      stopTimer();
      fieldEl.classList.add("locked");
      renderFace("cool");
      windowEl.classList.add("win");
      // auto-flag remaining mines
      for (const cell of cells) {
        if (cell.mine && cell.flag !== FLAG.FLAG) {
          cell.flag = FLAG.FLAG;
          flagCount++;
          paintCell(cells.indexOf(cell));
        }
      }
      updateMineCounter();
      recordBestTime();
      clearSave();
      setStatus(`You cleared ${cols}\u00d7${rows} in ${time}s! \u2014 ${LEVELS[level].label}`);
      canRollback = false;
      rollbackBtn.hidden = true;
    }
  }

  // ---------- Chording ----------
  function chord(i) {
    const cell = cells[i];
    if (!cell.revealed || cell.adj === 0) return;
    const c = i % cols, r = Math.floor(i / cols);
    const ns = neighbors(c, r);
    const flags = ns.filter((n) => cells[n].flag === FLAG.FLAG).length;
    if (flags !== cell.adj) return;
    let boomed = false;
    for (const n of ns) {
      if (cells[n].flag !== FLAG.FLAG && !cells[n].revealed) {
        if (cells[n].mine) { explode(n); boomed = true; }
        else reveal(n);
      }
    }
    if (!boomed) checkWin();
  }

  // ---------- Timer ----------
  function startTimer() {
    if (timerId) return;
    timerId = setInterval(() => {
      if (time < 999) { time++; updateTimer(); saveGame(); }
    }, 1000);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  // ---------- Status bar ----------
  function setStatus(msg) { if (statusBar) statusBar.textContent = msg; }

  // ---------- Persistence (resume across refresh) ----------
  // Compact serialization: cells are [mine, revealed, flag] tuples; adjacencies
  // are recomputed from mines on restore.
  function serializeGame() {
    return {
      v: 1,
      level,
      minesPlaced, gameStarted, gameOver,
      firstClickCell, time,
      outcome: !gameOver ? null
        : (revealedCount === cells.filter((c) => !c.mine).length ? "win" : "lose"),
      cells: cells.map((c) => [c.mine ? 1 : 0, c.revealed ? 1 : 0, c.flag]),
    };
  }

  function saveGame() {
    try { localStorage.setItem("ms-game", JSON.stringify(serializeGame())); }
    catch {}
  }
  function clearSave() {
    try { localStorage.removeItem("ms-game"); } catch {}
  }

  // Rebuild the board for level `l` and repaint from a serialized snapshot.
  function applyGame(s) {
    if (!s || !LEVELS[s.level] || !Array.isArray(s.cells)) return false;
    if (s.level !== level) level = s.level;
    buildBoard();  // fresh DOM; scalars overridden below
    if (s.cells.length !== cells.length) { newGame(); return true; }

    for (let j = 0; j < cells.length; j++) {
      cells[j].mine = !!s.cells[j][0];
      cells[j].revealed = !!s.cells[j][1];
      cells[j].flag = s.cells[j][2] | 0;
    }
    computeAdj();
    minesPlaced = !!s.minesPlaced;
    gameStarted = !!s.gameStarted;
    gameOver = !!s.gameOver;
    firstClickCell = s.firstClickCell == null ? -1 : s.firstClickCell;
    flagCount = cells.reduce((a, c) => a + (c.flag === FLAG.FLAG ? 1 : 0), 0);
    revealedCount = cells.filter((c) => c.revealed).length;
    time = Math.min(999, s.time | 0);

    for (let j = 0; j < cells.length; j++) paintCell(j);
    updateMineCounter();
    updateTimer();

    if (gameOver) {
      fieldEl.classList.add("locked");
      renderFace(s.outcome === "win" ? "cool" : "dead");
      if (s.outcome === "win") windowEl.classList.add("win");
      setStatus(s.outcome === "win" ? "You won — press F2 or the smiley for a new game."
                                     : "You lost — press F2 or the smiley for a new game.");
    } else {
      setStatus(minesPlaced ? "Good luck!" : "First click is always safe.");
      if (minesPlaced) startTimer();
    }
    saveGame();
    return true;
  }

  // ---------- God Mode ----------
  function setGodMode(on) {
    godMode = !!on;
    try { localStorage.setItem("ms-god", godMode ? "1" : "0"); } catch {}
    updateGodMenu();
    if (!godMode) { canRollback = false; rollbackBtn.hidden = true; }
    setStatus(godMode
      ? "God Mode ON — fatal moves can be rolled back."
      : "God Mode off.");
  }
  function updateGodMenu() {
    const b = document.querySelector('button[data-action="god-mode"]');
    if (b) b.classList.toggle("checked", godMode);
  }

  function doRollback() {
    if (!checkpoint) { newGame(); return; }
    const s = checkpoint;
    canRollback = false;
    rollbackBtn.hidden = true;
    checkpoint = null;
    applyGame(s);
    if (minesPlaced && !gameOver) startTimer();
    setStatus("Rolled back to before the fatal move.");
  }

  // ---------- Input ----------
  fieldEl.addEventListener("contextmenu", (e) => e.preventDefault());

  fieldEl.addEventListener("mousedown", (e) => {
    if (gameOver || e.button > 2) return;
    const cellEl = e.target.closest(".cell");
    if (!cellEl) return;
    const i = idx(+cellEl.dataset.c, +cellEl.dataset.r);
    if (e.button === 0 && !cells[i].revealed && cells[i].flag !== FLAG.FLAG) {
      renderFace("worried");
    }
  });

  fieldEl.addEventListener("mouseup", (e) => {
    if (gameOver) return;
    const cellEl = e.target.closest(".cell");
    if (!cellEl) return;
    const i = idx(+cellEl.dataset.c, +cellEl.dataset.r);
    const cell = cells[i];

    if (e.button === 2) {
      // cycle flag / question
      if (cell.revealed) return;
      if (cell.flag === FLAG.NONE) { cell.flag = FLAG.FLAG; flagCount++; }
      else if (cell.flag === FLAG.FLAG) { cell.flag = FLAG.QUESTION; flagCount--; }
      else { cell.flag = FLAG.NONE; }
      paintCell(i);
      updateMineCounter();
      saveGame();
      return;
    }

    // Snapshot the pre-move state so a fatal click can be rolled back.
    if (minesPlaced) checkpoint = serializeGame();

    if (e.button === 1) { // middle click = chord
      e.preventDefault();
      if (cell.revealed) { chord(i); if (!gameOver) saveGame(); }
      return;
    }

    if (e.button === 0) {
      renderFace("normal");
      if (cell.flag === FLAG.FLAG) return;
      if (cell.revealed) { chord(i); if (!gameOver) saveGame(); return; }

      if (!minesPlaced) {
        placeMines(i);
        checkpoint = null; // first move is always safe; nothing to undo
        if (!gameStarted) { gameStarted = true; startTimer(); }
      }
      if (cell.mine) { explode(i, "You uncovered a mine."); return; }
      reveal(i);
      checkWin();
      if (!gameOver) saveGame();
    }
  });

  // prevent middle-click autoscroll
  fieldEl.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });

  smileyEl.addEventListener("click", () => {
    if (gameOver && canRollback && checkpoint) doRollback();
    else newGame();
  });
  rollbackBtn.addEventListener("click", () => { if (canRollback) doRollback(); });

  // ---------- Best times ----------
  function bestKey() { return `ms-best-${level}`; }
  function getBestTimes() {
    try { return JSON.parse(localStorage.getItem(bestKey())) || {}; }
    catch { return {}; }
  }
  function recordBestTime() {
    const data = getBestTimes();
    const t = time;
    if (data.best === undefined || t < data.best) {
      data.best = t;
      try { localStorage.setItem(bestKey(), JSON.stringify(data)); } catch {}
    }
  }

  // ---------- Menu / dialogs ----------
  function newGame() { buildBoard(); saveGame(); setStatus(godMode ? "New game — God Mode ON." : "New game — first click is always safe."); }

  function setLevel(l) { if (LEVELS[l]) { level = l; buildBoard(); saveGame(); setStatus(godMode ? "New game — God Mode ON." : "New game — first click is always safe."); } }

  // ---------- Matrix code rain (Virus theme background) ----------
  const matrixCtx = matrixCanvas ? matrixCanvas.getContext("2d") : null;
  const MATRIX_GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモ0123456789ABCDEF$#%&*+=";
  const MATRIX_FONT_PX = 16;
  const reduceMotion = !!(window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let matrixRaf = null, matrixCols = 0, matrixDrops = [], matrixStep = 0;

  function matrixResize() {
    if (!matrixCanvas) return;
    matrixCanvas.width = window.innerWidth;
    matrixCanvas.height = window.innerHeight;
    matrixCols = Math.ceil(matrixCanvas.width / MATRIX_FONT_PX);
    matrixDrops = new Array(matrixCols);
    for (let i = 0; i < matrixCols; i++) matrixDrops[i] = Math.random() * -60;
    if (matrixCtx) {
      matrixCtx.fillStyle = "#03170a";
      matrixCtx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);
    }
  }

  function matrixFrame() {
    matrixRaf = requestAnimationFrame(matrixFrame);
    if ((matrixStep++ % 3) !== 0) return;   // ~20fps: plenty for rain, saves CPU
    const w = matrixCanvas.width, h = matrixCanvas.height;
    matrixCtx.fillStyle = "rgba(3, 23, 10, 0.08)";   // translucent wipe = fading trail
    matrixCtx.fillRect(0, 0, w, h);
    matrixCtx.font = MATRIX_FONT_PX + "px monospace";
    matrixCtx.textAlign = "center";
    for (let i = 0; i < matrixCols; i++) {
      const glyph = MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0];
      const x = i * MATRIX_FONT_PX + MATRIX_FONT_PX / 2;
      const y = matrixDrops[i] * MATRIX_FONT_PX;
      matrixCtx.fillStyle = "rgba(215,255,220,.95)";  // bright leading glyph
      matrixCtx.fillText(glyph, x, y);
      matrixCtx.fillStyle = "rgba(40,205,90,.5)";     // green trail
      matrixCtx.fillText(glyph, x, y - MATRIX_FONT_PX);
      if (y > h && Math.random() > 0.972) matrixDrops[i] = 0;
      matrixDrops[i] += 1;
    }
  }

  function startMatrix() {
    if (!matrixCtx || reduceMotion || matrixRaf) return;
    matrixResize();
    matrixRaf = requestAnimationFrame(matrixFrame);
  }
  function stopMatrix() {
    if (matrixRaf) { cancelAnimationFrame(matrixRaf); matrixRaf = null; }
  }

  // The Virus theme renames the game; every other theme keeps the original.
  function titleFor(t) { return t === "virus" ? "Virussweeper" : "Minesweeper"; }
  function applyTitle(t) {
    if (windowTitleEl) windowTitleEl.textContent = titleFor(t);
    document.title = titleFor(t);
  }

  // Theme is applied by setting data-theme on <html>; flags/faces are repainted.
  function setTheme(t) {
    if (!THEMES.includes(t)) return;
    theme = t;
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("ms-theme", t); } catch {}
    markChecked();
    renderFace(faceState);
    for (let i = 0; i < cells.length; i++) paintCell(i);
    applyTitle(t);
    if (t === "virus") startMatrix(); else stopMatrix();
  }

  // Group-aware checkmark rendering for menu items (difficulty + theme).
  function markChecked() {
    const active = { level, theme: "theme-" + theme };
    document.querySelectorAll(".menu-dropdown button[data-action]").forEach((b) => {
      const group = b.dataset.check;
      if (!group) return;
      b.classList.toggle("checked", b.dataset.action === active[group]);
    });
  }

  function openDialog(title, bodyHtml, buttons) {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="title-bar">
          <div class="title-bar-inner"><span class="title-text">${title}</span></div>
          <div class="title-buttons"><button class="tb-btn close" data-close aria-label="Close"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.8 1.8 L8.2 8.2 M8.2 1.8 L1.8 8.2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></button></div>
        </div>
        <div class="dialog-content">${bodyHtml}</div>
        <div class="dialog-buttons"></div>
      </div>`;
    const btnWrap = backdrop.querySelector(".dialog-buttons");
    (buttons || [{ label: "OK", primary: true }]).forEach((b) => {
      const el = document.createElement("button");
      el.className = "xp-btn" + (b.primary ? " primary" : "");
      el.textContent = b.label;
      el.addEventListener("click", () => { closeModal(); b.onClick && b.onClick(); });
      btnWrap.appendChild(el);
    });
    backdrop.querySelector("[data-close]").addEventListener("click", closeModal);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeModal(); });
    modalRoot.innerHTML = "";
    modalRoot.appendChild(backdrop);
    return backdrop;
  }
  function closeModal() { modalRoot.innerHTML = ""; }

  function showBestTimes() {
    const rows = Object.keys(LEVELS).map((k) => {
      const b = (() => { try { return JSON.parse(localStorage.getItem(`ms-best-${k}`))?.best; } catch { return null; } })();
      return `<tr><th>${LEVELS[k].label}</th><td>${b != null ? b + " sec" : "— none —"}</td></tr>`;
    }).join("");
    openDialog("Minesweeper Best Times",
      `<table><tbody>${rows}</tbody></table>`, [{ label: "OK", primary: true }]);
  }

  function showHowToPlay() {
    openDialog("How to Play", `
      <p>The object of Minesweeper is to clear the minefield quickly without
      detonating any of the mines.</p>
      <ul>
        <li><b>Left-click</b> a square to uncover it.</li>
        <li><b>Right-click</b> to place a flag (and again for a <b>?</b> marker).</li>
        <li>Numbers indicate how many mines touch that square.</li>
        <li>Click an uncovered number with the correct flags around it to
        <b>chord</b> (uncover neighbors at once).</li>
        <li>The first click is always safe. Click the smiley to start a new game.</li>
        <li>Your game is <b>saved automatically</b> — refresh the page to keep playing.</li>
        <li>Turn on <b>Game &rarr; God Mode</b> to roll back a fatal move
        (press <b>R</b> or click the smiley after stepping on a mine).</li>
      </ul>`, [{ label: "OK", primary: true }]);
  }

  const THEME_LABELS = { xp: "Windows XP", vista: "Windows Vista", classic: "Classic 95", cyberpunk: "Cyberpunk", virus: "Virus", ocean: "Ocean", crayon: "Crayon" };
  function showAbout() {
    openDialog("About Minesweeper", `
      <div class="icon-row" style="font-size:22px">${faceSvg("cool", theme)}</div>
      <p><b>Minesweeper</b></p>
      <p>An HTML5 tribute to the classic Windows game, with multiple themes.</p>
      <p style="color:#666">Theme: <b>${THEME_LABELS[theme] || theme}</b><br />
      You are playing: <b>${LEVELS[level].label}</b>
      (${cols}&times;${rows}, ${totalMines} mines)<br />
      God Mode: <b>${godMode ? "ON" : "off"}</b></p>`,
      [{ label: "OK", primary: true }]);
  }

  function flashWindow() {
    windowEl.classList.remove("flash");
    void windowEl.offsetWidth;
    windowEl.classList.add("flash");
    setTimeout(() => windowEl.classList.remove("flash"), 400);
  }

  overlayEl.addEventListener("click", () => { overlayEl.hidden = true; });

  // ---------- Window controls ----------
  // Returns to the game center. The target is read from the shared back link so
  // the centre's path is declared in exactly one place (index.html).
  function goToCenter() {
    // assign() leaves a history entry, so the browser Back button comes back to
    // the board; the game itself is persisted in ms-game either way.
    window.location.assign(backLinkEl ? backLinkEl.href : "../../index.html");
  }
  btnCloseEl.addEventListener("click", goToCenter);

  // ---------- Menu behavior ----------
  const menuBar = document.getElementById("menuBar");
  let menuOpen = false;

  function closeMenus() {
    menuBar.querySelectorAll(".menu-item").forEach((m) => m.classList.remove("open"));
    menuOpen = false;
  }

  menuBar.querySelectorAll(".menu-item > .menu-label").forEach((label) => {
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = label.parentElement;
      const wasOpen = item.classList.contains("open");
      closeMenus();
      if (!wasOpen) { item.classList.add("open"); menuOpen = true; }
    });
    label.addEventListener("mouseenter", () => {
      if (menuOpen) {
        closeMenus();
        item_open(label);
      }
    });
  });
  function item_open(label) {
    label.parentElement.classList.add("open");
    menuOpen = true;
  }

  menuBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".menu-dropdown button");
    if (!btn) return;
    const action = btn.dataset.action;
    closeMenus();
    handleAction(action);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-bar")) closeMenus();
  });

  function handleAction(action) {
    switch (action) {
      case "new": newGame(); break;
      case "easy": setLevel("easy"); break;
      case "medium": setLevel("medium"); break;
      case "expert": setLevel("expert"); break;
      case "exit": goToCenter(); break;
      case "how-to-play": showHowToPlay(); break;
      case "about": showAbout(); break;
      case "best-times": showBestTimes(); break;
      case "god-mode": setGodMode(!godMode); break;
      case "rollback": if (canRollback) doRollback(); break;
      default:
        if (action && action.startsWith("theme-")) setTheme(action.slice(6));
    }
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (modalRoot.firstChild) { if (e.key === "Escape") closeModal(); return; }
    const k = e.key.toLowerCase();
    if (e.altKey) {
      const map = { g: "game", t: "theme", h: "help" };
      if (map[k]) {
        e.preventDefault();
        const item = menuBar.querySelector(`[data-menu="${map[k]}"]`);
        closeMenus(); item.classList.add("open"); menuOpen = true;
      }
      return;
    }
    if (k === "f2") { e.preventDefault(); newGame(); }
    else if (k === "1") setLevel("easy");
    else if (k === "2") setLevel("medium");
    else if (k === "3") setLevel("expert");
    else if (k === "r" && canRollback) { e.preventDefault(); doRollback(); }
    else if (k === "g" && e.ctrlKey) { e.preventDefault(); setGodMode(!godMode); }
    else if (k === "b" && e.ctrlKey) { e.preventDefault(); showBestTimes(); }
  });

  // ---------- Init ----------
  mineDigits = buildLed(mineCounterEl);
  timerDigits = buildLed(timerEl);

  // Restore saved theme (validate against the known list).
  try {
    const saved = localStorage.getItem("ms-theme");
    if (saved && THEMES.includes(saved)) theme = saved;
  } catch {}
  document.documentElement.setAttribute("data-theme", theme);
  applyTitle(theme);
  if (theme === "virus") startMatrix();

  // Restore God Mode preference.
  try { godMode = localStorage.getItem("ms-god") === "1"; } catch {}
  updateGodMenu();

  // Resume the previous game if one was saved; otherwise start fresh.
  let restored = false;
  try {
    const raw = localStorage.getItem("ms-game");
    const s = raw && JSON.parse(raw);
    if (s && s.v === 1) restored = applyGame(s);
  } catch {}
  if (!restored) {
    buildBoard();
    saveGame();
    setStatus("Welcome! Left-click to reveal, right-click to flag.");
  }

  // Keep the board fitted to the viewport (does not reset game state).
  let resizeRaf = null;
  function scheduleLayout() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      layout();
      if (matrixRaf) matrixResize();
    });
  }
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("orientationchange", scheduleLayout);

  // Pause the rain while the tab is hidden; resume on Virus theme.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMatrix();
    else if (theme === "virus") startMatrix();
  });
})();
