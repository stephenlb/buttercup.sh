/* ═══════════════════════════════════════════════════════════════════════════
   pwa — install the harness as an app, and keep it working offline.

   Two small jobs:

     · Register sw.js (see that file for what it will and will not cache), which
       is what lets a browser offer INSTALL at all and what answers the start
       URL when there is no network.
     · Surface the install prompt. Chrome and Edge hand it over as an event
       instead of a button, so the tagline's `install` is hidden until that
       event arrives and gone again once the app is installed.

   Not registered from `file://` — a service worker needs a real origin — so
   opening index.html off disk behaves exactly as it did before, with no cache
   in front of the files you are editing. `?nosw=1` does the same on a served
   copy, and unregisters one that is already there, for when you are debugging
   the harness rather than the app.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const secure = location.protocol === "https:" ||
                 /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const wanted = !new URLSearchParams(location.search).has("nosw");

  if ("serviceWorker" in navigator && secure) {
    if (wanted) {
      // After load: the worker's install fetches the shell, and that should not
      // compete with the page's own first paint.
      addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
      });
    } else {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
  }

  /* ── the INSTALL affordance ─────────────────────────────────────────────────
     `beforeinstallprompt` fires only where the browser has an installer to
     offer and the app is not already installed. Everywhere else — Safari, iOS,
     an app already on the home screen — the button simply never appears, and
     Add to Home Screen in the browser's own menu does the same job.
     --------------------------------------------------------------------- */
  const btn = document.getElementById("install");
  let offer = null;

  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                  // ours to fire, from the click below
    offer = e;
    if (btn) btn.hidden = false;
  });

  addEventListener("appinstalled", () => {
    offer = null;
    if (btn) btn.hidden = true;
  });

  if (btn) btn.addEventListener("click", async () => {
    if (!offer) return;
    // An offer is good for one prompt; a dismissal is not final, and the
    // browser fires the event again on a later visit, which puts the button
    // back.
    btn.hidden = true;
    const shown = offer;
    offer = null;
    try { await shown.prompt(); } catch { /* the browser withdrew it: fine */ }
  });

  window.PWA = {
    get installable() { return !!offer; },
    // True in a window the OS launched: the harness is running as an app.
    get standalone() {
      return matchMedia("(display-mode: standalone)").matches ||
             matchMedia("(display-mode: window-controls-overlay)").matches ||
             navigator.standalone === true;
    },
  };
})();
