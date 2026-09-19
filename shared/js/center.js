/* ===== Game Center — light/dark override =====
   CSS already follows prefers-color-scheme. This script only lets the user
   override it explicitly, and persists that choice. */
(function () {
  var KEY = "gc-mode";                 // must match the inline snippet in index.html
  var root = document.documentElement;
  var btn = document.getElementById("modeToggle");
  var label = document.getElementById("modeLabel");
  if (!btn || !label) return;

  function systemDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  // Effective mode: explicit choice wins, otherwise follow the OS.
  function current() {
    return root.getAttribute("data-mode") || (systemDark() ? "dark" : "light");
  }

  function render() {
    var now = current();
    var next = now === "dark" ? "light" : "dark";
    label.textContent = next === "dark" ? "Dark" : "Light";   // mode the click applies
    btn.setAttribute("aria-pressed", String(now === "dark"));
    btn.title = "Switch to " + next + " mode";
  }

  btn.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-mode", next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    render();
  });

  // Re-render when the OS flips, but only while no explicit choice is stored.
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onSystem = function () { if (!root.getAttribute("data-mode")) render(); };
    if (mq.addEventListener) mq.addEventListener("change", onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  }

  render();
})();

/* ===== Game Center — favourites + ordering =====
   Cards are shown alphabetically, with any favourited games floated to the
   front. The favourite set is persisted in localStorage. The star lives inside
   the card's <a>, so its click is stopped to avoid triggering navigation. */
(function () {
  var grid = document.querySelector(".gc-grid");
  if (!grid) return;
  var FAV_KEY = "gc-favourites";

  function load() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) {}
  }
  var favs = load();
  function isFav(href) { return favs.indexOf(href) !== -1; }

  function titleOf(card) {
    var t = card.querySelector(".gc-card__title");
    return t && t.firstChild ? t.firstChild.textContent.trim() : card.href;
  }

  function applyStar(card) {
    var star = card.querySelector(".gc-fav");
    if (!star) return;
    var on = isFav(card.href);
    var name = titleOf(card);
    star.setAttribute("aria-pressed", String(on));
    star.setAttribute("aria-label", (on ? "Remove " : "Add ") + name + " from favourites");
    star.title = on ? "Remove from favourites" : "Add to favourites";
  }

  function sortGrid() {
    var cards = Array.prototype.slice.call(grid.querySelectorAll(".gc-card"));
    cards.sort(function (a, b) {
      var af = isFav(a.href) ? 0 : 1, bf = isFav(b.href) ? 0 : 1;
      if (af !== bf) return af - bf;                        // favourites first
      return titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true, sensitivity: "base" });
    });
    cards.forEach(function (c) { grid.appendChild(c); });   // reinsert in order
  }

  function toggle(card) {
    var href = card.href, i = favs.indexOf(href);
    if (i === -1) favs.push(href); else favs.splice(i, 1);
    save(favs);
    applyStar(card);
    sortGrid();
  }

  Array.prototype.slice.call(grid.querySelectorAll(".gc-card")).forEach(function (card) {
    var star = card.querySelector(".gc-fav");
    if (!star) return;
    applyStar(card);
    star.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation(); toggle(card);
    });
    star.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault(); e.stopPropagation(); toggle(card);
      }
    });
  });

  sortGrid();
})();

/* ===== Game Center — search + category filter =====
   Cards are shown when their title matches the search text AND their
   data-category matches the active chip ("all" = no category filter).
   Hiding uses the hidden attribute, which base.css un-overrides for the
   flex cards. Favourite sorting keeps running underneath untouched. */
(function () {
  var grid = document.querySelector(".gc-grid");
  var input = document.getElementById("gameSearch");
  var empty = document.getElementById("gcEmpty");
  if (!grid || !input) return;
  var chips = Array.prototype.slice.call(document.querySelectorAll(".gc-chip"));
  var category = "all";

  function nameOf(card) {
    var t = card.querySelector(".gc-card__title");
    return t && t.firstChild ? t.firstChild.textContent.trim().toLowerCase() : "";
  }

  function apply() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    Array.prototype.slice.call(grid.querySelectorAll(".gc-card")).forEach(function (card) {
      var okCat = category === "all" || (card.getAttribute("data-category") || "").toLowerCase() === category;
      var show = okCat && (!q || nameOf(card).indexOf(q) !== -1);
      card.hidden = !show;
      if (show) shown++;
    });
    if (empty) empty.hidden = shown !== 0;
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      category = chip.getAttribute("data-category") || "all";
      chips.forEach(function (c) {
        var on = c === chip;
        c.classList.toggle("gc-chip--on", on);
        c.setAttribute("aria-pressed", String(on));
      });
      apply();
    });
  });

  input.addEventListener("input", apply);
  apply();
})();

/* ===== Game Center — blank-header click scrolls to top =====
   The header is sticky, so it is a natural home target. Clicks on real
   controls inside it (toggle, links, the search label) are ignored. */
(function () {
  var header = document.querySelector(".gc-header");
  if (!header) return;
  header.addEventListener("click", function (e) {
    if (e.target.closest("a, button, input, label, select, textarea")) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
})();
