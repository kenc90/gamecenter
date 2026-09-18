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

  // ---------- DOM refs ----------
  const fieldEl = document.getElementById("field");
  const smileyEl = document.getElementById("smiley");
  const mineCounterEl = document.getElementById("mineCounter");
  const timerEl = document.getElementById("timer");
  const windowEl = document.getElementById("gameWindow");
  const overlayEl = document.getElementById("overlay");
  const overlayMsgEl = document.getElementById("overlayMsg");
  const modalRoot = document.getElementById("modal-root");

  // ---------- Game state ----------
  let level = "expert";
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

  // ---------- Smiley faces ----------
  const FACES = {
    normal: "😊", worried: "😮", dead: "😵", cool: "😎",
  };
  function renderFace(state) {
    smileyEl.textContent = FACES[state] || FACES.normal;
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
    markActiveLevel();
    layout();
  }

  // Compute the largest cell size (in px) that lets the current grid fit
  // within the viewport, then expose it as the --cell custom property.
  function layout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Reserve space for window chrome, title bar, menu, top panel and bevels.
    const padX = 48;
    const padY = 128;
    const availW = Math.max(120, vw - padX);
    const availH = Math.max(120, vh - padY);
    // Border thickness (2px each side) is fixed, so subtract it per cell.
    let size = Math.floor(Math.min((availW - cols * 3) / cols, (availH - rows * 3) / rows));
    size = Math.max(12, Math.min(size, 46));
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
    for (let i = 0; i < cells.length; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      cells[i].adj = neighbors(c, r).filter((n) => cells[n].mine).length;
    }
    minesPlaced = true;
  }

  // ---------- Cell visuals ----------
  const MINE_SVG = `<svg viewBox="0 0 16 16"><g stroke="#000" stroke-width="1.2">
    <line x1="8" y1="1" x2="8" y2="15"/><line x1="1" y1="8" x2="15" y2="8"/>
    <line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></g>
    <circle cx="8" cy="8" r="4.2" fill="#000"/><circle cx="6.4" cy="6.4" r="1.2" fill="#fff"/></svg>`;
  const FLAG_SVG = `<svg viewBox="0 0 16 16"><rect x="3" y="2.5" width="2" height="11" fill="#000"/>
    <path d="M5 3 L13 5.5 L5 8 Z" fill="#d40000"/><rect x="2" y="13" width="6" height="1.6" fill="#000"/></svg>`;

  function paintCell(i) {
    const cell = cells[i];
    const el = cell.el;
    el.className = "cell";
    el.innerHTML = "";
    if (cell.revealed) {
      el.classList.add("revealed");
      if (cell.mine) {
        el.innerHTML = MINE_SVG;
        if (i === firstClickCell) el.classList.add("mine-hit");
      } else if (cell.adj > 0) {
        el.textContent = cell.adj;
        el.dataset.n = cell.adj;
      }
    } else {
      if (cell.flag === FLAG.FLAG) el.innerHTML = FLAG_SVG;
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

  function explode(i) {
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
        cell.el.innerHTML = FLAG_SVG;
      }
    }
    paintCell(i);
    cells[i].el.classList.add("mine-hit");
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
      if (time < 999) { time++; updateTimer(); }
    }, 1000);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

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
      return;
    }

    if (e.button === 1) { // middle click = chord
      e.preventDefault();
      if (cell.revealed) chord(i);
      return;
    }

    if (e.button === 0) {
      renderFace("normal");
      if (cell.flag === FLAG.FLAG) return;
      if (cell.revealed) { chord(i); return; }

      if (!minesPlaced) {
        placeMines(i);
        if (!gameStarted) { gameStarted = true; startTimer(); }
      }
      if (cell.mine) { explode(i); return; }
      reveal(i);
      checkWin();
    }
  });

  // prevent middle-click autoscroll
  fieldEl.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });

  smileyEl.addEventListener("click", newGame);

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
  function newGame() { buildBoard(); }

  function setLevel(l) { if (LEVELS[l]) { level = l; buildBoard(); } }

  function markActiveLevel() {
    document.querySelectorAll(".menu-dropdown button[data-action]").forEach((b) => {
      b.classList.remove("checked");
      if (b.dataset.action === level) b.classList.add("checked");
    });
  }

  function openDialog(title, bodyHtml, buttons) {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="title-bar">
          <div class="title-bar-inner"><span class="title-text">${title}</span></div>
          <div class="title-buttons"><button class="tb-btn close" data-close>&#10005;</button></div>
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
      </ul>`, [{ label: "OK", primary: true }]);
  }

  function showAbout() {
    openDialog("About Minesweeper", `
      <div class="icon-row" style="font-size:22px">${FACES.cool}</div>
      <p><b>Minesweeper</b></p>
      <p>An HTML5 tribute to the classic Windows XP game.</p>
      <p style="color:#666">You are playing: <b>${LEVELS[level].label}</b>
      (${cols}&times;${rows}, ${totalMines} mines)</p>`,
      [{ label: "OK", primary: true }]);
  }

  function flashWindow() {
    windowEl.classList.remove("flash");
    void windowEl.offsetWidth;
    windowEl.classList.add("flash");
    setTimeout(() => windowEl.classList.remove("flash"), 400);
  }

  function showExit() {
    overlayMsgEl.innerHTML = `${FACES.cool} Thanks for playing Minesweeper! <a href="#" onclick="location.reload()">Play again</a>`;
    overlayEl.hidden = false;
  }
  overlayEl.addEventListener("click", () => { overlayEl.hidden = true; });

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
      case "exit": showExit(); break;
      case "how-to-play": showHowToPlay(); break;
      case "about": showAbout(); break;
      case "best-times": showBestTimes(); break;
    }
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (modalRoot.firstChild) { if (e.key === "Escape") closeModal(); return; }
    const k = e.key.toLowerCase();
    if (e.altKey) {
      const map = { g: "game", h: "help" };
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
    else if (k === "b" && e.ctrlKey) { e.preventDefault(); showBestTimes(); }
  });

  // ---------- Init ----------
  mineDigits = buildLed(mineCounterEl);
  timerDigits = buildLed(timerEl);
  buildBoard();

  // Keep the board fitted to the viewport (does not reset game state).
  let resizeRaf = null;
  function scheduleLayout() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = null; layout(); });
  }
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("orientationchange", scheduleLayout);
})();
