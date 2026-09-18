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
