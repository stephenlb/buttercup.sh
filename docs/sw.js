
const VERSION = "08853b8ffc59";
const CACHE = `buttercup-${VERSION}`;
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
await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
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
if (new URL(req.url).origin !== location.origin) return;
e.respondWith(serve(e, req));
});
async function serve(e, req) {
const cache = await caches.open(CACHE);
const hit = await cache.match(req, { ignoreSearch: true });
if (hit) {
e.waitUntil(update(cache, req).catch(() => {}));
return hit;
}
try {
return await update(cache, req);
} catch (err) {
const shell = req.mode === "navigate" && await cache.match("./");
if (shell) return shell;
throw err;
}
}
async function update(cache, req) {
const res = await fetch(req);
if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
return res;
}
