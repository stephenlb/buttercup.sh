/* ═══════════════════════════════════════════════════════════════════════════
   sw — the service worker that makes the harness installable and offline.

   An installed app has to answer its own start_url with no network, so this
   keeps a copy of the shell — the page, the manifest, the icons — and serves
   what it has while it refreshes it in the background.

   Two rules keep it honest, and they are the reason the harness stays "no
   backend, nothing of yours leaves this tab":

     · Same-origin GETs only. A model request, a WebLLM weight file, an npm
       lookup — anything cross-origin — is not touched at all: no respondWith,
       so the browser makes the request as if this worker did not exist. Nothing
       with a key in it is ever written to a cache.
     · No POSTs. The signup form and every vendor call go straight out.

   VERSION is stamped by build.mjs with a hash of the bundle it ships beside, so
   a new build lands in a new cache and the old one is dropped on activate. In
   the unbundled source it stays "dev".
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = "dev";                  /* build.mjs stamps the bundle's hash */
const CACHE = `buttercup-${VERSION}`;

// The start_url first: an installed window opens on it. The rest is what a cold
// launch needs before it can paint. Lessons are not listed — they are cached as
// they are read, which is the difference between an app shell and a mirror.
const SHELL = [
  "./",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time, failures swallowed: addAll is all-or-nothing, and a single
    // missing icon should not leave the app with no cached page at all.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    // The page that is open keeps the JavaScript it already loaded; taking over
    // now only means the *next* load is the new bundle, with no reload forced
    // out from under a running agent.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys())
      if (name.startsWith("buttercup-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== location.origin) return;   // vendors: untouched
  e.respondWith(serve(e, req));
});

/* Stale-while-revalidate. The cached copy answers immediately — the whole
   harness is one file, so that is the whole paint — and a fresh one is fetched
   behind it for next time. `ignoreSearch` because `?theme=light` and friends
   address the same document. */
async function serve(e, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    e.waitUntil(update(cache, req).catch(() => {}));   // offline: keep the copy
    return hit;
  }
  try {
    return await update(cache, req);
  } catch (err) {
    // Offline and never seen: a navigation still gets the shell, so deep links
    // and the lessons archive open into the app rather than a browser error.
    const shell = req.mode === "navigate" && await cache.match("./");
    if (shell) return shell;
    throw err;
  }
}

async function update(cache, req) {
  const res = await fetch(req);
  // `basic` only: an opaque cross-origin response tells us nothing about
  // whether it succeeded, and a redirect is not the thing that was asked for.
  if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
  return res;
}
