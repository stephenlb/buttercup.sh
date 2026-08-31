/* ═══════════════════════════════════════════════════════════════════════════
   theme — which tube is lit: the system's, the day one, or the night one.

   The palette itself is one set of `light-dark()` pairs in the stylesheet,
   resolved against the root's `color-scheme`. So the whole job here is to cycle
   one attribute — `data-theme`, absent for AUTO — and remember the choice:

     AUTO  → follow prefers-color-scheme   (no attribute)
     DAY   → pinned light
     NIGHT → pinned dark

   No styles are set from script, and the button's face is not written either:
   it ships with all three glyphs — sun, crescent, both — and CSS shows the live
   one.

   `?theme=light` pins one for the length of a load, which is what screenshots
   and CSS work want; it is deliberately not saved.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const KEY = "buttercup.theme";
  const CYCLE = ["auto", "light", "dark"];
  const root = document.documentElement;

  const clean = (t) => (CYCLE.includes(t) ? t : null);

  let now = clean(localStorage.getItem(KEY)) || "auto";

  // A URL override wins for this load and is never written back.
  const asked = clean(new URLSearchParams(location.search).get("theme"));
  if (asked) now = asked;

  const apply = () => {
    if (now === "auto") delete root.dataset.theme;
    else root.dataset.theme = now;
  };
  apply();

  // Delegated, because this script runs before the title bar exists in the
  // bundled build and after it in the source one — either way the click lands.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#theme")) return;
    now = CYCLE[(CYCLE.indexOf(now) + 1) % CYCLE.length];
    apply();
    try { localStorage.setItem(KEY, now); } catch { /* private mode: fine */ }
  });

  window.Theme = { get current() { return now; }, list: CYCLE.slice() };
})();
