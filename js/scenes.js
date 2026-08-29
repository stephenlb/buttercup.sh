/* ═══════════════════════════════════════════════════════════════════════════
   scenes — which view is out the window this session.

   The room under the prompt holds seven pixel-art scenes; exactly one is on
   screen, and which one is a coin toss on every load. That is the whole job:
   write a name to `data-scene` and let the stylesheet do the rest. The scenes
   themselves are 100% CSS — nothing here animates, measures or paints.

   `?scene=city` pins one, which is what screenshots and CSS work want.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const SCENES = ["beach", "city", "woods", "orbit", "reef", "rails", "volcano"];
  const box = document.getElementById("scenes");
  if (!box) return;

  const asked = new URLSearchParams(location.search).get("scene");
  const pick = SCENES.includes(asked)
    ? asked
    : SCENES[Math.floor(Math.random() * SCENES.length)];

  box.dataset.scene = pick;
  window.Scenes = { list: SCENES.slice(), current: pick };
})();
